/**
 * Suporte Humano — "Novo ticket": envio em segundo plano do e-mail da equipe e CRIAÇÃO do ticket (migração 143).
 *
 * Um e-mail por cliente (UM destinatário por mensagem), pela MESMA caixa e SMTP das respostas do agente (support@, `server/emailSuporte.js`) — por isso a
 * resposta do cliente cai na caixa que o fluxo n8n lê e entra NO MESMO ticket (INSERT ... ON CONFLICT (lower(remetente_email)) DO UPDATE).
 * A mesma caixa é o atendimento: o envio é ESPAÇADO e o TETO POR HORA (`config_disparos.sppl_ativo_max_por_hora`, padrão 120) soma os envios do Suporte Ativo.
 *
 * Ordem (tudo numa transação): cria o ticket → manda o e-mail → só então grava o horário do envio e confirma. Se o e-mail falhar, o ticket some (rollback) e a
 * linha volta para a fila (até 3 tentativas; depois "falhou", com "Tentar de novo" na tela): nunca fica ticket vazio. Enquanto a transação está aberta, uma resposta
 * do cliente (n8n) espera na trava do índice único e depois atualiza este mesmo ticket.
 *
 * Sem SLA contra o agente: primeira/última resposta do agente = horário do envio e ultimo_email_cliente_em NULL; o relógio só volta quando o cliente responder.
 * NÃO grava em email_ia.respostas_agente (não infla "e-mails respondidos" nem a 1ª resposta) e NÃO copia para Enviados (o leitor de Enviados registraria como resposta).
 */
import { query, pool } from '../server/db.js';
import { enviarRespostaSuporte, respostaConfigurada } from '../server/emailSuporte.js';
import { invalidar } from './cacheCurto.js';

const MAX_TENTATIVAS = 3;
const ESPACO_MS = Number(process.env.SPPL_ATIVO_ESPACO_MS) || 1500;
let rodando = false;
let acionado = false;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function tetoPorHora() {
  const { rows } = await query(`SELECT valor FROM config_disparos WHERE chave = 'sppl_ativo_max_por_hora'`);
  const n = Number(rows[0]?.valor); return Number.isFinite(n) && n > 0 ? n : 120;
}

async function reservar() {
  await query(`UPDATE email_ia.suporte_equipe_envios SET status = 'fila' WHERE status = 'enviando' AND proxima_tentativa_em < now() - interval '5 minutes'`);
  const { rows } = await query(
    `UPDATE email_ia.suporte_equipe_envios SET status = 'enviando', tentativas = tentativas + 1, proxima_tentativa_em = now()
      WHERE id = (SELECT id FROM email_ia.suporte_equipe_envios WHERE status = 'fila' AND proxima_tentativa_em <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  return rows[0] ?? null;
}

const resumoDoTicket = (r) => [
  `Ticket iniciado pela equipe (${r.criado_por || 'equipe'}).`,
  r.motivo_contato ? `Motivo: ${r.motivo_contato}.` : null,
  r.numero_pedido ? `Pedido: ${r.numero_pedido}.` : null,
  r.modelo_nome ? `Modelo: ${r.modelo_nome}.` : null,
  `Assunto: ${r.assunto}`,
].filter(Boolean).join(' ').slice(0, 1000);

/** Marca a linha como falha definitiva sem mandar nada (ex.: já existe ticket para este e-mail). */
async function recusar(r, erro, casoId = null) {
  await query(`UPDATE email_ia.suporte_equipe_envios SET status = 'falhou', erro = $2, caso_id = coalesce($3, caso_id) WHERE id = $1`, [r.id, erro, casoId]);
}

async function enviarUm(r, log) {
  const cli = await pool.connect();
  let emTransacao = false;
  try {
    await cli.query('BEGIN'); emTransacao = true;
    await cli.query(`SELECT set_config('sendtrace.usuario', $1, true)`, [String(r.criado_por || 'Equipe').slice(0, 120)]);   // o histórico do card mostra quem abriu
    const email = String(r.para_email).trim().toLowerCase();
    const { rows: [novo] } = await cli.query(
      `INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, status, board_id, origem, iniciado_por, iniciado_pela_equipe_em,
                                               tag_motivo, iniciado_em, primeira_resposta_agente_em, ultima_resposta_agente_em, atualizado_em)
       VALUES ($1, $2, $3, 'Iniciado pela equipe (Novo ticket)', 'esperando_resposta', $4, 'equipe', $5, now(), 'outros', now(), now(), now(), now())
       ON CONFLICT (lower(remetente_email)) DO NOTHING RETURNING id`,
      [email, r.nome, resumoDoTicket(r), r.board_id, r.criado_por]);
    if (!novo) {
      await cli.query('ROLLBACK'); emTransacao = false;
      const { rows: [ex] } = await query(`SELECT id FROM email_ia.suporte_escalado WHERE lower(remetente_email) = $1`, [email]);
      await recusar(r, ex ? `Já existe o ticket #${ex.id} para este e-mail (o cliente escreveu enquanto isso). Nada foi enviado.`
        : 'O ticket não pôde ser criado (as respostas deste cliente estão isoladas no Suporte Ativo). Nada foi enviado.', ex?.id ?? null);
      return;
    }
    const envio = await enviarRespostaSuporte({ para: email, assunto: r.assunto, texto: r.texto, copiarEnviados: false });
    // o gatilho de INSERT marca ultimo_email_cliente_em = agora; o cliente ainda não escreveu: NULL (a "vez do agente" só liga quando ele responder)
    await cli.query(
      `UPDATE email_ia.suporte_escalado SET primeira_resposta_agente_em = $2, ultima_resposta_agente_em = $2, iniciado_pela_equipe_em = $2, ultimo_email_cliente_em = NULL, atualizado_em = $2 WHERE id = $1`,
      [novo.id, envio.enviadoEm]);
    await cli.query(`UPDATE email_ia.suporte_equipe_envios SET status = 'enviado', enviado_em = $2, message_id = $3, caso_id = $4, erro = NULL WHERE id = $1`, [r.id, envio.enviadoEm, envio.messageId, novo.id]);
    await cli.query('COMMIT'); emTransacao = false;
    invalidar();
  } catch (e) {
    if (emTransacao) await cli.query('ROLLBACK').catch(() => {});
    const definitivo = e.naoConfigurado || r.tentativas >= MAX_TENTATIVAS;
    await query(`UPDATE email_ia.suporte_equipe_envios SET status = $2, erro = $3, proxima_tentativa_em = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [r.id, definitivo ? 'falhou' : 'fila', String(e.message || e).slice(0, 400), String(30 * r.tentativas)]);
    log?.(`Suporte Humano, novo ticket: envio ${r.id} ${definitivo ? 'falhou' : 'vai tentar de novo'}: ${e.message}`);
  } finally {
    cli.release();
  }
}

export async function processarEnvioEquipe(log) {
  if (rodando) { acionado = true; return; }
  rodando = true;
  try {
    if (!respostaConfigurada) {
      await query(`UPDATE email_ia.suporte_equipe_envios SET status = 'falhou', erro = 'Envio não configurado neste servidor.' WHERE status = 'fila'`);
      return;
    }
    const teto = await tetoPorHora();
    for (;;) {
      const { rows: [h] } = await query(
        `SELECT (SELECT count(*) FROM email_ia.suporte_equipe_envios WHERE status = 'enviado' AND enviado_em > now() - interval '1 hour')
              + (SELECT count(*) FROM sppl_ativo_envios WHERE status = 'enviado' AND enviado_em > now() - interval '1 hour') AS n`);
      if (Number(h.n) >= teto) { log?.(`Suporte Humano, novo ticket: teto de ${teto} e-mails/hora atingido; o resto espera.`); break; }
      const r = await reservar();
      if (!r) break;
      await enviarUm(r, log);
      await dormir(ESPACO_MS);
    }
  } finally {
    rodando = false;
    if (acionado) { acionado = false; setImmediate(() => processarEnvioEquipe(log).catch(() => {})); }
  }
}

export function acionarEnvioEquipe(log) { setImmediate(() => processarEnvioEquipe(log).catch((e) => log?.(`Suporte Humano, novo ticket: ${e.message}`))); }

/** Varre a fila a cada 30 s (retentativas e teto por hora). */
export function iniciarEnvioEquipe(log) {
  const t = setInterval(() => processarEnvioEquipe(log).catch((e) => log?.(`Suporte Humano, novo ticket: ${e.message}`)), 30_000);
  t.unref?.();
  return t;
}
