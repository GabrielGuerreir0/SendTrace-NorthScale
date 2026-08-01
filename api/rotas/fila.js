/**
 * A fila de disparos — `disparos_pos_venda`.
 *
 * É a tabela que o worker do n8n consome, então tudo aqui tem consequência
 * fora do painel: escrever exige administrador, e `/pendentes/` existe para o
 * worker perguntar "o que já venceu?" sem ter que reproduzir a regra.
 */
import { query } from '../../server/db.js';
import { DisparoPosVenda, DisparoEntrada, paginado, paginacaoParams } from '../esquemas.js';
import { registrarCrud, fatiar, montarBusca, montarOrdem, ErroHttp } from '../comum.js';

const COLUNAS = `id, transacao_id, nome, email, telefone, produto, etapa_atual,
  proximo_disparo, status, tentativas, ultimo_erro, claimed_at, criado_em,
  chat_resumo, chat_resumo_em`;

const BUSCA_EM = ['transacao_id', 'nome', 'email', 'telefone', 'produto'];
const ORDENAVEIS = ['id', 'criado_em', 'proximo_disparo', 'etapa_atual', 'tentativas', 'status'];

export default async function rotasFila(app) {
  /*
   * Vencidos, na ordem em que devem sair.
   *
   * Precisa ser declarada ANTES do CRUD: sem isso, `/api/disparos/pendentes/`
   * casaria com `/api/disparos/:id/` e o "pendentes" viraria um id.
   */
  app.get('/api/disparos/pendentes/', {
    schema: {
      tags: ['Fila'],
      summary: 'Disparos ativos cujo horário já passou',
      description: 'O que o worker deveria estar processando agora: `status = ativo` '
        + 'e `proximo_disparo <= agora`, do mais antigo para o mais novo.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...paginacaoParams,
          etapa_atual: { type: 'integer' },
          atraso_min: { type: 'integer', description: 'Só os vencidos há pelo menos N minutos.' },
        },
      },
      response: { 200: paginado('DisparoPosVenda') },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const valores = [];
    const partes = ["status = 'ativo'"];

    if (req.query.atraso_min !== undefined) {
      valores.push(Number(req.query.atraso_min));
      partes.push(`proximo_disparo <= now() - make_interval(mins => $${valores.length}::int)`);
    } else {
      partes.push('proximo_disparo <= now()');
    }
    if (req.query.etapa_atual !== undefined) {
      valores.push(Number(req.query.etapa_atual));
      partes.push(`etapa_atual = $${valores.length}`);
    }

    const onde = `WHERE ${partes.join(' AND ')}`;
    const cont = await query(`SELECT count(*)::int AS n FROM disparos_pos_venda ${onde}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const { rows } = await query(
      `SELECT ${COLUNAS} FROM disparos_pos_venda ${onde}
       ORDER BY proximo_disparo ASC LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  /*
   * O resumo do chat de suporte, gravado pelo CHATBOT (outra aplicação).
   *
   * O bot conhece o E-MAIL do cliente, não o id do pedido — então a rota
   * localiza por e-mail, sem diferenciar maiúsculas, e grava o resumo em
   * todos os pedidos daquele cliente. Exige sessão, não administrador: o
   * resumo é anotação interna e não muda nada do que sai para o cliente —
   * a regra "só admin escreve" existe para o que os clientes recebem.
   *
   * Declarada ANTES do CRUD pelo mesmo motivo de /pendentes/: "chat" não
   * pode ser engolido como se fosse um :id.
   */
  app.put('/api/disparos/chat/', {
    schema: {
      tags: ['Fila'],
      summary: 'Grava o "último atendimento" (resumo de chat) de um pedido ou cliente',
      description: 'Para o chatbot de suporte: com `transacao_id`, grava o resumo NAQUELE '
        + 'pedido; com `email`, em todos os pedidos do cliente. É também o caminho dos '
        + 'resumos PARCIAIS (checkpoints durante a conversa) — cada gravação sobrescreve '
        + 'a anterior, sem criar registro no histórico. Mandar `resumo: null` apaga.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['resumo'],
        properties: {
          transacao_id: { type: 'string', maxLength: 120, description: 'O pedido da conversa — a chave preferida.' },
          email: { type: 'string', maxLength: 200, description: 'Alternativa: todos os pedidos deste e-mail.' },
          resumo: { type: ['string', 'null'], maxLength: 10_000, description: 'O resumo da conversa. Nulo apaga.' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            atualizados: { type: 'integer', description: 'Quantos pedidos receberam o resumo.' },
            ids: { type: 'array', items: { type: 'integer' } },
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
    const { resumo } = req.body;
    if (!transacao && !email) {
      throw new ErroHttp(400, 'Informe transacao_id ou email.');
    }

    // Apagar o resumo apaga o carimbo junto: um "quando" sem resumo mentiria
    // que houve chat.
    const { rows, rowCount } = await query(
      `UPDATE disparos_pos_venda
       SET chat_resumo = $2,
           chat_resumo_em = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
       WHERE ${transacao ? 'transacao_id = $1' : 'lower(email) = lower($1)'}
       RETURNING id`,
      [transacao ?? email, resumo],
    );
    if (!rowCount) {
      throw new ErroHttp(404, transacao
        ? `Nenhum pedido com a transação ${transacao}.`
        : `Nenhum pedido com o e-mail ${email}.`);
    }
    return { atualizados: rowCount, ids: rows.map((r) => r.id) };
  });

  registrarCrud(app, {
    rota: '/api/disparos/',
    tabela: 'disparos_pos_venda',
    chave: 'id',
    esquema: DisparoPosVenda,
    esquemaEntrada: DisparoEntrada,
    tag: 'Fila',
    colunas: COLUNAS,
    // Quem gravar chat_resumo pelo CRUD (admin) ganha o carimbo de horário
    // junto — sem isso o resumo mudaria e o "quando" ficaria mentindo.
    aoEntrar: (corpo) => (corpo.chat_resumo !== undefined
      ? { ...corpo, chat_resumo_em: new Date() }
      : corpo),
    buscaEm: BUSCA_EM,
    ordenaveis: ORDENAVEIS,
    ordemPadrao: 'proximo_disparo ASC NULLS LAST',
    filtros: {
      status: { coluna: 'status', esquema: { type: 'string', description: "Ex.: 'ativo', 'cancelado'." } },
      transacao_id: { coluna: 'transacao_id' },
      etapa_atual: { coluna: 'etapa_atual', numero: true, esquema: { type: 'integer' } },
      etapa_atual__gte: { coluna: 'etapa_atual', op: '>=', numero: true, esquema: { type: 'integer' } },
      etapa_atual__lte: { coluna: 'etapa_atual', op: '<=', numero: true, esquema: { type: 'integer' } },
      criado_em__gte: { coluna: 'criado_em', op: '>=', esquema: { type: 'string', format: 'date-time' } },
      criado_em__lte: { coluna: 'criado_em', op: '<=', esquema: { type: 'string', format: 'date-time' } },
      proximo_disparo__gte: { coluna: 'proximo_disparo', op: '>=', esquema: { type: 'string', format: 'date-time' } },
      proximo_disparo__lte: { coluna: 'proximo_disparo', op: '<=', esquema: { type: 'string', format: 'date-time' } },
      produto: { coluna: 'produto', esquema: { type: 'string', description: 'Nome exato da oferta, como está na fila.' } },
    },
  });
}
