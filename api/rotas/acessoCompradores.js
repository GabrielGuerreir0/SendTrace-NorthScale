/**
 * Lista de compradores de um produto para o app de membros (my.getneurorecall.com) — 23/11/2026, pedido do Gustavo.
 *
 * O app consulta de tempos em tempos quem tem acesso: um item por e-mail, com `ativo` = tem ao menos um pedido do
 * produto sem reembolso e sem chargeback. Só e-mail e situação: nada de nome, telefone, endereço ou valor.
 *
 * Auth: `Authorization: Bearer <chave>`. A chave é exclusiva desta rota (não abre o resto do SendTrace) e só o HASH
 * (SHA-256) fica no código; revogar é trocar o hash (ou a env `ACESSO_COMPRADORES_API_KEY_SHA256`). Mesmo molde da Recoverly.
 * O log registra produto e página, nunca e-mail.
 */
import crypto from 'node:crypto';
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const HASH_TOKEN = (process.env.ACESSO_COMPRADORES_API_KEY_SHA256
  || '2456b08fc843ed5c6f54317a9ae61b505fadf2c4ee31241189d0afedc41471be').trim();

function tokenValido(cabecalho) {
  const bruto = String(cabecalho ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bruto) return false;
  const a = crypto.createHash('sha256').update(bruto).digest();
  const b = Buffer.from(HASH_TOKEN, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const POR_PAGINA_PADRAO = 10000;
const POR_PAGINA_MAXIMO = 10000;
const RE_SLUG = /^[a-z0-9_-]{1,60}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export default async function rotasAcessoCompradores(app) {
  app.get('/api/acesso/compradores', {
    schema: {
      tags: ['Acesso'],
      summary: 'Compradores de um produto (e-mail e situação) para o app de membros',
      description: 'Auth por `Authorization: Bearer` com a chave exclusiva desta rota. Informe `produto` (slug). Devolve um item por e-mail, '
        + 'em minúsculas, ordenado por e-mail, paginado (`pagina`, `por_pagina`); `ativo` é falso quando todos os pedidos do e-mail no produto '
        + 'foram reembolsados ou tiveram chargeback. Opcionais: `desde` (data/hora ISO) devolve só quem teve pedido, reembolso ou chargeback '
        + 'depois desse momento; `email` consulta uma pessoa só. Só e-mail e situação.',
      querystring: {
        type: 'object',
        properties: {
          produto: { type: 'string', maxLength: 80 },
          pagina: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
          por_pagina: { type: 'integer', minimum: 1, maximum: POR_PAGINA_MAXIMO, default: POR_PAGINA_PADRAO },
          desde: { type: 'string', maxLength: 40 },
          email: { type: 'string', maxLength: 320 },
        },
      },
      security: [],
    },
  }, async (req, resposta) => {
    resposta.header('Cache-Control', 'no-store');
    if (!tokenValido(req.headers.authorization)) throw new ErroHttp(401, 'Chave ausente ou inválida.');

    const produto = String(req.query.produto ?? '').trim().toLowerCase();
    if (!RE_SLUG.test(produto)) throw new ErroHttp(400, 'Informe o produto (slug), ex.: ?produto=neurorecallpro.');
    const { rowCount } = await query("SELECT 1 FROM produtos WHERE slug = $1 AND slug <> '*'", [produto]);
    if (!rowCount) throw new ErroHttp(400, 'Produto desconhecido.');

    const emailUnico = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    if (emailUnico && !EMAIL_RE.test(emailUnico)) throw new ErroHttp(400, 'E-mail inválido.');

    let desde = null;
    if (req.query.desde) {
      const d = new Date(req.query.desde);
      if (Number.isNaN(d.getTime())) throw new ErroHttp(400, '"desde" inválido: use data e hora ISO, ex.: 2026-11-23T10:00:00Z.');
      desde = d.toISOString();
    }

    const pagina = req.query.pagina ?? 1;
    const porPagina = req.query.por_pagina ?? POR_PAGINA_PADRAO;
    console.log(`[acesso-compradores] produto=${produto} pagina=${pagina} por_pagina=${porPagina}${desde ? ' desde' : ''}${emailUnico ? ' email' : ''}`);

    // Pede uma linha a mais só para saber se há próxima página.
    const { rows } = await query(
      `SELECT lower(trim(email)) AS email,
              bool_or(reembolsado_em IS NULL AND chargeback_em IS NULL) AS ativo
         FROM disparos_pos_venda
        WHERE produto_slug = $1
          AND email IS NOT NULL AND trim(email) <> ''
          AND ($2::text IS NULL OR lower(trim(email)) = $2)
        GROUP BY 1
       HAVING ($3::timestamptz IS NULL OR greatest(max(criado_em), max(reembolsado_em), max(chargeback_em)) > $3)
        ORDER BY 1
        LIMIT $4 OFFSET $5`,
      [produto, emailUnico, desde, porPagina + 1, (pagina - 1) * porPagina],
    );

    const temMais = rows.length > porPagina;
    return {
      produto,
      pagina,
      por_pagina: porPagina,
      tem_mais: temMais,
      compradores: rows.slice(0, porPagina).map((r) => ({ email: r.email, ativo: r.ativo })),
    };
  });
}
