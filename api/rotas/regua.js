/**
 * A régua: cadência (`etapas_regua`), copy (`mensagens_regua`), as linhas de
 * variação e a configuração que diz qual delas está no ar.
 *
 * Uma etapa dispara e-mail E SMS ao mesmo tempo — o canal é atributo da
 * mensagem, não da etapa. Por isso a chave de `mensagens_regua` é a trinca
 * (etapa, canal, linha), e não um id qualquer.
 */
import { query, pool } from '../../server/db.js';
import {
  EtapaRegua, MensagemRegua, PainelLinhaCopy, ConfigDisparo,
  PainelLinhaMensagens, PainelLinhaHistorico, paginado, paginacaoParams,
} from '../esquemas.js';
import { registrarCrud, ErroHttp, fatiar, montarOrdem } from '../comum.js';

const COLUNAS_MSG = `etapa, canal, linha, produto, assunto, texto, botao, destino,
  corpo_html, ativo, atualizado_em`;

const SLUG_PRODUTO = /^(\*|[a-z0-9]{2,40})$/;

/**
 * A PK composta viaja como um texto só: `etapa:canal:linha:produto`.
 *
 * O formato antigo de 3 partes continua aceito e significa `produto = '*'` —
 * é o que deixa BFF e front antigos funcionarem durante a transição, em vez de
 * exigir que API e painel subam no mesmo segundo.
 */
function partirChave(bruto) {
  const partes = String(bruto).split(':');
  const [etapa, canal, linha, produto] = partes;
  if (partes.length < 3 || partes.length > 4
      || !/^\d+$/.test(etapa ?? '') || !['email', 'sms'].includes(canal) || !linha
      || (produto !== undefined && !SLUG_PRODUTO.test(produto))) {
    throw new ErroHttp(400, 'Chave inválida. O formato é etapa:canal:linha:produto — '
      + "por exemplo 1:email:1:neuromindpro. Sem o produto, vale o padrão '*'.");
  }
  return { etapa: Number(etapa), canal, linha, produto: produto ?? '*' };
}

export default async function rotasRegua(app) {
  /* ═══════════════════════════  etapas  ═══════════════════════════ */

  registrarCrud(app, {
    rota: '/api/etapas/',
    tabela: 'etapas_regua',
    chave: 'etapa',
    esquema: EtapaRegua,
    tag: 'Régua',
    colunas: 'etapa, nome, espera_h, offset_h, ativo, descricao, atualizado_em',
    buscaEm: ['nome', 'descricao'],
    ordenaveis: ['etapa', 'nome', 'offset_h'],
    ordemPadrao: 'etapa ASC',
    filtros: { ativo: { coluna: 'ativo', esquema: { type: 'boolean' } } },
    aoEntrar: (corpo) => ({ ...corpo, atualizado_em: new Date() }),
  });

  /* ══════════════════════════  mensagens  ══════════════════════════ */

  app.get('/api/mensagens/', {
    schema: {
      tags: ['Régua'],
      summary: 'Lista a copy da régua',
      description: 'Toda etapa tem uma mensagem por canal, linha e produto. '
        + "Filtre por `linha` para ver uma variação inteira; `produto='*'` é o padrão "
        + 'que os produtos sem copy própria herdam.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...paginacaoParams,
          etapa: { type: 'integer' },
          canal: { type: 'string', enum: ['email', 'sms'] },
          linha: { type: 'string' },
          produto: { type: 'string', description: "Slug do produto, ou '*' para o padrão." },
          ativo: { type: 'boolean' },
          destino: { type: 'string', enum: ['EBOOK', 'ASSISTENTE'] },
          search: { type: 'string', description: 'Procura em: assunto, texto, corpo_html.' },
          ordering: { type: 'string', description: 'Aceita: etapa, canal, linha, produto, atualizado_em.' },
        },
      },
      response: { 200: paginado('MensagemRegua') },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const valores = [];
    const partes = [];
    // `produto` PRECISA estar nesta lista: filtro fora dela é ignorado em
    // silêncio, e o cliente receberia a copy de todos os produtos misturada.
    for (const campo of ['etapa', 'canal', 'linha', 'produto', 'ativo', 'destino']) {
      if (req.query[campo] === undefined) continue;
      valores.push(campo === 'etapa' ? Number(req.query[campo]) : req.query[campo]);
      partes.push(`${campo} = $${valores.length}`);
    }
    if (req.query.search) {
      valores.push(`%${req.query.search}%`);
      const i = valores.length;
      partes.push(`(assunto ILIKE $${i} OR texto ILIKE $${i} OR corpo_html ILIKE $${i})`);
    }
    const onde = partes.length ? `WHERE ${partes.join(' AND ')}` : '';

    const cont = await query(`SELECT count(*)::int AS n FROM mensagens_regua ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const ordem = montarOrdem(
      req.query.ordering, ['etapa', 'canal', 'linha', 'produto', 'atualizado_em'],
      'etapa ASC, canal ASC, linha ASC, produto ASC',
    );
    const { rows } = await query(
      `SELECT ${COLUNAS_MSG} FROM mensagens_regua ${onde} ORDER BY ${ordem}
       LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  app.get('/api/mensagens/:pk/', {
    schema: {
      tags: ['Régua'],
      summary: 'Lê uma mensagem pela chave etapa:canal:linha:produto',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { pk: { type: 'string', examples: ['1:email:1:*', '1:email:1:neuromindpro'] } },
        required: ['pk'],
      },
      response: { 200: { $ref: 'MensagemRegua#' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { etapa, canal, linha, produto } = partirChave(req.params.pk);
    const { rows } = await query(
      `SELECT ${COLUNAS_MSG} FROM mensagens_regua
        WHERE etapa = $1 AND canal = $2 AND linha = $3 AND produto = $4`,
      [etapa, canal, linha, produto],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Mensagem não encontrada.');
    return rows[0];
  });

  /**
   * Gravar mensagem é UPSERT pela trinca.
   *
   * O mesmo caminho serve para criar e para editar — é o que o contrato do robô
   * espera, e evita o cliente ter que descobrir antes se a mensagem já existe.
   */
  const gravar = async (req, resposta) => {
    const alvo = req.params.pk ? partirChave(req.params.pk) : null;
    const c = req.body;
    const etapa = alvo?.etapa ?? c.etapa;
    const canal = alvo?.canal ?? c.canal;
    const linha = String(alvo?.linha ?? c.linha);
    // Quem ainda chama com a chave de 3 partes (ou sem o campo no corpo) grava
    // o padrão — é exatamente o comportamento de antes da migração.
    const produto = alvo?.produto ?? c.produto ?? '*';
    if (etapa === undefined || !canal || !linha) {
      throw new ErroHttp(400, 'Informe etapa, canal e linha.');
    }
    if (!SLUG_PRODUTO.test(produto)) {
      throw new ErroHttp(400, "Produto inválido: use o slug canônico (ex.: neuromindpro) ou '*'.");
    }

    const eEmail = canal === 'email';
    const { rows } = await query(
      `INSERT INTO mensagens_regua
         (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (etapa, canal, linha, produto) DO UPDATE SET
         assunto = EXCLUDED.assunto, corpo_html = EXCLUDED.corpo_html,
         botao = EXCLUDED.botao, destino = EXCLUDED.destino,
         texto = EXCLUDED.texto, ativo = EXCLUDED.ativo, atualizado_em = now()
       RETURNING ${COLUNAS_MSG}`,
      [
        etapa, canal, linha, produto,
        // No SMS estes campos não existem: gravar string vazia deixaria lixo
        // que depois conta como "preenchido" em qualquer verificação.
        eEmail ? (c.assunto ?? null) : null,
        eEmail ? (c.corpo_html ?? null) : null,
        eEmail ? (c.botao ?? null) : null,
        eEmail ? (c.destino ?? null) : null,
        c.texto ?? '',
        c.ativo !== false,
      ],
    );
    resposta.code(req.method === 'POST' ? 201 : 200);
    return rows[0];
  };

  app.post('/api/mensagens/', {
    schema: {
      tags: ['Régua'],
      summary: 'Cria ou sobrescreve uma mensagem',
      security: [{ bearerAuth: [] }],
      body: { $ref: 'MensagemRegua#' },
      response: { 201: { $ref: 'MensagemRegua#' } },
    },
    onRequest: [app.exigirAdmin],
  }, gravar);

  for (const metodo of ['put', 'patch']) {
    app[metodo]('/api/mensagens/:pk/', {
      schema: {
        tags: ['Régua'],
        summary: 'Grava a mensagem desta chave',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { pk: { type: 'string', examples: ['1:email:1'] } }, required: ['pk'] },
        body: { $ref: 'MensagemRegua#' },
        response: { 200: { $ref: 'MensagemRegua#' } },
      },
      onRequest: [app.exigirAdmin],
    }, gravar);
  }

  app.delete('/api/mensagens/:pk/', {
    schema: {
      tags: ['Régua'],
      summary: 'Apaga uma mensagem',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { pk: { type: 'string' } }, required: ['pk'] },
      response: { 204: { type: 'null' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirAdmin],
  }, async (req, resposta) => {
    const { etapa, canal, linha, produto } = partirChave(req.params.pk);
    const r = await query(
      'DELETE FROM mensagens_regua WHERE etapa = $1 AND canal = $2 AND linha = $3 AND produto = $4',
      [etapa, canal, linha, produto],
    );
    if (!r.rowCount) throw new ErroHttp(404, 'Mensagem não encontrada.');
    resposta.code(204);
    return null;
  });

  /* ═════════════════════════  linhas de copy  ═════════════════════ */

  registrarCrud(app, {
    rota: '/api/linhas-copy/',
    tabela: 'painel_linhas_copy',
    chave: 'linha',
    esquema: PainelLinhaCopy,
    tag: 'Linhas',
    colunas: 'linha, nome, intuito, ordem',
    buscaEm: ['nome', 'intuito'],
    ordenaveis: ['linha', 'nome', 'ordem'],
    ordemPadrao: 'ordem ASC, linha ASC',
  });

  /**
   * Clonar uma linha inteira.
   *
   * Uma linha em branco são doze mensagens para escrever antes de poder ativar.
   * Copiar é o caminho normal — e faz numa transação: uma linha registrada com
   * metade das mensagens apareceria como ativável e falharia no disparo.
   */
  app.post('/api/linhas-copy/:linha/copiar/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Cria uma linha nova a partir desta',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { linha: { type: 'string' } }, required: ['linha'] },
      body: {
        type: 'object',
        properties: {
          linha: { type: 'string', maxLength: 4, description: 'Número da linha nova.' },
          nome: { type: 'string', maxLength: 60 },
          intuito: { type: ['string', 'null'] },
          ordem: { type: 'integer' },
        },
        required: ['linha', 'nome'],
      },
      response: {
        201: {
          type: 'object',
          properties: { linha: { type: 'string' }, copiadas: { type: 'integer' } },
        },
        409: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirAdmin],
  }, async (req, resposta) => {
    const origem = req.params.linha;
    const { linha: nova, nome, intuito = null, ordem } = req.body;

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(
        `INSERT INTO painel_linhas_copy (linha, nome, intuito, ordem)
         VALUES ($1, $2, $3, $4::smallint)`,
        // `??` e `||` não se misturam sem parêntese: o JS recusa a ambiguidade
        // em vez de escolher uma precedência por você.
        [nova, nome, intuito, ordem ?? (Number(nova) || 0)],
      );
      // `produto` PRECISA vir junto no clone. Sem ele, toda a copy por produto
      // da linha de origem colapsaria em '*' — e o DO NOTHING engoliria as
      // colisões sem avisar: 200 na hora, copy perdida descoberta semanas depois.
      const r = await cliente.query(
        `INSERT INTO mensagens_regua
           (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo, atualizado_em)
         SELECT etapa, canal, $1::text, produto, assunto, corpo_html, botao, destino, texto, ativo, now()
         FROM mensagens_regua WHERE linha = $2::text
         ON CONFLICT (etapa, canal, linha, produto) DO NOTHING`,
        [nova, origem],
      );
      await cliente.query('COMMIT');
      resposta.code(201);
      return { linha: nova, copiadas: r.rowCount };
    } catch (err) {
      await cliente.query('ROLLBACK');
      if (err.code === '23505') throw new ErroHttp(409, `A linha ${nova} já existe.`);
      throw err;
    } finally {
      cliente.release();
    }
  });

  /* ══════════════════════════  configuração  ══════════════════════ */

  registrarCrud(app, {
    rota: '/api/config/',
    tabela: 'config_disparos',
    chave: 'chave',
    esquema: ConfigDisparo,
    tag: 'Configuração',
    colunas: 'chave, valor',
    ordenaveis: ['chave'],
    ordemPadrao: 'chave ASC',
  });

  /* ═══════════════════════  linha ativa e histórico  ══════════════ */

  app.get('/api/linha-ativa/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Qual linha de copy está no ar',
      description: 'A VERDADE é `config_disparos.linha_ativa` — é o que o robô lê a cada '
        + 'disparo. `trocada_em`/`trocada_por` só existem quando a troca passou pelo painel.',
      security: [{ bearerAuth: [] }],
      response: { 200: { $ref: 'PainelLinhaMensagens#' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async () => {
    const cfg = await query("SELECT valor FROM config_disparos WHERE chave = 'linha_ativa'");
    if (!cfg.rows[0]) throw new ErroHttp(404, 'Nenhuma linha ativa registrada.');
    const linha = String(cfg.rows[0].valor);

    const reg = await query(
      'SELECT linha, trocada_em, trocada_por, resposta FROM painel_linha_mensagens WHERE id = 1',
    );
    const r = reg.rows[0];
    // Autoria só quando o registro corresponde ao que está de fato no ar:
    // dizer "fulano trocou" ao lado de uma linha que não foi ele seria mentira.
    const combina = r && String(r.linha) === linha;
    return {
      linha,
      trocada_em: combina ? r.trocada_em : null,
      trocada_por: combina ? r.trocada_por : null,
      resposta: combina ? r.resposta : null,
    };
  });

  app.put('/api/linha-ativa/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Registra qual linha passou a valer',
      description: 'Grava `config_disparos.linha_ativa` E o registro de autoria, '
        + 'numa transação — meio caminho aqui deixaria o painel afirmando uma '
        + 'campanha que o robô não está usando. Recusa linha incompleta: a conta '
        + "é sobre o produto '*' (o padrão), porque a cascata garante que todo "
        + 'produto tem para onde cair.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          linha: { type: 'string', maxLength: 4 },
          resposta: { type: ['string', 'null'], description: 'O que o n8n respondeu, para auditoria.' },
        },
        required: ['linha'],
      },
      response: { 200: { $ref: 'PainelLinhaMensagens#' }, 400: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirAdmin],
  }, async (req) => {
    const linha = String(req.body.linha);
    const existe = await query('SELECT 1 FROM painel_linhas_copy WHERE linha = $1', [linha]);
    if (!existe.rowCount) throw new ErroHttp(400, `A linha ${linha} não está cadastrada.`);

    /*
     * Antes, quem garantia a completude era só o webhook do n8n — chamar esta
     * rota direto punha no ar uma linha incompleta. A conta usa `produto = '*'`
     * de propósito: exigir copy de TODO produto em TODA etapa faria meia dúzia
     * de mensagens de um produto travarem a troca de linha do painel inteiro.
     */
    const faltas = await query(
      `SELECT count(*)::int AS faltam
       FROM etapas_regua e
       CROSS JOIN (VALUES ('email'), ('sms')) AS c(canal)
       WHERE e.ativo
         AND NOT EXISTS (SELECT 1 FROM mensagens_regua m
                          WHERE m.etapa = e.etapa AND m.canal = c.canal
                            AND m.linha = $1 AND m.produto = '*' AND m.ativo)`,
      [linha],
    );
    if (faltas.rows[0].faltam > 0) {
      throw new ErroHttp(400, `A linha ${linha} está incompleta: faltam `
        + `${faltas.rows[0].faltam} mensagens padrão ('*') para as etapas ativas.`);
    }

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(
        `INSERT INTO config_disparos (chave, valor) VALUES ('linha_ativa', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [linha],
      );
      const { rows } = await cliente.query(
        `INSERT INTO painel_linha_mensagens (id, linha, trocada_em, trocada_por, resposta)
         VALUES (1, $1, now(), $2, $3)
         ON CONFLICT (id) DO UPDATE SET linha = EXCLUDED.linha, trocada_em = now(),
           trocada_por = EXCLUDED.trocada_por, resposta = EXCLUDED.resposta
         RETURNING linha, trocada_em, trocada_por, resposta`,
        [linha, req.usuario.user_id, (req.body.resposta ?? null)],
      );
      await cliente.query('COMMIT');
      return rows[0];
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw err;
    } finally {
      cliente.release();
    }
  });

  app.get('/api/linha-historico/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Histórico de trocas de linha',
      description: 'Inclui as tentativas que FALHARAM — é justamente delas que se '
        + 'descobre que o webhook parou de responder.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { ...paginacaoParams, linha: { type: 'string' }, sucesso: { type: 'boolean' } },
      },
      response: { 200: paginado('PainelLinhaHistorico') },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const valores = [];
    const partes = [];
    for (const campo of ['linha', 'sucesso']) {
      if (req.query[campo] === undefined) continue;
      valores.push(req.query[campo]);
      partes.push(`${campo} = $${valores.length}`);
    }
    const onde = partes.length ? `WHERE ${partes.join(' AND ')}` : '';
    const cont = await query(`SELECT count(*)::int AS n FROM painel_linha_historico ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const { rows } = await query(
      `SELECT id, linha, em, por, sucesso, detalhe FROM painel_linha_historico ${onde}
       ORDER BY em DESC LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  app.post('/api/linha-historico/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Registra uma tentativa de troca',
      description: 'Existe para o painel poder anotar TAMBÉM o que deu errado. '
        + 'Sem esta rota, só as trocas bem-sucedidas deixariam rastro.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          linha: { type: 'string', maxLength: 4 },
          sucesso: { type: 'boolean' },
          detalhe: { type: ['string', 'null'], maxLength: 500 },
        },
        required: ['linha', 'sucesso'],
      },
      response: { 201: { $ref: 'PainelLinhaHistorico#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req, resposta) => {
    const { rows } = await query(
      `INSERT INTO painel_linha_historico (linha, por, sucesso, detalhe)
       VALUES ($1, $2, $3, $4) RETURNING id, linha, em, por, sucesso, detalhe`,
      [String(req.body.linha), req.usuario.user_id, req.body.sucesso, (req.body.detalhe ?? null)],
    );
    resposta.code(201);
    return rows[0];
  });

  app.get('/api/linha-historico/:id/', {
    schema: {
      tags: ['Linhas'],
      summary: 'Lê uma tentativa',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      response: { 200: { $ref: 'PainelLinhaHistorico#' }, 404: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      'SELECT id, linha, em, por, sucesso, detalhe FROM painel_linha_historico WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Registro não encontrado.');
    return rows[0];
  });
}
