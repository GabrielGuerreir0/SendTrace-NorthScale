/**
 * Autenticação: e-mail e senha viram um par de tokens.
 *
 * A conferência da senha NÃO é reescrita aqui — é a mesma função que o painel
 * usa (`server/auth.js`), com o scrypt, o freio de força bruta por conta e a
 * regra de conta desativada. Duas implementações de "esta senha confere?" é
 * pedir para uma delas envelhecer sozinha.
 */
import {
  autenticar, conferirSenha, trocarSenha, criarUsuario, definirAdmin, definirAtivo,
  emitirSenhaProvisoria, contarAdmins, validarSenha, normalizarEmail, emailValido,
  criarTokenReset, usuarioDoTokenReset, consumirTokenReset,
} from '../../server/auth.js';
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

  /*
   * Trocar a PRÓPRIA senha. Exige a senha atual mesmo com token válido: sem
   * isso, um computador deixado aberto vira sequestro de conta permanente.
   * É também o que transforma a senha provisória de um convite em definitiva.
   */
  app.post('/api/auth/senha/', {
    schema: {
      tags: ['Acesso'],
      summary: 'Troca a senha da própria conta',
      description: 'Confere a senha atual antes de aceitar a nova. Se a atual era '
        + 'provisória, ela vira definitiva e o prazo do convite deixa de existir.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          atual: { type: 'string' },
          nova: { type: 'string' },
        },
        required: ['atual', 'nova'],
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'Erro#' },
        403: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    if (req.usuario.servico || req.usuario.user_id == null) {
      throw new ErroHttp(403, 'O token de serviço não tem senha para trocar.');
    }
    const { rows } = await query(
      'SELECT email, senha_hash, senha_salt, senha_params FROM painel_usuarios WHERE id = $1',
      [req.usuario.user_id],
    );
    if (!rows[0] || !(await conferirSenha(req.body.atual, rows[0]))) {
      // Atraso fixo, como no login: errar a senha atual não pode ser mais
      // rápido que acertá-la.
      await new Promise((ok) => setTimeout(ok, 260));
      throw new ErroHttp(400, 'Senha atual incorreta.');
    }
    const problema = validarSenha(req.body.nova, { email: rows[0].email });
    if (problema) throw new ErroHttp(400, problema);
    if (req.body.nova === req.body.atual) {
      throw new ErroHttp(400, 'A nova senha precisa ser diferente da atual.');
    }
    await trocarSenha(req.usuario.user_id, req.body.nova);
    return { ok: true };
  });

  /*
   * Recuperação de senha por e-mail (self-service, sem admin envolvido).
   * Público de propósito — quem esqueceu a senha não tem sessão nenhuma.
   *
   * `gerado` distingue conta-existe de conta-inexistente na resposta — isso
   * só é seguro porque esta rota é chamada SERVER-TO-SERVER pelo painel
   * (server/index.js), nunca exposta ao navegador. O painel devolve uma
   * mensagem idêntica ao navegador nos dois casos, com atraso fixo. A API
   * não deve ser exposta publicamente por conta dessa premissa — mesmo
   * raciocínio que já vale hoje para /api/auth/token/.
   */
  app.post('/api/auth/esqueci-senha/', {
    schema: {
      tags: ['Acesso'],
      summary: 'Gera um token de recuperação, se a conta existir e estiver ativa',
      description: 'Rota pública, sem sessão. `gerado: false` cobre e-mail inexistente, conta '
        + 'desativada, OU cooldown de 1 min (já pediu recentemente) — os três casos são '
        + 'indistinguíveis de propósito.',
      body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            gerado: { type: 'boolean' },
            token: { type: 'string' },
            email: { type: 'string' },
          },
        },
      },
    },
  }, async (req) => {
    const email = normalizarEmail(req.body.email);
    const { rows } = await query('SELECT id FROM painel_usuarios WHERE email = $1 AND ativo', [email]);
    if (!rows[0]) return { gerado: false };
    const token = await criarTokenReset(rows[0].id, { ip: req.ip });
    if (!token) return { gerado: false };
    return { gerado: true, token, email };
  });

  app.post('/api/auth/redefinir-senha/', {
    schema: {
      tags: ['Acesso'],
      summary: 'Troca a senha usando um token de recuperação',
      description: 'Rota pública. Token de uso único, expira em 30 min. Derruba as sessões '
        + 'abertas da conta (ver server/index.js, que chama fecharSessoesDe depois desta rota '
        + 'responder ok — esta função aqui só grava no banco).',
      body: {
        type: 'object',
        required: ['token', 'senha'],
        properties: { token: { type: 'string' }, senha: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, email: { type: 'string' } } },
        400: { $ref: 'Erro#' },
      },
    },
  }, async (req) => {
    const alvo = await usuarioDoTokenReset(String(req.body.token ?? ''));
    if (!alvo) throw new ErroHttp(400, 'Link inválido, expirado ou já usado. Peça um novo.');
    const problema = validarSenha(req.body.senha, { email: alvo.email });
    if (problema) throw new ErroHttp(400, problema);
    await trocarSenha(alvo.usuario_id, req.body.senha);
    await consumirTokenReset(String(req.body.token));
    return { ok: true, email: alvo.email };
  });

  /* ────────────────────────────  usuários  ──────────────────────────── */

  app.get('/api/usuarios/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Lista os usuários do painel',
      description: 'Só para administradores. Senhas nunca são expostas.',
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

  /*
   * Criar usuário — só administrador.
   *
   * A senha chega pronta (quem cria sorteia uma) e nasce PROVISÓRIA: com
   * prazo (CONVITE_DIAS) e exigindo troca no primeiro acesso. Quem cria não
   * deve seguir sabendo a senha de ninguém.
   */
  app.post('/api/usuarios/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Cria um usuário com senha provisória',
      description: 'Só administradores. A senha enviada vale por um prazo e a conta '
        + 'exige a troca no primeiro acesso (`trocar_senha`). O envio do convite por '
        + 'e-mail é papel do painel, não desta API.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          nome: { type: 'string', maxLength: 120 },
          senha: { type: 'string' },
          admin: { type: 'boolean', default: false },
        },
        required: ['email', 'senha'],
      },
      response: {
        201: { $ref: 'PainelUsuario#' },
        400: { $ref: 'Erro#' },
        409: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirAdmin],
  }, async (req, resposta) => {
    const email = normalizarEmail(req.body.email);
    if (!emailValido(email)) throw new ErroHttp(400, 'E-mail inválido.');

    const problema = validarSenha(req.body.senha, { email });
    if (problema) throw new ErroHttp(400, problema);

    try {
      const novo = await criarUsuario({
        email,
        nome: String(req.body.nome ?? '').trim().slice(0, 120) || null,
        senha: req.body.senha,
        admin: !!req.body.admin,
        criadoPor: req.usuario.user_id,
      });
      resposta.code(201);
      return novo;
    } catch (err) {
      if (err.code === '23505') throw new ErroHttp(409, 'Já existe um usuário com esse e-mail.');
      throw err;
    }
  });

  /*
   * Alterar usuário — só administrador. Três mudanças possíveis, combináveis:
   * `admin`, `ativo` e `senha` (que emite uma provisória nova e derruba as
   * sessões da conta). As travas impedem o tiro no pé: ninguém se rebaixa nem
   * se desativa, e sempre sobra pelo menos um administrador ativo.
   */
  app.patch('/api/usuarios/:id/', {
    schema: {
      tags: ['Usuários'],
      summary: 'Promove/rebaixa, ativa/desativa ou emite senha provisória',
      description: 'Só administradores. `senha` vira provisória: com prazo, exigindo '
        + 'troca no primeiro acesso e encerrando as sessões abertas da conta.',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          admin: { type: 'boolean' },
          ativo: { type: 'boolean' },
          senha: { type: 'string' },
        },
      },
      response: {
        200: { $ref: 'PainelUsuario#' },
        400: { $ref: 'Erro#' },
        404: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirAdmin],
  }, async (req) => {
    const alvo = Number(req.params.id);
    const corpo = req.body ?? {};

    const { rows } = await query(
      'SELECT email, admin, ativo FROM painel_usuarios WHERE id = $1', [alvo],
    );
    const atual = rows[0];
    if (!atual) throw new ErroHttp(404, 'Usuário não encontrado.');

    if (corpo.admin === false) {
      // Rebaixar a si mesmo tiraria o acesso à própria tela em uso, sem volta
      // se não houver outro admin — e o painel não pode ficar sem nenhum.
      if (alvo === req.usuario.user_id) {
        throw new ErroHttp(400, 'Você não pode remover o seu próprio acesso de administrador.');
      }
      if (atual.admin && atual.ativo && (await contarAdmins()) <= 1) {
        throw new ErroHttp(400, 'Precisa sobrar pelo menos um administrador ativo.');
      }
    }
    if ('admin' in corpo) await definirAdmin(alvo, corpo.admin);

    if (corpo.ativo === false) {
      if (alvo === req.usuario.user_id) {
        throw new ErroHttp(400, 'Você não pode desativar a própria conta.');
      }
      if (atual.admin && atual.ativo && corpo.admin !== false && (await contarAdmins()) <= 1) {
        throw new ErroHttp(400, 'Precisa sobrar pelo menos um administrador ativo.');
      }
    }
    if ('ativo' in corpo) await definirAtivo(alvo, corpo.ativo);

    if (corpo.senha !== undefined) {
      const problema = validarSenha(corpo.senha, { email: atual.email });
      if (problema) throw new ErroHttp(400, problema);
      await emitirSenhaProvisoria(alvo, corpo.senha);
    }

    const { rows: fim } = await query(
      `SELECT ${COLUNAS_USUARIO} FROM painel_usuarios WHERE id = $1`, [alvo],
    );
    return fim[0];
  });
}
