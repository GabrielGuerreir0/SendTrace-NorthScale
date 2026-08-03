/**
 * O histórico de atendimentos do chatbot — a memória do suporte.
 *
 * A chave é o ID DE TRANSAÇÃO: a conversa pertence a UM pedido, não a um
 * endereço de e-mail — um cliente com dois pedidos não mistura os históricos.
 * O e-mail continua guardado (e aceito como fallback de busca, inclusive para
 * registros de antes da chave existir).
 *
 *   GET  /api/atendimentos/?transacao_id=…  (e/ou ?email=…)
 *        → os atendimentos daquele pedido/cliente, do mais novo ao mais
 *          antigo. Com os dois parâmetros, casa qualquer um (OR) — é o que
 *          costura histórico antigo por e-mail com o novo por transação.
 *
 *   POST /api/atendimentos/
 *        → grava o resumo de uma conversa encerrada. Aceita transacao_id,
 *          email ou ambos; o que faltar é resolvido consultando a fila — e a
 *          resposta volta com o NOME DO CLIENTE e o PRODUTO do pedido, para
 *          quem grava já receber a confirmação de a quem o registro pertence.
 *          Também espelha o texto como "último atendimento" (chat_resumo) do
 *          pedido, numa tacada só.
 *
 * Ambas exigem sessão, não admin: o token de serviço do bot passa.
 */
import { query } from '../../server/db.js';
import { paginacaoParams, paginado } from '../esquemas.js';
import { fatiar, ErroHttp } from '../comum.js';

const COLUNAS = `id, transacao_id, email, resumo, desfecho, risco_chargeback,
  motivo, topico_id, resolvido, reembolso_pedido, reembolso_evitado, csat,
  duracao_s, iniciado_em, etapa_regua, criado_em`;

/**
 * Resolve o TÓPICO de um atendimento: acha pelo slug ou cria na hora.
 *
 * Criar aqui (e não numa rota à parte) é o que garante a relação: nenhum
 * atendimento fica com um motivo que não existe em chat_topicos. A descrição
 * só é gravada quando o tópico ainda não tem uma — cada conversa nova não
 * pode ficar reescrevendo o critério do tópico.
 */
async function resolverTopico(slug, nome, descricao) {
  if (!slug) return null;
  const nomeFinal = String(nome ?? '').trim()
    || slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const { rows } = await query(
    `INSERT INTO chat_topicos (slug, nome, descricao)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE
       SET descricao = coalesce(chat_topicos.descricao, EXCLUDED.descricao)
     RETURNING id`,
    [slug, nomeFinal.slice(0, 120), String(descricao ?? '').trim().slice(0, 500) || null],
  );
  return rows[0]?.id ?? null;
}

/** O pedido dono de uma transação — nome, e-mail, produto e etapa vêm dele. */
async function pedidoDaTransacao(transacaoId) {
  const { rows } = await query(
    `SELECT transacao_id, nome, email, produto, etapa_atual FROM disparos_pos_venda
     WHERE transacao_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [transacaoId],
  );
  return rows[0] ?? null;
}

/** O pedido mais recente de um e-mail — para resolver a transação de quem só tem o e-mail. */
async function pedidoDoEmail(email) {
  const { rows } = await query(
    `SELECT transacao_id, nome, email, produto, etapa_atual FROM disparos_pos_venda
     WHERE lower(email) = lower($1) ORDER BY criado_em DESC LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export default async function rotasAtendimentos(app) {
  app.get('/api/atendimentos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Histórico de atendimentos de um pedido (ou cliente)',
      description: 'Os resumos que o chatbot gravou, do mais novo ao mais antigo. '
        + 'Informe `transacao_id` (a chave preferida), `email`, ou os dois — com '
        + 'ambos, casa qualquer um, costurando o histórico antigo por e-mail com '
        + 'o novo por transação. Não existe listagem geral, de propósito.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          transacao_id: { type: 'string', maxLength: 120 },
          email: { type: 'string', maxLength: 200 },
          ...paginacaoParams,
        },
      },
      response: { 200: paginado('Atendimento'), 400: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const transacao = String(req.query.transacao_id ?? '').trim();
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!transacao && !email) {
      throw new ErroHttp(400, 'Informe ?transacao_id= ou ?email= — o histórico é sempre de um pedido/cliente.');
    }

    const valores = [];
    const conds = [];
    if (transacao) {
      valores.push(transacao);
      conds.push(`transacao_id = $${valores.length}`);
    }
    if (email) {
      valores.push(email);
      conds.push(`lower(email) = $${valores.length}`);
    }
    const onde = `WHERE ${conds.join(' OR ')}`;

    const cont = await query(`SELECT count(*)::int AS n FROM chat_atendimentos ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const { rows } = await query(
      `SELECT ${COLUNAS} FROM chat_atendimentos ${onde}
       ORDER BY criado_em DESC LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  app.post('/api/atendimentos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Registra o resumo de uma conversa encerrada',
      description: 'Chaveia pelo ID de transação. Aceita `transacao_id`, `email` ou '
        + 'ambos — o que faltar é resolvido pela fila. A resposta traz `cliente` '
        + '(nome) e `produto` do pedido, e o texto também vira o "último '
        + 'atendimento" (chat_resumo) daquele pedido.',
      security: [{ bearerAuth: [] }],
      body: { $ref: 'Atendimento#' },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            transacao_id: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            cliente: { type: ['string', 'null'], description: 'Nome do cliente, vindo do pedido.' },
            produto: { type: ['string', 'null'], description: 'Produto do pedido.' },
            resumo: { type: 'string' },
            desfecho: { type: ['string', 'null'] },
            risco_chargeback: { type: 'boolean' },
            motivo: { type: ['string', 'null'] },
            topico_id: { type: ['integer', 'null'] },
            resolvido: { type: ['boolean', 'null'] },
            reembolso_pedido: { type: 'boolean' },
            reembolso_evitado: { type: ['boolean', 'null'] },
            csat: { type: ['integer', 'null'] },
            duracao_s: { type: ['integer', 'null'] },
            etapa_regua: { type: ['integer', 'null'] },
            criado_em: { type: 'string', format: 'date-time' },
          },
        },
        400: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req, resposta) => {
    let transacao = String(req.body.transacao_id ?? '').trim() || null;
    let email = String(req.body.email ?? '').trim() || null;
    const resumo = String(req.body.resumo ?? '').trim();
    if (!resumo) throw new ErroHttp(400, 'resumo é obrigatório.');
    if (!transacao && !email) {
      throw new ErroHttp(400, 'Informe transacao_id ou email — a conversa precisa pertencer a alguém.');
    }

    // Resolve o que faltar — e traz nome/produto para devolver na resposta.
    let pedido = null;
    if (transacao) pedido = await pedidoDaTransacao(transacao);
    if (!pedido && email) pedido = await pedidoDoEmail(email);
    if (pedido) {
      transacao = transacao ?? pedido.transacao_id;
      email = email ?? pedido.email;
    }

    /*
     * Os campos do dashboard. O bot manda o que sabe (motivo, resolvido,
     * reembolso, csat, duração); a etapa da régua é resolvida AQUI, do
     * pedido — o bot não conhece a régua e não precisa conhecer.
     *
     * `reembolso_evitado` só vale quando houve pedido de reembolso: gravar
     * um "evitado" sem pedido inflaria o save rate com conversas que nunca
     * estiveram em risco.
     */
    const reembolsoPedido = req.body.reembolso_pedido === true;
    const iniciadoEm = req.body.iniciado_em && !Number.isNaN(Date.parse(req.body.iniciado_em))
      ? new Date(req.body.iniciado_em)
      : null;

    // O motivo é o SLUG do tópico. O tópico correspondente é achado — ou
    // criado agora, com o nome e a descrição que o bot mandou — e o
    // atendimento nasce relacionado a ele.
    const motivoSlug = String(req.body.motivo ?? '').trim().toLowerCase() || null;
    const topicoId = await resolverTopico(
      motivoSlug, req.body.topico_nome, req.body.topico_descricao,
    );

    const { rows } = await query(
      `INSERT INTO chat_atendimentos
         (transacao_id, email, resumo, desfecho, risco_chargeback,
          motivo, topico_id, resolvido, reembolso_pedido, reembolso_evitado,
          csat, duracao_s, iniciado_em, etapa_regua)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COLUNAS}`,
      [
        transacao, email, resumo, req.body.desfecho ?? null, req.body.risco_chargeback === true,
        motivoSlug,
        topicoId,
        typeof req.body.resolvido === 'boolean' ? req.body.resolvido : null,
        reembolsoPedido,
        reembolsoPedido ? req.body.reembolso_evitado === true : null,
        Number.isInteger(req.body.csat) ? req.body.csat : null,
        Number.isInteger(req.body.duracao_s) ? Math.max(0, req.body.duracao_s) : null,
        iniciadoEm,
        pedido?.etapa_atual ?? null,
      ],
    );

    // O espelho "último atendimento" vai para O PEDIDO da conversa quando a
    // transação é conhecida; sem ela, para todos os pedidos do e-mail — o
    // comportamento antigo, melhor que não espelhar nada.
    if (transacao) {
      await query(
        `UPDATE disparos_pos_venda SET chat_resumo = $2, chat_resumo_em = now()
         WHERE transacao_id = $1`,
        [transacao, resumo],
      );
    } else if (email) {
      await query(
        `UPDATE disparos_pos_venda SET chat_resumo = $2, chat_resumo_em = now()
         WHERE lower(email) = lower($1)`,
        [email, resumo],
      );
    }

    resposta.code(201);
    return {
      ...rows[0],
      cliente: pedido?.nome ?? null,
      produto: pedido?.produto ?? null,
    };
  });

  /*
   * A nota de satisfação (1–5 estrelas), dada DEPOIS do encerramento.
   *
   * O bot grava o atendimento quando a conversa fecha; as estrelas aparecem
   * na tela seguinte. Então a nota chega separada e vai para o atendimento
   * MAIS RECENTE daquele pedido/cliente — uma janela de 24h impede que uma
   * avaliação atrasada caia numa conversa de semanas atrás.
   */
  app.post('/api/atendimentos/csat/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Registra a nota de satisfação (1–5) do último atendimento',
      description: 'A nota vai para o atendimento mais recente (últimas 24h) do '
        + '`transacao_id` ou `email` informado. Repetir a chamada sobrescreve — '
        + 'o cliente pode mudar de ideia no clique seguinte.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['csat'],
        properties: {
          transacao_id: { type: 'string', maxLength: 120 },
          email: { type: 'string', maxLength: 200 },
          csat: { type: 'integer', minimum: 1, maximum: 5 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'O atendimento que recebeu a nota.' },
            csat: { type: 'integer' },
          },
        },
        400: { $ref: 'Erro#' },
        404: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const transacao = String(req.body.transacao_id ?? '').trim() || null;
    const email = String(req.body.email ?? '').trim() || null;
    if (!transacao && !email) {
      throw new ErroHttp(400, 'Informe transacao_id ou email — a nota pertence a uma conversa.');
    }

    const valores = [req.body.csat];
    const conds = [];
    if (transacao) {
      valores.push(transacao);
      conds.push(`transacao_id = $${valores.length}`);
    }
    if (email) {
      valores.push(email);
      conds.push(`lower(email) = lower($${valores.length})`);
    }

    const { rows } = await query(
      `UPDATE chat_atendimentos SET csat = $1
       WHERE id = (SELECT id FROM chat_atendimentos
                   WHERE (${conds.join(' OR ')})
                     AND criado_em >= now() - interval '24 hours'
                   ORDER BY criado_em DESC LIMIT 1)
       RETURNING id, csat`,
      valores,
    );
    if (!rows.length) {
      throw new ErroHttp(404, 'Nenhum atendimento nas últimas 24h para receber a nota.');
    }
    return rows[0];
  });

  /*
   * Os TÓPICOS de contato, com descrição e volume — é o que a IA lê antes de
   * classificar uma conversa: a descrição é o critério de encaixe. Assunto
   * que se enquadra num tópico existente reutiliza o slug dele; assunto
   * realmente novo vira tópico novo no POST /api/atendimentos/.
   */
  app.get('/api/topicos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Os tópicos de contato, com descrição e volume de conversas',
      description: 'Do mais comum ao mais raro. A descrição é o critério de '
        + 'encaixe que a IA usa para decidir se uma conversa nova pertence ao '
        + 'tópico — sem forçar: assunto genuinamente diferente vira tópico novo.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { limite: { type: 'integer', default: 60, maximum: 200 } },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              slug: { type: 'string' },
              nome: { type: 'string' },
              descricao: { type: ['string', 'null'] },
              total: { type: 'integer' },
            },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT t.id, t.slug, t.nome, t.descricao,
              count(a.id)::int AS total
       FROM chat_topicos t
       LEFT JOIN chat_atendimentos a ON a.topico_id = t.id
       GROUP BY t.id ORDER BY total DESC, t.slug LIMIT $1`,
      [Math.min(200, Number(req.query.limite) || 60)],
    );
    return rows;
  });

  /*
   * O vocabulário VIVO de motivos — os assuntos que já existem, com volume.
   *
   * É o que o bot lê antes de classificar uma conversa nova: assunto igual ou
   * muito próximo de um existente REUTILIZA aquele nome (as conversas se
   * mesclam na mesma linha do dashboard); assunto realmente diferente ganha
   * nome novo e vira linha própria. Sem este catálogo, cada conversa
   * inventaria uma grafia e o ranking viraria poeira de motivos únicos.
   */
  app.get('/api/atendimentos/motivos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Os motivos de contato já registrados, do mais comum ao mais raro',
      description: 'O vocabulário vivo: o bot reutiliza estes nomes ao classificar '
        + 'conversas de assunto igual ou próximo, e só cria nome novo quando o '
        + 'assunto é realmente diferente.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { limite: { type: 'integer', default: 60, maximum: 200 } },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              motivo: { type: 'string' },
              total: { type: 'integer' },
            },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT motivo, count(*)::int AS total
       FROM chat_atendimentos
       WHERE motivo IS NOT NULL
       GROUP BY motivo ORDER BY total DESC, motivo LIMIT $1`,
      [Math.min(200, Number(req.query.limite) || 60)],
    );
    return rows;
  });

  /*
   * O backlog da base de conhecimento: perguntas que a IA não soube responder.
   *
   * O bot grava uma linha POR OCORRÊNCIA (não um contador): é o que permite
   * ver "31 vezes, 12 nesta semana" e ler exemplos reais. O ranking é feito
   * pela rota de métricas; aqui é só o registro.
   */
  app.post('/api/perguntas-sem-resposta/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Registra perguntas que a IA não conseguiu responder',
      description: 'Uma linha por ocorrência. Aceita uma pergunta ou um lote '
        + '(`perguntas: [...]`) da mesma conversa. É o backlog de evolução da '
        + 'base de conhecimento.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          pergunta: { type: 'string', maxLength: 500 },
          perguntas: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
          transacao_id: { type: 'string', maxLength: 120 },
          email: { type: 'string', maxLength: 200 },
          produto: { type: 'string', maxLength: 300 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: { gravadas: { type: 'integer' } },
        },
        400: { $ref: 'Erro#' },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req, resposta) => {
    const lote = [
      ...(Array.isArray(req.body.perguntas) ? req.body.perguntas : []),
      ...(req.body.pergunta ? [req.body.pergunta] : []),
    ]
      .map((p) => String(p ?? '').trim().slice(0, 500))
      .filter(Boolean);
    if (!lote.length) throw new ErroHttp(400, 'Informe pergunta ou perguntas.');

    const transacao = String(req.body.transacao_id ?? '').trim() || null;
    const email = String(req.body.email ?? '').trim() || null;
    const produto = String(req.body.produto ?? '').trim() || null;

    let gravadas = 0;
    for (const pergunta of lote) {
      await query(
        `INSERT INTO chat_perguntas_sem_resposta (pergunta, transacao_id, email, produto)
         VALUES ($1, $2, $3, $4)`,
        [pergunta, transacao, email, produto],
      );
      gravadas += 1;
    }
    resposta.code(201);
    return { gravadas };
  });
}
