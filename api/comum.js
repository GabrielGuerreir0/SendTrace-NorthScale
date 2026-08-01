/**
 * Peças que todas as rotas usam: paginação, filtros e o CRUD genérico.
 *
 * O que justifica um CRUD genérico aqui é que sete recursos têm exatamente o
 * mesmo comportamento — listar com filtro, ler um, criar, atualizar, apagar —
 * mudando só a tabela e a chave. Escrever isso sete vezes garantiria que uma
 * delas ficasse diferente das outras sem ninguém decidir isso.
 */
import { query } from '../server/db.js';
import { paginado, paginacaoParams } from './esquemas.js';

/** Erro que vira resposta HTTP com corpo `{detail}`, como o resto da API. */
export class ErroHttp extends Error {
  constructor(status, detalhe) {
    super(detalhe);
    this.statusCode = status;
    this.detalhe = detalhe;
  }
}

/* ────────────────────────────  paginação  ─────────────────────────── */

export function fatiar(req, total) {
  const pagina = Math.max(1, Number(req.query.page) || 1);
  const tamanho = Math.min(500, Math.max(1, Number(req.query.page_size) || 100));
  const offset = (pagina - 1) * tamanho;

  // A URL da próxima página sai da URL desta, com `page` trocado. Montá-la à
  // mão perderia os filtros e o cliente pagina outro conjunto sem perceber.
  const enderecoDe = (n) => {
    if (n < 1) return null;
    const u = new URL(req.url, `${req.protocol}://${req.hostname}`);
    u.searchParams.set('page', String(n));
    return u.toString();
  };

  return {
    limit: tamanho,
    offset,
    envelope: (results) => ({
      count: total,
      next: offset + tamanho < total ? enderecoDe(pagina + 1) : null,
      previous: pagina > 1 ? enderecoDe(pagina - 1) : null,
      results,
    }),
  };
}

/* ─────────────────────────────  filtros  ──────────────────────────── */

/**
 * Traduz `?campo=valor` em SQL parametrizado.
 *
 * `permitidos` mapeia o nome do parâmetro para {coluna, op}. Nada fora dessa
 * lista vira consulta: sem isso, um parâmetro inventado poderia costurar
 * qualquer coisa no WHERE.
 */
export function montarFiltros(consulta, permitidos, valores = []) {
  const partes = [];
  for (const [nome, def] of Object.entries(permitidos)) {
    const bruto = consulta[nome];
    if (bruto === undefined || bruto === '') continue;
    const op = def.op ?? '=';
    if (op === 'ilike') {
      valores.push(`%${bruto}%`);
      partes.push(`${def.coluna} ILIKE $${valores.length}`);
    } else {
      valores.push(def.numero ? Number(bruto) : bruto);
      partes.push(`${def.coluna} ${op} $${valores.length}`);
    }
  }
  return { partes, valores };
}

/**
 * `?search=` procura em várias colunas de uma vez.
 *
 * Uma comparação por coluna com o mesmo termo, em vez de concatenar tudo:
 * concatenar acharia "ana@x.com" ao buscar por "anax", que ninguém pediu.
 */
export function montarBusca(termo, colunas, valores) {
  if (!termo) return null;
  valores.push(`%${termo}%`);
  const i = valores.length;
  return `(${colunas.map((c) => `${c} ILIKE $${i}`).join(' OR ')})`;
}

/**
 * `?ordering=campo` ou `-campo`. Só colunas conhecidas.
 *
 * Interpolar o nome vindo do cliente seria injeção direta no ORDER BY — e um
 * ORDER BY não aceita parâmetro, então a defesa TEM que ser a lista.
 */
export function montarOrdem(pedido, colunas, padrao) {
  if (!pedido) return padrao;
  const desc = pedido.startsWith('-');
  const nome = desc ? pedido.slice(1) : pedido;
  if (!colunas.includes(nome)) return padrao;
  return `${nome} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
}

/* ───────────────────────────  CRUD genérico  ──────────────────────── */

const listaColunas = (obj) => Object.keys(obj).join(', ');
const listaValores = (obj) => Object.keys(obj).map((_, i) => `$${i + 1}`).join(', ');

/**
 * Registra listar/ler/criar/atualizar/apagar de um recurso.
 *
 * `chave` é o nome da coluna que identifica um registro (etapa, linha, chave…).
 * `escrita` diz quem pode alterar: por padrão só administradores, porque tudo
 * aqui muda o que sai para clientes reais.
 */
export function registrarCrud(app, {
  rota, tabela, chave, esquema, esquemaEntrada, tag, colunas, filtros = {},
  buscaEm = [], ordenaveis = [], ordemPadrao, somenteLeitura = false,
  aoTransformar = (linha) => linha, aoEntrar = (corpo) => corpo,
}) {
  const ref = esquema.$id;
  const entrada = esquemaEntrada ?? esquema;

  /* ── lista ── */
  app.get(rota, {
    // Ler também exige conta. Sem esta linha a lista respondia a qualquer um
    // que soubesse a URL — e `disparos_pos_venda` tem e-mail e telefone de
    // cliente em cada registro.
    onRequest: [app.exigirSessao],
    schema: {
      tags: [tag],
      summary: `Lista ${tag.toLowerCase()}`,
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...paginacaoParams,
          ...Object.fromEntries(Object.entries(filtros).map(([n, d]) => [n, d.esquema ?? { type: 'string' }])),
          ...(buscaEm.length ? { search: { type: 'string', description: `Procura em: ${buscaEm.join(', ')}.` } } : {}),
          ...(ordenaveis.length ? { ordering: { type: 'string', description: `Campo para ordenar; com '-' na frente, decrescente. Aceita: ${ordenaveis.join(', ')}.` } } : {}),
        },
      },
      response: { 200: paginado(ref) },
    },
  }, async (req) => {
    const valores = [];
    const { partes } = montarFiltros(req.query, filtros, valores);
    const busca = montarBusca(req.query.search, buscaEm, valores);
    if (busca) partes.push(busca);

    const onde = partes.length ? `WHERE ${partes.join(' AND ')}` : '';
    const cont = await query(`SELECT count(*)::int AS n FROM ${tabela} ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);

    const ordem = montarOrdem(req.query.ordering, ordenaveis, ordemPadrao);
    const { rows } = await query(
      `SELECT ${colunas} FROM ${tabela} ${onde} ORDER BY ${ordem}
       LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows.map(aoTransformar));
  });

  /* ── um registro ── */
  app.get(`${rota}:${chave}/`, {
    onRequest: [app.exigirSessao],
    schema: {
      tags: [tag],
      summary: `Lê um registro pelo ${chave}`,
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { [chave]: { type: 'string' } }, required: [chave] },
      response: { 200: { $ref: `${ref}#` }, 404: { $ref: 'Erro#' } },
    },
  }, async (req) => {
    const { rows } = await query(
      `SELECT ${colunas} FROM ${tabela} WHERE ${chave}::text = $1`, [req.params[chave]],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Não encontrado.');
    return aoTransformar(rows[0]);
  });

  if (somenteLeitura) return;

  /* ── criar ── */
  app.post(rota, {
    schema: {
      tags: [tag],
      summary: `Cria ${tag.toLowerCase()}`,
      security: [{ bearerAuth: [] }],
      body: { $ref: `${entrada.$id}#` },
      response: { 201: { $ref: `${ref}#` }, 409: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirAdmin],
  }, async (req, resposta) => {
    const dados = aoEntrar(req.body);
    const { rows } = await query(
      `INSERT INTO ${tabela} (${listaColunas(dados)}) VALUES (${listaValores(dados)})
       RETURNING ${colunas}`,
      Object.values(dados),
    );
    resposta.code(201);
    return aoTransformar(rows[0]);
  });

  /* ── substituir e remendar ── */
  for (const metodo of ['put', 'patch']) {
    app[metodo](`${rota}:${chave}/`, {
      schema: {
        tags: [tag],
        summary: metodo === 'put' ? 'Substitui um registro' : 'Altera alguns campos',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { [chave]: { type: 'string' } }, required: [chave] },
        body: { $ref: `${entrada.$id}#` },
        response: { 200: { $ref: `${ref}#` }, 404: { $ref: 'Erro#' } },
      },
      onRequest: [app.exigirAdmin],
      // No PATCH, campo ausente é campo não mexido — então o schema de entrada
      // não pode exigir nada. No PUT, o corpo é a nova verdade inteira.
      ...(metodo === 'patch' ? { attachValidation: false } : {}),
    }, async (req) => {
      const dados = aoEntrar(req.body, metodo);
      const campos = Object.keys(dados);
      if (!campos.length) throw new ErroHttp(400, 'Nada para alterar.');

      const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const { rows } = await query(
        `UPDATE ${tabela} SET ${sets} WHERE ${chave}::text = $1 RETURNING ${colunas}`,
        [req.params[chave], ...Object.values(dados)],
      );
      if (!rows[0]) throw new ErroHttp(404, 'Não encontrado.');
      return aoTransformar(rows[0]);
    });
  }

  /* ── apagar ── */
  app.delete(`${rota}:${chave}/`, {
    schema: {
      tags: [tag],
      summary: 'Apaga um registro',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { [chave]: { type: 'string' } }, required: [chave] },
      response: { 204: { type: 'null' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirAdmin],
  }, async (req, resposta) => {
    const r = await query(`DELETE FROM ${tabela} WHERE ${chave}::text = $1`, [req.params[chave]]);
    if (!r.rowCount) throw new ErroHttp(404, 'Não encontrado.');
    resposta.code(204);
    return null;
  });
}
