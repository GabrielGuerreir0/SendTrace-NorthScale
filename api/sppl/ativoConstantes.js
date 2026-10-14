/**
 * SPPL — Suporte Ativo (2º momento da Késsia, PDF "SPPL - NORTHSCALE", seção 5). As listas abaixo são EXATAMENTE as do PDF; o banco guarda texto livre
 * (migração 101) para a lista poder evoluir sem migração: quem valida é a API.
 */
export const STATUS_LOGISTICO = ['Caso novo - Analisar', 'Enviado para fulfillment - Ag. rastreio', 'Pedido enviado - Ag. entrega'];

export const MOTIVO_PROBLEMA = [
  'Caso novo — Analisar', 'Pedido recusado pelo cliente', 'Endereço incompleto', 'Cliente mudou de endereço', 'Pedido parado/atrasado pela logística',
  'Pedido aguardando retirada', 'Pedido parado nos Correios (a pedido do cliente)', 'Devolução ao remetente', 'Confirmar recebimento', 'Pedido retornou', 'Ausente para recebimento',
];

export const STATUS_SUPORTE = [
  'Caso novo - Analisar', 'Problema identificado - Entrar em contato com cliente', 'Em atendimento - Conversando com cliente', 'Em atendimento - Em fase de reenvio ao cliente',
  'Resolvido - Entregue ao cliente', 'Sem acordo - Pediu reembolso', 'Sem acordo - Reembolsado', 'Não resolvido - Cliente não retornou o contato',
];

export const STATUS_TICKET = ['aberto', 'resolvido', 'fechado'];
export const ROTULO_STATUS_TICKET = { aberto: 'Aberto', resolvido: 'Resolvido', fechado: 'Fechado' };

/** Propriedades que a equipe pode alterar (individual e em massa). `tipo`: lista fechada ou texto livre. */
export const PROPRIEDADES = {
  status_logistico: { lista: STATUS_LOGISTICO },
  motivo_problema: { lista: MOTIVO_PROBLEMA },
  status_suporte: { lista: STATUS_SUPORTE },
  status_ticket: { lista: STATUS_TICKET },
  rastreio_reenvio: { texto: 200 },
  link_reenvio: { texto: 500 },
};

/** Marcadores aceitos na mensagem em massa; cada cliente recebe a mensagem com os dados DELE. */
export const MARCADORES = ['nome', 'pedido', 'produto', 'rastreio', 'link_rastreio'];

/** Limites de segurança do envio em massa (a caixa support@ é a mesma do atendimento: um bloqueio por excesso derrubaria o suporte). */
export const MAX_POR_LOTE = 200;
export const MAX_SELECIONAR = 1000;
