/**
 * SPPL — Monitoramento Logístico (2º momento da Késsia): 5 quadros de pedidos com problema logístico, relatório de pedidos (14 informações),
 * exportação para Excel e a ação "Selecionar para Suporte Ativo". Atualiza sozinho (a cada 60 s com a aba aberta). Tudo em português.
 * Os critérios dos quadros estão na migração 101 (view sppl_logistica) e repetidos aqui, em texto, para a equipe.
 */
import { api, montarPaginacao } from './emailComum.js';
import { rotuloStatus17Pt } from './linhaTempo17.js';
import { baixarXlsx } from './xlsx.js';
import { el, fmtData, fmtDataHora, fmtValor, rotPlataforma, campoSelect, campoTexto, mensagem } from './spplComum.js';

const QUADROS = [
  { n: 1, titulo: 'Pedidos sem rastreio', criterio: 'Mais de 2 dias úteis desde a compra, sem código de rastreio.', objetivo: 'Atraso na geração do rastreio: conferir se a fulfillment recebeu o pedido.' },
  { n: 2, titulo: 'Rastreio, mas sem despacho', criterio: 'Código gerado há mais de 2 dias úteis e nenhuma coleta confirmada pela transportadora.', objetivo: 'O código existe, mas o pacote ainda não foi despachado.' },
  { n: 3, titulo: 'Monitorar', criterio: '5 a 9 dias corridos sem movimentação logística relevante.', objetivo: 'Possível atraso; acompanhar sem contato imediato com o cliente.' },
  { n: 4, titulo: 'Atenção', criterio: '10 a 14 dias corridos sem movimentação logística relevante.', objetivo: 'Priorizar a análise; avaliar contato com o cliente ou cobrança da transportadora.' },
  { n: 5, titulo: 'Críticos', criterio: '15 dias corridos ou mais sem movimentação logística relevante.', objetivo: 'Casos prioritários que exigem decisão de solução.' },
];
const POR_PAGINA = 50;
const estado = { quadro: 'todos', busca: '', plataforma: '', fulfillment: '', suporte_ativo: 'nao', pagina: 1, selecionados: new Set(), total: 0, itens: [], resumo: null, carregando: false };
let raiz = null; let temporizador = null; let iniciado = false; let msgEl = null;

const consulta = (extra = {}) => {
  const q = new URLSearchParams();
  q.set('quadro', estado.quadro);
  if (estado.busca) q.set('busca', estado.busca); if (estado.plataforma) q.set('plataforma', estado.plataforma);
  if (estado.fulfillment) q.set('fulfillment', estado.fulfillment); if (estado.suporte_ativo) q.set('suporte_ativo', estado.suporte_ativo);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
};

/* ── quadros ── */
function desenharQuadros() {
  const caixa = raiz.querySelector('#mon-quadros'); caixa.replaceChildren();
  const r = estado.resumo; const total = r ? Object.values(r.quadros).reduce((s, v) => s + v, 0) : 0;
  const mk = (chave, rotulo, valor, criterio, tom) => {
    const b = el('button', undefined, 'sppl-kpi'); b.type = 'button'; b.setAttribute('aria-pressed', String(estado.quadro === chave));
    if (tom) b.dataset.tom = tom; b.title = criterio;
    const num = el('b', valor === null || valor === undefined ? '…' : String(valor)); const rot = el('span', rotulo); const crit = el('small', criterio, 'sppl-kpi-criterio');
    b.append(num, rot, crit);
    b.addEventListener('click', () => { estado.quadro = chave; estado.pagina = 1; estado.selecionados.clear(); desenharQuadros(); carregarLista(); });
    return b;
  };
  caixa.append(mk('todos', 'Todos os quadros', total, 'Todos os pedidos que caíram em algum quadro.'));
  for (const q of QUADROS) caixa.append(mk(String(q.n), `${q.n} · ${q.titulo}`, r?.quadros[q.n], q.criterio, q.n >= 4 && r?.quadros[q.n] > 0 ? 'alto' : undefined));
  if (r) caixa.append(mk('sem17', 'Sem dado do 17TRACK', r.sem_17track, 'Tem código de rastreio, mas o 17TRACK ainda não acompanha o pacote: não dá para calcular dias sem movimentação.'));
}

async function carregarResumo() {
  const r = await api('/api/rastreio/sppl/logistica/resumo');
  if (r.ok) { estado.resumo = r.dados; desenharQuadros(); const aviso = raiz.querySelector('#mon-atualizado'); if (aviso) aviso.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${r.dados.tickets_abertos} pedido(s) no Suporte Ativo`; }
}

/* ── relatório ── */
const celula = (rotulo, conteudo, classe) => { const td = document.createElement('td'); td.dataset.label = rotulo; if (classe) td.className = classe; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? '—'; return td; };

function linha(p) {
  const tr = document.createElement('tr'); tr.className = 'sup-linha-clique';
  const marca = document.createElement('input'); marca.type = 'checkbox'; marca.checked = estado.selecionados.has(p.transacao_id); marca.setAttribute('aria-label', `Selecionar o pedido ${p.numero_pedido}`);
  if (p.ticket_id) { marca.disabled = true; marca.title = 'Já está no Suporte Ativo'; }
  marca.addEventListener('click', (e) => e.stopPropagation());
  marca.addEventListener('change', () => { if (marca.checked) estado.selecionados.add(p.transacao_id); else estado.selecionados.delete(p.transacao_id); atualizarBarra(); });
  const cliente = el('div'); cliente.append(el('strong', p.nome || '—'), el('br'), el('small', p.email || '', 'cartao-sub'));
  let rastreio = el('span', '—');
  if (p.rastreio) { rastreio = el('div'); rastreio.append(el('span', p.rastreio)); if (p.link_rastreio) { const a = el('a', 'Acompanhar'); a.href = p.link_rastreio; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.addEventListener('click', (e) => e.stopPropagation()); rastreio.append(el('br'), a); } }
  const pedido = el('div'); pedido.append(el('strong', p.numero_pedido)); if (p.ticket_id) pedido.append(el('br'), el('span', 'No Suporte Ativo', 'sppl-selo'));
  const tdMarca = document.createElement('td'); tdMarca.append(marca);
  const dias = p.dias_sem_movimentacao;
  tr.append(tdMarca, celula('Pedido', pedido), celula('Cliente', cliente), celula('Endereço do cliente', p.endereco || '—'), celula('Fulfillment', p.fulfillment || '—'),
    celula('Transportadora', p.transportadora || '—'), celula('Produtos comprados', p.produtos || '—'), celula('Quantidade', p.quantidade ?? '—'), celula('Valor', fmtValor(p.valor)),
    celula('Código de rastreio', rastreio), celula('Data do pedido', fmtData(p.data_pedido)), celula('Idade (dias)', p.idade_dias ?? '—'),
    celula('Última movimentação', p.ultima_movimentacao_em ? fmtDataHora(p.ultima_movimentacao_em) : 'Nenhuma'), celula('Dias sem movimentação', dias ?? '—', dias >= 15 ? 'sppl-prazo--vencido' : ''),
    celula('Último status', rotuloStatus17Pt(p.ultimo_status) === '—' && !p.rastreio ? 'Sem rastreio' : rotuloStatus17Pt(p.ultimo_status)));
  tr.addEventListener('click', () => document.dispatchEvent(new CustomEvent('rastreio:abrir-pedido', { detail: { transacao_id: p.transacao_id } })));
  return tr;
}

async function carregarLista() {
  if (estado.carregando) return; estado.carregando = true;
  const corpo = raiz.querySelector('#mon-corpo');
  try {
    const r = await api(`/api/rastreio/sppl/logistica/pedidos?${consulta({ pagina: estado.pagina, tamanho: POR_PAGINA })}`);
    if (!r.ok) { corpo.replaceChildren(vazio(r.dados?.erro || r.dados?.detail || 'Não foi possível carregar os pedidos.')); return; }
    estado.itens = r.dados.itens; estado.total = r.dados.total;
    corpo.replaceChildren(...(estado.itens.length ? estado.itens.map(linha) : [vazio('Nenhum pedido neste quadro com os filtros atuais.')]));
    montarPaginacao(raiz.querySelector('#mon-paginacao'), { pagina: estado.pagina, totalPaginas: Math.max(1, Math.ceil(estado.total / POR_PAGINA)), total: estado.total, rotuloItem: 'pedidos' }, (p) => { estado.pagina = p; carregarLista(); });
    atualizarBarra();
  } finally { estado.carregando = false; }
}
const vazio = (texto) => { const tr = document.createElement('tr'); const td = el('td', texto, 'vazio-suave'); td.colSpan = 15; tr.append(td); return tr; };

function atualizarBarra() {
  const n = estado.selecionados.size; const barra = raiz.querySelector('#mon-barra-sel');
  barra.querySelector('#mon-sel-texto').textContent = n ? `${n} pedido(s) selecionado(s)` : 'Nenhum pedido selecionado';
  barra.querySelector('#mon-btn-selecionar').disabled = !n; barra.querySelector('#mon-btn-limpar').hidden = !n;
  const todosFiltro = barra.querySelector('#mon-btn-todos-filtro'); todosFiltro.hidden = !(estado.total > estado.itens.length && estado.itens.length > 0);
  todosFiltro.textContent = `Selecionar os ${estado.total} do filtro`;
  const cab = raiz.querySelector('#mon-marca-todos'); if (cab) cab.checked = estado.itens.length > 0 && estado.itens.filter((p) => !p.ticket_id).every((p) => estado.selecionados.has(p.transacao_id));
}

/* ── ações ── */
async function selecionarTodosDoFiltro() {
  mensagem(msgEl, 'Buscando os pedidos do filtro…');
  const r = await api(`/api/rastreio/sppl/logistica/pedidos?${consulta({ todos: 1 })}`);
  if (!r.ok) { mensagem(msgEl, 'Não foi possível buscar os pedidos do filtro.', true); return; }
  for (const p of r.dados.itens) if (!p.ticket_id) estado.selecionados.add(p.transacao_id);
  mensagem(msgEl, r.dados.cortado ? `Selecionados ${estado.selecionados.size} (o filtro tem ${r.dados.total}; refine o filtro para pegar o resto).` : `${estado.selecionados.size} pedido(s) selecionado(s).`);
  for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]:not(:disabled)')) cb.checked = true;
  atualizarBarra();
}

async function enviarParaSuporteAtivo() {
  const lista = [...estado.selecionados]; if (!lista.length) return;
  if (!window.confirm(`Selecionar ${lista.length} pedido(s) para o Suporte Ativo do SPPL?\n\nIsso só cria os tickets (status inicial "Caso novo - Analisar"). Nenhum e-mail é enviado agora.`)) return;
  const btn = raiz.querySelector('#mon-btn-selecionar'); btn.disabled = true; let criados = 0; let ja = 0;
  try {
    for (let i = 0; i < lista.length; i += 500) {
      const r = await api('/api/rastreio/sppl/ativo/selecionar', { metodo: 'POST', corpo: { transacao_ids: lista.slice(i, i + 500) } });
      if (!r.ok) { mensagem(msgEl, r.dados?.erro || r.dados?.detail || 'Não foi possível selecionar.', true); return; }
      criados += r.dados.criados; ja += r.dados.ja_existiam;
    }
    mensagem(msgEl, `${criados} ticket(s) criado(s) no Suporte Ativo${ja ? ` (${ja} já existiam)` : ''}. Abra a aba "Suporte Ativo" para enviar os e-mails.`);
    estado.selecionados.clear(); await carregarResumo(); await carregarLista();
    document.dispatchEvent(new CustomEvent('sppl:ativo-mudou'));
  } finally { btn.disabled = false; }
}

async function exportarExcel() {
  const btn = raiz.querySelector('#mon-btn-excel'); btn.disabled = true; mensagem(msgEl, 'Gerando a planilha…');
  try {
    const r = await api(`/api/rastreio/sppl/logistica/pedidos?${consulta({ todos: 1 })}`);
    if (!r.ok) { mensagem(msgEl, 'Não foi possível gerar a planilha.', true); return; }
    const cab = ['Número do pedido', 'Cliente', 'E-mail', 'Endereço do cliente', 'Fulfillment responsável', 'Transportadora', 'Produtos comprados (principal e upsells)', 'Quantidade de produtos', 'Valor do pedido (USD)',
      'Código de rastreio original', 'Link para acompanhamento', 'Data do pedido', 'Idade do pedido (dias)', 'Data da última movimentação relevante', 'Dias sem movimentação relevante', 'Último status registrado', 'Quadro', 'Plataforma'];
    const NOME_QUADRO = Object.fromEntries(QUADROS.map((q) => [q.n, `${q.n} · ${q.titulo}`]));
    const linhas = [cab, ...r.dados.itens.map((p) => [p.numero_pedido, p.nome, p.email, p.endereco, p.fulfillment, p.transportadora, p.produtos, p.quantidade, p.valor === null || p.valor === undefined ? null : Number(p.valor),
      p.rastreio, p.link_rastreio, fmtData(p.data_pedido), p.idade_dias, p.ultima_movimentacao_em ? fmtDataHora(p.ultima_movimentacao_em) : '', p.dias_sem_movimentacao, rotuloStatus17Pt(p.ultimo_status), NOME_QUADRO[p.quadro] || (p.sem_17track ? 'Sem dado do 17TRACK' : ''), rotPlataforma(p.plataforma)])];
    const q = estado.quadro === 'todos' ? 'todos-os-quadros' : estado.quadro === 'sem17' ? 'sem-17track' : `quadro-${estado.quadro}`;
    baixarXlsx(`sppl-pedidos-${q}-${new Date().toISOString().slice(0, 10)}.xlsx`, 'Pedidos', linhas, { larguras: [18, 22, 26, 36, 14, 14, 44, 12, 14, 24, 40, 14, 12, 20, 12, 28, 24, 14] });
    mensagem(msgEl, `Planilha gerada com ${r.dados.itens.length} pedido(s)${r.dados.cortado ? ` (o filtro tem ${r.dados.total}; a planilha leva até 5000)` : ''}.`);
  } finally { btn.disabled = false; }
}

/* ── montagem da tela ── */
function montar() {
  raiz = document.getElementById('mon-raiz'); raiz.replaceChildren();
  const cab = el('header', undefined, 'cartao-cabeca'); const quem = el('div');
  quem.append(el('h2', 'Monitoramento logístico do SPPL'), el('p', 'Acompanhe pedidos com problema de rastreio, despacho ou entrega, analise cada caso, cobre fulfillment ou transportadora e decida se o pedido continua em monitoramento ou vai para o Suporte Ativo. Estar aqui não significa que o cliente receberá e-mail.', 'cartao-sub'));
  quem.append(el('p', 'Os dias sem movimentação contam a partir do último evento REAL da transportadora (criar etiqueta ou atualizar o pedido não zera a contagem). Pedido que entrou no Suporte Ativo e foi FECHADO sai desta tela.', 'cartao-sub'));
  quem.append(el('p', undefined, 'cartao-sub sppl-aviso')); quem.lastChild.id = 'mon-atualizado';
  cab.append(quem); raiz.append(cab);
  const quadros = el('div', undefined, 'sppl-kpis sppl-kpis--quadros'); quadros.id = 'mon-quadros'; quadros.setAttribute('role', 'group'); quadros.setAttribute('aria-label', 'Quadros do monitoramento'); raiz.append(quadros);

  const filtros = el('div', undefined, 'sppl-filtros');
  const b = campoTexto('Buscar', { tipo: 'search', max: 80, placeholder: 'Pedido, cliente, e-mail ou código de rastreio', cresce: true });
  let t0; b.input.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { estado.busca = b.input.value.trim(); estado.pagina = 1; carregarLista(); }, 350); });
  const plat = campoSelect('Plataforma', [['', 'Todas'], ['jvzoo', 'JVZoo'], ['buygoods', 'BuyGoods'], ['digistore24', 'Digistore24']], '', (v) => { estado.plataforma = v; estado.pagina = 1; carregarLista(); });
  const ful = campoSelect('Fulfillment', [['', 'Todas'], ['redrock', 'Red Rock'], ['fullstack', 'FullStack'], ['jetstream', 'Jetpack']], '', (v) => { estado.fulfillment = v; estado.pagina = 1; carregarLista(); });
  const sa = campoSelect('Suporte Ativo', [['nao', 'Ainda não selecionados'], ['', 'Todos'], ['sim', 'Já no Suporte Ativo']], 'nao', (v) => { estado.suporte_ativo = v; estado.pagina = 1; carregarLista(); });
  filtros.append(b.rotulo, plat.rotulo, ful.rotulo, sa.rotulo); raiz.append(filtros);

  const barra = el('div', undefined, 'sppl-acoes'); barra.id = 'mon-barra-sel';
  const txt = el('span', 'Nenhum pedido selecionado', 'cartao-sub'); txt.id = 'mon-sel-texto';
  const bSel = el('button', 'Selecionar para Suporte Ativo do SPPL', 'btn btn-forte'); bSel.type = 'button'; bSel.id = 'mon-btn-selecionar'; bSel.disabled = true; bSel.addEventListener('click', enviarParaSuporteAtivo);
  const bTodos = el('button', 'Selecionar todos do filtro', 'btn'); bTodos.type = 'button'; bTodos.id = 'mon-btn-todos-filtro'; bTodos.hidden = true; bTodos.addEventListener('click', selecionarTodosDoFiltro);
  const bLimpar = el('button', 'Limpar seleção', 'btn'); bLimpar.type = 'button'; bLimpar.id = 'mon-btn-limpar'; bLimpar.hidden = true; bLimpar.addEventListener('click', () => { estado.selecionados.clear(); for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]')) cb.checked = false; atualizarBarra(); });
  const bExcel = el('button', 'Exportar para Excel', 'btn'); bExcel.type = 'button'; bExcel.id = 'mon-btn-excel'; bExcel.addEventListener('click', exportarExcel);
  msgEl = el('span', '', 'cartao-sub'); msgEl.setAttribute('role', 'status');
  barra.append(txt, bSel, bTodos, bLimpar, bExcel, msgEl); raiz.append(barra);

  const envolve = el('div', undefined, 'tabela-envolve'); const tab = el('table', undefined, 'tabela tabela--empilha tabela--larga'); tab.id = 'mon-tabela';
  const thead = document.createElement('thead'); const trh = document.createElement('tr');
  const thMarca = document.createElement('th'); thMarca.scope = 'col'; const todos = document.createElement('input'); todos.type = 'checkbox'; todos.id = 'mon-marca-todos'; todos.setAttribute('aria-label', 'Selecionar todos os pedidos desta página');
  todos.addEventListener('change', () => { for (const p of estado.itens) { if (p.ticket_id) continue; if (todos.checked) estado.selecionados.add(p.transacao_id); else estado.selecionados.delete(p.transacao_id); } for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]:not(:disabled)')) cb.checked = todos.checked; atualizarBarra(); });
  thMarca.append(todos); trh.append(thMarca);
  for (const h of ['Pedido', 'Cliente', 'Endereço do cliente', 'Fulfillment', 'Transportadora', 'Produtos comprados', 'Qtd.', 'Valor', 'Código de rastreio', 'Data do pedido', 'Idade (dias)', 'Última movimentação', 'Dias sem movimentação', 'Último status']) { const th = el('th', h); th.scope = 'col'; trh.append(th); }
  thead.append(trh); const tbody = document.createElement('tbody'); tbody.id = 'mon-corpo'; tbody.append(vazio('carregando…'));
  tab.append(thead, tbody); envolve.append(tab); raiz.append(envolve);
  const pag = el('div', undefined, 'paginacao'); pag.id = 'mon-paginacao'; raiz.append(pag);
}

async function atualizar() { await Promise.all([carregarResumo(), carregarLista()]); }

/** Chamado quando a aba é aberta. Monta na primeira vez e liga a atualização automática enquanto a aba estiver visível. */
export function abrirMonitor() {
  if (!iniciado) { iniciado = true; montar(); desenharQuadros(); atualizar(); }
  clearInterval(temporizador);
  temporizador = setInterval(() => { if (document.hidden || document.getElementById('rst-painel-monitor')?.hidden) return; carregarResumo(); if (!estado.selecionados.size) carregarLista(); }, 60_000);
}
export function fecharMonitor() { clearInterval(temporizador); temporizador = null; }
document.addEventListener('sppl:ativo-mudou', () => { if (iniciado) atualizar(); });
