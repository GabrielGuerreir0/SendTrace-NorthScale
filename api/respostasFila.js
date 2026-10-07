/**
 * Envio em segundo plano das respostas do agente (migração 087). A rota de responder só grava em `respostas_fila` e devolve; este módulo
 * manda o e-mail pela SMTP, registra a resposta em `respostas_agente` (o gatilho do ciclo agente ↔ lead move o card) e guarda a cópia em Enviados.
 * Falha: até 3 tentativas com espera crescente (30 s, 60 s); depois fica "falhou" e a ficha do ticket mostra o aviso com "Tentar de novo".
 */
import { query } from '../server/db.js';
import { enviarRespostaSuporte, respostaConfigurada } from '../server/emailSuporte.js';
import { invalidar } from './cacheCurto.js';

const MAX_TENTATIVAS = 3;
let rodando = false;
let acionado = false;

async function reservarProxima() {
  // Reenvia o que ficou "enviando" por mais de 5 min (processo caiu no meio) e pega a próxima da fila sem disputar com outra instância.
  await query(`UPDATE email_ia.respostas_fila SET status = 'fila' WHERE status = 'enviando' AND proxima_tentativa_em < now() - interval '5 minutes'`);
  const { rows } = await query(
    `UPDATE email_ia.respostas_fila SET status = 'enviando', tentativas = tentativas + 1, proxima_tentativa_em = now()
      WHERE id = (SELECT id FROM email_ia.respostas_fila WHERE status = 'fila' AND proxima_tentativa_em <= now()
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  return rows[0] ?? null;
}

async function enviarUma(r, log) {
  try {
    // Encadeamento: o último e-mail do cliente dá o In-Reply-To e, se a tela não mandou assunto, o "Re: …".
    const { rows: [ultimo] } = await query(
      `SELECT message_id, assunto FROM email_ia.emails WHERE lower(remetente_email) = lower($1) AND plataforma_origem IS NULL ORDER BY data_email DESC LIMIT 1`,
      [r.para_email],
    );
    const base = (r.assunto || ultimo?.assunto || 'Your support request').replace(/^\s*(re|res)\s*:\s*/i, '');
    const envio = await enviarRespostaSuporte({
      para: r.para_email, assunto: `Re: ${base}`, texto: r.texto, inReplyTo: ultimo?.message_id || undefined, messageId: r.message_id,
    });
    await query(
      `INSERT INTO email_ia.respostas_agente (message_id, in_reply_to, para_email, assunto, corpo_texto, enviado_em, caso_id, board_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (message_id) DO NOTHING`,
      [r.message_id, ultimo?.message_id ?? null, r.para_email, `Re: ${base}`, r.texto, envio.enviadoEm, r.caso_id, r.board_id],
    );
    await query(`UPDATE email_ia.respostas_fila SET status = 'enviado', enviado_em = $2, erro = NULL WHERE id = $1`, [r.id, envio.enviadoEm]);
    await query(
      `UPDATE email_ia.suporte_escalado SET primeiro_toque_humano_em = coalesce(primeiro_toque_humano_em, now()), atualizado_em = now() WHERE id = $1`, [r.caso_id],
    );
    invalidar();
    if (!envio.copiadoParaEnviados) log.warn({ id: r.id }, 'resposta enviada, mas a cópia em Enviados falhou');
  } catch (err) {
    const definitivo = r.tentativas >= MAX_TENTATIVAS || err.naoConfigurado;
    await query(
      `UPDATE email_ia.respostas_fila SET status = $2, erro = $3, proxima_tentativa_em = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [r.id, definitivo ? 'falhou' : 'fila', String(err.message).slice(0, 300), String(30 * r.tentativas)],
    );
    invalidar();
    log.error({ id: r.id, tentativa: r.tentativas, err: err.message }, 'falha ao enviar resposta da fila');
  }
}

/** Processa tudo que está pronto. Seguro chamar várias vezes: só uma rodada corre por vez neste processo. */
export async function processarFila(log) {
  if (!respostaConfigurada) return;
  if (rodando) { acionado = true; return; }
  rodando = true;
  try {
    do {
      acionado = false;
      for (let r = await reservarProxima(); r; r = await reservarProxima()) await enviarUma(r, log);
    } while (acionado);
  } catch (err) {
    log.error({ err: err.message }, 'falha ao processar a fila de respostas');
  } finally {
    rodando = false;
  }
}

/** Chamado pela rota logo depois de gravar: dispara o envio sem esperar o próximo ciclo. */
export function acionarEnvio(log) {
  setImmediate(() => processarFila(log));
}

/** Liga o ciclo de segurança (reenvio das que falharam e das que sobraram de um reinício). */
export function iniciarFilaDeRespostas(log) {
  const timer = setInterval(() => processarFila(log), 5000);
  processarFila(log);
  return () => clearInterval(timer);
}
