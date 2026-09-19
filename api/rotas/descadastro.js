/**
 * Descadastro dos e-mails de pós-venda — rota PÚBLICA (sem token de acesso), como o pixel e o rastreio.
 *
 *   GET  /descadastro/?e=<email>&t=<assinatura>  → página de confirmação (NÃO descadastra: robôs de segurança de
 *                                                  e-mail abrem links sozinhos e descadastrariam todo mundo)
 *   POST /descadastro/?e=<email>&t=<assinatura>  → descadastra. É também o "one-click" do List-Unsubscribe-Post
 *                                                  (RFC 8058) que Gmail/Yahoo/AOL chamam sem abrir página.
 *
 * A assinatura é `descadastro_token(email)` (migração 040): sem ela ninguém descadastra o e-mail dos outros.
 * Descadastrar só para a régua: pedido, garantia e reembolso não são afetados (a página diz isso).
 * Todo texto vindo da URL sai escapado.
 */
import { query } from '../../server/db.js';

const SUPORTE = 'support@northsupplements.online';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RE_EMAIL = /^[^@\s,;]{1,120}@[^@\s,;]{1,120}\.[^@\s,;]{2,20}$/;

function pagina(titulo, corpoHtml) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>' + esc(titulo) + '</title>'
    + '<style>body{margin:0;background:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2430;line-height:1.6}'
    + '.c{max-width:480px;margin:48px auto;padding:0 16px}.k{background:#fff;border-radius:10px;padding:32px 28px}'
    + 'h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px;font-size:15px}.s{font-size:13px;color:#6b7280}'
    + 'button{padding:12px 22px;background:#415fe5;color:#fff;border:0;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer}</style></head>'
    + '<body><div class="c"><div class="k">' + corpoHtml + '</div></div></body></html>';
}

const AVISO = 'This only stops our follow-up emails. It does <b>not</b> cancel your order and does not affect your money-back guarantee.';
const AJUDA = 'Need help with your order? Write to <a href="mailto:' + SUPORTE + '">' + SUPORTE + '</a>.';

export default async function rotasDescadastro(app) {
  // o "one-click" chega como application/x-www-form-urlencoded ("List-Unsubscribe=One-Click"); o conteúdo não importa
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, corpo, feito) => feito(null, corpo));

  const entrada = async (req) => {
    const email = String(req.query?.e ?? '').trim().toLowerCase();
    const token = String(req.query?.t ?? '').trim();
    if (!RE_EMAIL.test(email) || !/^[0-9a-f]{32}$/.test(token)) return null;
    const { rows } = await query('SELECT public.descadastro_token($1) = $2 AS ok', [email, token]);
    return rows[0]?.ok ? { email, token } : null;
  };

  const enviarHtml = (resposta, status, html) => resposta
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
    .send(html);

  const invalido = (resposta) => enviarHtml(resposta, 400, pagina('Link not valid',
    '<h1>This link is not valid</h1><p>It may be incomplete. Open the unsubscribe link from your email again.</p><p class="s">' + AJUDA + '</p>'));

  app.get('/descadastro/', {
    schema: { tags: ['Saúde'], summary: 'Página de confirmação do descadastro (pública, assinada)', hide: true },
  }, async (req, resposta) => {
    const ok = await entrada(req).catch(() => null);
    if (!ok) return invalido(resposta);
    const acao = '/descadastrar?e=' + encodeURIComponent(ok.email) + '&t=' + ok.token;
    return enviarHtml(resposta, 200, pagina('Unsubscribe',
      '<h1>Stop our follow-up emails?</h1><p>We will stop sending follow-up emails to <b>' + esc(ok.email) + '</b>.</p><p class="s">' + AVISO + '</p>'
      + '<form method="post" action="' + esc(acao) + '"><button type="submit">Yes, unsubscribe me</button></form>'
      + '<p class="s" style="margin-top:18px">' + AJUDA + '</p>'));
  });

  app.post('/descadastro/', {
    schema: { tags: ['Saúde'], summary: 'Descadastra os e-mails da régua (pública, assinada; também é o one-click do List-Unsubscribe-Post)', hide: true },
  }, async (req, resposta) => {
    const ok = await entrada(req).catch(() => null);
    if (!ok) return invalido(resposta);
    const xff = req.headers['x-forwarded-for'];
    const ip = (xff ? String(xff).split(',')[0].trim() : req.socket?.remoteAddress) || null;
    // o botão do próprio Gmail/Yahoo manda esse corpo; a página nossa manda formulário vazio
    const origem = /List-Unsubscribe=One-Click/i.test(String(req.body ?? '')) ? 'one-click' : 'link';
    await query('SELECT public.descadastrar($1, $2, $3)', [ok.email, origem, ip]);
    return enviarHtml(resposta, 200, pagina('Unsubscribed',
      '<h1>You are unsubscribed</h1><p>You will no longer receive our follow-up emails at <b>' + esc(ok.email) + '</b>.</p><p class="s">' + AVISO + '</p>'
      + '<p class="s">' + AJUDA + '</p>'));
  });
}
