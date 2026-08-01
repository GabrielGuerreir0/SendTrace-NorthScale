/**
 * A fila de disparos — `disparos_pos_venda`.
 *
 * É a tabela que o worker do n8n consome, então tudo aqui tem consequência
 * fora do painel: escrever exige administrador, e `/pendentes/` existe para o
 * worker perguntar "o que já venceu?" sem ter que reproduzir a regra.
 */
import { query } from '../../server/db.js';
import { DisparoPosVenda, DisparoEntrada, paginado, paginacaoParams } from '../esquemas.js';
import { registrarCrud, fatiar, montarBusca, montarOrdem } from '../comum.js';

const COLUNAS = `id, transacao_id, nome, email, telefone, produto, etapa_atual,
  proximo_disparo, status, tentativas, ultimo_erro, claimed_at, criado_em`;

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

  registrarCrud(app, {
    rota: '/api/disparos/',
    tabela: 'disparos_pos_venda',
    chave: 'id',
    esquema: DisparoPosVenda,
    esquemaEntrada: DisparoEntrada,
    tag: 'Fila',
    colunas: COLUNAS,
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
