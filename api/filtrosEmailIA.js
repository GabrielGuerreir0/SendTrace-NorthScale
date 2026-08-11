/**
 * O {filtro} dinâmico da Central de E-mail IA, compartilhado por GET /api/dados
 * (tickets e detalhes) — período, busca livre e os recortes por enum descritos
 * na §4.2 da especificação.
 *
 * Cada valor vira um BIND PARAMETER, nunca texto concatenado — o painel usa
 * `pg` com prepared statements, então a técnica de base64 do protótipo (que
 * só existia porque ele rodava `psql` via subprocess) não é necessária aqui.
 * Os enums ainda são validados contra allowlist antes de entrar na query: não
 * é defesa contra injeção (bind param já resolve isso), é para um valor
 * inventado na URL não silenciosamente não casar com nada.
 */

export const CATEGORIAS = [
  'devolucao', 'reclamacao', 'duvida_produto', 'duvida_pedido', 'orcamento', 'elogio', 'troca', 'garantia', 'outro',
];
export const SENTIMENTOS = ['positivo', 'neutro', 'negativo', 'muito_negativo'];
export const URGENCIAS = ['baixa', 'media', 'alta'];
export const AREAS_PROBLEMA = ['entrega', 'produto', 'codigo_rastreio', 'pagamento', 'atendimento', 'anuncio_informacao', 'outro'];
export const RESPONSAVEIS = ['transportadora', 'fulfillment', 'nossa_empresa', 'fabricante', 'plataforma_pagamento', 'cliente', 'indefinido'];
export const PROBLEMAS_PAGAMENTO = [
  'compra_nao_reconhecida', 'cobranca_duplicada', 'cobranca_valor_maior', 'pede_cancelamento_reembolso',
  'reembolso_nao_recebido', 'outro_pagamento', 'sem_problema_pagamento',
];
export const PLATAFORMAS = [
  'digistore24', 'buygoods', 'jvzoo', 'interno', 'hotmart', 'eduzz', 'monetizze', 'kiwify',
  'clickbank', 'cartpanda', 'braintree', 'paypal', 'stripe', 'shipoffers', 'helpdesk',
];
export const MOTIVOS_DEVOLUCAO = [
  'produto_com_defeito', 'produto_errado', 'dano_no_transporte', 'atraso_na_entrega', 'arrependimento',
  'tamanho_ou_medida_errada', 'diferente_do_anuncio', 'outro',
];

function listaValida(bruto, permitidos) {
  if (!bruto) return null;
  const valores = String(bruto).split(',').map((v) => v.trim()).filter((v) => permitidos.includes(v));
  return valores.length ? valores : null;
}

/**
 * Filtro sobre email_ia.emails: dias, q (assunto/nome/e-mail/resumo/produto/
 * pedido via ILIKE), cat, sent, urg, pede, area, resp, pgto, plat.
 *
 * `inicio` é a posição do primeiro placeholder — cada rota decide onde o
 * filtro entra na lista de parâmetros da consulta que o usa.
 */
export function filtroEmails(qs, inicio = 1) {
  const condicoes = [];
  const valores = [];
  let i = inicio;

  const dias = Number(qs.dias);
  if (Number.isFinite(dias) && dias > 0) {
    condicoes.push(`data_email >= now() - make_interval(days => $${i}::int)`);
    valores.push(dias);
    i += 1;
  }

  if (qs.q) {
    condicoes.push(`(assunto ILIKE $${i} OR remetente_nome ILIKE $${i} OR remetente_email ILIKE $${i}
      OR resumo ILIKE $${i} OR produto_mencionado ILIKE $${i} OR numero_pedido ILIKE $${i})`);
    valores.push(`%${qs.q}%`);
    i += 1;
  }

  const cat = listaValida(qs.cat, CATEGORIAS);
  if (cat) { condicoes.push(`categoria = ANY($${i}::text[])`); valores.push(cat); i += 1; }

  const sent = listaValida(qs.sent, SENTIMENTOS);
  if (sent) { condicoes.push(`sentimento = ANY($${i}::text[])`); valores.push(sent); i += 1; }

  const urg = listaValida(qs.urg, URGENCIAS);
  if (urg) { condicoes.push(`urgencia = ANY($${i}::text[])`); valores.push(urg); i += 1; }

  if (qs.pede === 'true' || qs.pede === 'false') {
    condicoes.push(`pede_resposta = $${i}::boolean`);
    valores.push(qs.pede === 'true');
    i += 1;
  }

  const area = listaValida(qs.area, AREAS_PROBLEMA);
  if (area) { condicoes.push(`area_problema = ANY($${i}::text[])`); valores.push(area); i += 1; }

  const resp = listaValida(qs.resp, RESPONSAVEIS);
  if (resp) { condicoes.push(`responsavel = ANY($${i}::text[])`); valores.push(resp); i += 1; }

  const pgto = listaValida(qs.pgto, PROBLEMAS_PAGAMENTO);
  if (pgto) { condicoes.push(`problema_pagamento = ANY($${i}::text[])`); valores.push(pgto); i += 1; }

  const plat = listaValida(qs.plat, PLATAFORMAS);
  if (plat) { condicoes.push(`plataforma_origem = ANY($${i}::text[])`); valores.push(plat); i += 1; }

  return { sql: condicoes.length ? condicoes.join(' AND ') : 'true', valores, fim: i };
}

/**
 * Filtro sobre email_ia.tickets: período (por ultimo_email_em) + busca — `tq`
 * é a busca própria da tabela de tickets (nome/e-mail); sem ela, cai para o
 * `q` global, para a busca do cabeçalho continuar filtrando a tabela também.
 */
export function filtroTickets(qs, inicio = 1) {
  const condicoes = [];
  const valores = [];
  let i = inicio;

  const dias = Number(qs.dias);
  if (Number.isFinite(dias) && dias > 0) {
    condicoes.push(`ultimo_email_em >= now() - make_interval(days => $${i}::int)`);
    valores.push(dias);
    i += 1;
  }

  const busca = qs.tq || qs.q;
  if (busca) {
    condicoes.push(`(nome ILIKE $${i} OR remetente_email ILIKE $${i})`);
    valores.push(`%${busca}%`);
    i += 1;
  }

  return {
    sql: condicoes.length ? condicoes.join(' AND ') : 'true', valores, fim: i, temBusca: Boolean(busca),
  };
}
