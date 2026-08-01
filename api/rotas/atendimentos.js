/**
 * O histórico de atendimentos do chatbot — a memória do suporte.
 *
 * Duas rotas, um contrato simples:
 *
 *   GET  /api/atendimentos/?email=…  → os atendimentos DAQUELE cliente, do
 *        mais novo ao mais antigo. É o que a IA lê antes de responder e o
 *        que o painel mostra no duplo clique da linha.
 *
 *   POST /api/atendimentos/          → grava o resumo de uma conversa
 *        encerrada. Além de inserir no histórico, espelha o texto em
 *        disparos_pos_venda.chat_resumo — o atalho "último atendimento"
 *        que a tabela de pedidos exibe — numa tacada só, para as duas
 *        visões nunca divergirem.
 *
 * Ambas exigem sessão, não admin: o token de serviço do bot passa, e o
 * resumo é anotação interna — não muda nada do que sai para o cliente.
 */
import { query } from '../../server/db.js';
import { paginacaoParams, paginado } from '../esquemas.js';
import { fatiar, ErroHttp } from '../comum.js';

const COLUNAS = 'id, email, resumo, desfecho, risco_chargeback, criado_em';

export default async function rotasAtendimentos(app) {
  app.get('/api/atendimentos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Histórico de atendimentos de um cliente',
      description: 'Os resumos que o chatbot gravou para este e-mail, do mais novo '
        + 'ao mais antigo. `?email=` é obrigatório: o histórico é sempre de UM cliente '
        + '— não existe listagem geral, de propósito.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', maxLength: 200, description: 'E-mail exato do cliente (sem diferenciar maiúsculas).' },
          ...paginacaoParams,
        },
      },
      response: { 200: paginado('Atendimento'), 400: { $ref: 'Erro#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!email) throw new ErroHttp(400, 'Informe ?email= — o histórico é sempre de um cliente.');

    const cont = await query(
      'SELECT count(*)::int AS n FROM chat_atendimentos WHERE lower(email) = $1',
      [email],
    );
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const { rows } = await query(
      `SELECT ${COLUNAS} FROM chat_atendimentos
       WHERE lower(email) = $1
       ORDER BY criado_em DESC LIMIT $2 OFFSET $3`,
      [email, limit, offset],
    );
    return envelope(rows);
  });

  app.post('/api/atendimentos/', {
    schema: {
      tags: ['Suporte'],
      summary: 'Registra o resumo de uma conversa encerrada',
      description: 'Insere no histórico E atualiza o "último atendimento" '
        + '(chat_resumo) de todos os pedidos daquele e-mail — as duas visões '
        + 'andam sempre juntas.',
      security: [{ bearerAuth: [] }],
      body: { $ref: 'Atendimento#' },
      response: { 201: { $ref: 'Atendimento#' } },
    },
    onRequest: [app.exigirSessao],
  }, async (req, resposta) => {
    const email = String(req.body.email).trim();
    const resumo = String(req.body.resumo).trim();
    if (!email || !resumo) throw new ErroHttp(400, 'email e resumo são obrigatórios.');

    const { rows } = await query(
      `INSERT INTO chat_atendimentos (email, resumo, desfecho, risco_chargeback)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUNAS}`,
      [email, resumo, req.body.desfecho ?? null, req.body.risco_chargeback === true],
    );

    // O espelho no pedido é conveniência, não a fonte da verdade — se o
    // cliente não tiver pedido na fila (comprou por fora, e-mail diferente),
    // o histórico acima já guardou tudo mesmo assim.
    await query(
      `UPDATE disparos_pos_venda
       SET chat_resumo = $2, chat_resumo_em = now()
       WHERE lower(email) = lower($1)`,
      [email, resumo],
    );

    resposta.code(201);
    return rows[0];
  });
}
