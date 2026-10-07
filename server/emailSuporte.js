/**
 * Resposta ao cliente pelo SendTrace, com a identidade da caixa de suporte (support@) — PDF da Késsia de 07/10/2026, item 2.
 *
 * O envio é pela SMTP da Hostinger (decisão do Lucas, 07/10), com o MESMO login da caixa que o painel já lê por IMAP (a Hostinger não separa
 * credencial de envio e de leitura). A mensagem sai com `Message-ID` próprio e `In-Reply-To`/`References` do último e-mail do cliente (o e-mail cai
 * na mesma conversa na caixa do cliente) e uma cópia é gravada na pasta Enviados por IMAP (`APPEND`) — assim o webmail continua mostrando tudo e o
 * leitor de Enviados (cron de 5 em 5 min, `respostas_agente`) acha a mensagem, mas ela já é registrada aqui, na hora, para o ciclo agente ↔ lead andar.
 *
 * Variáveis (todas opcionais; sem login o painel responde 503 e o resto segue igual):
 *   SUPORTE_SMTP_USUARIO / SUPORTE_SMTP_SENHA   (padrão: IMAP_USUARIO/IMAP_SENHA, depois SMTP_USUARIO/SMTP_SENHA)
 *   SUPORTE_SMTP_HOST (smtp.hostinger.com) · SUPORTE_SMTP_PORT (465) · SUPORTE_SMTP_DE (padrão: "NorthScale Support <usuario>")
 *   SUPORTE_PASTA_ENVIADOS (INBOX.Sent) · IMAP_HOST / IMAP_PORT
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';

const env = process.env;
const USUARIO = env.SUPORTE_SMTP_USUARIO || env.IMAP_USUARIO || env.SMTP_USUARIO;
const SENHA = env.SUPORTE_SMTP_SENHA || env.IMAP_SENHA || env.SMTP_SENHA;
const HOST = env.SUPORTE_SMTP_HOST || 'smtp.hostinger.com';
const PORTA = Number(env.SUPORTE_SMTP_PORT) || 465;
const DE = env.SUPORTE_SMTP_DE || (USUARIO && USUARIO.includes('@') ? `NorthScale Support <${USUARIO}>` : null);
const PASTA_ENVIADOS = env.SUPORTE_PASTA_ENVIADOS || 'INBOX.Sent';

export const respostaConfigurada = Boolean(USUARIO && SENHA && DE);

let transporte = null;
function obterTransporte() {
  if (transporte) return transporte;
  transporte = nodemailer.createTransport({
    host: HOST, port: PORTA, secure: PORTA === 465, auth: { user: USUARIO, pass: SENHA },
    connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 30000,
  });
  return transporte;
}

/** Copia a mensagem enviada para a pasta Enviados (o SMTP não faz isso sozinho). Falha aqui não desfaz o envio. */
async function copiarParaEnviados(raw) {
  const client = new ImapFlow({
    host: env.IMAP_HOST || 'imap.hostinger.com', port: Number(env.IMAP_PORT) || 993, secure: true,
    auth: { user: USUARIO, pass: SENHA }, logger: false,
  });
  await client.connect();
  try {
    await client.append(PASTA_ENVIADOS, raw, ['\\Seen']);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Envia a resposta. Devolve `{ messageId, enviadoEm, copiadoParaEnviados }`; lança se o SMTP recusar. */
export async function enviarRespostaSuporte({ para, assunto, texto, inReplyTo, references }) {
  if (!respostaConfigurada) throw Object.assign(new Error('Envio de resposta não configurado neste servidor.'), { naoConfigurado: true });
  const dominio = (DE.match(/@([^>\s]+)/)?.[1] ?? 'localhost').replace(/>$/, '');
  const messageId = `<${randomUUID()}@${dominio}>`;
  const enviadoEm = new Date();
  const opcoes = {
    from: DE, to: para, subject: assunto, text: texto, messageId, date: enviadoEm,
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
  };
  const raw = await new MailComposer(opcoes).compile().build();
  await obterTransporte().sendMail({ envelope: { from: USUARIO, to: [para] }, raw });
  let copiado = true;
  try { await copiarParaEnviados(raw); } catch { copiado = false; }
  return { messageId, enviadoEm, copiadoParaEnviados: copiado };
}
