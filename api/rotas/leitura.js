/**
 * Acesso de LEITURA ao SendTrace (pedido do Lucas, 20/10/2026; migração 115) — para a Késsia consultar tudo com o Claude dela.
 *
 *   GET    /api/leitura/                       → quem sou, limites e o que existe (guia de 1 tela)
 *   GET    /api/leitura/regras                 → o que fica de fora (credenciais) e por quê
 *   GET    /api/leitura/esquema[?tabela=x]     → tabelas, views, colunas, tipos, comentários e nº de linhas (só o que a chave pode ler)
 *   GET    /api/leitura/tabela/:nome           → linhas de uma tabela (?limite, ?offset, ?ordem=coluna, ?desc=1)
 *   POST   /api/leitura/sql  {sql, limite}     → SELECT/WITH livre numa transação READ ONLY (outro usuário do banco, só SELECT)
 *   ·· administrador (login normal, nunca com chave de leitura) ··
 *   GET    /api/leitura/chaves                 → chaves criadas (sem o token)
 *   POST   /api/leitura/chaves  {dono,…}       → cria uma chave; o token aparece só nesta resposta
 *   DELETE /api/leitura/chaves/:id             → revoga
 *   GET    /api/leitura/auditoria              → quem consultou o quê (?chave_id, ?limite)
 *
 * Todas as outras rotas GET da API também respondem a uma chave `str_ro_…` (ver `exigirSessao`); estas aqui são as que leem o BANCO direto.
 * `mascarar_pii` da chave troca nome/e-mail/telefone/endereço por um hash curto nos resultados de /tabela e /sql.
 */
import { ErroHttp } from '../comum.js';
import { query } from '../../server/db.js';
import { consultarLeitura, leituraConfigurada, LIMITE_PADRAO, LIMITE_MAXIMO } from '../../server/dbLeitura.js';
import { criarChave, listarChaves, revogarChave, mascararLinhas } from '../leituraChaves.js';

const RE_NOME = /^[a-z_][a-z0-9_]*$/;

/** Esquema + tabela → { esquema, nome } validados; sem esquema, procura em public e depois em email_ia. */
const separarNome = (bruto) => {
  const partes = String(bruto ?? '').toLowerCase().split('.');
  if (partes.length > 2 || partes.some((p) => !RE_NOME.test(p))) throw new ErroHttp(400, 'Nome de tabela inválido (use "tabela" ou "esquema.tabela").');
  return partes.length === 2 ? { esquema: partes[0], nome: partes[1] } : { esquema: null, nome: partes[0] };
};

const SQL_ESQUEMA = `
  SELECT n.nspname AS esquema, c.relname AS nome,
         CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view materializada' ELSE 'tabela' END AS tipo,
         CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS linhas_estimadas,
         obj_description(c.oid, 'pg_class') AS comentario,
         (SELECT jsonb_agg(jsonb_build_object(
                   'nome', a.attname, 'tipo', format_type(a.atttypid, a.atttypmod), 'aceita_nulo', NOT a.attnotnull,
                   'chave_primaria', COALESCE(a.attnum = ANY (SELECT unnest(i.indkey) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary), false),
                   'comentario', col_description(c.oid, a.attnum)) ORDER BY a.attnum)
            FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
             AND has_column_privilege(c.oid, a.attnum, 'SELECT')) AS colunas
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'email_ia') AND c.relkind IN ('r', 'v', 'm', 'p') AND NOT c.relispartition
     AND has_any_column_privilege(c.oid, 'SELECT')`;

export default async function rotasLeitura(app) {
  const doGestor = (req) => {
    if (req.usuario.leitura) throw new ErroHttp(403, 'Chave de leitura não administra chaves nem lê a auditoria.');
    if (!req.usuario.admin) throw new ErroHttp(403, 'Só administradores.');
  };
  /** Chave de leitura ou administrador logado; nunca o token de serviço (que também escreve). */
  const podeLer = (req) => {
    if (req.usuario.servico) throw new ErroHttp(403, 'Use uma chave de leitura (str_ro_…) ou entre como administrador.');
    if (!req.usuario.leitura && !req.usuario.admin) throw new ErroHttp(403, 'Só chave de leitura ou administrador.');
  };
  const marcarAuditoria = (req, extra) => { req.auditoria = { ...(req.auditoria ?? {}), ...extra }; };
  const precisaDoBanco = () => { if (!leituraConfigurada) throw new ErroHttp(503, 'A leitura direta do banco ainda não foi ativada neste servidor.'); };
  const security = [{ bearerAuth: [] }];

  app.get('/api/leitura/', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Leitura'], summary: 'Quem sou e o que existe', security },
  }, async (req) => {
    podeLer(req);
    return {
      quem: req.usuario.leitura ? { dono: req.usuario.nome, chave_id: req.usuario.chaveId, mascarar_pii: !!req.usuario.mascararPii } : { dono: req.usuario.nome, administrador: true },
      leitura_do_banco_ativa: leituraConfigurada,
      limites: { linhas_por_consulta_padrao: LIMITE_PADRAO, linhas_por_consulta_maximo: LIMITE_MAXIMO, tempo_por_consulta_s: 20, chamadas_por_minuto: 120 },
      rotas: {
        esquema: 'GET /api/leitura/esquema[?tabela=public.tickets]',
        tabela: 'GET /api/leitura/tabela/:nome?limite=100&offset=0&ordem=coluna&desc=1',
        sql: 'POST /api/leitura/sql  {"sql":"select …","limite":1000}',
        regras: 'GET /api/leitura/regras',
        telas: 'todas as rotas GET da API (ver /api/docs/ e /api/schema/)',
      },
    };
  });

  app.get('/api/leitura/regras', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Leitura'], summary: 'O que fica de fora da leitura (credenciais) e por quê', security },
  }, async (req) => {
    podeLer(req);
    const { rows } = await query('SELECT public.leitura_regras() AS r');
    return rows[0].r;
  });

  app.get('/api/leitura/esquema', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Leitura'], summary: 'Tabelas, views e colunas que esta chave pode ler', security, querystring: { type: 'object', properties: { tabela: { type: 'string', maxLength: 100 } } } },
  }, async (req) => {
    podeLer(req); precisaDoBanco();
    let sql = SQL_ESQUEMA;
    if (req.query.tabela) {
      const { esquema, nome } = separarNome(req.query.tabela);
      sql += ` AND c.relname = '${nome}'` + (esquema ? ` AND n.nspname = '${esquema}'` : '');
    }
    sql += ' ORDER BY 1, 2';
    const r = await consultarLeitura(sql, { limite: 5000 });
    marcarAuditoria(req, { linhas: r.linhas.length });
    return { total: r.linhas.length, tabelas: r.linhas };
  });

  app.get('/api/leitura/tabela/:nome', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Leitura'], summary: 'Linhas de uma tabela ou view', security,
      params: { type: 'object', required: ['nome'], properties: { nome: { type: 'string', maxLength: 100 } } },
      querystring: {
        type: 'object',
        properties: {
          limite: { type: 'integer', minimum: 1, maximum: LIMITE_MAXIMO }, offset: { type: 'integer', minimum: 0, maximum: 100_000_000 },
          ordem: { type: 'string', maxLength: 80 }, desc: { type: 'string', enum: ['1', 'true', '0', 'false'] },
        },
      },
    },
  }, async (req) => {
    podeLer(req); precisaDoBanco();
    const { esquema, nome } = separarNome(req.params.nome);
    // colunas liberadas (SELECT * falharia em tabela com coluna oculta); quem não existir ou não for legível = 404
    const cat = await consultarLeitura(
      `SELECT n.nspname AS esquema, c.relname AS nome,
              array_agg(a.attname::text ORDER BY a.attnum) AS colunas
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(c.oid, a.attnum, 'SELECT')
        WHERE n.nspname IN ('public','email_ia') AND c.relkind IN ('r','v','m','p') AND c.relname = '${nome}'${esquema ? ` AND n.nspname = '${esquema}'` : ''}
        GROUP BY 1, 2 ORDER BY (n.nspname = 'public') DESC LIMIT 1`,
      { limite: 1 },
    );
    const t = cat.linhas[0];
    if (!t) throw new ErroHttp(404, 'Tabela não encontrada, ou sem permissão de leitura (veja /api/leitura/esquema e /api/leitura/regras).');
    const cols = t.colunas.map((c) => `"${c}"`).join(', ');
    let ordem = '';
    if (req.query.ordem) {
      if (!t.colunas.includes(req.query.ordem)) throw new ErroHttp(400, `Coluna "${req.query.ordem}" não existe em ${t.esquema}.${t.nome}.`);
      ordem = ` ORDER BY "${req.query.ordem}" ${['1', 'true'].includes(req.query.desc) ? 'DESC' : 'ASC'} NULLS LAST`;
    }
    const offset = req.query.offset ? ` OFFSET ${Number(req.query.offset)}` : '';
    const r = await consultarLeitura(`SELECT ${cols} FROM "${t.esquema}"."${t.nome}"${ordem}${offset}`, { limite: req.query.limite });
    marcarAuditoria(req, { linhas: r.linhas.length });
    return { tabela: `${t.esquema}.${t.nome}`, campos: r.campos, linhas: req.usuario.mascararPii ? mascararLinhas(r.linhas) : r.linhas, truncado: r.truncado, limite: r.limite };
  });

  app.post('/api/leitura/sql', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Leitura'], summary: 'SELECT livre (somente leitura)', security,
      body: { type: 'object', required: ['sql'], additionalProperties: false, properties: { sql: { type: 'string', minLength: 1, maxLength: 20000 }, limite: { type: 'integer', minimum: 1, maximum: LIMITE_MAXIMO } } },
    },
  }, async (req) => {
    podeLer(req); precisaDoBanco();
    marcarAuditoria(req, { sql: req.body.sql });
    const r = await consultarLeitura(req.body.sql, { limite: req.body.limite });
    marcarAuditoria(req, { linhas: r.linhas.length });
    return { campos: r.campos, linhas: req.usuario.mascararPii ? mascararLinhas(r.linhas) : r.linhas, truncado: r.truncado, limite: r.limite };
  });

  /* ───────────── administração das chaves (só administrador logado) ───────────── */

  app.get('/api/leitura/chaves', {
    onRequest: [app.exigirSessao], schema: { tags: ['Leitura'], summary: 'Chaves de leitura (sem o token)', security },
  }, async (req) => { doGestor(req); return { chaves: await listarChaves() }; });

  app.post('/api/leitura/chaves', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Leitura'], summary: 'Cria uma chave de leitura (o token aparece só aqui)', security,
      body: { type: 'object', required: ['dono'], additionalProperties: false, properties: { dono: { type: 'string', minLength: 2, maxLength: 120 }, descricao: { type: ['string', 'null'], maxLength: 300 }, mascarar_pii: { type: 'boolean' } } },
    },
  }, async (req, resposta) => {
    doGestor(req);
    const { id, token } = await criarChave({ dono: req.body.dono, descricao: req.body.descricao ?? null, mascararPii: req.body.mascarar_pii, criadaPor: req.usuario.nome || req.usuario.email });
    return resposta.code(201).send({ id, token, aviso: 'Guarde o token agora: ele não é mostrado de novo.' });
  });

  app.delete('/api/leitura/chaves/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Leitura'], summary: 'Revoga uma chave', security, params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req) => {
    doGestor(req);
    if (!(await revogarChave(req.params.id))) throw new ErroHttp(404, 'Chave não encontrada ou já revogada.');
    return { revogada: true };
  });

  app.get('/api/leitura/auditoria', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Leitura'], summary: 'Quem consultou o quê', security, querystring: { type: 'object', properties: { chave_id: { type: 'integer' }, limite: { type: 'integer', minimum: 1, maximum: 1000 } } } },
  }, async (req) => {
    doGestor(req);
    const { rows } = await query(
      `SELECT id, quando, chave_id, dono, metodo, rota, consulta, sql, status, ms, linhas, ip, erro FROM leitura_auditoria
        WHERE ($1::bigint IS NULL OR chave_id = $1) ORDER BY id DESC LIMIT $2`,
      [req.query.chave_id ?? null, req.query.limite ?? 200],
    );
    return { registros: rows };
  });
}
