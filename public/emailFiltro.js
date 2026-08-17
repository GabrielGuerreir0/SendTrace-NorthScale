/**
 * Central de E-mail IA — filtro compartilhado por Tickets, Detalhes e
 * Galeria: produto, loja e período. Fica em módulo próprio (em vez de
 * dentro de cada tela) porque as três precisam do MESMO estado — trocar de
 * Tickets para Detalhes sem mexer no filtro não pode perder o recorte.
 *
 * `produto`/`loja` cruzam por e-mail com o pedido do cliente
 * (mv_emails_x_pedidos no servidor) — não são os mesmos `#sel-produto`/
 * `#sel-plataforma` do topo (que só valem para Suporte IA/Régua), mas usam
 * o MESMO catálogo, então as opções são clonadas de lá em vez de recarregar
 * uma lista própria do servidor.
 */
const $ = (id) => document.getElementById(id);

/**
 * Período tem dois modos, mutuamente exclusivos — só um chega no servidor
 * por vez (ver qsFiltroCE): `dias` (últimos N dias) OU `dataDe`/`dataAte`
 * (intervalo de calendário escolhido nos dois campos de data).
 */
export const estadoCE = {
  produto: null, loja: null, dias: '', dataDe: '', dataAte: '',
};

const ouvintes = new Set();

/** Registra uma função a chamar sempre que produto/loja/período mudar. */
export function aoMudarFiltroCE(fn) {
  ouvintes.add(fn);
}

function notificar() {
  for (const fn of ouvintes) fn();
}

/** Monta os parâmetros de período/produto/loja prontos para a querystring. */
export function qsFiltroCE() {
  const p = new URLSearchParams();
  if (estadoCE.dias) {
    p.set('dias', estadoCE.dias);
  } else {
    if (estadoCE.dataDe) p.set('data_de', estadoCE.dataDe);
    if (estadoCE.dataAte) p.set('data_ate', estadoCE.dataAte);
  }
  if (estadoCE.produto) p.set('produto', estadoCE.produto);
  if (estadoCE.loja) p.set('loja', estadoCE.loja);
  return p;
}

/**
 * As opções de produto/loja são as MESMAS da barra do topo (mesmo catálogo
 * de `disparos_pos_venda`), só clonadas para não repetir uma ida ao
 * servidor. Idempotente: só clona se ainda não tiver nada além do "Todos".
 */
function sincronizarOpcoes() {
  const paresOrigem = [
    [$('sel-produto'), $('ce-sel-produto')],
    [$('sel-plataforma'), $('ce-sel-loja')],
  ];
  for (const [origem, destino] of paresOrigem) {
    if (!origem || !destino) continue;
    if (destino.options.length >= origem.options.length) continue;
    const valorAtual = destino.value;
    destino.replaceChildren(...[...origem.options].map((o) => o.cloneNode(true)));
    destino.value = valorAtual;
  }
}

$('ce-sel-produto')?.addEventListener('change', (e) => {
  estadoCE.produto = e.target.value || null;
  notificar();
});
$('ce-sel-loja')?.addEventListener('change', (e) => {
  estadoCE.loja = e.target.value || null;
  notificar();
});

/**
 * "Escolher datas…" é um valor de vitrine no próprio <select> — ao
 * escolhê-lo, só troca quais campos aparecem; o filtro de período em si
 * fica vazio (equivalente a "Tudo") até o usuário preencher De/Até.
 */
function mostrarCamposIntervalo(mostrar) {
  const campoDe = $('ce-campo-data-de');
  const campoAte = $('ce-campo-data-ate');
  if (campoDe) campoDe.hidden = !mostrar;
  if (campoAte) campoAte.hidden = !mostrar;
}

$('ce-sel-periodo')?.addEventListener('change', (e) => {
  if (e.target.value === 'intervalo') {
    estadoCE.dias = '';
    mostrarCamposIntervalo(true);
    notificar();
    return;
  }
  estadoCE.dias = e.target.value || '';
  estadoCE.dataDe = '';
  estadoCE.dataAte = '';
  const inputDe = $('ce-data-de');
  const inputAte = $('ce-data-ate');
  if (inputDe) { inputDe.value = ''; inputDe.max = ''; }
  if (inputAte) { inputAte.value = ''; inputAte.min = ''; }
  mostrarCamposIntervalo(false);
  notificar();
});

$('ce-data-de')?.addEventListener('change', (e) => {
  estadoCE.dataDe = e.target.value || '';
  const inputAte = $('ce-data-ate');
  if (inputAte) inputAte.min = estadoCE.dataDe;
  notificar();
});
$('ce-data-ate')?.addEventListener('change', (e) => {
  estadoCE.dataAte = e.target.value || '';
  const inputDe = $('ce-data-de');
  if (inputDe) inputDe.max = estadoCE.dataAte;
  notificar();
});

const ABAS_COM_FILTRO = new Set(['ticketsia', 'detalhesia', 'galeriaia']);
const ABAS_CENTRAL_EMAIL = new Set(['ticketsia', 'detalhesia', 'chatia', 'galeriaia', 'suporteescalado']);

/**
 * Chamada pelo troca-de-aba do painel (suporte.js): esconde a barra do topo
 * (produto/plataforma) nas 5 abas da Central de E-mail IA — lá ela não faz
 * nada — e mostra a barra nova só nas 3 que sabem usá-la. Chat com IA e
 * Suporte Escalado ficam sem nenhuma das duas: a IA roda a própria consulta
 * (chat) e a tabela de suporte_escalado não tem produto/loja/período (kanban).
 */
export function aoTrocarAba(nomeAba) {
  const barraCE = $('ce-filtro-barra');
  if (barraCE) {
    const mostrar = ABAS_COM_FILTRO.has(nomeAba);
    barraCE.hidden = !mostrar;
    if (mostrar) sincronizarOpcoes();
  }
  const mostrarTopo = !ABAS_CENTRAL_EMAIL.has(nomeAba);
  const campoProduto = $('campo-produto');
  const campoPlataforma = $('campo-plataforma');
  if (campoProduto) campoProduto.hidden = !mostrarTopo;
  if (campoPlataforma) campoPlataforma.hidden = !mostrarTopo;
}
