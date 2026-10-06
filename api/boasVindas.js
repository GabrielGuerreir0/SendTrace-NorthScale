/**
 * Texto padrão da boas-vindas automática (enviada pelo fluxo V2 do n8n quando um contato novo escreve; texto da Késsia, 05/10/2026).
 * ATENÇÃO: o texto de verdade mora no nó "Enviar Boas-Vindas" do n8n e o sistema NÃO guarda o que foi enviado a cada pessoa, só a hora
 * (email_ia.tickets.boas_vindas_enviada_em). A conversa do ticket mostra o texto que estava VIGENTE na hora do envio, conforme as versões abaixo
 * (horários dos backups do n8n em 05/10/2026, BRT). Quando o texto do n8n mudar, acrescente aqui uma versão nova com a data da troca.
 * Limite: versões anteriores à primeira conhecida (antes de 05/10 07:52) caem na versão 1 — se houve outra ainda mais antiga, não dá para saber.
 */
export const ASSUNTO_BOAS_VINDAS = "We've Received Your Request";

/** Mesma regra do n8n: primeiro nome válido vira "Hi Nome!", senão "Hello!". */
export function saudacao(nome) {
  const n = String(nome ?? '').trim().split(/\s+/)[0];
  return /^[A-Za-zÀ-ÿ'’-]{2,30}$/.test(n) ? `Hi ${n.charAt(0).toUpperCase()}${n.slice(1).toLowerCase()}!` : 'Hello!';
}

const CORPO_ANTIGO = `We hope you're doing well.
We've received your request and want to assure you it will be handled with the attention it deserves.
Within the next 4 hours, we will begin processing your case and will reach out with next steps.
We kindly ask that you allow this time, we'll be in touch again shortly.
Thank you for your patience.
Best regards,
Support Team`;

const D = (hms) => new Date(`2026-10-05T${hms}-03:00`).getTime();
const TROCA_NOME = D('07:52:52');     // v1 -> v2: passa a cumprimentar pelo nome ("Hi Maria,")
const TROCA_KESSIA = D('09:46:00');   // v2 -> v3: primeiro texto da Késsia
const TROCA_REVISADA = D('12:26:32'); // v3 -> v4: texto revisado (atual)

/** Texto da boas-vindas vigente na data do envio (`enviadaEm`); sem data, o atual. */
export function textoBoasVindas(nome, enviadaEm = null) {
  const quando = enviadaEm ? new Date(enviadaEm).getTime() : Infinity;
  const n = String(nome ?? '').trim().split(/\s+/)[0];
  const nomeOk = /^[A-Za-zÀ-ÿ'’-]{2,30}$/.test(n);
  const bonito = nomeOk ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : null;
  if (quando < TROCA_NOME) return CORPO_ANTIGO;
  if (quando < TROCA_KESSIA) return `${bonito ? `Hi ${bonito},` : 'Hello,'}\n${CORPO_ANTIGO}`;
  if (quando < TROCA_REVISADA) {
    return `${saudacao(nome)} We've received your message and your support request has been registered.

Within 4 hours, one of our specialized support agents will reach out to understand your request and help you in the best way possible.

To help us assist you faster, please provide:
• The product you purchased
• The email address used for the purchase or your order number

And please feel free to tell us what happened. We’re here to listen, help, and find the best solution for you 🤝`;
  }
  return `${saudacao(nome)} We've received your message, and your support request has been logged.

Within 4 hours, one of our support specialists will reach out to understand your request and help you in the best way possible.

To help us assist you faster, please reply to this email with:
• The product you purchased.
• The email address used for the purchase or your order number.
• The reason for your contact, with as much detail as possible. For example: what happened, when it happened, and whether you've already received your order.

If you have screenshots, photos, or any other information that could help us understand the situation, feel free to include them as well.

The more details you share, the faster we can help. We're here to listen, help, and find the best solution for you.

Best regards,
Support Team`;
}
