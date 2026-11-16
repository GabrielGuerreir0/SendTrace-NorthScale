/**
 * Pesquisa de motivo de estorno (migração 129; pedido do Lucas, 15/11/2026; ClickUp 1dfjmjuc53z).
 *
 * PÚBLICA (sem login), como o descadastro: o painel repassa `/pesquisa` para cá.
 *   GET  /pesquisa/?t=<token>[&r=<valor>]  → a próxima pergunta do convite. `r` só PRÉ-MARCA a opção (o botão do e-mail):
 *                                            não grava nada, porque robôs de segurança de e-mail abrem todos os links.
 *   POST /pesquisa/?t=<token>              → grava a resposta da pergunta atual (q, v ou pular) e volta para o GET (303).
 * Página HTML sem JavaScript, uma pergunta por vez, com a ordem e as condições de api/pesquisaEstorno.js.
 *
 * PAINEL (sessão; página 'pesquisa'). Escrever exige administrador (muda o que o cliente vê):
 *   GET  /api/pesquisa-estorno/perguntas/                 → perguntas atuais (inclusive desativadas) + nº de versões e respostas
 *   GET  /api/pesquisa-estorno/perguntas/:chave/versoes/  → histórico de versões de uma pergunta
 *   POST /api/pesquisa-estorno/perguntas/                 → grava uma VERSÃO NOVA (pergunta nova ou edição); nada é sobrescrito
 * Todo texto vindo de fora sai escapado.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { proximaPergunta, progresso, validarResposta, validarPergunta } from '../pesquisaEstorno.js';

const SUPORTE = 'support@northsupplements.online';
const RE_TOKEN = /^[0-9a-f]{32}$/;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = 'body{margin:0;background:#f3f4f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2430;line-height:1.55}'
  + '.c{max-width:540px;margin:32px auto;padding:0 16px}.k{background:#fff;border-radius:12px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}'
  + '.marca{font-size:13px;color:#6b7280;margin:0 0 14px;letter-spacing:.02em}.barra{height:6px;background:#e7e9ef;border-radius:3px;margin:0 0 22px;overflow:hidden}'
  + '.barra i{display:block;height:100%;background:#415fe5}h1{font-size:20px;line-height:1.35;margin:0 0 18px}'
  + '.op{display:block;border:1.5px solid #dfe2ea;border-radius:10px;padding:13px 14px;margin:0 0 10px;cursor:pointer;font-size:15px}'
  + '.op input{margin:0 10px 0 0;transform:scale(1.15);vertical-align:-1px}.op:has(input:checked){border-color:#415fe5;background:#f1f4ff}'
  + '.notas{display:grid;grid-template-columns:repeat(11,minmax(0,1fr));gap:4px;margin:0 0 6px}.notas .op{text-align:center;padding:9px 0;margin:0;font-size:14px}.notas .op input{display:block;margin:0 auto 4px}'
  + '.esc{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin:0 0 16px}'
  + 'textarea{width:100%;box-sizing:border-box;min-height:110px;border:1.5px solid #dfe2ea;border-radius:10px;padding:12px;font:inherit;font-size:15px}'
  + '.acoes{display:flex;gap:10px;align-items:center;margin-top:18px}button{padding:12px 22px;border:0;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer}'
  + '.ir{background:#415fe5;color:#fff}.pular{background:none;color:#6b7280;font-weight:600}.erro{color:#b42318;font-size:14px;margin:0 0 12px}'
  + 'p{margin:0 0 14px;font-size:15px}.s{font-size:13px;color:#6b7280}a{color:#415fe5}';

function pagina(titulo, corpo) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>' + esc(titulo) + '</title><style>' + CSS + '</style></head>'
    + '<body><div class="c"><div class="k">' + corpo + '</div></div></body></html>';
}

const enviarHtml = (resposta, status, html) => resposta.code(status)
  .header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex')
  .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
  .send(html);

const AJUDA = 'Need help with your order? Write to <a href="mailto:' + SUPORTE + '">' + SUPORTE + '</a>.';
const invalido = (resposta) => enviarHtml(resposta, 404, pagina('Link not valid',
  '<h1>This link is not valid</h1><p>It may be incomplete. Please open the link from your email again.</p><p class="s">' + AJUDA + '</p>'));

async function perguntasAtuais() {
  const { rows } = await query('SELECT * FROM pesquisa_estorno_perguntas_atuais');
  return rows;
}

async function carregar(token) {
  if (!RE_TOKEN.test(token)) return null;
  const { rows } = await query('SELECT * FROM pesquisa_estorno_convites WHERE token = $1', [token]);
  if (!rows[0]) return null;
  const r = await query('SELECT pergunta_chave, valor FROM pesquisa_estorno_respostas WHERE convite_id = $1', [rows[0].id]);
  return { convite: rows[0], respostas: Object.fromEntries(r.rows.map((x) => [x.pergunta_chave, x.valor])) };
}

function telaPergunta(c, p, prog, { marcado = '', erro = '' } = {}) {
  const titulo = c.grupo === 'banco' && p.texto_banco ? p.texto_banco : p.texto;
  const acao = '/pesquisa?t=' + encodeURIComponent(c.token);
  let campo = '';
  if (p.tipo === 'unica') {
    campo = p.opcoes.map((o) => '<label class="op"><input type="radio" name="v" value="' + esc(o.valor) + '"'
      + (o.valor === marcado ? ' checked' : '') + (p.obrigatoria ? ' required' : '') + '>' + esc(o.rotulo) + '</label>').join('');
  } else if (p.tipo === 'nota') {
    campo = '<div class="notas">' + Array.from({ length: 11 }, (_, i) => '<label class="op"><input type="radio" name="v" value="' + i + '"'
      + (String(i) === marcado ? ' checked' : '') + '>' + i + '</label>').join('') + '</div><div class="esc"><span>Not likely</span><span>Very likely</span></div>';
  } else {
    campo = '<textarea name="v" maxlength="1000" placeholder="Type here (optional)"></textarea>';
  }
  const pct = prog.total ? Math.round((prog.feitas / prog.total) * 100) : 0;
  return pagina(c.produto ? `${c.produto} · Quick question` : 'Quick question',
    '<p class="marca">' + esc(c.produto || 'Your order') + ' · question ' + (prog.feitas + 1) + ' of ' + prog.total + '</p>'
    + '<div class="barra"><i style="width:' + pct + '%"></i></div>'
    + (erro ? '<p class="erro">' + esc(erro) + '</p>' : '')
    + '<form method="post" action="' + esc(acao) + '"><h1>' + esc(titulo) + '</h1>'
    + '<input type="hidden" name="q" value="' + esc(p.chave) + '">' + campo
    + '<div class="acoes"><button class="ir" type="submit">Continue</button>'
    + (p.obrigatoria ? '' : '<button class="pular" type="submit" name="pular" value="1" formnovalidate>Skip</button>') + '</div></form>');
}

function telaFim(c, respostas) {
  let corpo = '<h1>Thank you!</h1><p>Your answers go straight to our team and help us improve.</p>';
  if (respostas.reconhece === 'nao') {
    corpo = '<h1>Thank you for letting us know</h1><p>Our team will review this order. If you have any questions, write to <a href="mailto:'
      + SUPORTE + '">' + SUPORTE + '</a>.</p>';
  } else if (respostas.motivo === 'nao_chegou' || respostas.motivo === 'cobranca') {
    corpo += '<p>If you still need help with your order, write to <a href="mailto:' + SUPORTE + '">' + SUPORTE + '</a> and we will get back to you.</p>';
  }
  return pagina('Thank you', corpo + '<p class="s">You can close this page.</p>');
}

export default async function rotasPesquisaEstorno(app) {
  /* ── pública ── */
  app.get('/pesquisa/', { schema: { hide: true } }, async (req, resposta) => {
    const dados = await carregar(String(req.query?.t ?? '')).catch(() => null);
    if (!dados) return invalido(resposta);
    const { convite: c, respostas } = dados;
    await query('UPDATE pesquisa_estorno_convites SET clicou_em = COALESCE(clicou_em, now()) WHERE id = $1', [c.id]);
    const perguntas = await perguntasAtuais();
    const p = proximaPergunta(perguntas, c.grupo, respostas);
    if (!p) return enviarHtml(resposta, 200, telaFim(c, respostas));
    const marcado = String(req.query?.r ?? '');
    return enviarHtml(resposta, 200, telaPergunta(c, p, progresso(perguntas, c.grupo, respostas), {
      marcado: p.tipo !== 'texto' && /^[a-z0-9_]{1,40}$/.test(marcado) ? marcado : '' }));
  });

  app.post('/pesquisa/', { schema: { hide: true } }, async (req, resposta) => {
    const token = String(req.query?.t ?? '');
    const dados = await carregar(token).catch(() => null);
    if (!dados) return invalido(resposta);
    const { convite: c, respostas } = dados;
    const corpo = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
    const perguntas = await perguntasAtuais();
    const p = proximaPergunta(perguntas, c.grupo, respostas);
    const volta = () => resposta.code(303).header('Location', '/pesquisa?t=' + token).header('Cache-Control', 'no-store').send('');
    // terminou, ou a pergunta enviada não é a da vez (página antiga, voltar do navegador): só mostra onde está
    if (!p || corpo.get('q') !== p.chave) return volta();
    const r = corpo.get('pular') === '1' && !p.obrigatoria ? { ok: true, valor: null } : validarResposta(p, corpo.get('v'));
    if (!r.ok) return enviarHtml(resposta, 422, telaPergunta(c, p, progresso(perguntas, c.grupo, respostas), { erro: r.erro }));
    await query(`INSERT INTO pesquisa_estorno_respostas (convite_id, pergunta_chave, pergunta_versao, valor) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (convite_id, pergunta_chave) DO NOTHING`, [c.id, p.chave, p.versao, r.valor]);
    const novas = { ...respostas, [p.chave]: r.valor };
    const terminou = !proximaPergunta(perguntas, c.grupo, novas);
    await query(`UPDATE pesquisa_estorno_convites SET iniciado_em = COALESCE(iniciado_em, now()), clicou_em = COALESCE(clicou_em, now()),
                   concluido_em = CASE WHEN $2 THEN COALESCE(concluido_em, now()) ELSE concluido_em END,
                   suspeita_fraude = suspeita_fraude OR $3
                 WHERE id = $1`, [c.id, terminou, p.chave === 'reconhece' && r.valor === 'nao']);
    return volta();
  });

  // o formulário da página chega como application/x-www-form-urlencoded; lê como texto (no máximo 8 KB)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, corpo, feito) => feito(null, corpo));

  /* ── painel ── */
  app.get('/api/pesquisa-estorno/perguntas/', { onRequest: [app.exigirSessao], schema: { tags: ['Pesquisa de estorno'], summary: 'Perguntas atuais' } }, async () => {
    const { rows } = await query(`
      SELECT a.*, (SELECT count(*) FROM pesquisa_estorno_perguntas v WHERE v.chave = a.chave)::int AS versoes,
             (SELECT count(*) FROM pesquisa_estorno_respostas r WHERE r.pergunta_chave = a.chave)::int AS respostas
      FROM pesquisa_estorno_perguntas_atuais a ORDER BY a.ordem, a.chave`);
    return { perguntas: rows };
  });

  app.get('/api/pesquisa-estorno/perguntas/:chave/versoes/', { onRequest: [app.exigirSessao], schema: { tags: ['Pesquisa de estorno'], summary: 'Versões de uma pergunta' } }, async (req) => {
    const { rows } = await query(`
      SELECT p.*, (SELECT count(*) FROM pesquisa_estorno_respostas r WHERE r.pergunta_chave = p.chave AND r.pergunta_versao = p.versao)::int AS respostas
      FROM pesquisa_estorno_perguntas p WHERE p.chave = $1 ORDER BY p.versao DESC`, [String(req.params.chave)]);
    return { versoes: rows };
  });

  app.post('/api/pesquisa-estorno/perguntas/', { onRequest: [app.exigirAdmin], schema: { tags: ['Pesquisa de estorno'], summary: 'Grava uma versão nova de uma pergunta' } }, async (req) => {
    if (req.usuario?.leitura) throw new ErroHttp(403, 'Esta chave é somente de leitura.');
    const atuais = await perguntasAtuais();
    const v = validarPergunta(req.body ?? {}, atuais.filter((p) => p.ativa));
    if (!v.ok) throw new ErroHttp(422, v.erros.join(' '));
    const q = v.pergunta;
    const { rows } = await query(`
      INSERT INTO pesquisa_estorno_perguntas (chave, versao, grupo, ordem, tipo, texto, texto_banco, opcoes, mostrar_se, obrigatoria, ativa, criado_por)
      SELECT $1, COALESCE(MAX(versao), 0) + 1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11 FROM pesquisa_estorno_perguntas WHERE chave = $1
      RETURNING *`,
    [q.chave, q.grupo, q.ordem, q.tipo, q.texto, q.texto_banco, JSON.stringify(q.opcoes), q.mostrar_se ? JSON.stringify(q.mostrar_se) : null,
      q.obrigatoria, q.ativa, req.usuario?.email ?? null]);
    return { pergunta: rows[0] };
  });

  /* ── acompanhamento (migração 130): funil, motivos e a chave liga/desliga ── */
  const CHAVES_CFG = ['pesquisa_estorno_ativo', 'pesquisa_estorno_pct', 'pesquisa_estorno_lembrete_ativo', 'pesquisa_estorno_desde', 'pesquisa_estorno_max_rodada'];
  const lerCfg = async () => Object.fromEntries((await query('SELECT chave, valor FROM config_disparos WHERE chave = ANY($1)', [CHAVES_CFG])).rows.map((r) => [r.chave, r.valor]));

  app.get('/api/pesquisa-estorno/resumo/', { onRequest: [app.exigirSessao], schema: { tags: ['Pesquisa de estorno'], summary: 'Funil, descartes, motivos e comentários' } }, async (req) => {
    const dias = Math.min(Math.max(Number(req.query?.dias) || 30, 1), 365);
    const desde = `now() - interval '${dias} days'`;
    const [funil, descartes, respostas, comentarios, porDia, cfg] = await Promise.all([
      query(`SELECT grupo, estorno_tipo, count(*)::int AS criados, count(*) FILTER (WHERE amostra)::int AS amostra,
                    count(*) FILTER (WHERE descartado IS NOT NULL AND descartado <> 'fora_da_amostra')::int AS descartados,
                    count(email_enviado_em)::int AS enviados, count(aberto_em)::int AS abertos, count(clicou_em)::int AS clicaram,
                    count(iniciado_em)::int AS iniciaram, count(concluido_em)::int AS concluiram, count(lembrete_enviado_em)::int AS lembretes,
                    count(*) FILTER (WHERE suspeita_fraude)::int AS suspeita, count(bounce_em)::int AS bounce, count(spam_em)::int AS spam,
                    count(*) FILTER (WHERE email_enviado_em IS NULL AND descartado IS NULL)::int AS na_fila
               FROM pesquisa_estorno_convites WHERE criado_em >= ${desde} GROUP BY 1, 2 ORDER BY 1, 2`),
      query(`SELECT descartado AS motivo, count(*)::int AS n FROM pesquisa_estorno_convites WHERE criado_em >= ${desde} AND descartado IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
      query(`SELECT r.pergunta_chave, c.grupo, coalesce(r.valor, '(pulou)') AS valor, count(*)::int AS n
               FROM pesquisa_estorno_respostas r JOIN pesquisa_estorno_convites c ON c.id = r.convite_id
              JOIN pesquisa_estorno_perguntas p ON p.chave = r.pergunta_chave AND p.versao = r.pergunta_versao
              WHERE c.criado_em >= ${desde} AND p.tipo <> 'texto' GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`),
      query(`SELECT r.respondido_em, c.grupo, c.estorno_tipo, c.plataforma, c.produto, r.valor
               FROM pesquisa_estorno_respostas r JOIN pesquisa_estorno_convites c ON c.id = r.convite_id
              WHERE c.criado_em >= ${desde} AND r.pergunta_chave = 'comentario' AND r.valor IS NOT NULL ORDER BY r.respondido_em DESC LIMIT 50`),
      query(`SELECT (email_enviado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia, count(*)::int AS enviados, count(clicou_em)::int AS clicaram,
                    count(concluido_em)::int AS concluiram
               FROM pesquisa_estorno_convites WHERE email_enviado_em >= ${desde} GROUP BY 1 ORDER BY 1`),
      lerCfg(),
    ]);
    return { dias, config: cfg, funil: funil.rows, descartes: descartes.rows, respostas: respostas.rows, comentarios: comentarios.rows, por_dia: porDia.rows };
  });

  app.post('/api/pesquisa-estorno/config/', { onRequest: [app.exigirAdmin], schema: { tags: ['Pesquisa de estorno'], summary: 'Liga/desliga o envio, % do piloto e lembrete' } }, async (req) => {
    if (req.usuario?.leitura) throw new ErroHttp(403, 'Esta chave é somente de leitura.');
    const b = req.body ?? {};
    const novos = {};
    if (b.ativo !== undefined) novos.pesquisa_estorno_ativo = b.ativo === true || b.ativo === 'true' ? 'true' : 'false';
    if (b.lembrete !== undefined) novos.pesquisa_estorno_lembrete_ativo = b.lembrete === true || b.lembrete === 'true' ? 'true' : 'false';
    if (b.pct !== undefined) {
      const n = Number(b.pct);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new ErroHttp(422, 'O percentual do piloto vai de 0 a 100.');
      novos.pesquisa_estorno_pct = String(n);
    }
    for (const [chave, valor] of Object.entries(novos)) {
      await query('INSERT INTO config_disparos (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', [chave, valor]);
    }
    req.log.info({ por: req.usuario?.email, novos }, 'pesquisa de estorno: configuração alterada');
    return { config: await lerCfg() };
  });
}
