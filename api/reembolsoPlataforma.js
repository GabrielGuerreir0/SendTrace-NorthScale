/**
 * Classificação automática de "Reembolsado pela plataforma" (pedido da Késsia/Rodrigo, 21/10/2026; migração 118).
 * Tickets com essa resolução ganham, sozinhos, um destes tipos de resolução:
 *   Reembolsado pela plataforma - Sem atendimento | - Evasão provável | - Outros
 * Camada 1 (SQL, view email_ia.v_reembolso_plataforma_camada1): primeira resposta do agente x data do reembolso.
 * Camada 2 (IA lê a conversa inteira): os que a camada 1 não resolve. Confiança "baixa" grava o status e marca o ticket para revisão humana.
 *
 * Gatilho (reavaliar): enquanto a resolução for "Reembolsado pela plataforma" (ou um dos 3 tipos acima, classificado pelo sistema) e a ASSINATURA da conversa
 * mudou — e-mail novo do cliente, resposta nova do agente, data do reembolso ou do chargeback. Ticket já classificado pela IA só é reprocessado com e-mail
 * novo ou resposta nova (evita custo e oscilação). Resolução mudada à mão por uma pessoa nunca é sobrescrita.
 * A rotina nasce DESLIGADA (config_disparos.reembolso_plataforma_ativo); o backfill/simulação rodam pelo terminal (api/reembolsoPlataformaCli.js).
 */
import Anthropic from '@anthropic-ai/sdk';
import { pool, query } from '../server/db.js';

export const BASE = 'Reembolsado pela plataforma';
export const SEM = `${BASE} - Sem atendimento`;
export const EVA = `${BASE} - Evasão provável`;
export const OUT = `${BASE} - Outros`;
export const TIPOS = [BASE, SEM, EVA, OUT];
const MAPA = { SEM_ATENDIMENTO: SEM, EVASAO_PROVAVEL: EVA, OUTROS: OUT };
const AUTORES_SISTEMA = ['Sistema', 'Sistema (IA)'];
export const VERSAO_PROMPT = 'v1';
const MODELO_PADRAO = 'claude-sonnet-5';
const LIMITE_TEXTO = 120_000;   // só protege contra conversa absurda; uma conversa normal vai inteira

/* ───────── camada 1 (a mesma regra da view, para testar sem banco) ───────── */
const dataBRT = (d) => new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 10);   // America/Sao_Paulo (sem horário de verão desde 2019)
export function camada1({ pResp, dr }) {
  if (!pResp) return { status: SEM, motivo: 'agente nunca respondeu' };
  if (dr && dataBRT(pResp) >= String(dr).slice(0, 10)) return { status: SEM, motivo: 'primeira resposta no dia ou depois do reembolso' };
  return null;   // vai para a camada 2
}

/* ───────── gatilho: precisa reavaliar? ───────── */
export const assinatura = (c) => `${c.n_emails}|${c.n_resp}|${c.dr ? String(c.dr).slice(0, 10) : ''}|${c.dcb ? String(c.dcb).slice(0, 10) : ''}`;
export function precisaAvaliar(c) {
  if (c.tipo_resolucao === BASE) return true;                                          // acabou de receber a resolução
  if (!TIPOS.includes(c.tipo_resolucao)) return false;
  if (c.reembolso_plat_origem === null || c.reembolso_plat_origem === undefined) return false;   // classificado por uma pessoa: não mexe
  if (!AUTORES_SISTEMA.includes(c.propriedades_atualizado_por || 'Sistema')) return false;       // pessoa mudou o tipo à mão
  const [ne, nr] = String(c.reembolso_plat_assinatura || '').split('|');
  const conversaMudou = String(c.n_emails) !== ne || String(c.n_resp) !== nr;
  if (c.reembolso_plat_origem === 'IA') return conversaMudou;                          // IA: só e-mail novo ou resposta nova
  return assinatura(c) !== c.reembolso_plat_assinatura;                                // SQL/regra: qualquer mudança
}

/* ───────── candidatos ───────── */
export async function candidatos() {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL statement_timeout = '180s'");   // o padrão do banco é 15 s; esta rotina é mais pesada que uma tela
    const { rows } = await cli.query(
      `WITH fam AS (
         SELECT s.id AS caso_id, lower(s.remetente_email) AS em, f.tipo_resolucao, to_char(f.data_reembolso_total, 'YYYY-MM-DD') AS dr, to_char(f.data_chargeback, 'YYYY-MM-DD') AS dcb, f.propriedades_atualizado_por,   -- texto: o driver devolveria DATE como objeto Date
                f.reembolso_plat_origem, f.reembolso_plat_assinatura
           FROM email_ia.suporte_escalado s JOIN email_ia.suporte_escalado_ficha f ON f.suporte_escalado_id = s.id
          WHERE s.ticket_mae_id IS NULL AND f.tipo_resolucao = ANY($1::text[])
       ), ag AS (
         SELECT coalesce(s.ticket_mae_id, s.id) AS caso_id, min(r.enviado_em) AS p_resp, count(*)::int AS n_resp
           FROM email_ia.respostas_agente r JOIN email_ia.suporte_escalado s ON s.id = r.caso_id
          WHERE coalesce(s.ticket_mae_id, s.id) IN (SELECT caso_id FROM fam) GROUP BY 1
       ), em AS (
         SELECT lower(e.remetente_email) AS em, count(*)::int AS n_emails
           FROM email_ia.emails e WHERE lower(e.remetente_email) IN (SELECT em FROM fam) GROUP BY 1
       )
       SELECT fam.*, ag.p_resp, coalesce(ag.n_resp, 0) AS n_resp, coalesce(em.n_emails, 0) AS n_emails
         FROM fam LEFT JOIN ag ON ag.caso_id = fam.caso_id LEFT JOIN em ON em.em = fam.em
        ORDER BY fam.caso_id`, [TIPOS]);
    await cli.query('COMMIT');
    return rows;
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
}

/* ───────── conversa (linha do tempo cronológica) ───────── */
/** Tira só citações repetidas e assinaturas; o resto do texto vai inteiro. */
export function limparTexto(t) {
  let s = String(t || '').replace(/\r\n?/g, '\n');
  const cortes = [/^-{2,}\s*(Original Message|Mensagem original|Forwarded message)[^\n]*$/im, /^On .{5,120}wrote:\s*$/m, /^Em .{5,120}escreveu:\s*$/m, /^De:\s.+\n(Enviado|Date|Data):/m, /^From:\s.+\n(Sent|Date):/m];
  for (const re of cortes) { const m = re.exec(s); if (m) s = s.slice(0, m.index); }
  s = s.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const sig = /^-- ?$/m.exec(s); if (sig) s = s.slice(0, sig.index);
  s = s.replace(/^(Sent from my (iPhone|iPad|Android)|Get Outlook for \w+|Enviado do meu \w+)[^\n]*$/gim, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
export async function linhaDoTempo(c, db = { query }) {
  const [em, ag] = await Promise.all([
    db.query(`SELECT coalesce(e.data_email, e.criado_em) AS t, e.assunto, e.corpo_texto FROM email_ia.emails e WHERE lower(e.remetente_email) = $1 ORDER BY coalesce(e.data_email, e.criado_em)`, [c.em]),
    db.query(`SELECT r.enviado_em AS t, r.assunto, r.corpo_texto FROM email_ia.respostas_agente r
               WHERE r.caso_id IN (SELECT id FROM email_ia.suporte_escalado WHERE id = $1 OR ticket_mae_id = $1) ORDER BY r.enviado_em`, [c.caso_id]),
  ]);
  const itens = [...em.rows.map((x) => ({ ...x, quem: 'CLIENTE' })), ...ag.rows.map((x) => ({ ...x, quem: 'AGENTE' }))];
  if (c.dr) itens.push({ t: new Date(`${String(c.dr).slice(0, 10)}T12:00:00-03:00`), quem: 'EVENTO', assunto: '', corpo_texto: 'Reembolso total registrado (data do reembolso).' });
  if (c.dcb) itens.push({ t: new Date(`${String(c.dcb).slice(0, 10)}T12:00:00-03:00`), quem: 'EVENTO', assunto: '', corpo_texto: 'Chargeback registrado (data do chargeback).' });
  const comData = (x) => x.t && Number.isFinite(new Date(x.t).getTime());
  itens.sort((a, b) => (comData(a) ? new Date(a.t) : 0) - (comData(b) ? new Date(b.t) : 0));
  const texto = itens.map((x) => `[${x.quem} · ${comData(x) ? new Date(x.t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'sem data'}]${x.assunto ? ` Assunto: ${x.assunto}` : ''}\n${limparTexto(x.corpo_texto) || '(sem texto)'}`).join('\n\n---\n\n');
  return { texto: texto.length > LIMITE_TEXTO ? `${texto.slice(0, LIMITE_TEXTO / 4)}\n\n[… trecho do meio omitido por tamanho …]\n\n${texto.slice(-LIMITE_TEXTO * 3 / 4)}` : texto, n: itens.length };
}

/* ───────── camada 2: IA ───────── */
export const PROMPT = `Você classifica tickets de suporte de uma empresa de nutracêuticos cujo cliente
acabou recebendo reembolso diretamente da plataforma de pagamento ou do banco.
Leia a conversa inteira (e-mails do cliente, respostas do agente e datas) e
escolha UMA categoria:

SEM_ATENDIMENTO: o agente não teve oportunidade real de reverter. Isso inclui:
 - o reembolso ou estorno já tinha saído, ou saiu enquanto a conversa ocorria,
   e o agente chegou tarde ou só confirmou;
 - o cliente já tinha aberto disputa no banco, cartão ou plataforma antes da
   resposta do agente;
 - o cliente diz que já foi reembolsado.

EVASAO_PROVAVEL: o agente atuou de verdade antes do reembolso (ofereceu solução,
reembolso parcial, reenvio, devolução, instruções) e o cliente:
 - recusou e disse que iria ao banco, à plataforma ou abriria chargeback, ou
 - parou de responder e o reembolso saiu depois pela plataforma.

OUTROS: não há evasão nem prova de que a plataforma foi mais rápida (conversa
sem desfecho claro, cliente cooperativo, reembolso concedido pela própria
empresa, e-mails vazios).

Em caso de dúvida entre SEM_ATENDIMENTO e EVASAO_PROVAVEL, escolha SEM_ATENDIMENTO só se houver prova de que a disputa ou o reembolso veio antes do atendimento efetivo do agente.

Responda só em JSON: {"categoria": "...", "confianca": "alta|media|baixa",
"motivo": "até 15 palavras, sem dados pessoais"}`;
let cliente;
const clienteAnthropic = () => { if (!process.env.ANTHROPIC_API_KEY) return null; cliente ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return cliente; };
/** Pergunta à IA. Falha (sem chave, erro de rede, JSON ruim) NÃO vira classificação: devolve {falhou:true} e o ticket fica como está para a próxima rodada. */
export async function perguntarIA(conversa, { modelo = MODELO_PADRAO, api = clienteAnthropic() } = {}) {
  if (!api) return { falhou: true, motivo: 'Sem chave da IA configurada.' };
  try {
    const r = await api.messages.create({ model: modelo, max_tokens: 4000, system: PROMPT, messages: [{ role: 'user', content: conversa }] });
    const bruto = (r.content || []).filter((b) => typeof b.text === 'string').map((b) => b.text).join('');
    if (!bruto.includes('{')) return { falhou: true, motivo: `IA sem resposta em texto (parou por ${r.stop_reason})` };
    const j = JSON.parse(bruto.slice(bruto.indexOf('{'), bruto.lastIndexOf('}') + 1));
    if (!MAPA[j.categoria]) return { falhou: true, motivo: `categoria inesperada: ${String(j.categoria).slice(0, 30)}` };
    const confianca = ['alta', 'media', 'baixa'].includes(j.confianca) ? j.confianca : 'baixa';
    return { categoria: j.categoria, confianca, motivo: String(j.motivo || '').slice(0, 200), modelo };
  } catch (e) { return { falhou: true, motivo: `Falha ao consultar a IA: ${String(e.message || e).slice(0, 120)}` }; }
}

/* ───────── decisão por ticket ───────── */
/** Devolve {status, origem, confianca, motivo, revisar, categoria?} ou {falhou} ou null (nada a fazer). `gravarAvaliacao=false` na simulação não guarda nada fora o cache da IA. */
export async function decidir(c, { db = { query }, modelo = MODELO_PADRAO, api, forcar = false } = {}) {
  const c1 = camada1({ pResp: c.p_resp, dr: c.dr });
  if (c1) return { status: c1.status, origem: 'SQL', confianca: null, motivo: c1.motivo, revisar: false };
  if (!c.n_emails) return { status: OUT, origem: 'REGRA', confianca: null, motivo: 'sem e-mail do cliente na base', revisar: false };
  const chaveModelo = `${modelo}|${VERSAO_PROMPT}`, conversa = `${c.n_emails}|${c.n_resp}`;
  const { rows } = await db.query('SELECT categoria, confianca, motivo FROM email_ia.reembolso_plataforma_avaliacoes WHERE caso_id = $1 AND conversa = $2 AND modelo = $3', [c.caso_id, conversa, chaveModelo]);
  let a = rows[0];
  if (!a || forcar) {
    const tl = await linhaDoTempo(c, db);
    a = await perguntarIA(tl.texto, { modelo, api });
    if (a.falhou) return { falhou: true, motivo: a.motivo };
    await db.query(`INSERT INTO email_ia.reembolso_plataforma_avaliacoes (caso_id, conversa, categoria, confianca, motivo, modelo) VALUES ($1,$2,$3,$4,$5,$6)
                    ON CONFLICT (caso_id, conversa, modelo) DO UPDATE SET categoria = EXCLUDED.categoria, confianca = EXCLUDED.confianca, motivo = EXCLUDED.motivo, avaliado_em = now()`, [c.caso_id, conversa, a.categoria, a.confianca, a.motivo, chaveModelo]);
  }
  return { status: MAPA[a.categoria], origem: 'IA', categoria: a.categoria, confianca: a.confianca, motivo: a.motivo, revisar: a.confianca === 'baixa' };
}

/** Grava a classificação na ficha (só se ela ainda é a que lemos) e no log. */
export async function gravar(c, d) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const autor = d.origem === 'IA' ? 'Sistema (IA)' : 'Sistema';
    const { rowCount } = await cli.query(
      `UPDATE email_ia.suporte_escalado_ficha
          SET tipo_resolucao = $2, reembolso_plat_origem = $3, reembolso_plat_confianca = $4, reembolso_plat_motivo = $5, reembolso_plat_revisar = $6,
              reembolso_plat_avaliado_em = now(), reembolso_plat_assinatura = $7,
              propriedades_atualizado_por = $8, propriedades_atualizado_em = now(), atualizado_por = $8, atualizado_em = now()
        WHERE suporte_escalado_id = $1 AND tipo_resolucao = $9 AND coalesce(propriedades_atualizado_por, 'Sistema') = ANY($10::text[])`,
      [c.caso_id, d.status, d.origem, d.confianca, d.motivo, d.revisar, assinatura(c), autor, c.tipo_resolucao, c.tipo_resolucao === BASE ? [...AUTORES_SISTEMA, c.propriedades_atualizado_por ?? 'Sistema'] : AUTORES_SISTEMA]);
    if (rowCount) await cli.query(`INSERT INTO email_ia.reembolso_plataforma_log (caso_id, tipo_antes, tipo_depois, origem, confianca, motivo, revisar) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.caso_id, c.tipo_resolucao, d.status, d.origem, d.confianca, d.motivo, d.revisar]);
    await cli.query('COMMIT');
    return Boolean(rowCount);
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
}

/** Uma rodada. gravar=false = simulação (consulta a IA e guarda só o cache de avaliações; NÃO altera ticket). */
export async function rodar({ gravar: grava = false, modelo = MODELO_PADRAO, api, limite = Infinity, todos = false, log = () => {} } = {}) {
  const cands = await candidatos(), linhas = [];
  for (const c of cands) {
    if (linhas.length >= limite) break;
    if (!todos && !precisaAvaliar(c)) continue;
    if (linhas.length && linhas.length % 25 === 0) log(`… ${linhas.length} tickets avaliados`);
    const d = await decidir(c, { modelo, api });
    if (d.falhou) { log(`ticket ${c.caso_id}: ${d.motivo}`); linhas.push({ c, falhou: true, motivo: d.motivo }); continue; }
    const mudou = c.tipo_resolucao !== d.status || c.reembolso_plat_origem !== d.origem;
    let gravado = false;
    if (grava && (mudou || assinatura(c) !== c.reembolso_plat_assinatura || (c.reembolso_plat_confianca ?? null) !== (d.confianca ?? null))) {
      try { gravado = await gravar(c, d); } catch (e) { log(`ticket ${c.caso_id}: ${e.message}`); }
    }
    linhas.push({ c, d, mudou, gravado });
  }
  return linhas;
}

/** Chamada pelo agendador da API: só roda com reembolso_plataforma_ativo = 'true' (nasce 'false'). */
export async function rodadaPeriodica(log = () => {}) {
  const { rows } = await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'reembolso_plataforma_%'`);
  const c = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  if (c.reembolso_plataforma_ativo !== 'true') return { rodou: false, motivo: 'desligado' };
  const linhas = await rodar({ gravar: true, modelo: c.reembolso_plataforma_modelo || MODELO_PADRAO, log });
  const n = linhas.filter((l) => l.gravado).length;
  if (n) log(`reembolso da plataforma: ${linhas.length} avaliados, ${n} classificados`);
  return { rodou: true, avaliados: linhas.length, classificados: n };
}
