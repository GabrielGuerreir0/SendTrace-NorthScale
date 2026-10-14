/**
 * SPPL — Suporte Ativo: envio em segundo plano dos e-mails em massa (migração 101). Um e-mail por cliente (UM destinatário por mensagem), pela MESMA
 * caixa e SMTP das respostas do agente (support@, `server/emailSuporte.js`). Como essa caixa também é o atendimento, o envio é ESPAÇADO e tem TETO POR
 * HORA (`config_disparos.sppl_ativo_max_por_hora`, padrão 120): excesso de envio poderia bloquear a caixa e derrubar o suporte.
 * Falha: até 3 tentativas (espera crescente); depois "falhou", com botão "Tentar de novo" na tela. O envio NUNCA muda o status do ticket.
 * Não grava cópia em Enviados (evita que o leitor de Enviados trate a mensagem como resposta de agente do Suporte Escalado).
 */
import { query } from '../../server/db.js';
import { enviarRespostaSuporte, respostaConfigurada } from '../../server/emailSuporte.js';

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
  await query(`UPDATE sppl_ativo_envios SET status = 'fila' WHERE status = 'enviando' AND proxima_tentativa_em < now() - interval '5 minutes'`);
  const { rows } = await query(
    `UPDATE sppl_ativo_envios SET status = 'enviando', tentativas = tentativas + 1, proxima_tentativa_em = now()
      WHERE id = (SELECT id FROM sppl_ativo_envios WHERE status = 'fila' AND proxima_tentativa_em <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  return rows[0] ?? null;
}

async function enviarUm(r, log) {
  try {
    const envio = await enviarRespostaSuporte({ para: r.para_email, assunto: r.assunto, texto: r.texto, copiarEnviados: false });
    await query(`UPDATE sppl_ativo_envios SET status = 'enviado', enviado_em = $2, message_id = $3, erro = NULL WHERE id = $1`, [r.id, envio.enviadoEm, envio.messageId]);
    await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'email_enviado', $2, $3)`, [r.ticket_id, JSON.stringify({ lote: r.lote, assunto: r.assunto }), r.criado_por]);
  } catch (e) {
    const definitivo = e.naoConfigurado || r.tentativas >= MAX_TENTATIVAS;
    await query(`UPDATE sppl_ativo_envios SET status = $2, erro = $3, proxima_tentativa_em = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [r.id, definitivo ? 'falhou' : 'fila', String(e.message || e).slice(0, 400), String(30 * r.tentativas)]);
    if (definitivo) await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'email_falhou', $2, $3)`, [r.ticket_id, JSON.stringify({ lote: r.lote, erro: String(e.message || e).slice(0, 200) }), r.criado_por]);
    log?.(`SPPL Suporte Ativo: envio ${r.id} ${definitivo ? 'falhou' : 'vai tentar de novo'}: ${e.message}`);
  }
}

export async function processarEnvioAtivo(log) {
  if (rodando) { acionado = true; return; }
  rodando = true;
  try {
    if (!respostaConfigurada) {
      await query(`UPDATE sppl_ativo_envios SET status = 'falhou', erro = 'Envio não configurado neste servidor.' WHERE status = 'fila'`);
      return;
    }
    const teto = await tetoPorHora();
    for (;;) {
      const { rows: [h] } = await query(`SELECT count(*)::int AS n FROM sppl_ativo_envios WHERE status = 'enviado' AND enviado_em > now() - interval '1 hour'`);
      if (h.n >= teto) { log?.(`SPPL Suporte Ativo: teto de ${teto} e-mails/hora atingido; o resto espera.`); break; }
      const r = await reservar();
      if (!r) break;
      await enviarUm(r, log);
      await dormir(ESPACO_MS);
    }
  } finally {
    rodando = false;
    if (acionado) { acionado = false; setImmediate(() => processarEnvioAtivo(log).catch(() => {})); }
  }
}

export function acionarEnvioAtivo(log) { setImmediate(() => processarEnvioAtivo(log).catch((e) => log?.(`SPPL Suporte Ativo: ${e.message}`))); }

/** Varre a fila a cada 30 s (retentativas e teto por hora). */
export function iniciarEnvioAtivo(log) {
  const t = setInterval(() => processarEnvioAtivo(log).catch((e) => log?.(`SPPL Suporte Ativo: ${e.message}`)), 30_000);
  t.unref?.();
  return t;
}
