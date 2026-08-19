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
 * Recorta por produto/loja de alguma VENDA do mesmo cliente, cruzando por
 * e-mail com email_ia.mv_emails_x_pedidos — o único lugar com produto/loja
 * como valor EXATO (mesmo catálogo da barra de produto/plataforma do topo),
 * diferente do `plataforma_origem` de email_ia.emails (que marca e-mail
 * GERADO por uma plataforma, tipo recibo, não a plataforma da venda).
 * Quem nunca teve pedido vinculado fica de fora quando isto está ativo.
 *
 * `colunaEmail` PRECISA vir qualificado com a tabela/alias de fora (ex.:
 * `'tk.remetente_email'`, nunca só `'remetente_email'`) — dentro do EXISTS
 * já existe uma `mv_emails_x_pedidos` com a MESMA coluna, e um nome sem
 * prefixo cai nela em vez de correlacionar com a linha de fora, virando uma
 * comparação sempre-verdadeira (ou sempre-falsa) que ignora o cliente.
 *
 * Se `qs.__emailsProdutoLoja` já vier preenchido (ver resolverEmailsProdutoLoja,
 * chamado uma vez no início de GET /api/dados), usa um `= ANY(array)` em vez
 * do EXISTS — evita repetir o mesmo Seq Scan em mv_emails_x_pedidos em cada
 * uma das ~15 sub-consultas que passam pelo mesmo `qs`.
 */
export function condicaoProdutoLoja(qs, colunaEmail, condicoes, valores, inicio) {
  let i = inicio;

  if (qs.__emailsProdutoLoja) {
    condicoes.push(`lower(${colunaEmail}) = ANY($${i}::text[])`);
    valores.push(qs.__emailsProdutoLoja);
    return i + 1;
  }

  const produto = qs.produto ? String(qs.produto) : null;
  const loja = qs.loja ? String(qs.loja) : null;
  if (!produto && !loja) return i;

  const sub = [`lower(m.remetente_email) = lower(${colunaEmail})`];
  if (produto) { sub.push(`m.produto = $${i}`); valores.push(produto); i += 1; }
  if (loja) { sub.push(`m.plataforma = $${i}`); valores.push(loja); i += 1; }
  condicoes.push(`EXISTS (SELECT 1 FROM email_ia.mv_emails_x_pedidos m WHERE ${sub.join(' AND ')})`);
  return i;
}

/**
 * Resolve produto/loja para uma lista de e-mails (minúsculos) UMA VEZ, antes
 * do fan-out de /api/dados — sem isto, cada uma das ~15 sub-consultas que
 * chamam filtroEmails/filtroTickets reavaliaria o mesmo EXISTS contra
 * mv_emails_x_pedidos (Seq Scan × 15, sem índice em produto/plataforma).
 * Devolve `qs` sem alterar se não houver produto/loja no pedido.
 */
export async function resolverEmailsProdutoLoja(qs, query) {
  if (!qs.produto && !qs.loja) return qs;
  const condicoes = [];
  const valores = [];
  let i = 1;
  if (qs.produto) { condicoes.push(`produto = $${i}`); valores.push(String(qs.produto)); i += 1; }
  if (qs.loja) { condicoes.push(`plataforma = $${i}`); valores.push(String(qs.loja)); i += 1; }
  const { rows } = await query(
    `SELECT DISTINCT lower(remetente_email) AS email FROM email_ia.mv_emails_x_pedidos WHERE ${condicoes.join(' AND ')}`,
    valores,
  );
  return { ...qs, __emailsProdutoLoja: rows.map((r) => r.email) };
}

/**
 * Recorta por período de duas formas, mutuamente exclusivas — `dias` tem
 * prioridade se os dois vierem juntos por engano:
 *   · `dias`: janela relativa (últimos N dias), como já era.
 *   · `data_de`/`data_ate`: intervalo absoluto (calendário) — qualquer um
 *     dos dois sozinho já filtra (ex.: só `data_de` = "desde tal dia").
 *     `data_ate` inclui o dia inteiro (< dia seguinte), não só 00:00.
 */
export function condicaoPeriodo(qs, coluna, condicoes, valores, inicio) {
  let i = inicio;
  const dias = Number(qs.dias);
  if (Number.isFinite(dias) && dias > 0) {
    condicoes.push(`${coluna} >= now() - make_interval(days => $${i}::int)`);
    valores.push(dias);
    return i + 1;
  }
  if (qs.data_de) {
    condicoes.push(`${coluna} >= $${i}::date`);
    valores.push(String(qs.data_de));
    i += 1;
  }
  if (qs.data_ate) {
    condicoes.push(`${coluna} < ($${i}::date + interval '1 day')`);
    valores.push(String(qs.data_ate));
    i += 1;
  }
  return i;
}

/**
 * Filtro sobre email_ia.emails: dias/data_de/data_ate, q (assunto/nome/
 * e-mail/resumo/produto/pedido via ILIKE), cat, sent, urg, pede, area, resp,
 * pgto, plat, motivo.
 *
 * `inicio` é a posição do primeiro placeholder — cada rota decide onde o
 * filtro entra na lista de parâmetros da consulta que o usa.
 */
export function filtroEmails(qs, inicio = 1, aliasEmail = 'emails') {
  const condicoes = [];
  const valores = [];
  let i = condicaoPeriodo(qs, 'data_email', condicoes, valores, inicio);

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

  const motivo = listaValida(qs.motivo, MOTIVOS_DEVOLUCAO);
  if (motivo) { condicoes.push(`motivo_devolucao = ANY($${i}::text[])`); valores.push(motivo); i += 1; }

  // Precisa do alias/nome de tabela da consulta que chamou filtroEmails: um
  // "remetente_email" sem prefixo aqui dentro cairia no email_ia.mv_emails_x_pedidos
  // do EXISTS (mesmo nome de coluna), não na linha de fora — o filtro viraria
  // sempre verdadeiro (ou sempre falso) em vez de recortar por cliente.
  i = condicaoProdutoLoja(qs, `${aliasEmail}.remetente_email`, condicoes, valores, i);

  return { sql: condicoes.length ? condicoes.join(' AND ') : 'true', valores, fim: i };
}

/**
 * Filtro sobre email_ia.tickets: período (por ultimo_email_em) + busca — `tq`
 * é a busca própria da tabela de tickets (nome/e-mail); sem ela, cai para o
 * `q` global, para a busca do cabeçalho continuar filtrando a tabela também.
 */
export function filtroTickets(qs, inicio = 1, aliasEmail = 'tickets') {
  const condicoes = [];
  const valores = [];
  let i = condicaoPeriodo(qs, 'ultimo_email_em', condicoes, valores, inicio);

  const busca = qs.tq || qs.q;
  if (busca) {
    condicoes.push(`(nome ILIKE $${i} OR remetente_email ILIKE $${i})`);
    valores.push(`%${busca}%`);
    i += 1;
  }

  i = condicaoProdutoLoja(qs, `${aliasEmail}.remetente_email`, condicoes, valores, i);

  return {
    sql: condicoes.length ? condicoes.join(' AND ') : 'true', valores, fim: i, temBusca: Boolean(busca),
  };
}
