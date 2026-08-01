/**
 * Envio de e-mail do painel — hoje só o convite com a senha provisória.
 *
 * OPCIONAL de propósito. Sem SMTP configurado o painel continua funcionando
 * igual: a senha provisória aparece na tela para quem criou a conta repassar
 * como quiser. Envio de e-mail que quebra a criação de usuário seria um
 * péssimo negócio — a conta é o que importa, o aviso é conveniência.
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
    // 465 é TLS desde o primeiro byte; 587 abre em claro e sobe para TLS com
    // STARTTLS. Errar isso é o motivo nº 1 de "conecta mas não envia".
    secure: SMTP_SEGURO ? SMTP_SEGURO === 'true' : porta === 465,
    auth: SMTP_USUARIO ? { user: SMTP_USUARIO, pass: SMTP_SENHA } : undefined,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
  return transporte;
}

/**
 * Endereço público do painel.
 *
 * Enquanto o domínio não está decidido, sai do cabeçalho `Host` da requisição
 * que disparou o envio: o link aponta para o mesmo lugar por onde a pessoa que
 * criou a conta está acessando, que é o palpite certo em praticamente todo
 * caso. `PAINEL_URL` no .env passa por cima quando você fixar o endereço.
 *
 * O Host é dado pelo cliente, então é validado: sem isso alguém poderia mandar
 * `Host: site-falso.com` e fazer o painel enviar, com a sua marca e de dentro
 * do seu SMTP, um convite apontando para um login clonado.
 */
export function urlDoPainel(req) {
  if (PAINEL_URL) return String(PAINEL_URL).replace(/\/+$/, '');

  const host = req?.headers?.host ?? '';
  const aceitavel = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) && host.length <= 200;
  if (!aceitavel) {
    const porta = Number(process.env.PORT) || 4300;
    return `http://${process.env.HOST || '127.0.0.1'}:${porta}`;
  }

  const https = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
  return `${https ? 'https' : 'http'}://${host}`;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function corpoConvite({ base, email, senha, dias, quemConvidou, admin }) {
  const link = `${base}/login`;
  const papel = admin ? 'com permissão de administrador' : 'com acesso de leitura';

  const html = `
<div style="background:#eef0f4;padding:24px 12px">
  <div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2430">
    <div style="background:#0c0c0c;border-radius:10px 10px 0 0;padding:18px 24px;text-align:center">
      <span style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#fff">${esc(NOME).toUpperCase()}</span>
    </div>
    <div style="background:#fff;border-radius:0 0 10px 10px;padding:28px 26px">
      <p style="margin:0 0 16px">Criaram um acesso para você no painel <b>${esc(NOME)}</b>, ${esc(papel)}.</p>

      <div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 4px;font-size:12px;color:#6b7280">E-MAIL</p>
        <p style="margin:0 0 14px;font-weight:600">${esc(email)}</p>
        <p style="margin:0 0 4px;font-size:12px;color:#6b7280">SENHA PROVISÓRIA</p>
        <p style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:17px;font-weight:700;letter-spacing:.06em">${esc(senha)}</p>
      </div>

      <p style="margin:22px 0">
        <a href="${esc(link)}" style="display:inline-block;padding:13px 26px;background:#415fe5;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Entrar no painel &rarr;</a>
      </p>
      <p style="margin:0 0 18px;font-size:13px;color:#6b7280">
        Se o botão não funcionar, abra: <a href="${esc(link)}" style="color:#415fe5">${esc(link)}</a>
      </p>

      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
        <p style="margin:0;font-size:14px">
          Esta senha é <b>provisória</b> e vale por <b>${dias} dias</b>. No primeiro acesso o
          painel vai pedir uma senha sua — escolha uma que só você conheça.
        </p>
      </div>

      <p style="margin:18px 0 0;font-size:13px;color:#6b7280">
        Se você não esperava este e-mail, ignore: sem o primeiro acesso, a senha expira sozinha${quemConvidou ? `. Quem criou o acesso foi ${esc(quemConvidou)}` : ''}.
      </p>
    </div>
  </div>
</div>`.trim();

  // Alternativa em texto puro: cliente que não renderiza HTML, leitor de tela e
  // filtro de spam tratam melhor uma mensagem que tem as duas partes.
  const texto = [
    `Criaram um acesso para você no painel ${NOME}, ${papel}.`,
    '',
    `E-mail: ${email}`,
    `Senha provisória: ${senha}`,
    '',
    `Entrar: ${link}`,
    '',
    `A senha é provisória e vale por ${dias} dias. No primeiro acesso o painel`,
    'vai pedir uma senha sua.',
    '',
    quemConvidou ? `Acesso criado por ${quemConvidou}.` : '',
  ].filter((l) => l !== undefined).join('\n');

  return { html, texto, link };
}

/**
 * Manda o convite. NUNCA estoura: devolve `{ enviado, motivo }` para quem
 * chamou decidir o que dizer na tela. Falha de SMTP não pode desfazer a
 * criação de um usuário que já existe no banco.
 */
export async function enviarConvite({ para, senha, admin, quemConvidou, dias, req }) {
  if (!emailConfigurado) {
    return { enviado: false, motivo: 'SMTP não configurado no .env' };
  }

  const base = urlDoPainel(req);
  const { html, texto, link } = corpoConvite({
    base, email: para, senha, dias, quemConvidou, admin,
  });

  try {
    await obterTransporte().sendMail({
      from: SMTP_DE,
      to: para,
      subject: `Seu acesso ao painel ${NOME}`,
      text: texto,
      html,
      // Convite não é newsletter: não deve gerar resposta automática de férias
      // nem ser reenviado em cadeia por regras de encaminhamento.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
    return { enviado: true, link };
  } catch (err) {
    // A mensagem do SMTP ajuda a diagnosticar e não expõe segredo (a senha não
    // aparece nela), então volta para a tela de quem está criando o usuário.
    console.error('[email] falha ao enviar convite:', err.message);
    return { enviado: false, motivo: err.message };
  }
}

/** Testa a conexão SMTP sem mandar nada — usado no `npm run setup`. */
export async function verificarSmtp() {
  if (!emailConfigurado) return { ok: false, motivo: 'não configurado' };
  try {
    await obterTransporte().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}
