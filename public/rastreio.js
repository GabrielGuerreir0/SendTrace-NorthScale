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
  rotularStatusRastreio, rotularPlataforma, abrirFicha,
} from './emailComum.js';
import { n, dataHora } from './format.js';

const POR_PAGINA = 25;
const estado = {
  busca: '', status: '', produto: '', plataforma: '', pagina: 1,
};

const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);

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
    kpiCard({ icone: '◐', tom: 'neutro', rotulo: 'Consultando fornecedor', valor: n(r.pendente_consulta) }),
    kpiCard({ icone: '●', tom: 'neutro', rotulo: 'Pedido recebido', valor: n(r.pending) }),
    kpiCard({ icone: '➤', tom: 'neutro', rotulo: 'A caminho', valor: n(r.shipped) }),
    kpiCard({ icone: '✓', tom: 'bom', rotulo: 'Entregue', valor: n(r.delivered) }),
    kpiCard({ icone: '✕', tom: 'neutro', rotulo: 'Cancelado', valor: n(r.cancelled) }),
    kpiCard({ icone: '?', tom: 'neutro', rotulo: 'Status não mapeado', valor: n(r.desconhecido) }),
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
      { rotulo: 'Provedor', valor: d.provedor || '—' },
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
  const params = new URLSearchParams();
  if (estado.status) params.set('status', estado.status);
  if (estado.produto) params.set('produto', estado.produto);
  if (estado.plataforma) params.set('plataforma', estado.plataforma);
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

async function carregarResumo() {
  const params = new URLSearchParams();
  if (estado.produto) params.set('produto', estado.produto);
  if (estado.plataforma) params.set('plataforma', estado.plataforma);
  const { ok, dados: r } = await api(`/api/metricas/rastreio?${params}`);
  if (!ok) return;
  renderKpis(r);
}

function carregarTudo() {
  carregarResumo();
  carregarLista();
}

/* ═══════════════════════════════════  filtros  ═════════════════════════════ */

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
$('rst-atualizar').addEventListener('click', carregarTudo);

// O catálogo do topo pode chegar depois desta aba já ter carregado — sincroniza
// de novo a cada vez que a aba é aberta, sem custo (o clone é idempotente).
$('aba-btn-rastreio').addEventListener('click', sincronizarSelects);

// Primeira carga — mesma mecânica das outras abas (todas ficam no DOM, só
// escondidas), sem polling: dado de fulfillment não muda a cada segundos.
sincronizarSelects();
carregarTudo();
