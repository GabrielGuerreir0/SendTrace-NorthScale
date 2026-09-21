/**
 * Aba "Rastreio de Pedidos" — Red Rock + FullStack (fulfillment). Só
 * leitura: quem escreve em `rastreio_pedidos`/`rastreio_eventos` são os
 * scripts standalone na VPS (`/root/rastreio_redrock/rastreio_redrock.py` e,
 * desde 18/09/2026, `/root/rastreio_fullstack/rastreio_fullstack.py`), nunca
 * este painel (ver api/rotas/rastreio.js). Mesmo padrão de
 * visaoGeral.js/relatorioMetricas.js: sem entrar no polling automático do
 * painel — um pedido de fulfillment não muda a cada poucos segundos, e a
 * consulta de verdade já roda por fora.
 *
 * `nao_encontrado` NÃO é erro: mesmo com dois fulfillment centers
 * integrados (Red Rock + FullStack), ainda cobre pedido que nenhum dos dois
 * tem — paykey do JVZoo nunca capturado, ou pedido genuinamente ainda não
 * despachado (ver PLANO.md, "Rastreamento de Disparo", seção 3). Só
 * `exception` (falha real de consulta) usa estilo de alarme — em todo o
 * resto (KPI, pílula da tabela, ficha) isso é respeitado de propósito.
 *
 * i18n (16/09/2026): única aba do painel com tradução — os textos ESTÁTICOS
 * do HTML usam `data-t="chave"` (ver aplicarTraducoesEstaticas) e os
 * DINÂMICOS (KPI, tabelas, modal, gráfico) chamam `t('chave')` direto. Padrão
 * inglês (clientes das plataformas são americanos), com toggle pra
 * português salvo por navegador — ver i18n.js. `LABEL_STATUS_RASTREIO` em
 * emailComum.js também é bilíngue, mas só ela: nenhuma outra aba usa aquela
 * tabela, então trocar o idioma aqui nunca vaza pra outro lugar do painel.
 */
import {
  $, api, debounce, kpiCard, montarPaginacao, renderTabela, chipRastreio,
  rotularStatusRastreio, rotularPlataforma, abrirFicha, seloProvedor, tooltip,
} from './emailComum.js';
import { n, dataHora, dia, duracaoH } from './format.js';
import { desenharLinha } from './charts.js';
import { criarTradutor, idiomaAtual, montarSeletorIdioma } from './i18n.js';

/** dia (col. `date` do Postgres, "AAAA-MM-DD" sem hora/fuso) → "DD/MM" sem
 * passar por `new Date()`: um `date` puro seria lido como meia-noite UTC e o
 * fuso do navegador (ex.: -03:00) empurraria pro dia anterior. */
const rotuloDia = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Cor fixa por plataforma na paleta categórica (`--serie-N`) — as 3
 * conhecidas sempre com a mesma cor entre uma troca de métrica e outra;
 * qualquer plataforma nova cai nas posições seguintes. */
const COR_PLATAFORMA = { JVZoo: 0, BuyGoods: 1, DigiStore24: 2 };

const POR_PAGINA = 25;
const estado = {
  busca: '', status: '', produto: '', plataforma: '', provedor: '', pagina: 1,
  periodo: '', dataDe: '', dataAte: '',
};

/* ═══════════════════════════════════  i18n  ═════════════════════════════════ */

const DIC = {
  // cabeçalho da aba
  titRastreio: { en: 'Order Tracking', pt: 'Rastreio de Pedidos' },
  heroRastreioEye: { en: 'Order tracking', pt: 'Rastreio de pedidos' },
  heroRastreioA: { en: 'From the order', pt: 'Do pedido' },
  heroRastreioB: { en: "to the customer's door.", pt: 'à porta do cliente.' },
  heroRastreioSub: {
    en: 'Status of every order at Red Rock and FullStack, delivery times and late deliveries.',
    pt: 'Status de cada pedido na Red Rock e na FullStack, prazos de entrega e entregas atrasadas.',
  },
  subRastreio: {
    en: 'Checked against Red Rock and FullStack by separate scripts (never real-time). An order '
      + 'can still show up as "not found on either platform" — expected for a checkout/platform '
      + "combination neither fulfillment center covers yet, not an error.",
    pt: 'Consulta contra a Red Rock e a FullStack, feita por scripts à parte (nunca em tempo '
      + 'real). Um pedido ainda pode aparecer como "não encontrado em nenhuma plataforma" — '
      + 'esperado pra uma combinação de checkout/plataforma que nenhum dos dois fulfillment '
      + 'centers cobre ainda, não é erro.',
  },
  atualizarAgora: { en: 'Refresh now', pt: 'Atualizar agora' },
  subabaTodos: { en: 'All', pt: 'Todos' },

  // KPIs
  kpiTotal: { en: 'Total orders', pt: 'Total de pedidos' },
  kpiTotalNota: { en: 'checked with a provider at least once', pt: 'já consultados com um provedor ao menos uma vez' },
  kpiTaxaEntrega: { en: 'Delivery rate', pt: 'Taxa de entrega' },
  kpiTaxaEntregaNota: { en: 'delivered ÷ (on its way + delivered)', pt: 'entregues ÷ (a caminho + entregues)' },
  kpiErroConsulta: { en: 'Query error', pt: 'Erro na consulta' },
  kpiErroConsultaNota: { en: 'real API/network failure — the only status treated as an alarm here', pt: 'falha real de API/rede — o único status tratado como alarme aqui' },
  kpiNaoEncontrado: { en: 'Not found on either platform', pt: 'Não encontrado em nenhuma plataforma' },
  kpiNaoEncontradoNota: { en: 'not covered by Red Rock or FullStack yet — expected for some checkout/platform combinations', pt: 'ainda não coberto pela Red Rock nem pela FullStack — esperado pra algumas combinações de checkout/plataforma' },
  kpiConsultando: { en: 'Checking with provider', pt: 'Consultando fornecedor' },
  kpiConsultandoNota: { en: 'orders being checked with a provider for the first time right now', pt: 'pedidos sendo consultados com um provedor pela primeira vez agora' },
  kpiRecebido: { en: 'Order received', pt: 'Pedido recebido' },
  kpiRecebidoNota: { en: 'orders fulfillment received from the platforms and hasn\'t shipped yet', pt: 'pedidos que a fulfillment recebeu das plataformas e ainda não foi enviado' },
  kpiACaminho: { en: 'On its way', pt: 'A caminho' },
  kpiACaminhoNota: { en: 'orders that have shipped', pt: 'pedidos que foram enviados' },
  kpiEntregue: { en: 'Delivered', pt: 'Entregue' },
  kpiEntregueNota: { en: 'orders that already reached the customer', pt: 'pedidos que já chegaram no cliente' },
  kpiCancelado: { en: 'Cancelled', pt: 'Cancelado' },
  kpiCanceladoNota: { en: 'orders that were cancelled', pt: 'pedidos que foram cancelados' },
  kpiStatusNaoMapeado: { en: 'Unmapped status', pt: 'Status não mapeado' },
  kpiStatusNaoMapeadoNota: { en: 'the provider returned a status we don\'t recognize yet', pt: 'o provedor devolveu um status que ainda não reconhecemos' },
  kpiSemCodigo: { en: 'Missing tracking code', pt: 'Sem código de rastreio' },
  kpiSemCodigoNota: { en: 'in fulfillment (received, shipped, delivered or cancelled) but still no tracking_number', pt: 'na fulfillment (recebido, a caminho, entregue ou cancelado) mas ainda sem tracking_number' },

  // Saúde do rastreio (seção)
  titSaude: { en: 'Tracking Health', pt: 'Saúde do rastreio' },
  subSaude: {
    en: 'Detection speed, coverage by platform, delivery time and status transitions. Click a row '
      + 'to see the orders behind that number. Detection/transition averages never include the '
      + 'retroactive email backfill (09/15) — organic detection only, so old orders "found" only '
      + "now don't inflate the numbers; transport/total time use the provider's own timestamps, "
      + "so they don't have that limitation.",
    pt: 'Velocidade de detecção, cobertura por plataforma, tempo de entrega e transições de '
      + 'status. Clique numa linha pra ver os pedidos por trás daquele número. As médias '
      + 'de detecção/transição nunca incluem o backfill retroativo por e-mail (15/09) — só '
      + 'detecção orgânica, pra não inflar os números com pedidos antigos "achados" só agora; '
      + 'as de tempo de transporte/total usam os timestamps do próprio provedor, então não '
      + 'têm essa limitação.',
  },
  tabTempoTit: { en: 'Time to appear in tracking', pt: 'Tempo até aparecer no rastreio' },
  tabTempoSub: { en: 'From purchase to first tracking record, by platform.', pt: 'Da compra até o primeiro registro de rastreio, por plataforma.' },
  tabNaoEncTit: { en: 'Not found on either platform', pt: 'Não encontrados em nenhuma plataforma' },
  tabNaoEncSub: { en: 'By platform — and how long since the purchase was made.', pt: 'Por plataforma — e há quanto tempo a compra foi feita.' },
  tabTransicoesTit: { en: 'Time between status changes', pt: 'Tempo entre mudanças de status' },
  tabTransicoesSub: { en: 'How long an order takes from one status to the next.', pt: 'Quanto tempo um pedido leva de um status pro próximo.' },
  tabTransporteTit: { en: 'Transit time', pt: 'Tempo de transporte' },
  tabTransporteSub: { en: "From dispatch (on its way) to delivery, by platform — straight from the provider's timestamps.", pt: 'Do despacho (a caminho) até a entrega, por plataforma — direto dos timestamps do provedor.' },
  tabTotalTit: { en: 'Total time: purchase → delivery', pt: 'Tempo total: compra → entrega' },
  tabTotalSub: { en: 'Full cycle, by platform — includes prep time before dispatch.', pt: 'Ciclo completo, por plataforma — inclui o tempo de preparação antes do despacho.' },
  tabDistribTit: { en: 'Delivery time breakdown', pt: 'Distribuição do tempo de entrega' },
  tabDistribSub: { en: 'How many delivered orders fall in each time range, by platform.', pt: 'Quantos pedidos entregues caem em cada faixa de tempo, por plataforma.' },
  colFaixa: { en: 'Time range', pt: 'Faixa' },
  colQuantidade: { en: 'Count', pt: 'Quantidade' },
  faixaAte: { en: 'Up to {max} days', pt: 'Até {max} dias' },
  faixaEntre: { en: '{min} to {max} days', pt: '{min} a {max} dias' },
  faixaMais: { en: '{min}+ days', pt: '{min}+ dias' },
  tabSemCodigoTit: { en: 'Found but missing tracking code', pt: 'Encontrados sem código de rastreio' },
  tabSemCodigoSub: { en: 'Already has a status with the provider, but still no tracking_number.', pt: 'Já tem status com o provedor, mas ainda sem tracking_number.' },
  tabFunilTit: { en: 'Funnel by platform', pt: 'Funil por plataforma' },
  tabFunilSub: { en: 'The same breakdown as the KPIs above, split by platform.', pt: 'O mesmo corte dos KPIs acima, quebrado por plataforma.' },
  tabProvedoresTit: { en: 'Tracking providers', pt: 'Provedores de rastreio' },
  tabProvedoresSub: { en: 'How many orders each provider already covers.', pt: 'Quantos pedidos cada provedor já cobre.' },

  // colunas de tabela (reaproveitadas em várias)
  colPlataforma: { en: 'Platform', pt: 'Plataforma' },
  colAmostras: { en: 'Samples', pt: 'Amostras' },
  colMedia: { en: 'Average', pt: 'Média' },
  colMediana: { en: 'Median', pt: 'Mediana' },
  colTotal: { en: 'Total', pt: 'Total' },
  colMediaDias: { en: 'Average days', pt: 'Média dias' },
  colCompraAntiga: { en: 'Oldest purchase', pt: 'Compra mais antiga' },
  colDe: { en: 'From', pt: 'De' },
  colPara: { en: 'To', pt: 'Para' },
  colStatus: { en: 'Status', pt: 'Status' },
  colConsultando: { en: 'Checking', pt: 'Consultando' },
  colNaoEncontrado: { en: 'Not found', pt: 'Não encontrado' },
  colRecebido: { en: 'Received', pt: 'Recebido' },
  colACaminho: { en: 'On its way', pt: 'A caminho' },
  colEntregue: { en: 'Delivered', pt: 'Entregue' },
  colCancelado: { en: 'Cancelled', pt: 'Cancelado' },
  colProvedor: { en: 'Provider', pt: 'Provedor' },
  colPedido: { en: 'Order', pt: 'Pedido' },
  colProduto: { en: 'Product', pt: 'Produto' },
  colTransportadora: { en: 'Carrier', pt: 'Transportadora' },
  colCodigoRastreio: { en: 'Tracking code', pt: 'Código de rastreio' },
  colAtualizado: { en: 'Updated', pt: 'Atualizado' },
  colNome: { en: 'Name', pt: 'Nome' },
  colRastreio: { en: 'Tracking', pt: 'Rastreio' },
  colCriadoEm: { en: 'Created at', pt: 'Criado em' },
  colDuracao: { en: 'Duration', pt: 'Duração' },
  colPeriodo: { en: 'Period', pt: 'Período' },
  colAte: { en: 'To', pt: 'Até' },
  carregando: { en: 'loading…', pt: 'carregando…' },

  // Evolução no tempo
  titEvolucao: { en: 'Trend Over Time', pt: 'Evolução no tempo' },
  subEvolucao: {
    en: 'Pick which status change to see — each line is a platform, each point a day. Click a '
      + 'point to see that day\'s orders, from slowest to fastest.',
    pt: 'Escolha qual mudança de status ver — cada linha é uma plataforma, cada ponto um dia. '
      + 'Clique num ponto pra ver os pedidos daquele dia, do mais lento pro mais rápido.',
  },
  labelMetrica: { en: 'Metric', pt: 'Métrica' },
  metricaDeteccao: { en: 'Time to appear in tracking (purchase → 1st record)', pt: 'Tempo até aparecer no rastreio (compra → 1º registro)' },
  metricaTransporte: { en: 'Transit time (on its way → delivered)', pt: 'Tempo de transporte (a caminho → entregue)' },
  metricaTotal: { en: 'Total time (purchase → delivered)', pt: 'Tempo total (compra → entregue)' },
  tempoMedioUnidade: { en: 'average time', pt: 'tempo médio' },
  semDadosGrafico: { en: "Not enough data for this range yet.", pt: 'Sem dados suficientes pra esse recorte ainda.' },
  slowestToFastest: { en: 'slowest to fastest', pt: 'do mais lento pro mais rápido' },

  // Pedidos (lista)
  titPedidos: { en: 'Orders', pt: 'Pedidos' },
  subPedidos: { en: 'Click a row to see the full record and timeline.', pt: 'Clique numa linha para ver a ficha completa e a linha do tempo.' },
  buscaSr: { en: 'Search transaction, customer or tracking code', pt: 'Buscar transação, cliente ou código de rastreio' },
  buscaPlaceholder: { en: 'Search transaction, customer or tracking code…', pt: 'Buscar transação, cliente ou código de rastreio…' },
  statusTodos: { en: 'All', pt: 'Todos' },
  statusPendenteConsulta: { en: 'Checking with provider', pt: 'Consultando fornecedor' },
  statusNaoEncontrado: { en: 'Not found on either platform', pt: 'Não encontrado em nenhuma plataforma' },
  statusPending: { en: 'Order received', pt: 'Pedido recebido' },
  statusShipped: { en: 'On its way', pt: 'A caminho' },
  statusDelivered: { en: 'Delivered', pt: 'Entregue' },
  statusCancelled: { en: 'Cancelled', pt: 'Cancelado' },
  statusException: { en: 'Query error', pt: 'Erro na consulta' },
  statusDesconhecido: { en: 'Unmapped status', pt: 'Status não mapeado' },
  statusSemCodigo: { en: 'Missing tracking code', pt: 'Sem código de rastreio' },
  filtrarProduto: { en: 'Filter by product', pt: 'Filtrar por produto' },
  todosProdutos: { en: 'All products', pt: 'Todos os produtos' },
  filtrarPlataforma: { en: 'Filter by platform', pt: 'Filtrar por plataforma' },
  todasPlataformas: { en: 'All platforms', pt: 'Todas as plataformas' },
  periodo7: { en: '7 days', pt: '7 dias' },
  periodo30: { en: '30 days', pt: '30 dias' },
  periodo60: { en: '60 days', pt: '60 dias' },
  periodo90: { en: '90 days', pt: '90 dias' },
  periodoTudo: { en: 'All time', pt: 'Tudo' },
  periodoEscolher: { en: 'Choose dates…', pt: 'Escolher datas…' },
  dataDeTitle: { en: 'Orders purchased from this date', pt: 'Pedidos comprados a partir desta data' },
  dataAteTitle: { en: 'Orders purchased up to this date (inclusive)', pt: 'Pedidos comprados até esta data (incluída)' },

  // empty states / erros
  vazioTempo: { en: 'No organic detection recorded yet.', pt: 'Sem detecção orgânica registrada ainda.' },
  vazioNaoEnc: { en: 'No order without a match on either platform.', pt: 'Nenhum pedido sem correlação em nenhuma plataforma.' },
  vazioTransicoes: { en: 'Not enough status transitions yet.', pt: 'Ainda sem transições de status suficientes.' },
  vazioSemCodigo: { en: 'Every order found already has a tracking code.', pt: 'Todo pedido encontrado já tem código de rastreio.' },
  vazioConsultado: { en: 'No order checked yet.', pt: 'Nenhum pedido consultado ainda.' },
  vazioTransporte: { en: 'No delivered order with a recorded dispatch yet.', pt: 'Nenhum pedido entregue com despacho registrado ainda.' },
  vazioEntregue: { en: 'No delivered order yet.', pt: 'Nenhum pedido entregue ainda.' },
  vazioFiltroPedidos: { en: 'No order found with this filter.', pt: 'Nenhum pedido encontrado com este filtro.' },
  erroCarregarPedidos: { en: "Couldn't load orders right now.", pt: 'Não consegui carregar os pedidos agora.' },
  erroCarregarDetalhe: { en: "Couldn't load these orders.", pt: 'Não consegui carregar estes pedidos.' },
  vazioDetalhe: { en: 'No order found with this scope.', pt: 'Nenhum pedido encontrado com este recorte.' },
  erroCarregarFicha: { en: "Couldn't load this order's details.", pt: 'Não consegui carregar os detalhes deste pedido.' },

  // drill-down (títulos abertos ao clicar numa linha)
  detalheNaoEncontrados: { en: 'Not found on either platform', pt: 'Não encontrados em nenhuma plataforma' },
  detalheSemCodigo: { en: 'Missing tracking code', pt: 'Sem código de rastreio' },
  detalheFunil: { en: 'Funnel by platform', pt: 'Funil por plataforma' },
  detalheProvedor: { en: 'Tracking provider', pt: 'Provedor de rastreio' },
  detalheTempoPorPedido: { en: 'time per order', pt: 'tempo por pedido' },

  // ficha do pedido
  fichaStatus: { en: 'Status', pt: 'Status' },
  fichaErroUltimaConsulta: { en: 'Error on last check', pt: 'Erro na última consulta' },
  fichaStatusBruto: { en: 'Raw status (provider)', pt: 'Status bruto (fornecedor)' },
  fichaProduto: { en: 'Product', pt: 'Produto' },
  fichaPlataforma: { en: 'Platform', pt: 'Plataforma' },
  fichaProvedor: { en: 'Provider', pt: 'Provedor' },
  fichaNumeroPedido: { en: 'Order number', pt: 'Número do pedido' },
  fichaPedidoCriadoEm: { en: 'Order created at', pt: 'Pedido criado em' },
  fichaTotal: { en: 'Total', pt: 'Total' },
  fichaTotalmenteAtendido: { en: 'Fully fulfilled', pt: 'Totalmente atendido' },
  fichaSim: { en: 'Yes', pt: 'Sim' },
  fichaNao: { en: 'No', pt: 'Não' },
  fichaTransportadora: { en: 'Carrier', pt: 'Transportadora' },
  fichaCodigoRastreio: { en: 'Tracking code', pt: 'Código de rastreio' },
  fichaStatusTransportadora: { en: 'Carrier status', pt: 'Status na transportadora' },
  fichaLinkRastreio: { en: 'Tracking link', pt: 'Link de rastreio' },
  fichaEnviadoEm: { en: 'Shipped at', pt: 'Enviado em' },
  fichaEntregueEm: { en: 'Delivered at', pt: 'Entregue em' },
  fichaUltimaConsulta: { en: 'Last check with provider', pt: 'Última consulta ao provedor' },
  fichaLinhaTempo: { en: 'Timeline', pt: 'Linha do tempo' },
  linhaTempoVazia: { en: 'No status change recorded yet.', pt: 'Nenhuma mudança de status registrada ainda.' },
  primeiroRegistro: { en: 'First record — {status}', pt: 'Primeiro registro — {status}' },

  // relacionados (front + upsell/downsell da mesma compra, cada um podendo ter caído num provedor diferente)
  fichaRelacionados: { en: 'Related orders (same customer)', pt: 'Pedidos relacionados (mesmo cliente)' },
  relacionadosVazio: { en: 'No other order from this customer within 1 day of this purchase.', pt: 'Nenhum outro pedido desse cliente a menos de 1 dia desta compra.' },
  origemFront: { en: 'Front', pt: 'Front' },
  origemUpsellDownsell: { en: 'Upsell/Downsell', pt: 'Upsell/Downsell' },
};
const t = criarTradutor(DIC);

/** Locale-aware: separador decimal PT (vírgula) vs EN (ponto). */
const pct = (v) => {
  if (v === null || v === undefined) return '—';
  const casa = idiomaAtual() === 'pt' ? ',' : '.';
  return `${String(v).replace('.', casa)}%`;
};

/** Varre todo `[data-t]`/`[data-t-title]` DENTRO da aba (e do modal de
 * drill-down, que mora fora dela no DOM mas é exclusivo dela) e aplica o
 * idioma atual — chamado no load e a cada troca EN/PT. */
function aplicarTraducoesEstaticas() {
  const raiz = [$('aba-rastreio'), $('rst-detalhe-modal')].filter(Boolean);
  for (const container of raiz) {
    container.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    container.querySelectorAll('[data-t-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.tPlaceholder); });
    container.querySelectorAll('[data-t-title]').forEach((el) => { el.title = t(el.dataset.tTitle); });
  }
}

/**
 * Produto/plataforma/período — os 3 recortes que valem pra tudo nesta aba
 * (KPIs, Saúde e lista de pedidos), não só a tabela. Mesmo mecanismo de
 * "dias" OU "data_de"/"data_ate" (mutuamente exclusivos) de emailFiltro.js.
 */
function paramsFiltro() {
  const p = new URLSearchParams();
  if (estado.produto) p.set('produto', estado.produto);
  if (estado.plataforma) p.set('plataforma', estado.plataforma);
  if (estado.provedor) p.set('provedor', estado.provedor);
  if (estado.periodo) {
    p.set('dias', estado.periodo);
  } else {
    if (estado.dataDe) p.set('data_de', estado.dataDe);
    if (estado.dataAte) p.set('data_ate', estado.dataAte);
  }
  return p;
}

/* ══════════════  produto/plataforma — clonados do seletor do topo  ═════════
 * Mesmo truque de emailFiltro.js (sincronizarOpcoes): mesmo catálogo de
 * `disparos_pos_venda`, sem repetir a ida ao servidor. Idempotente porque o
 * catálogo do topo pode ainda não ter chegado na primeira carga desta aba. */
function sincronizarSelects() {
  const pares = [
    [$('sel-produto'), $('rst-sel-produto'), 'todosProdutos'],
    [$('sel-plataforma'), $('rst-sel-plataforma'), 'todasPlataformas'],
  ];
  for (const [origem, destino, chavePlaceholder] of pares) {
    if (!origem || !destino) continue;
    if (destino.options.length < origem.options.length) {
      const valorAtual = destino.value;
      destino.replaceChildren(...[...origem.options].map((o) => o.cloneNode(true)));
      destino.value = valorAtual;
    }
    // O catálogo clonado vem do seletor do topo (só em português) — o
    // placeholder ("Todos os produtos"/"Todas as plataformas") é o único
    // item dessa lista que faz sentido traduzir; os nomes de produto/
    // plataforma em si são nomes próprios, iguais nos dois idiomas. Roda
    // TODA vez (não só ao clonar), pra acompanhar troca de idioma mesmo
    // sem re-clonar.
    if (destino.options[0]?.value === '') destino.options[0].textContent = t(chavePlaceholder);
  }
}

/* ══════════════════════════════════  KPIs  ═════════════════════════════════ */

function tomTaxa(taxa) {
  if (taxa === null || taxa === undefined) return 'neutro';
  if (taxa >= 90) return 'bom';
  if (taxa >= 70) return 'medio';
  return 'ruim';
}

function renderKpis(r) {
  $('rst-kpis').replaceChildren(
    kpiCard({ icone: '◍', tom: 'neutro', rotulo: t('kpiTotal'), valor: n(r.total), nota: t('kpiTotalNota') }),
    kpiCard({ icone: '✓', tom: tomTaxa(r.taxa_entrega), rotulo: t('kpiTaxaEntrega'), valor: pct(r.taxa_entrega), nota: t('kpiTaxaEntregaNota') }),
    kpiCard({ icone: '⚠', tom: r.exception > 0 ? 'ruim' : 'neutro', rotulo: t('kpiErroConsulta'), valor: n(r.exception), nota: t('kpiErroConsultaNota') }),
    // Pedido "não encontrado" nunca tem provedor gravado — dentro de uma
    // sub-aba Red Rock/FullStack esse card ficaria sempre zerado, então some
    // fora da sub-aba "Todos" (ver aplicarVisibilidadeProvedor).
    ...(estado.provedor ? [] : [kpiCard({ icone: '○', tom: 'neutro', rotulo: t('kpiNaoEncontrado'), valor: n(r.nao_encontrado), nota: t('kpiNaoEncontradoNota') })]),
  );
  $('rst-kpis-status').replaceChildren(
    kpiCard({ icone: '◐', tom: 'neutro', rotulo: t('kpiConsultando'), valor: n(r.pendente_consulta), nota: t('kpiConsultandoNota') }),
    kpiCard({ icone: '●', tom: 'neutro', rotulo: t('kpiRecebido'), valor: n(r.pending), nota: t('kpiRecebidoNota') }),
    kpiCard({ icone: '➤', tom: 'neutro', rotulo: t('kpiACaminho'), valor: n(r.shipped), nota: t('kpiACaminhoNota') }),
    kpiCard({ icone: '✓', tom: 'bom', rotulo: t('kpiEntregue'), valor: n(r.delivered), nota: t('kpiEntregueNota') }),
    kpiCard({ icone: '✕', tom: 'neutro', rotulo: t('kpiCancelado'), valor: n(r.cancelled), nota: t('kpiCanceladoNota') }),
    kpiCard({ icone: '?', tom: 'neutro', rotulo: t('kpiStatusNaoMapeado'), valor: n(r.desconhecido), nota: t('kpiStatusNaoMapeadoNota') }),
    kpiCard({
      icone: '▭', tom: r.sem_codigo_rastreio > 0 ? 'medio' : 'neutro', rotulo: t('kpiSemCodigo'),
      valor: n(r.sem_codigo_rastreio), nota: t('kpiSemCodigoNota'),
    }),
  );
}

/* ═══════════════════════════════════  tabela  ══════════════════════════════ */

function celPedido(p) {
  const div = document.createElement('div');
  const forte = document.createElement('span');
  forte.className = 'cel-forte cel-mono';
  forte.textContent = p.transacao_id;
  div.append(forte);
  if (p.nome) {
    const sub = document.createElement('span');
    sub.className = 'cel-sub';
    sub.textContent = p.nome;
    div.append(sub);
  }
  return div;
}

function renderLinhaTempo(eventos) {
  const ul = document.createElement('ul');
  ul.className = 'rastreio-linha-tempo';
  if (!eventos?.length) {
    const li = document.createElement('li');
    li.className = 'rastreio-linha-tempo-vazia';
    li.textContent = t('linhaTempoVazia');
    ul.append(li);
    return ul;
  }
  for (const ev of eventos) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = ev.status_anterior
      ? `${rotularStatusRastreio(ev.status_anterior)} → ${rotularStatusRastreio(ev.status_novo)}`
      : t('primeiroRegistro', { status: rotularStatusRastreio(ev.status_novo) });
    const span = document.createElement('span');
    span.textContent = `${dataHora(ev.detectado_em)} · ${ev.fonte}`;
    li.append(strong, span);
    ul.append(li);
  }
  return ul;
}

/** Front e upsell/downsell da mesma compra caem em transacao_id diferentes
 * (ver comentário em api/rotas/rastreio.js) — cada item aqui é clicável e
 * abre a PRÓPRIA ficha desse outro pedido, então clicar tanto no lado Red
 * Rock quanto no lado FullStack de uma mesma venda leva a informação de um
 * pro outro. */
function renderRelacionados(relacionados) {
  const ul = document.createElement('ul');
  ul.className = 'rastreio-relacionados';
  if (!relacionados?.length) {
    const li = document.createElement('li');
    li.className = 'rastreio-relacionados-vazio';
    li.textContent = t('relacionadosVazio');
    ul.append(li);
    return ul;
  }
  for (const rel of relacionados) {
    const li = document.createElement('li');
    li.className = 'rastreio-relacionados-item';

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'rastreio-relacionados-link';
    botao.textContent = rel.transacao_id;
    botao.addEventListener('click', () => abrirDetalhePedido({ transacao_id: rel.transacao_id }));

    const meta = document.createElement('span');
    meta.textContent = `${rel.origem === 'front' ? t('origemFront') : t('origemUpsellDownsell')}`
      + ` · ${rel.produto || '—'} · ${rotularPlataforma(rel.plataforma)}`;

    const status = document.createElement('span');
    status.append(seloProvedor(rel.provedor), ' ', chipRastreio(rel.status_interno));
    if (rel.tracking_number) {
      status.append(' · ');
      const tn = document.createElement('span');
      tn.className = 'cel-mono';
      tn.textContent = rel.tracking_number;
      status.append(tn);
    }

    li.append(botao, meta, status);
    ul.append(li);
  }
  return ul;
}

async function abrirDetalhePedido(linha) {
  const { ok, dados: d } = await api(`/api/rastreio/${encodeURIComponent(linha.transacao_id)}`);
  if (!ok) { window.alert(t('erroCarregarFicha')); return; }

  let linkRastreio = null;
  if (d.tracking_url) {
    linkRastreio = document.createElement('a');
    linkRastreio.href = d.tracking_url;
    linkRastreio.target = '_blank';
    linkRastreio.rel = 'noopener noreferrer';
    linkRastreio.textContent = d.tracking_url;
  }

  abrirFicha({
    titulo: d.transacao_id,
    subtitulo: d.nome || '',
    campos: [
      { rotulo: t('fichaStatus'), valor: chipRastreio(d.status_interno) },
      d.status_interno === 'exception' && d.ultimo_erro
        && { rotulo: t('fichaErroUltimaConsulta'), valor: d.ultimo_erro, largo: true },
      d.status_interno === 'desconhecido'
        && { rotulo: t('fichaStatusBruto'), valor: d.status_bruto || '—' },
      { rotulo: t('fichaProduto'), valor: d.produto || '—' },
      { rotulo: t('fichaPlataforma'), valor: rotularPlataforma(d.plataforma) },
      { rotulo: t('fichaProvedor'), valor: seloProvedor(d.provedor) },
      { rotulo: t('fichaNumeroPedido'), valor: d.order_number || '—' },
      { rotulo: t('fichaPedidoCriadoEm'), valor: d.order_created_at ? dataHora(d.order_created_at) : '—' },
      { rotulo: t('fichaTotal'), valor: d.total ? `${d.total} ${d.currency || ''}`.trim() : '—' },
      {
        rotulo: t('fichaTotalmenteAtendido'),
        valor: d.fully_fulfilled ? `${t('fichaSim')}${d.fully_fulfilled_at ? ` · ${dataHora(d.fully_fulfilled_at)}` : ''}` : t('fichaNao'),
      },
      { rotulo: t('fichaTransportadora'), valor: d.carrier_code || '—' },
      { rotulo: t('fichaCodigoRastreio'), valor: d.tracking_number || '—' },
      { rotulo: t('fichaStatusTransportadora'), valor: d.tracking_status || '—' },
      linkRastreio && { rotulo: t('fichaLinkRastreio'), valor: linkRastreio },
      { rotulo: t('fichaEnviadoEm'), valor: d.shipped_at ? dataHora(d.shipped_at) : '—' },
      { rotulo: t('fichaEntregueEm'), valor: d.delivered_at ? dataHora(d.delivered_at) : '—' },
      { rotulo: t('fichaUltimaConsulta'), valor: d.ultima_consulta_em ? dataHora(d.ultima_consulta_em) : '—' },
      { rotulo: t('fichaRelacionados'), valor: renderRelacionados(d.relacionados), largo: true },
      { rotulo: t('fichaLinhaTempo'), valor: renderLinhaTempo(d.eventos), largo: true },
    ],
  });
}

function renderTabelaPedidos(pedidos) {
  const colunas = [
    { render: celPedido },
    { render: (p) => p.produto || '—' },
    { render: (p) => rotularPlataforma(p.plataforma) },
    { render: (p) => chipRastreio(p.status_interno) },
    { render: (p) => seloProvedor(p.provedor) },
    { render: (p) => p.carrier_code || '—' },
    { classe: 'cel-mono', render: (p) => p.tracking_number || '—' },
    { classe: 'cel-mono', render: (p) => (p.atualizado_em ? dataHora(p.atualizado_em) : '—') },
  ];
  colunas.aoClicarLinha = abrirDetalhePedido;
  renderTabela($('rst-tabela-corpo'), pedidos, colunas, { vazio: t('vazioFiltroPedidos') });
}

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

let geracaoLista = 0;

async function carregarLista() {
  const meu = ++geracaoLista;
  const params = paramsFiltro();
  if (estado.status) params.set('status', estado.status);
  if (estado.busca) params.set('search', estado.busca);
  params.set('page', String(estado.pagina));
  params.set('page_size', String(POR_PAGINA));

  const { ok, dados: d } = await api(`/api/rastreio?${params}`);
  if (meu !== geracaoLista) return;
  if (!ok) {
    renderTabela($('rst-tabela-corpo'), [], [{ render: () => '' }], { vazio: t('erroCarregarPedidos') });
    $('rst-tabela-paginacao').replaceChildren();
    return;
  }

  renderTabelaPedidos(d.pedidos);
  const totalPaginas = Math.max(1, Math.ceil(d.total / POR_PAGINA));
  montarPaginacao($('rst-tabela-paginacao'), {
    pagina: estado.pagina, totalPaginas, total: d.total, rotuloItem: 'pedido',
  }, (p) => {
    estado.pagina = p;
    carregarLista();
  });
}

/* ═══════════════════════════════  saúde do rastreio  ═══════════════════════
 * Seis tabelas de cruzamento (ver /api/metricas/rastreio/saude em
 * api/rotas/rastreio.js) — carrega junto com o resumo, com os MESMOS
 * recortes de produto/plataforma/período (paramsFiltro), não é mais uma
 * visão geral sem filtro nenhum. */

/* ═══════════  drill-down: pedidos por trás de uma linha de Saúde  ══════════
 * Um modal só (rst-detalhe-modal), reaproveitado pelas 8 tabelas — cada
 * `aoClicarLinha` abaixo monta os parâmetros extra que identificam a linha
 * (a mesma dimensão que a query agregada usou) e chama abrirDetalheSaude.
 * O filtro produto/plataforma/período do topo da aba continua valendo
 * (paramsFiltro()), então o drill-down nunca mostra pedido fora do recorte
 * que já estava em tela. */
const DETALHE_POR_PAGINA = 25;
let detalheGeracao = 0;
let detalheExtra = null;
let detalhePagina = 1;

function colunasDetalhe() {
  return [
    { classe: 'cel-mono', render: (l) => l.transacao_id },
    { render: (l) => l.nome || '—' },
    { render: (l) => l.produto || '—' },
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => chipRastreio(l.status_interno) },
    { classe: 'cel-mono', render: (l) => l.tracking_number || '—' },
    { classe: 'cel-mono', render: (l) => (l.criado_em ? dataHora(l.criado_em) : '—') },
    { render: (l) => duracaoH(l.duracao_horas) },
  ];
}

async function carregarDetalheSaude() {
  const meu = ++detalheGeracao;
  const params = paramsFiltro();
  for (const [chave, valor] of Object.entries(detalheExtra)) {
    // Um clique no gráfico de linha manda dias:'' pra travar num dia exato
    // (data_de=data_ate=aquele dia) — sem isto, o filtro de período do topo
    // da aba (ex.: "últimos 30 dias"/"escolher datas…") continuaria valendo
    // JUNTO com `dia` (são condições AND independentes no backend, uma sobre
    // data de compra e outra sobre o dia do ponto) — sem apagar os três, um
    // filtro de período restritivo no topo podia zerar o resultado mesmo
    // com o `dia` certo.
    if (['dias', 'data_de', 'data_ate'].includes(chave) && valor === '') { params.delete(chave); continue; }
    if (valor !== undefined && valor !== null && valor !== '') params.set(chave, valor);
  }
  params.set('page', String(detalhePagina));
  params.set('page_size', String(DETALHE_POR_PAGINA));

  const { ok, dados: d } = await api(`/api/metricas/rastreio/saude/detalhe?${params}`);
  if (meu !== detalheGeracao) return;
  if (!ok) {
    renderTabela($('rst-detalhe-corpo'), [], colunasDetalhe(), { vazio: t('erroCarregarDetalhe') });
    $('rst-detalhe-pag').replaceChildren();
    return;
  }
  renderTabela($('rst-detalhe-corpo'), d.pedidos, colunasDetalhe(), { vazio: t('vazioDetalhe') });
  const totalPaginas = Math.max(1, Math.ceil(d.total / DETALHE_POR_PAGINA));
  montarPaginacao($('rst-detalhe-pag'), { pagina: detalhePagina, totalPaginas, total: d.total, rotuloItem: 'pedido' }, (p) => {
    detalhePagina = p;
    carregarDetalheSaude();
  });
}

function abrirDetalheSaude(titulo, subtitulo, extra) {
  $('rst-detalhe-titulo').textContent = titulo;
  $('rst-detalhe-sub').textContent = subtitulo;
  detalheExtra = extra;
  detalhePagina = 1;
  $('rst-detalhe-modal').showModal();
  carregarDetalheSaude();
}

$('rst-detalhe-fechar')?.addEventListener('click', () => $('rst-detalhe-modal').close());

function renderSaudeTempo(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('tabTempoTit'), rotularPlataforma(l.plataforma),
    { metrica: 'deteccao', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-tempo'), linhas, colunas, { vazio: t('vazioTempo') });
}

function renderSaudeNaoEncontrado(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.total) },
    { render: (l) => (l.media_dias_desde_compra ?? '—') },
    { render: (l) => (l.compra_mais_antiga ? dia(l.compra_mais_antiga) : '—') },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('detalheNaoEncontrados'), rotularPlataforma(l.plataforma),
    { metrica: 'lista', plataforma: l.plataforma, status_interno: 'nao_encontrado' },
  );
  renderTabela($('rst-saude-naoencontrado'), linhas, colunas, { vazio: t('vazioNaoEnc') });
}

function renderSaudeTransicoes(linhas) {
  const colunas = [
    { render: (l) => rotularStatusRastreio(l.status_anterior) },
    { render: (l) => rotularStatusRastreio(l.status_novo) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    `${rotularStatusRastreio(l.status_anterior)} → ${rotularStatusRastreio(l.status_novo)}`, t('detalheTempoPorPedido'),
    { metrica: 'transicao', status_anterior: l.status_anterior ?? '', status_novo: l.status_novo },
  );
  renderTabela($('rst-saude-transicoes'), linhas, colunas, { vazio: t('vazioTransicoes') });
}

function renderSaudeSemCodigo(linhas) {
  const colunas = [
    { render: (l) => chipRastreio(l.status_interno) },
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.total) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('detalheSemCodigo'), `${rotularStatusRastreio(l.status_interno)} · ${rotularPlataforma(l.plataforma)}`,
    { metrica: 'lista', plataforma: l.plataforma, status_interno: l.status_interno, sem_codigo: '1' },
  );
  renderTabela($('rst-saude-semcodigo'), linhas, colunas, { vazio: t('vazioSemCodigo') });
}

function renderSaudeFunil(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.total) },
    { render: (l) => n(l.pendente_consulta) },
    { render: (l) => n(l.nao_encontrado) },
    { render: (l) => n(l.pending) },
    { render: (l) => n(l.shipped) },
    { render: (l) => n(l.delivered) },
    { render: (l) => n(l.cancelled) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('detalheFunil'), rotularPlataforma(l.plataforma),
    { metrica: 'lista', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-funil'), linhas, colunas, { vazio: t('vazioConsultado') });
}

function renderSaudeProvedores(linhas) {
  const colunas = [
    { render: (l) => seloProvedor(l.provedor === 'nenhum' ? null : l.provedor) },
    { render: (l) => n(l.total) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('detalheProvedor'), l.provedor,
    { metrica: 'lista', provedor: l.provedor },
  );
  renderTabela($('rst-saude-provedores'), linhas, colunas, { vazio: t('vazioConsultado') });
}

function renderSaudeTransporte(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('tabTransporteTit'), rotularPlataforma(l.plataforma),
    { metrica: 'transporte', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-transporte'), linhas, colunas, { vazio: t('vazioTransporte') });
}

function renderSaudeTotal(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    t('tabTotalTit'), rotularPlataforma(l.plataforma),
    { metrica: 'total', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-total'), linhas, colunas, { vazio: t('vazioEntregue') });
}

/** Rótulo da faixa construído no cliente (min/max numéricos que o backend manda),
 * nunca o texto `faixa` cru que a query devolve — esse vem sempre em português,
 * ver o padrão desta aba de nunca mostrar string fixa vinda do servidor. */
function rotuloFaixa(l) {
  if (l.faixa_max_dias === null || l.faixa_max_dias === undefined) return t('faixaMais', { min: l.faixa_min_dias });
  if (l.faixa_min_dias === 0) return t('faixaAte', { max: l.faixa_max_dias });
  return t('faixaEntre', { min: l.faixa_min_dias, max: l.faixa_max_dias });
}

function renderSaudeDistrib(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: rotuloFaixa },
    { render: (l) => n(l.total) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    `${t('tabDistribTit')} — ${rotularPlataforma(l.plataforma)}`, rotuloFaixa(l),
    {
      metrica: 'total', plataforma: l.plataforma,
      duracao_dias_min: l.faixa_min_dias, duracao_dias_max: l.faixa_max_dias ?? '',
    },
  );
  renderTabela($('rst-saude-distrib'), linhas, colunas, { vazio: t('vazioEntregue') });
}

/* ═════════════  Evolução no tempo (gráfico de linha, por plataforma)  ══════════
 * Um select só, com uma opção por métrica de tempo que Saúde do rastreio já
 * conhece: as 3 fixas (deteccao/transporte/total) mais UMA por transição de
 * status real (transicoes_status é dinâmico — nasce só quando a transição
 * acontece de verdade, então "Pedido recebido → A caminho" só aparece se já
 * tiver amostra). O valor da opção codifica tudo que a rota /saude/serie/
 * precisa: `metrica`, e pra transição, `status_anterior|status_novo` juntos
 * (status_anterior vazio = null = primeiro evento, mesma convenção do drill-down). */
function popularSelectSerie(transicoes) {
  const sel = $('rst-serie-metrica');
  if (!sel) return;
  const valorAtual = sel.value;
  const opcoes = [
    { valor: 'deteccao', rotulo: t('metricaDeteccao') },
    ...transicoes.map((tr) => ({
      valor: `transicao|${tr.status_anterior ?? ''}|${tr.status_novo}`,
      rotulo: `${rotularStatusRastreio(tr.status_anterior)} → ${rotularStatusRastreio(tr.status_novo)}`,
    })),
    { valor: 'transporte', rotulo: t('metricaTransporte') },
    { valor: 'total', rotulo: t('metricaTotal') },
  ];
  sel.replaceChildren(...opcoes.map(({ valor, rotulo }) => {
    const opt = document.createElement('option');
    opt.value = valor; opt.textContent = rotulo;
    return opt;
  }));
  sel.value = opcoes.some((o) => o.valor === valorAtual) ? valorAtual : opcoes[0].valor;
}

async function carregarSerie() {
  const sel = $('rst-serie-metrica');
  const container = $('rst-serie-grafico');
  if (!sel || !container || !sel.value) return;
  const [tipo, statusAnterior, statusNovo] = sel.value.split('|');

  const params = paramsFiltro();
  params.set('metrica', tipo);
  if (tipo === 'transicao') {
    params.set('status_anterior', statusAnterior);
    params.set('status_novo', statusNovo);
  }

  const { ok, dados: s } = await api(`/api/metricas/rastreio/saude/serie?${params}`);
  if (!ok || !s.pontos.length) {
    desenharLinha(container, [], [], { textoVazio: t('semDadosGrafico') });
    return;
  }

  const dias = [...new Set(s.pontos.map((p) => p.dia))].sort();
  const plataformas = [...new Set(s.pontos.map((p) => p.plataforma))]
    .sort((a, b) => (COR_PLATAFORMA[a] ?? 99) - (COR_PLATAFORMA[b] ?? 99));
  const series = plataformas.map((plat, idx) => ({
    chave: plat,
    rotulo: rotularPlataforma(plat),
    cor: COR_PLATAFORMA[plat] ?? idx,
    pontos: dias.map((d) => s.pontos.find((p) => p.dia === d && p.plataforma === plat)?.media_horas ?? null),
  }));

  const rotuloMetrica = sel.options[sel.selectedIndex]?.textContent ?? '';
  desenharLinha(container, dias, series, {
    tooltip, unidade: t('tempoMedioUnidade'), formatarValor: duracaoH, rotuloEixoX: rotuloDia,
    aoClicarPonto: (plataforma, diaClicado) => abrirDetalheSaude(
      rotuloMetrica, `${rotularPlataforma(plataforma)} · ${rotuloDia(diaClicado)} — ${t('slowestToFastest')}`,
      {
        metrica: tipo, plataforma, status_anterior: statusAnterior, status_novo: statusNovo,
        // `dia` (não data_de/data_ate): o backend sabe que o dia de um ponto
        // do gráfico é o dia de ENTREGA/EVENTO da métrica, não o de compra —
        // ver o comentário em resolverMetricaTempo (api/rotas/rastreio.js).
        dias: '', data_de: '', data_ate: '', dia: diaClicado.slice(0, 10),
      },
    ),
  });
}

$('rst-serie-metrica')?.addEventListener('change', carregarSerie);

async function carregarSaude() {
  const params = paramsFiltro();
  const { ok, dados: s } = await api(`/api/metricas/rastreio/saude?${params}`);
  if (!ok) return;
  renderSaudeTempo(s.tempo_para_encontrar);
  renderSaudeNaoEncontrado(s.nao_encontrados);
  renderSaudeTransicoes(s.transicoes_status);
  renderSaudeSemCodigo(s.sem_codigo_rastreio);
  renderSaudeFunil(s.funil_por_plataforma);
  renderSaudeProvedores(s.provedores);
  renderSaudeTransporte(s.tempo_transporte);
  renderSaudeTotal(s.tempo_total);
  renderSaudeDistrib(s.distribuicao_entrega);
  popularSelectSerie(s.transicoes_status);
  carregarSerie();
}

async function carregarResumo() {
  const params = paramsFiltro();
  const { ok, dados: r } = await api(`/api/metricas/rastreio?${params}`);
  if (!ok) return;
  renderKpis(r);
}

function carregarTudo() {
  carregarResumo();
  carregarSaude();
  carregarLista();
}

/* ═══════════════════════════  idioma (EN/PT)  ═══════════════════════════════
 * Único par de botões da aba — trocar recarrega TUDO (KPIs, Saúde, gráfico,
 * lista): mais simples e mais seguro que tentar re-rotular cada pedaço já
 * renderizado, e o custo é baixo (é uma troca deliberada da pessoa, não algo
 * que acontece o tempo todo). */
function aoTrocarIdioma() {
  aplicarTraducoesEstaticas();
  sincronizarSelects();
  carregarTudo();
}
if ($('rst-idioma-seletor')) montarSeletorIdioma($('rst-idioma-seletor'), aoTrocarIdioma);
aplicarTraducoesEstaticas();

/* ═══════════════════════════════════  filtros  ═════════════════════════════ */

/**
 * Ponto de entrada pra "ir direto pra esta etapa" — chamado pela linha do
 * tempo da Home (ver visaoGeral.js). Sobrescreve o filtro de status atual
 * e recarrega só a lista (KPIs/Saúde continuam mostrando tudo, sem filtro
 * de status — mesmo padrão de abrirNaTabela em emailTickets.js).
 */
export async function abrirRastreioComStatus(status) {
  estado.status = status;
  $('rst-sel-status').value = status;
  estado.pagina = 1;
  await carregarLista();
}

$('rst-busca').addEventListener('input', debounce((e) => {
  estado.busca = e.target.value.trim();
  estado.pagina = 1;
  carregarLista();
}, 450));
$('rst-sel-status').addEventListener('change', (e) => {
  estado.status = e.target.value;
  estado.pagina = 1;
  carregarLista();
});
$('rst-sel-produto').addEventListener('change', (e) => {
  estado.produto = e.target.value;
  estado.pagina = 1;
  carregarTudo();
});
$('rst-sel-plataforma').addEventListener('change', (e) => {
  estado.plataforma = e.target.value;
  estado.pagina = 1;
  carregarTudo();
});

/* ══════════════  sub-abas: Todos / Red Rock / FullStack  ═══════════════════
 * Mesmo provedor (`r.provedor`) que já aparece como coluna/pílula na lista de
 * pedidos — aqui vira um recorte que se aplica a TUDO na aba (KPIs, Saúde,
 * gráfico e lista), igual produto/plataforma/período. Pedido "não encontrado
 * em nenhuma plataforma" nunca tem provedor gravado (a coluna só é
 * preenchida quando um dos dois scripts acha o pedido) — por isso o card de
 * KPI e as duas tabelas de Saúde que não fazem sentido filtradas por um só
 * provedor (Não encontrados, sempre vazia; Provedores, sempre uma linha só)
 * ficam escondidas fora da sub-aba "Todos", em vez de mostrar um vazio
 * confuso. Lembra a última escolha por navegador, mesmo padrão das subabas
 * do Suporte Escalado (ver emailSuporteEscalado.js).
 */
const SUBABAS_PROVEDOR = { todos: '', redrock: 'redrock', fullstack: 'fullstack' };

function aplicarVisibilidadeProvedor() {
  const combinado = estado.provedor === '';
  const blocoNaoEnc = $('rst-bloco-naoencontrado');
  const blocoProvedores = $('rst-bloco-provedores');
  if (blocoNaoEnc) blocoNaoEnc.hidden = !combinado;
  if (blocoProvedores) blocoProvedores.hidden = !combinado;
}

function mudarSubabaProvedor(nome) {
  estado.provedor = SUBABAS_PROVEDOR[nome];
  for (const chave of Object.keys(SUBABAS_PROVEDOR)) {
    $(`rst-subaba-btn-${chave}`)?.setAttribute('aria-selected', String(chave === nome));
  }
  localStorage.setItem('rstSubabaProvedor', nome);
  aplicarVisibilidadeProvedor();
  estado.pagina = 1;
  carregarTudo();
}

for (const nome of Object.keys(SUBABAS_PROVEDOR)) {
  $(`rst-subaba-btn-${nome}`)?.addEventListener('click', () => mudarSubabaProvedor(nome));
}
{
  const salva = localStorage.getItem('rstSubabaProvedor');
  const inicial = SUBABAS_PROVEDOR[salva] !== undefined ? salva : 'todos';
  estado.provedor = SUBABAS_PROVEDOR[inicial];
  for (const chave of Object.keys(SUBABAS_PROVEDOR)) {
    $(`rst-subaba-btn-${chave}`)?.setAttribute('aria-selected', String(chave === inicial));
  }
  aplicarVisibilidadeProvedor();
}

/**
 * "Escolher datas…" é um valor de vitrine no <select> — ao escolhê-lo, só
 * troca quais campos aparecem; o período em si fica vazio (= "Tudo") até
 * o usuário preencher De/Até. Mesmo padrão de emailFiltro.js (ce-sel-periodo).
 */
function mostrarCamposIntervaloRastreio(mostrar) {
  const campoDe = $('rst-campo-data-de');
  const campoAte = $('rst-campo-data-ate');
  if (campoDe) campoDe.hidden = !mostrar;
  if (campoAte) campoAte.hidden = !mostrar;
}

$('rst-sel-periodo').addEventListener('change', (e) => {
  if (e.target.value === 'intervalo') {
    estado.periodo = '';
    mostrarCamposIntervaloRastreio(true);
    estado.pagina = 1;
    carregarTudo();
    return;
  }
  estado.periodo = e.target.value || '';
  estado.dataDe = '';
  estado.dataAte = '';
  const inputDe = $('rst-data-de');
  const inputAte = $('rst-data-ate');
  if (inputDe) { inputDe.value = ''; inputDe.max = ''; }
  if (inputAte) { inputAte.value = ''; inputAte.min = ''; }
  mostrarCamposIntervaloRastreio(false);
  estado.pagina = 1;
  carregarTudo();
});
$('rst-data-de').addEventListener('change', (e) => {
  estado.dataDe = e.target.value || '';
  const inputAte = $('rst-data-ate');
  if (inputAte) inputAte.min = estado.dataDe;
  estado.pagina = 1;
  carregarTudo();
});
$('rst-data-ate').addEventListener('change', (e) => {
  estado.dataAte = e.target.value || '';
  const inputDe = $('rst-data-de');
  if (inputDe) inputDe.max = estado.dataAte;
  estado.pagina = 1;
  carregarTudo();
});

$('rst-atualizar').addEventListener('click', carregarTudo);

/**
 * O catálogo do topo (`sel-produto`/`sel-plataforma`) só existe depois do
 * primeiro `/api/snapshot` do painel voltar — medido em produção: ~6s desde
 * o login. Se o usuário abrir a aba Rastreio antes disso (comum: é a
 * primeira coisa que ele clica depois do login), `sincronizarSelects()`
 * clona uma lista vazia e nada dispara de novo sozinho depois (esta aba não
 * tem polling). Tenta de novo por até 15s — margem folgada sobre os ~6s
 * observados — e para assim que o topo tiver mais que só "Todos/Todas".
 */
function tentarSincronizarSelects(tentativasRestantes = 10) {
  sincronizarSelects();
  // Comparar os dois tamanhos (rst vs topo) não serve de gatilho: os dois
  // começam EMPATADOS em 1 (só o placeholder "Todos/Todas" de cada um),
  // então essa comparação já nasce "pronta" — e nunca reagenda a próxima
  // tentativa. O que precisa checar é só o TOPO: continua tentando enquanto
  // ele ainda não tiver nada além do próprio placeholder.
  const topoProduto = $('sel-produto');
  const aindaSemCatalogo = topoProduto && topoProduto.options.length <= 1;
  if (aindaSemCatalogo && tentativasRestantes > 0) {
    setTimeout(() => tentarSincronizarSelects(tentativasRestantes - 1), 1500);
  }
}

$('aba-btn-rastreio').addEventListener('click', () => tentarSincronizarSelects());

// Primeira carga — mesma mecânica das outras abas (todas ficam no DOM, só
// escondidas), sem polling: dado de fulfillment não muda a cada segundos.
tentarSincronizarSelects();
carregarTudo();
