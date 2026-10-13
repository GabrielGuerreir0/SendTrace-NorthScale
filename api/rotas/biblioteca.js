/**
 * Biblioteca de materiais (pedido do Lucas, 13/10/2026; migração 098): bônus, áreas VIP, e-books e guias com nicho e produto.
 *
 *   GET    /api/biblioteca              → { materiais[], pode_editar }   (sem o conteúdo dos arquivos)
 *   GET    /api/biblioteca/:id/arquivo  → o arquivo (PDF…) guardado no sistema; ?baixar=1 força o download
 *   POST   /api/biblioteca              → cria um material (só administrador); o arquivo vai em base64
 *   PUT    /api/biblioteca/:id          → altera (só administrador)
 *   DELETE /api/biblioteca/:id          → apaga (só administrador)
 *
 * A página é aberta a todo usuário logado (não depende de acesso por página); ler e baixar vale para todos, escrever só para o administrador.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

export const TIPOS = ['Bônus', 'E-book', 'Guia de uso', 'Área VIP', 'Rótulo / COA', 'Outro'];
const TIPOS_ARQUIVO = new Set(['application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const MAX_ARQUIVO = 40 * 1024 * 1024;
const CAMPOS_LISTA = `id, produto_slug, produto, nicho, tipo, titulo, descricao, url, arquivo_nome, arquivo_mime, arquivo_tamanho, onde_aparece, origem, atualizado_em, atualizado_por,
  (conteudo IS NOT NULL) AS tem_arquivo`;

export default async function rotasBiblioteca(app) {
  const soAdmin = (req) => { if (!req.usuario.admin) throw new ErroHttp(403, 'Só administradores alteram a biblioteca.'); };
  const quem = (req) => req.usuario.nome || req.usuario.email || null;
  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
  const corpoMaterial = (obrigatorios) => ({
    type: 'object', required: obrigatorios, additionalProperties: false,
    properties: {
      produto: { type: 'string', minLength: 1, maxLength: 120 }, produto_slug: { type: ['string', 'null'], maxLength: 80 },
      nicho: { type: 'string', minLength: 1, maxLength: 80 }, tipo: { type: 'string', enum: TIPOS },
      titulo: { type: 'string', minLength: 1, maxLength: 200 }, descricao: { type: ['string', 'null'], maxLength: 1000 },
      url: { type: ['string', 'null'], maxLength: 2000 },
      arquivo_nome: { type: 'string', maxLength: 200 }, arquivo_mime: { type: 'string', maxLength: 100 }, arquivo_base64: { type: 'string' },
      remover_arquivo: { type: 'boolean' },
    },
  });
  const urlOk = (u) => { if (u == null || u === '') return null; if (!/^https?:\/\/[^\s]+$/i.test(u.trim())) throw new ErroHttp(400, 'O link precisa começar com http:// ou https://.'); return u.trim(); };
  const lerArquivo = (b) => {
    if (!b.arquivo_base64) return null;
    const mime = String(b.arquivo_mime ?? '').toLowerCase();
    if (!TIPOS_ARQUIVO.has(mime)) throw new ErroHttp(400, 'Arquivo: só PDF, imagem (PNG/JPG), ZIP ou DOCX.');
    const conteudo = Buffer.from(b.arquivo_base64, 'base64');
    if (!conteudo.length) throw new ErroHttp(400, 'Arquivo vazio.');
    if (conteudo.length > MAX_ARQUIVO) throw new ErroHttp(413, 'O arquivo passa de 40 MB.');
    const nome = String(b.arquivo_nome || 'arquivo').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150) || 'arquivo';
    return { conteudo, mime, nome };
  };

  app.get('/api/biblioteca', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Biblioteca'], summary: 'Lista os materiais (sem o conteúdo dos arquivos)', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const { rows } = await query(`SELECT ${CAMPOS_LISTA} FROM public.biblioteca_materiais WHERE ativo ORDER BY nicho, produto, tipo, titulo`);
    return { materiais: rows, pode_editar: !!req.usuario.admin };
  });

  app.get('/api/biblioteca/:id/arquivo', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Biblioteca'], summary: 'Baixa o arquivo guardado no sistema', security: [{ bearerAuth: [] }], params: idParams, querystring: { type: 'object', properties: { baixar: { type: 'string' } } } },
  }, async (req, resposta) => {
    const { rows: [m] } = await query('SELECT arquivo_nome, arquivo_mime, conteudo FROM public.biblioteca_materiais WHERE id = $1 AND ativo AND conteudo IS NOT NULL', [req.params.id]);
    if (!m) throw new ErroHttp(404, 'Arquivo não encontrado.');
    resposta.header('Content-Type', m.arquivo_mime || 'application/octet-stream');
    resposta.header('Content-Disposition', `${req.query.baixar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.arquivo_nome || 'arquivo')}`);
    resposta.header('X-Content-Type-Options', 'nosniff');
    return resposta.send(m.conteudo);
  });

  app.post('/api/biblioteca', {
    onRequest: [app.exigirSessao],
    bodyLimit: 60 * 1024 * 1024,
    schema: { tags: ['Biblioteca'], summary: 'Cria um material (só administrador)', security: [{ bearerAuth: [] }], body: corpoMaterial(['produto', 'nicho', 'tipo', 'titulo']) },
  }, async (req, resposta) => {
    soAdmin(req);
    const b = req.body;
    const url = urlOk(b.url);
    const arq = lerArquivo(b);
    if (!url && !arq) throw new ErroHttp(400, 'Informe o link ou envie o arquivo.');
    const { rows: [novo] } = await query(
      `INSERT INTO public.biblioteca_materiais (produto_slug, produto, nicho, tipo, titulo, descricao, url, arquivo_nome, arquivo_mime, arquivo_tamanho, arquivo_md5, conteudo, origem, atualizado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $12::bytea IS NULL THEN NULL ELSE md5($12::bytea) END, $12, 'cadastro no painel', $11) RETURNING id`,
      [b.produto_slug ?? null, b.produto.trim(), b.nicho.trim(), b.tipo, b.titulo.trim(), b.descricao?.trim() || null, url, arq?.nome ?? null, arq?.mime ?? null, arq?.conteudo.length ?? null, quem(req), arq?.conteudo ?? null],
    ).catch((e) => { if (e.code === '23505') throw new ErroHttp(409, 'Este material já está cadastrado para o produto.'); throw e; });
    return resposta.code(201).send({ id: novo.id });
  });

  app.put('/api/biblioteca/:id', {
    onRequest: [app.exigirSessao],
    bodyLimit: 60 * 1024 * 1024,
    schema: { tags: ['Biblioteca'], summary: 'Altera um material (só administrador)', security: [{ bearerAuth: [] }], params: idParams, body: corpoMaterial([]) },
  }, async (req) => {
    soAdmin(req);
    const b = req.body;
    const sets = []; const valores = [];
    const add = (col, v) => { valores.push(v); sets.push(`${col} = $${valores.length}`); };
    for (const c of ['produto', 'nicho', 'titulo']) if (b[c] !== undefined) add(c, b[c].trim());
    if (b.produto_slug !== undefined) add('produto_slug', b.produto_slug);
    if (b.tipo !== undefined) add('tipo', b.tipo);
    if (b.descricao !== undefined) add('descricao', b.descricao?.trim() || null);
    if (b.url !== undefined) add('url', urlOk(b.url));
    const arq = lerArquivo(b);
    if (arq) { add('arquivo_nome', arq.nome); add('arquivo_mime', arq.mime); add('arquivo_tamanho', arq.conteudo.length); add('conteudo', arq.conteudo); sets.push(`arquivo_md5 = md5($${valores.length})`); }
    else if (b.remover_arquivo) { sets.push('arquivo_nome = NULL, arquivo_mime = NULL, arquivo_tamanho = NULL, arquivo_md5 = NULL, conteudo = NULL'); }
    if (!sets.length) throw new ErroHttp(400, 'Nada para alterar.');
    add('atualizado_por', quem(req)); sets.push('atualizado_em = now()');
    valores.push(req.params.id);
    const { rowCount } = await query(`UPDATE public.biblioteca_materiais SET ${sets.join(', ')} WHERE id = $${valores.length} AND ativo`, valores)
      .catch((e) => { if (e.code === '23514') throw new ErroHttp(400, 'O material precisa ter link ou arquivo.'); if (e.code === '23505') throw new ErroHttp(409, 'Este material já está cadastrado para o produto.'); throw e; });
    if (!rowCount) throw new ErroHttp(404, 'Material não encontrado.');
    return { ok: true };
  });

  app.delete('/api/biblioteca/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Biblioteca'], summary: 'Apaga um material (só administrador)', security: [{ bearerAuth: [] }], params: idParams },
  }, async (req) => {
    soAdmin(req);
    const { rowCount } = await query('DELETE FROM public.biblioteca_materiais WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new ErroHttp(404, 'Material não encontrado.');
    return { ok: true };
  });
}
