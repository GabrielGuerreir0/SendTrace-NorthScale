/**
 * Envio de e-mail da API — hoje só o digest de alertas (11/09/2026).
 *
 * Mesmo contrato do `server/email.js` (SMTP opcional, nunca estoura): a API
 * roda no MESMO `.env` do painel em produção (`env_file: .env` no compose),
 * então as variáveis `SMTP_*` já chegam aqui sem configuração extra.
 */
import nodemailer from 'nodemailer';

const {
  SMTP_HOST, SMTP_PORT, SMTP_USUARIO, SMTP_SENHA, SMTP_DE, SMTP_SEGURO,
  NOME_PAINEL, PAINEL_URL,
} = process.env;

export const emailConfigurado = Boolean(SMTP_HOST && SMTP_DE);

const NOME = NOME_PAINEL || 'SendTrace';

let transporte = null;
function obterTransporte() {
  if (!emailConfigurado) return null;
  if (transporte) return transporte;

  const porta = Number(SMTP_PORT) || 587;
  transporte = nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: SMTP_SEGURO ? SMTP_SEGURO === 'true' : porta === 465,
    auth: SMTP_USUARIO ? { user: SMTP_USUARIO, pass: SMTP_SENHA } : undefined,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
  return transporte;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Rótulo e cor por tipo de alerta — mesmo espírito de LABEL_* usados no painel. */
export const ALERTA_INFO = {
  foto_defeito: { titulo: 'Fotos com defeito visível', cor: '#fab219' },
  email_urgente: { titulo: 'E-mails urgentes sem resposta', cor: '#d03b3b' },
  caso_escalado: { titulo: 'Novos casos escalados', cor: '#415fe5' },
  chargeback: { titulo: 'Chargebacks consumados', cor: '#d03b3b' },
  reembolso: { titulo: 'Reembolsos consumados', cor: '#1baf7a' },
};

function secaoHtml(tipo, itens) {
  const info = ALERTA_INFO[tipo];
  const linhas = itens.map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px">
        ${esc(it.titulo)}
        ${it.subtitulo ? `<br><span style="color:#6b7280;font-size:12px">${esc(it.subtitulo)}</span>` : ''}
      </td>
    </tr>`).join('');

  return `
    <div style="margin:0 0 22px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${info.cor}">
        ${esc(info.titulo)} (${itens.length})
      </p>
      <table style="width:100%;border-collapse:collapse">${linhas}</table>
    </div>`;
}

function corpoAlertas({ base, porTipo }) {
  const secoes = Object.entries(porTipo)
    .filter(([, itens]) => itens.length > 0)
    .map(([tipo, itens]) => secaoHtml(tipo, itens))
    .join('');

  const total = Object.values(porTipo).reduce((a, itens) => a + itens.length, 0);

  const html = `
<div style="background:#eef0f4;padding:24px 12px">
  <div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2430">
    <div style="background:#0c0c0c;border-radius:10px 10px 0 0;padding:18px 24px;text-align:center">
      <span style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#fff">${esc(NOME).toUpperCase()}</span>
    </div>
    <div style="background:#fff;border-radius:0 0 10px 10px;padding:28px 26px">
      <p style="margin:0 0 20px">${total} alerta${total === 1 ? '' : 's'} desde a última checagem:</p>
      ${secoes}
      <p style="margin:22px 0 0">
        <a href="${esc(base)}" style="display:inline-block;padding:13px 26px;background:#415fe5;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Abrir o painel &rarr;</a>
      </p>
      <p style="margin:18px 0 0;font-size:13px;color:#6b7280">
        Você recebeu isto porque ativou este tipo de alerta em Meu Perfil. Pode desativar a qualquer momento por lá.
      </p>
    </div>
  </div>
</div>`.trim();

  const texto = [
    `${total} alerta${total === 1 ? '' : 's'} desde a última checagem:`,
    '',
    ...Object.entries(porTipo).filter(([, itens]) => itens.length > 0).flatMap(([tipo, itens]) => [
      `${ALERTA_INFO[tipo].titulo} (${itens.length}):`,
      ...itens.map((it) => `  - ${it.titulo}${it.subtitulo ? ` (${it.subtitulo})` : ''}`),
      '',
    ]),
    `Abrir o painel: ${base}`,
  ].join('\n');

  return { html, texto };
}

/**
 * Manda o digest de alertas. NUNCA estoura: devolve `{ enviado, motivo }`.
 * `porTipo` é `{ [tipo]: [{ titulo, subtitulo }] }`, só com os tipos que
 * este destinatário optou por receber e que têm item novo.
 */
export async function enviarAlertas({ para, porTipo }) {
  if (!emailConfigurado) return { enviado: false, motivo: 'SMTP não configurado no .env' };

  const total = Object.values(porTipo).reduce((a, itens) => a + itens.length, 0);
  if (total === 0) return { enviado: false, motivo: 'nada para notificar' };

  const base = (PAINEL_URL || '').replace(/\/+$/, '') || 'o painel';
  const { html, texto } = corpoAlertas({ base, porTipo });

  try {
    await obterTransporte().sendMail({
      from: SMTP_DE,
      to: para,
      subject: `${NOME} — ${total} alerta${total === 1 ? '' : 's'} novo${total === 1 ? '' : 's'}`,
      text: texto,
      html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
    return { enviado: true };
  } catch (err) {
    console.error('[api/email] falha ao enviar alertas:', err.message);
    return { enviado: false, motivo: err.message };
  }
}
