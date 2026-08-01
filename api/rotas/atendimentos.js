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

const COLUNAS = 'id, transacao_id, email, resumo, desfecho, risco_chargeback, criado_em';

/** O pedido dono de uma transação — nome, e-mail e produto vêm dele. */
async function pedidoDaTransacao(transacaoId) {
  const { rows } = await query(
    `SELECT transacao_id, nome, email, produto FROM disparos_pos_venda
     WHERE transacao_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [transacaoId],
  );
  return rows[0] ?? null;
}

/** O pedido mais recente de um e-mail — para resolver a transação de quem só tem o e-mail. */
async function pedidoDoEmail(email) {
  const { rows } = await query(
    `SELECT transacao_id, nome, email, produto FROM disparos_pos_venda
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

    const { rows } = await query(
      `INSERT INTO chat_atendimentos (transacao_id, email, resumo, desfecho, risco_chargeback)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUNAS}`,
      [transacao, email, resumo, req.body.desfecho ?? null, req.body.risco_chargeback === true],
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
}
