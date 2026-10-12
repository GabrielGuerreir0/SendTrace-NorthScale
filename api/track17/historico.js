/**
 * Histórico do 17TRACK de UM pedido — usado pela ficha interna, pela página pública /rastreio e pela API da Recoverly.
 * A versão pública nunca leva o motivo da recusa, o payload bruto nem nada além de status, texto da transportadora, cidade, estado e país
 * (CEP e rua nem chegam ao banco). Pedido que o 17TRACK não retornou NÃO some: a resposta diz `disponivel: false` e o resto da tela segue
 * com os dados da fulfillment.
 */
import { query } from '../../server/db.js';

const LIMITE_EVENTOS = 200;

/** Linha do registro do 17TRACK do pedido (ou null se o pedido não tem código / nunca foi registrado). */
export async function registroDoPedido(transacaoId) {
  const { rows } = await query(
    `SELECT g.numero, g.situacao_registro, g.motivo_recusa, g.ultimo_status, g.ultimo_substatus, g.ultimo_evento_em, g.atualizado_em
       FROM rastreio_pedidos p JOIN rastreio_17t_registros g ON g.numero = p.tracking_number
      WHERE p.transacao_id = $1`, [transacaoId]);
  return rows[0] ?? null;
}

export async function eventosDoCodigo(numero) {
  const { rows } = await query(
    `SELECT ocorreu_em, status, substatus, descricao, cidade, estado, pais, provedor_17t
       FROM rastreio_17t_eventos WHERE numero = $1 ORDER BY ocorreu_em DESC NULLS LAST, id DESC LIMIT ${LIMITE_EVENTOS}`, [numero]);
  return rows;
}

/** Ficha interna: registro completo (inclui motivo da recusa) + todos os eventos. */
export async function historicoInterno(transacaoId) {
  const registro = await registroDoPedido(transacaoId);
  const eventos = registro && registro.situacao_registro === 'aceito' ? await eventosDoCodigo(registro.numero) : [];
  return { registro_17track: registro, historico_17track: eventos };
}

/** Público / Recoverly: só o que o cliente pode ver. */
export async function historicoPublico(transacaoId) {
  const registro = await registroDoPedido(transacaoId);
  const eventos = registro && registro.situacao_registro === 'aceito' ? await eventosDoCodigo(registro.numero) : [];
  return {
    fonte_17track: {
      disponivel: eventos.length > 0,
      ultimo_status: eventos.length ? registro.ultimo_status : null,
      atualizado_em: eventos.length ? registro.atualizado_em : null,
    },
    historico_17track: eventos.map((e) => ({ status: e.status, descricao: e.descricao, cidade: e.cidade, estado: e.estado, pais: e.pais, em: e.ocorreu_em })),
  };
}

/** Ocorrências do SPPL do pedido (só a ficha interna). */
export async function ocorrenciasDoPedido(transacaoId) {
  const { rows } = await query(
    `SELECT id, categoria, etapa, prioridade, situacao, responsavel, proxima_acao, aberta_em, prazo_ate, resolvida_em, resultado
       FROM sppl_ocorrencias WHERE transacao_id = $1 ORDER BY aberta_em DESC LIMIT 50`, [transacaoId]);
  return rows;
}
