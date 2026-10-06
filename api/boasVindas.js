/**
 * Texto padrão da boas-vindas automática (enviada pelo fluxo V2 do n8n quando um contato novo escreve; texto da Késsia, 05/10/2026).
 * ATENÇÃO: o texto de verdade mora no nó "Enviar Boas-Vindas" do n8n e o sistema NÃO guarda o que foi enviado a cada pessoa, só a hora
 * (email_ia.tickets.boas_vindas_enviada_em). A conversa do ticket mostra ESTE texto padrão; se o texto do n8n mudar, mude aqui também.
 */
export const ASSUNTO_BOAS_VINDAS = "We've Received Your Request";

/** Mesma regra do n8n: primeiro nome válido vira "Hi Nome!", senão "Hello!". */
export function saudacao(nome) {
  const n = String(nome ?? '').trim().split(/\s+/)[0];
  return /^[A-Za-zÀ-ÿ'’-]{2,30}$/.test(n) ? `Hi ${n.charAt(0).toUpperCase()}${n.slice(1).toLowerCase()}!` : 'Hello!';
}

export function textoBoasVindas(nome) {
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
