/**
 * Reversão indireta (pedido da Késsia, 21/10/2026; migração 116).
 *
 * Ticket de Reembolso/Chargeback em que o último e-mail foi do nosso agente, esperava resposta e o cliente não voltou:
 *   - Tipo de resolução passa para "Reversão indireta - 10D / 30D / 60D" ou "Reversão indireta concluída - superior a 60D" (dias desde a mensagem do agente);
 *   - Detalhamento "Verificando - Ag. Cliente" vira "Cliente não retornou" (outro detalhamento não muda);
 *   - em dúvida se a mensagem esperava resposta: Tipo de resolução = "Analisar - Possível caso de reversão indireta" (nada mais muda).
 * Só entra o ticket que cumpre TODAS as condições da Késsia (ver `candidatos`). A IA lê SÓ o texto da última mensagem do agente (sem nome, e-mail ou histórico).
 * Com `reversao_indireta_ativo = false` (padrão) nada é gravado em ticket: só a simulação roda.
 */
import Anthropic from '@anthropic-ai/sdk';
import { pool, query } from '../server/db.js';

export const TIPO_ANALISAR = 'Analisar - Possível caso de reversão indireta';
export const TIPOS_REVERSAO_INDIRETA = ['Reversão indireta - 10D', 'Reversão indireta - 30D', 'Reversão indireta - 60D', 'Reversão indireta concluída - superior a 60D'];
/* Tipos em que o ticket pode estar para entrar na regra. Os de reversão indireta ficam na lista de propósito: é assim que o ticket avança de 10D para 30D, 60D… */
export const TIPOS_ELEGIVEIS = ['Verificando - Ag. Cliente', 'Reversão total do reembolso', 'Cliente não retornou', ...TIPOS_REVERSAO_INDIRETA];
const DETALHE_ORIGEM = 'Verificando - Ag. Cliente';
const DETALHE_NOVO = 'Cliente não retornou';
const AUTOR = 'Sistema (IA)';

/** Faixa pelos dias sem resposta; null = menos de 10 dias (não altera). */
export function tipoPorDias(dias) {
  if (!Number.isFinite(dias) || dias < 10) return null;
  if (dias <= 19) return TIPOS_REVERSAO_INDIRETA[0];
  if (dias <= 30) return TIPOS_REVERSAO_INDIRETA[1];
  if (dias <= 60) return TIPOS_REVERSAO_INDIRETA[2];
  return TIPOS_REVERSAO_INDIRETA[3];
}

/**
 * Tickets que cumprem as condições estruturais (a IA decide só a 4ª):
 * 1 motivo Reembolso/Chargeback · 2 tipo atual elegível · 3 última mensagem do ticket é do agente (não do cliente nem do sistema)
 * 5/7 sem reembolso nem chargeback depois do 1º e-mail (indicadores, datas e coluna Reembolsado) · 6 não é reembolso parcial.
 * Dias = dias corridos (fuso de São Paulo) desde a última mensagem do agente.
 */
export async function candidatos() {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL statement_timeout = '120s'");   // o padrão do banco é 15 s; esta rotina diária é mais pesada que uma tela
    const { rows } = await cli.query(
      `WITH ag AS (   -- última mensagem do agente por ticket principal (mensagem de ticket mesclado conta no principal)
         SELECT coalesce(s.ticket_mae_id, s.id) AS caso_id, max(r.enviado_em) AS agente_em
           FROM email_ia.respostas_agente r JOIN email_ia.suporte_escalado s ON s.id = r.caso_id
          GROUP BY 1
       ), base AS (
         SELECT s.id AS caso_id, s.status, s.ultimo_email_cliente_em, f.tipo_resolucao, f.detalhamento_motivo, f.motivo_contato,
                f.reembolso_apos_1o_email, f.chargeback_apos_1o_email, f.data_reembolso_total, f.data_chargeback, f.chargeback_em, f.percentual_reembolso
           FROM email_ia.suporte_escalado s JOIN email_ia.suporte_escalado_ficha f ON f.suporte_escalado_id = s.id
          WHERE s.ticket_mae_id IS NULL AND f.motivo_contato IN ('Reembolso', 'Chargeback') AND f.tipo_resolucao = ANY($1::text[])
       )
       SELECT b.caso_id, b.tipo_resolucao, b.detalhamento_motivo, b.motivo_contato, ag.agente_em,
              ((now() AT TIME ZONE 'America/Sao_Paulo')::date - (ag.agente_em AT TIME ZONE 'America/Sao_Paulo')::date) AS dias
         FROM base b JOIN ag ON ag.caso_id = b.caso_id
        WHERE coalesce(b.status, '') <> 'reembolsado'
          AND (b.ultimo_email_cliente_em IS NULL OR b.ultimo_email_cliente_em < ag.agente_em)
          AND NOT EXISTS (SELECT 1 FROM email_ia.mensagens_sistema ms WHERE ms.caso_id = b.caso_id AND ms.enviado_em > ag.agente_em)
          AND coalesce(b.reembolso_apos_1o_email, '') <> 'Sim' AND coalesce(b.chargeback_apos_1o_email, '') <> 'Sim'
          AND b.data_reembolso_total IS NULL AND b.data_chargeback IS NULL AND b.chargeback_em IS NULL
          AND b.percentual_reembolso IS NULL
        ORDER BY ag.agente_em`, [TIPOS_ELEGIVEIS]);
    await cli.query('COMMIT');
    return rows.map((r) => ({ ...r, dias: Number(r.dias) }));
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
}

/** Texto da última mensagem do agente (já sem a parte citada). */
async function ultimaMensagemAgente(casoId, agenteEm, db = { query }) {
  const { rows } = await db.query(
    `SELECT assunto, corpo_texto FROM email_ia.respostas_agente
      WHERE enviado_em = $2 AND caso_id IN (SELECT id FROM email_ia.suporte_escalado WHERE id = $1 OR ticket_mae_id = $1)
      ORDER BY id DESC LIMIT 1`, [casoId, agenteEm]);
  return rows[0] ? { assunto: rows[0].assunto || '', corpo: rows[0].corpo_texto || '' } : null;
}

/* Versão do prompt: entra na chave da decisão guardada. Mudou o prompt = a IA reavalia (as decisões antigas ficam no banco, mas não são reaproveitadas). v2 (21/10): a simulação mostrou a IA tratando "use o produto por mais dias" como aviso. */
export const VERSAO_PROMPT = 'v2';
const SISTEMA = `Você classifica UM e-mail enviado por um agente de suporte (a loja é de suplementos) a um cliente que pediu reembolso ou abriu disputa.
Pergunta: depois dessa mensagem, o agente estava ESPERANDO UMA RESPOSTA ou uma atitude do cliente para o caso avançar?

Marque "espera_resposta" quando a mensagem:
 a) orienta, convida ou pede ao cliente que USE, TESTE ou continue usando o produto por um período (ex.: 30 dias, mais algumas semanas) antes de decidir — mesmo que NÃO termine com uma pergunta; é o caso mais comum, e conta como esperar resposta;
 b) pede informação ou dado (foto, número do pedido, motivo, confirmação de dados, endereço);
 c) faz outra pergunta ou proposta (oferta, desconto, troca, manter o pedido) que precisa de aceite ou resposta.
Marque "nao_espera" SÓ quando a mensagem é claramente um encerramento, agradecimento ou aviso puro: reembolso ou reenvio já feito, confirmação de recebimento, código de rastreio informado, "caso resolvido". Se a mensagem apenas informa e NÃO pede nem convida o cliente a nada, é "nao_espera".
Marque "duvida" se não tiver certeza ou se a mensagem mistura informação com um convite que você não sabe se pede resposta. Na dúvida, SEMPRE "duvida" — nunca chute. Convidar o cliente a testar o produto NÃO é dúvida: é "espera_resposta".

O e-mail pode estar em inglês ou português. Responda SOMENTE com JSON: {"decisao":"espera_resposta|nao_espera|duvida","motivo":"uma frase curta em português"}`;

let cliente;
const clienteAnthropic = () => { if (!process.env.ANTHROPIC_API_KEY) return null; cliente ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return cliente; };

/** Pergunta à IA. Qualquer problema (sem chave, erro, JSON ruim) vira "duvida" — o ticket vai para revisão, nunca é classificado no chute. */
const MODELO_PADRAO = 'claude-haiku-4-5';
export async function perguntarIA({ assunto, corpo }, { modelo = MODELO_PADRAO, api = clienteAnthropic() } = {}) {
  if (!api) return { decisao: 'duvida', motivo: 'Sem chave da IA configurada.', modelo: null, falhou: true };
  const texto = `Assunto: ${assunto}\n\n${String(corpo).slice(0, 4000)}`;
  try {
    const r = await api.messages.create({ model: modelo, max_tokens: 200, temperature: 0, system: SISTEMA, messages: [{ role: 'user', content: texto }] });
    const bruto = (r.content || []).map((b) => b.text || '').join('');
    const j = JSON.parse(bruto.slice(bruto.indexOf('{'), bruto.lastIndexOf('}') + 1));
    const decisao = ['espera_resposta', 'nao_espera', 'duvida'].includes(j.decisao) ? j.decisao : 'duvida';
    return { decisao, motivo: String(j.motivo || '').slice(0, 300), modelo };
  } catch (e) {
    return { decisao: 'duvida', motivo: `Falha ao consultar a IA: ${String(e.message || e).slice(0, 120)}`, modelo, falhou: true };
  }
}

/** Decisão já guardada para este ticket e esta mensagem do agente, ou pergunta à IA e guarda. Mensagem vazia = dúvida. */
async function decisaoDe(c, { db = { query }, modelo, api, gravar = true } = {}) {
  const chaveModelo = `${modelo || MODELO_PADRAO}|${VERSAO_PROMPT}`;
  const { rows } = await db.query('SELECT decisao, motivo FROM email_ia.reversao_indireta_avaliacoes WHERE caso_id = $1 AND agente_em = $2 AND modelo = $3', [c.caso_id, c.agente_em, chaveModelo]);
  if (rows[0]) return { ...rows[0], reaproveitada: true };
  const msg = await ultimaMensagemAgente(c.caso_id, c.agente_em, db);
  const d = !msg || !msg.corpo.trim() ? { decisao: 'duvida', motivo: 'Não encontrei o texto da mensagem do agente.', modelo: null } : await perguntarIA(msg, { modelo, api });
  if (gravar && !d.falhou) {   // falha de IA não é guardada: na próxima rodada tenta de novo
    await db.query(`INSERT INTO email_ia.reversao_indireta_avaliacoes (caso_id, agente_em, decisao, motivo, modelo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (caso_id, agente_em) DO UPDATE SET decisao = EXCLUDED.decisao, motivo = EXCLUDED.motivo, modelo = EXCLUDED.modelo, avaliado_em = now()`,
      [c.caso_id, c.agente_em, d.decisao, d.motivo, chaveModelo]);
  }
  return { decisao: d.decisao, motivo: d.motivo, trecho: msg ? msg.corpo.replace(/\s+/g, ' ').slice(0, 240) : '', falhou: d.falhou };
}

/** O que a regra faria com este ticket (sem gravar). */
export function planejar(c, d) {
  const alvo = tipoPorDias(c.dias);
  if (alvo === null) return { acao: 'nenhuma', porque: 'menos de 10 dias sem resposta' };
  if (d.decisao === 'nao_espera') return { acao: 'nenhuma', porque: 'a mensagem do agente não esperava resposta' };
  if (d.decisao === 'duvida') return c.tipo_resolucao === TIPO_ANALISAR ? { acao: 'nenhuma', porque: 'já está em análise' } : { acao: 'analisar', tipo: TIPO_ANALISAR };
  const detalhe = c.detalhamento_motivo === DETALHE_ORIGEM ? DETALHE_NOVO : c.detalhamento_motivo;
  if (alvo === c.tipo_resolucao && detalhe === c.detalhamento_motivo) return { acao: 'nenhuma', porque: 'já está na faixa certa' };
  return { acao: 'classificar', tipo: alvo, detalhe };
}

/** Uma rodada. `gravar=false` (simulação) consulta a IA e guarda as decisões, mas NÃO altera ticket. */
export async function rodar({ gravar = false, modelo, api, log = () => {}, limite = Infinity } = {}) {
  const cands = (await candidatos()).slice(0, limite);
  const linhas = [];
  for (const c of cands) {
    if (tipoPorDias(c.dias) === null) { linhas.push({ ...c, decisao: '', motivo: '', trecho: '', ...planejar(c, { decisao: '' }) }); continue; }   // não gasta IA com ticket de menos de 10 dias
    const d = await decisaoDe(c, { modelo, api });
    const p = planejar(c, d);
    if (gravar && p.acao !== 'nenhuma') {
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        const { rowCount } = await cli.query(
          `UPDATE email_ia.suporte_escalado_ficha
              SET tipo_resolucao = $2, detalhamento_motivo = COALESCE($3, detalhamento_motivo),
                  propriedades_atualizado_por = $4, propriedades_atualizado_em = now(), atualizado_por = $4, atualizado_em = now()
            WHERE suporte_escalado_id = $1 AND tipo_resolucao = $5 AND detalhamento_motivo IS NOT DISTINCT FROM $6`,
          [c.caso_id, p.tipo, p.acao === 'classificar' ? p.detalhe : null, AUTOR, c.tipo_resolucao, c.detalhamento_motivo]);   // só se a ficha não mudou desde a leitura
        if (rowCount) await cli.query(
          `INSERT INTO email_ia.reversao_indireta_log (caso_id, dias, tipo_antes, tipo_depois, detalhe_antes, detalhe_depois, decisao) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [c.caso_id, c.dias, c.tipo_resolucao, p.tipo, c.detalhamento_motivo, p.acao === 'classificar' ? p.detalhe : c.detalhamento_motivo, d.decisao]);
        await cli.query('COMMIT');
        p.gravado = Boolean(rowCount);
      } catch (e) { await cli.query('ROLLBACK').catch(() => {}); p.erro = e.message; log(`ticket ${c.caso_id}: ${e.message}`); } finally { cli.release(); }
    }
    linhas.push({ ...c, decisao: d.decisao, motivo: d.motivo, trecho: d.trecho || '', falhou: d.falhou, ...p });
  }
  return linhas;
}

/** Chamada pelo agendador da API: só grava com `reversao_indireta_ativo = true` e no máximo uma vez por dia (depois das 6h de São Paulo). */
export async function rodadaDiaria(log = () => {}) {
  const { rows } = await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'reversao_indireta_%'`);
  const c = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  if (c.reversao_indireta_ativo !== 'true') return { rodou: false, motivo: 'desligado' };
  const { rows: [t] } = await query(`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS hoje, extract(hour FROM now() AT TIME ZONE 'America/Sao_Paulo') AS hora`);
  if (Number(t.hora) < 6 || c.reversao_indireta_ultima_rodada === t.hoje) return { rodou: false, motivo: 'já rodou hoje ou ainda cedo' };
  const linhas = await rodar({ gravar: true, modelo: c.reversao_indireta_modelo || undefined, log });
  await query(`UPDATE config_disparos SET valor = $1 WHERE chave = 'reversao_indireta_ultima_rodada'`, [t.hoje]);
  const n = (a) => linhas.filter((l) => l.acao === a && l.gravado).length;
  log(`reversão indireta: ${linhas.length} candidatos, ${n('classificar')} classificados, ${n('analisar')} para análise`);
  return { rodou: true, candidatos: linhas.length, classificados: n('classificar'), analisar: n('analisar') };
}
