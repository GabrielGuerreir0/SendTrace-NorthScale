/**
 * Aba "Rastreio de Pedidos" — Red Rock (fulfillment). Só leitura: quem
 * escreve em `rastreio_pedidos`/`rastreio_eventos` é o script
 * `server/rastreio/consultar_redrock.py`, nunca este painel (ver
 * api/rotas/rastreio.js). Mesmo padrão de visaoGeral.js/relatorioMetricas.js:
 * sem entrar no polling automático do painel — um pedido de fulfillment não
 * muda a cada poucos segundos, e a consulta de verdade já roda por fora.
 *
 * `nao_encontrado` NÃO é erro: cobre a maioria dos pedidos JVZoo/BuyGoods
 * hoje, porque só o fulfillment center da Red Rock está integrado (ver
 * PLANO.md, "Rastreamento de Disparo", seção 3). Só `exception` (falha real
 * de consulta) usa estilo de alarme — em todo o resto (KPI, pílula da
 * tabela, ficha) isso é respeitado de propósito.
 */
import {
  $, api, debounce, kpiCard, montarPaginacao, renderTabela, chipRastreio,
  rotularStatusRastreio, rotularPlataforma, abrirFicha, seloProvedor, tooltip,
} from './emailComum.js';
import { n, dataHora, dia, duracaoH } from './format.js';
import { desenharLinha } from './charts.js';

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
  busca: '', status: '', produto: '', plataforma: '', pagina: 1,
  periodo: '', dataDe: '', dataAte: '',
};

const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);

/**
 * Produto/plataforma/período — os 3 recortes que valem pra tudo nesta aba
 * (KPIs, Saúde e lista de pedidos), não só a tabela. Mesmo mecanismo de
 * "dias" OU "data_de"/"data_ate" (mutuamente exclusivos) de emailFiltro.js.
 */
function paramsFiltro() {
  const p = new URLSearchParams();
  if (estado.produto) p.set('produto', estado.produto);
  if (estado.plataforma) p.set('plataforma', estado.plataforma);
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
    [$('sel-produto'), $('rst-sel-produto')],
    [$('sel-plataforma'), $('rst-sel-plataforma')],
  ];
  for (const [origem, destino] of pares) {
    if (!origem || !destino) continue;
    if (destino.options.length >= origem.options.length) continue;
    const valorAtual = destino.value;
    destino.replaceChildren(...[...origem.options].map((o) => o.cloneNode(true)));
    destino.value = valorAtual;
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
    kpiCard({
      icone: '◍', tom: 'neutro', rotulo: 'Total de pedidos', valor: n(r.total),
      nota: 'já consultados na Red Rock ao menos uma vez',
    }),
    kpiCard({
      icone: '✓', tom: tomTaxa(r.taxa_entrega), rotulo: 'Taxa de entrega', valor: pct(r.taxa_entrega),
      nota: 'entregues ÷ (a caminho + entregues)',
    }),
    kpiCard({
      icone: '⚠', tom: r.exception > 0 ? 'ruim' : 'neutro', rotulo: 'Erro na consulta', valor: n(r.exception),
      nota: 'falha real de API/rede — o único status tratado como alarme aqui',
    }),
    kpiCard({
      icone: '○', tom: 'neutro', rotulo: 'Não encontrado na Red Rock', valor: n(r.nao_encontrado),
      nota: 'outro fulfillment center, ainda não integrado — esperado pra JVZoo/BuyGoods',
    }),
  );
  $('rst-kpis-status').replaceChildren(
    kpiCard({
      icone: '◐', tom: 'neutro', rotulo: 'Consultando fornecedor', valor: n(r.pendente_consulta),
      nota: 'pedidos sendo consultados na Red Rock pela primeira vez agora',
    }),
    kpiCard({
      icone: '●', tom: 'neutro', rotulo: 'Pedido recebido', valor: n(r.pending),
      nota: 'pedidos que a fulfillment recebeu das plataformas e ainda não foi enviado',
    }),
    kpiCard({
      icone: '➤', tom: 'neutro', rotulo: 'A caminho', valor: n(r.shipped),
      nota: 'pedidos que foram enviados',
    }),
    kpiCard({
      icone: '✓', tom: 'bom', rotulo: 'Entregue', valor: n(r.delivered),
      nota: 'pedidos que já chegaram no cliente',
    }),
    kpiCard({
      icone: '✕', tom: 'neutro', rotulo: 'Cancelado', valor: n(r.cancelled),
      nota: 'pedidos que foram cancelados',
    }),
    kpiCard({
      icone: '?', tom: 'neutro', rotulo: 'Status não mapeado', valor: n(r.desconhecido),
      nota: 'a Red Rock devolveu um status que ainda não reconhecemos',
    }),
    kpiCard({
      icone: '▭', tom: r.sem_codigo_rastreio > 0 ? 'medio' : 'neutro', rotulo: 'Sem código de rastreio',
      valor: n(r.sem_codigo_rastreio),
      nota: 'na fulfillment (recebido, a caminho, entregue ou cancelado) mas ainda sem tracking_number',
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
    li.textContent = 'Nenhuma mudança de status registrada ainda.';
    ul.append(li);
    return ul;
  }
  for (const ev of eventos) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = ev.status_anterior
      ? `${rotularStatusRastreio(ev.status_anterior)} → ${rotularStatusRastreio(ev.status_novo)}`
      : `Primeiro registro — ${rotularStatusRastreio(ev.status_novo)}`;
    const span = document.createElement('span');
    span.textContent = `${dataHora(ev.detectado_em)} · ${ev.fonte}`;
    li.append(strong, span);
    ul.append(li);
  }
  return ul;
}

async function abrirDetalhePedido(linha) {
  const { ok, dados: d } = await api(`/api/rastreio/${encodeURIComponent(linha.transacao_id)}`);
  if (!ok) { window.alert('Não consegui carregar os detalhes deste pedido.'); return; }

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
      { rotulo: 'Status', valor: chipRastreio(d.status_interno) },
      d.status_interno === 'exception' && d.ultimo_erro
        && { rotulo: 'Erro na última consulta', valor: d.ultimo_erro, largo: true },
      d.status_interno === 'desconhecido'
        && { rotulo: 'Status bruto (fornecedor)', valor: d.status_bruto || '—' },
      { rotulo: 'Produto', valor: d.produto || '—' },
      { rotulo: 'Plataforma', valor: rotularPlataforma(d.plataforma) },
      { rotulo: 'Provedor', valor: seloProvedor(d.provedor) },
      { rotulo: 'Número do pedido', valor: d.order_number || '—' },
      { rotulo: 'Pedido criado em', valor: d.order_created_at ? dataHora(d.order_created_at) : '—' },
      { rotulo: 'Total', valor: d.total ? `${d.total} ${d.currency || ''}`.trim() : '—' },
      {
        rotulo: 'Totalmente atendido',
        valor: d.fully_fulfilled ? `Sim${d.fully_fulfilled_at ? ` · ${dataHora(d.fully_fulfilled_at)}` : ''}` : 'Não',
      },
      { rotulo: 'Transportadora', valor: d.carrier_code || '—' },
      { rotulo: 'Código de rastreio', valor: d.tracking_number || '—' },
      { rotulo: 'Status na transportadora', valor: d.tracking_status || '—' },
      linkRastreio && { rotulo: 'Link de rastreio', valor: linkRastreio },
      { rotulo: 'Enviado em', valor: d.shipped_at ? dataHora(d.shipped_at) : '—' },
      { rotulo: 'Entregue em', valor: d.delivered_at ? dataHora(d.delivered_at) : '—' },
      { rotulo: 'Última consulta à Red Rock', valor: d.ultima_consulta_em ? dataHora(d.ultima_consulta_em) : '—' },
      { rotulo: 'Linha do tempo', valor: renderLinhaTempo(d.eventos), largo: true },
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
  renderTabela($('rst-tabela-corpo'), pedidos, colunas, { vazio: 'Nenhum pedido encontrado com este filtro.' });
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
    renderTabela($('rst-tabela-corpo'), [], [{ render: () => '' }], { vazio: 'Não consegui carregar os pedidos agora.' });
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
    // da aba (ex.: "últimos 30 dias") continuaria valendo e ignoraria o dia
    // clicado, porque `dias` tem prioridade sobre data_de/data_ate no backend.
    if (chave === 'dias' && valor === '') { params.delete('dias'); continue; }
    if (valor !== undefined && valor !== null && valor !== '') params.set(chave, valor);
  }
  params.set('page', String(detalhePagina));
  params.set('page_size', String(DETALHE_POR_PAGINA));

  const { ok, dados: d } = await api(`/api/metricas/rastreio/saude/detalhe?${params}`);
  if (meu !== detalheGeracao) return;
  if (!ok) {
    renderTabela($('rst-detalhe-corpo'), [], colunasDetalhe(), { vazio: 'Não consegui carregar estes pedidos.' });
    $('rst-detalhe-pag').replaceChildren();
    return;
  }
  renderTabela($('rst-detalhe-corpo'), d.results, colunasDetalhe(), { vazio: 'Nenhum pedido encontrado com este recorte.' });
  const totalPaginas = Math.max(1, Math.ceil(d.count / DETALHE_POR_PAGINA));
  montarPaginacao($('rst-detalhe-pag'), { pagina: detalhePagina, totalPaginas, total: d.count, rotuloItem: 'pedido' }, (p) => {
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
    'Tempo até aparecer na Red Rock', rotularPlataforma(l.plataforma),
    { metrica: 'deteccao', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-tempo'), linhas, colunas, { vazio: 'Sem detecção orgânica registrada ainda.' });
}

function renderSaudeNaoEncontrado(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.total) },
    { render: (l) => (l.media_dias_desde_compra ?? '—') },
    { render: (l) => (l.compra_mais_antiga ? dia(l.compra_mais_antiga) : '—') },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    'Não encontrados na Red Rock', rotularPlataforma(l.plataforma),
    { metrica: 'lista', plataforma: l.plataforma, status_interno: 'nao_encontrado' },
  );
  renderTabela($('rst-saude-naoencontrado'), linhas, colunas, { vazio: 'Nenhum pedido sem correlação com a Red Rock.' });
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
    `${rotularStatusRastreio(l.status_anterior)} → ${rotularStatusRastreio(l.status_novo)}`, 'tempo por pedido',
    { metrica: 'transicao', status_anterior: l.status_anterior ?? '', status_novo: l.status_novo },
  );
  renderTabela($('rst-saude-transicoes'), linhas, colunas, { vazio: 'Ainda sem transições de status suficientes.' });
}

function renderSaudeSemCodigo(linhas) {
  const colunas = [
    { render: (l) => chipRastreio(l.status_interno) },
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.total) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    'Sem código de rastreio', `${rotularStatusRastreio(l.status_interno)} · ${rotularPlataforma(l.plataforma)}`,
    { metrica: 'lista', plataforma: l.plataforma, status_interno: l.status_interno, sem_codigo: '1' },
  );
  renderTabela($('rst-saude-semcodigo'), linhas, colunas, { vazio: 'Todo pedido encontrado já tem código de rastreio.' });
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
    'Funil por plataforma', rotularPlataforma(l.plataforma),
    { metrica: 'lista', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-funil'), linhas, colunas, { vazio: 'Nenhum pedido consultado ainda.' });
}

function renderSaudeProvedores(linhas) {
  const colunas = [
    { render: (l) => seloProvedor(l.provedor === 'nenhum' ? null : l.provedor) },
    { render: (l) => n(l.total) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    'Provedor de rastreio', l.provedor,
    { metrica: 'lista', provedor: l.provedor },
  );
  renderTabela($('rst-saude-provedores'), linhas, colunas, { vazio: 'Nenhum pedido consultado ainda.' });
}

function renderSaudeTransporte(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    'Tempo de transporte', rotularPlataforma(l.plataforma),
    { metrica: 'transporte', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-transporte'), linhas, colunas, { vazio: 'Nenhum pedido entregue com despacho registrado ainda.' });
}

function renderSaudeTotal(linhas) {
  const colunas = [
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => n(l.amostras) },
    { render: (l) => duracaoH(l.media_horas) },
    { render: (l) => duracaoH(l.mediana_horas) },
  ];
  colunas.aoClicarLinha = (l) => abrirDetalheSaude(
    'Tempo total: compra → entrega', rotularPlataforma(l.plataforma),
    { metrica: 'total', plataforma: l.plataforma },
  );
  renderTabela($('rst-saude-total'), linhas, colunas, { vazio: 'Nenhum pedido entregue ainda.' });
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
    { valor: 'deteccao', rotulo: 'Tempo até aparecer na Red Rock (compra → 1º registro)' },
    ...transicoes.map((t) => ({
      valor: `transicao|${t.status_anterior ?? ''}|${t.status_novo}`,
      rotulo: `${rotularStatusRastreio(t.status_anterior)} → ${rotularStatusRastreio(t.status_novo)}`,
    })),
    { valor: 'transporte', rotulo: 'Tempo de transporte (a caminho → entregue)' },
    { valor: 'total', rotulo: 'Tempo total (compra → entregue)' },
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
    desenharLinha(container, [], [], { textoVazio: 'Sem dados suficientes pra esse recorte ainda.' });
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
    tooltip, unidade: 'tempo médio', formatarValor: duracaoH, rotuloEixoX: rotuloDia,
    aoClicarPonto: (plataforma, diaClicado) => abrirDetalheSaude(
      rotuloMetrica, `${rotularPlataforma(plataforma)} · ${rotuloDia(diaClicado)} — do mais lento pro mais rápido`,
      {
        metrica: tipo, plataforma, status_anterior: statusAnterior, status_novo: statusNovo,
        dias: '', data_de: diaClicado, data_ate: diaClicado,
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
