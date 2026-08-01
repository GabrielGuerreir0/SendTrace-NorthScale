/**
 * Autenticação: e-mail e senha viram um par de tokens.
 *
 * A conferência da senha NÃO é reescrita aqui — é a mesma função que o painel
 * usa (`server/auth.js`), com o scrypt, o freio de força bruta por conta e a
 * regra de conta desativada. Duas implementações de "esta senha confere?" é
 * pedir para uma delas envelhecer sozinha.
 */
import { autenticar } from '../../server/auth.js';
import { query } from '../../server/db.js';
import { ErroHttp, fatiar, montarBusca, montarOrdem } from '../comum.js';

/** Colunas do usuário que podem sair daqui. O hash da senha nunca entra. */
const COLUNAS_USUARIO = `id, email, nome, admin, ativo, trocar_senha, criado_em,
  criado_por, ultimo_acesso, falhas, bloqueado_ate, senha_expira_em`;

export default async function rotasAcesso(app) {
  /* ─────────────────────────────  token  ───────────────────────────── */

  app.post('/api/auth/token/', {
    schema: {
      tags: ['Acesso'],
      summary: 'Troca e-mail e senha por um par de tokens',
      description: 'O `access` vai no cabeçalho `Authorization: Bearer <access>`. '
        + 'Quando ele vencer, use o `refresh` em /api/auth/token/refresh/ — '
        + 'a senha não precisa ser digitada de novo.',
      body: { $ref: 'Credenciais#' },
      response: { 200: { $ref: 'ParTokens#' }, 401: { $ref: 'Erro#' } },
    },
  }, async (req) => {
    const r = await autenticar(req.body.email, req.body.password ?? '');
    if (!r.ok) {
      // Atraso fixo: o tempo de resposta não deve distinguir os motivos, senão
      // dá para descobrir quais e-mails existem cronometrando.
      await new Promise((ok) => setTimeout(ok, 260));
      throw new ErroHttp(401, r.erro);
    }
    return app.emitirTokens(r.usuario);
  });

  app.post('/api/auth/token/refresh/', {
    schema: {
      tags: ['Acesso'],
      summary: 'Renova o access a partir do refresh',
      body: { $ref: 'PedidoRefresh#' },
      response: { 200: { $ref: 'ParTokens#' }, 401: { $ref: 'Erro#' } },
    },
  }, async (req) => {
    let carga;
    try {
      carga = app.jwt.verify(req.body.refresh);
    } catch {
      throw new ErroHttp(401, 'Refresh inválido ou vencido. Entre de novo.');
    }
    if (carga.tipo !== 'refresh') throw new ErroHttp(401, 'Este token não é de refresh.');

    /*
     * O usuário é relido do banco, não copiado do token.
     *
     * Um refresh vale horas. Sem esta leitura, quem foi desativado ou perdeu o
     * admin no meio do caminho continuaria renovando o acesso antigo até o
     * token expirar — a revogação demoraria a valer.
     */
    const { rows } = await query(
      `SELECT id, email, nome, admin, ativo FROM painel_usuarios WHERE id = $1`,
      [carga.user_id],
    );
    const u = rows[0];
    if (!u || !u.ativo) throw new ErroHttp(401, 'Conta inexistente ou desativada.');
    return app.emitirTokens(u);
  });

  /* ────────────────────────────  usuários  ──────────────────────────── */

  app.get('/api/usuarios/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Lista os usuários do painel',
      description: 'Somente leitura, e só para administradores. Senhas nunca são expostas.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          search: { type: 'string', description: 'Procura em: email, nome.' },
          ordering: { type: 'string', description: "Aceita: id, email, nome, ultimo_acesso, criado_em. Com '-' na frente, decrescente." },
          ativo: { type: 'boolean' },
          admin: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            next: { type: ['string', 'null'] },
            previous: { type: ['string', 'null'] },
            results: { type: 'array', items: { $ref: 'PainelUsuario#' } },
          },
        },
      },
    },
    onRequest: [app.exigirAdmin],
  }, async (req) => {
    const valores = [];
    const partes = [];
    for (const campo of ['ativo', 'admin']) {
      if (req.query[campo] !== undefined) {
        valores.push(req.query[campo]);
        partes.push(`${campo} = $${valores.length}`);
      }
    }
    const busca = montarBusca(req.query.search, ['email', 'nome'], valores);
    if (busca) partes.push(busca);
    const onde = partes.length ? `WHERE ${partes.join(' AND ')}` : '';

    const cont = await query(`SELECT count(*)::int AS n FROM painel_usuarios ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const ordem = montarOrdem(
      req.query.ordering, ['id', 'email', 'nome', 'ultimo_acesso', 'criado_em'], 'id ASC',
    );
    const { rows } = await query(
      `SELECT ${COLUNAS_USUARIO} FROM painel_usuarios ${onde} ORDER BY ${ordem}
       LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  app.get('/api/usuarios/:id/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Lê um usuário',
      description: 'Quem não é administrador só consegue ler a própria conta — '
        + 'é o que o painel usa para descobrir quem entrou.',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      response: { 200: { $ref: 'PainelUsuario#' }, 403: { $ref: 'Erro#' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const alvo = Number(req.params.id);
    if (!req.usuario.admin && req.usuario.user_id !== alvo) {
      throw new ErroHttp(403, 'Você só pode ler a própria conta.');
    }
    const { rows } = await query(
      `SELECT ${COLUNAS_USUARIO} FROM painel_usuarios WHERE id = $1`, [alvo],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Usuário não encontrado.');
    return rows[0];
  });

  app.get('/api/usuarios/eu/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Quem sou eu',
      description: 'A conta dona do token usado nesta chamada.',
      security: [{ bearerAuth: [] }],
      response: { 200: { $ref: 'PainelUsuario#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT ${COLUNAS_USUARIO} FROM painel_usuarios WHERE id = $1`, [req.usuario.user_id],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Usuário não encontrado.');
    return rows[0];
  });
}
