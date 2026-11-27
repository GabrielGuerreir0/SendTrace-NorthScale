/**
 * MONIT-SPPL — tela "Monitoramento Logístico" (Késsia, 26/11/2026): classificação dos pedidos em aberto em 5 grupos / 24 classes, lista ordenável com
 * filtros, ficha do pedido com a linha do tempo do 17Track, e (módulos à parte) tratativas e prazos. SEMPRE em português.
 * Os textos de negócio (nomes, "como tratar", urgência) vêm da API (`/api/rastreio/monit/config`): a tela não os repete. Todo texto da API entra por textContent.
 */
import { api, montarPaginacao } from './emailComum.js';
import { el, fmtData, fmtDataHora, fmtValor, rotPlataforma, campoSelect, campoTexto, criarJanela, selo, mensagem } from './spplComum.js';

const BASE = '/api/rastreio/monit';
const estado = {
  cfg: null, leitura: null, resumo: null, dados: null, carregando: false, aba: 'classificacao',
  filtros: { desde: '2026-10-01', reemb: 'sem' },                                  // globais (valem para todas as abas)
  lista: { grupo: '', classe: '', causa: '', q: '', fulfillment: '', plataforma: '', tratado: '', multi: false, ordem: 'dias_desde_evento', dir: 'desc', pagina: 1 },
  selecionados: new Set(), tamanho: 100,
};
let raiz = null; let temporizador = null; let iniciado = false; let tokenLista = 0; let msgEl = null;
const modulos = {};   // módulos carregados sob demanda (tratativas, prazos, indicadores)
const ARQUIVOS = { tratativas: './monitTratativas.js', prazos: './monitPrazos.js', indicadores: './monitIndicadores.js' };
/** Importa e inicia um módulo uma única vez. `raizDe` = onde ele desenha (aba ou bloco). */
async function modulo(nome, raizDe) {
  if (modulos[nome]) return modulos[nome];
  const m = await import(ARQUIVOS[nome]); modulos[nome] = m;
  m.iniciar({ raiz: raizDe ?? raiz.querySelector(`.mon-painel[data-aba=${nome}]`), estado, api, abrirFicha, parametros, filtrarPor });
  return m;
}

const CSS = `
.mon-topo { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end; justify-content: space-between; margin: 0 0 12px; }
.mon-topo .sppl-filtros { margin: 0; }
.mon-lido { font-size: 12px; color: var(--tinta-fraca); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mon-lido b { color: var(--tinta); font-variant-numeric: tabular-nums; }
.mon-seg { display: inline-flex; border: 1px solid var(--borda); border-radius: 10px; overflow: hidden; }
.mon-seg button { appearance: none; border: 0; background: var(--superficie-2, var(--superficie)); color: var(--tinta); padding: 7px 12px; font: inherit; font-size: 12px; cursor: pointer; border-right: 1px solid var(--borda); }
.mon-seg button:last-child { border-right: 0; }
.mon-seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--st-em-dia) 18%, var(--superficie)); font-weight: 600; }
.mon-abas { display: flex; gap: 6px; margin: 0 0 14px; border-bottom: 1px solid var(--borda); }
.mon-abas button { appearance: none; border: 0; background: none; color: var(--tinta-fraca); padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.mon-abas button[aria-selected="true"] { color: var(--tinta); border-bottom-color: var(--st-em-dia); font-weight: 600; }
.mon-grupos { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 0 0 12px; }
.mon-grupo { appearance: none; text-align: left; border: 1px solid var(--borda); border-radius: 12px; background: var(--superficie-2, var(--superficie)); padding: 12px 14px; cursor: pointer; color: var(--tinta); font: inherit; }
.mon-grupo:hover { border-color: var(--eixo); }
.mon-grupo[aria-pressed="true"] { border-color: var(--st-em-dia); box-shadow: 0 0 0 2px color-mix(in srgb, var(--st-em-dia) 25%, transparent); }
.mon-grupo b { font: 600 24px/1.1 var(--fonte-mono); font-variant-numeric: tabular-nums; }
.mon-grupo small { display: block; color: var(--tinta-fraca); font-size: 11px; margin-top: 2px; }
.mon-grupo .mon-nome { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.mon-pilha { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: var(--trilho); margin-top: 8px; }
.mon-pilha i { display: block; height: 100%; }
.mon-avisos { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.mon-aviso { border: 1px solid #E0A526; background: color-mix(in srgb, #E0A526 14%, var(--superficie)); border-radius: 10px; padding: 7px 12px; font-size: 12.5px; cursor: pointer; color: var(--tinta); font: inherit; font-size: 12.5px; }
.mon-todo { border: 1px solid var(--borda); border-radius: 12px; padding: 12px 14px; margin: 0 0 14px; background: var(--superficie-2, var(--superficie)); }
.mon-todo summary { cursor: pointer; font-weight: 600; font-size: 13px; }
.mon-barra { display: grid; grid-template-columns: minmax(150px, 260px) 1fr 90px; gap: 10px; align-items: center; width: 100%; appearance: none; border: 0; background: none; padding: 3px 0; text-align: left; cursor: pointer; color: var(--tinta); font: inherit; font-size: 12.5px; }
.mon-barra:hover { background: color-mix(in srgb, var(--tinta) 5%, transparent); }
.mon-barra .mon-trilho { height: 10px; border-radius: 6px; background: var(--trilho); overflow: hidden; }
.mon-barra .mon-trilho i { display: block; height: 100%; border-radius: 6px; }
.mon-barra span:last-child { text-align: right; font-variant-numeric: tabular-nums; color: var(--tinta-fraca); }
.mon-gtit { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--tinta-fraca); margin: 10px 0 3px; }
.mon-tabela th[data-ordem] { cursor: pointer; user-select: none; white-space: nowrap; }
.mon-tabela th[data-ordem]:hover { color: var(--st-em-dia); }
.mon-tabela td { vertical-align: top; }
.mon-tabela .mon-pt { max-width: 280px; }
.mon-cl { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--borda); white-space: nowrap; }
.mon-ficha dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0 0 12px; font-size: 13px; }
.mon-ficha dt { color: var(--tinta-fraca); }
.mon-ficha dd { margin: 0; overflow-wrap: anywhere; }
.mon-ficha h3 { margin: 16px 0 6px; font-size: 13px; }
.mon-caixa { border: 1px solid var(--borda); border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; background: var(--superficie-2, var(--superficie)); font-size: 13px; }
.mon-tl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mon-tl th, .mon-tl td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--borda); vertical-align: top; }
.mon-tl tr[data-atual="1"] td { background: color-mix(in srgb, var(--st-atrasado) 16%, transparent); }
.mon-tl tr[data-relevante="0"] td { color: var(--tinta-fraca); }
.mon-vazio { color: var(--tinta-fraca); padding: 14px 4px; font-size: 13px; }
`;

const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const pct = (v, t) => (t ? `${(100 * v / t).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '0%');
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const grupoDe = (id) => estado.cfg.grupos.find((g) => g.id === id);
const classeDe = (k) => estado.cfg.classes.find((c) => c.chave === k);
const rotFul = (f) => estado.cfg.rotulo_fulfillment[String(f || '').toLowerCase()] ?? f ?? '—';
const rotPlat = (p) => (p ? rotPlataforma(p) : 'Não identificada');
const seguro = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);
function link(texto, url) { const u = seguro(url); if (!u) return el('span', texto ?? '—'); const a = el('a', texto); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }

/** Parâmetros globais + os da lista, em query string. */
function parametros({ lista = true, extra = {} } = {}) {
  const p = new URLSearchParams();
  const g = estado.filtros; p.set('desde', g.desde); p.set('reemb', g.reemb);
  if (lista) { const l = estado.lista; for (const k of ['grupo', 'classe', 'causa', 'q', 'fulfillment', 'plataforma', 'tratado']) if (l[k]) p.set(k, l[k]); if (l.multi) p.set('multi', '1'); }
  else { const l = estado.lista; for (const k of ['fulfillment', 'plataforma']) if (l[k]) p.set(k, l[k]); }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, v);
  return p.toString();
}

/* ───────────────────────────────  carregamento  ─────────────────────────────── */

async function carregarEstado() { const r = await api(`${BASE}/estado`); if (r.ok) { estado.leitura = r.dados; desenharLido(); } }
function desenharLido() {
  const a = raiz?.querySelector('#mon-lido'); if (!a) return;
  a.replaceChildren(el('span', 'SendTrace + 17Track · dados lidos em '), el('b', estado.leitura?.lido_em ? hora(estado.leitura.lido_em) : '— (ainda não calculado)'));
  if (estado.leitura?.erro) a.append(selo('falha na última leitura', 'alto'));
}

async function carregarResumo() {
  const r = await api(`${BASE}/resumo?${parametros({ lista: false })}`);
  if (r.ok) { estado.resumo = r.dados; if (r.dados.lido_em) estado.leitura = { ...(estado.leitura ?? {}), lido_em: r.dados.lido_em }; desenharLido(); desenharBlocos(); desenharVisaoTodo(); modulos.indicadores?.recarregar?.(); }
  else mensagem(msgEl, r.dados?.detail ?? 'Não foi possível carregar o resumo.', true);
}

async function carregarLista() {
  const meu = ++tokenLista;
  const corpo = raiz.querySelector('#mon-corpo'); if (!estado.dados) corpo.replaceChildren(linhaVazia('carregando…'));
  const r = await api(`${BASE}/lista?${parametros({ extra: { ordem: estado.lista.ordem, dir: estado.lista.dir, pagina: estado.lista.pagina, tamanho: estado.tamanho } })}`);
  if (meu !== tokenLista) return;   // chegou uma resposta mais nova
  if (!r.ok) { corpo.replaceChildren(linhaVazia(r.dados?.detail ?? 'Não foi possível carregar a lista.')); return; }
  estado.dados = r.dados; desenharTabela();
}

async function carregarTudo() { await Promise.all([carregarResumo(), carregarLista()]); }

async function atualizarAgora() {
  const b = raiz.querySelector('#mon-atualizar'); b.disabled = true; b.textContent = 'Atualizando…'; mensagem(msgEl, 'Recalculando a classificação (leva alguns segundos)…');
  try {
    const r = await api(`${BASE}/atualizar`, { metodo: 'POST', corpo: {} });
    if (!r.ok) mensagem(msgEl, r.dados?.detail ?? 'Não foi possível atualizar.', true);
    else if (r.dados.ok === false) mensagem(msgEl, `Falha ao recalcular: ${r.dados.erro}`, true);
    else mensagem(msgEl, r.dados.reaproveitada ? 'A leitura tem menos de 20 segundos: nada a refazer.' : `Atualizado: ${n(r.dados.linhas)} pedidos classificados.`);
    await carregarEstado(); await carregarTudo();
    if (modulos[estado.aba]?.recarregar) modulos[estado.aba].recarregar();
  } finally { setTimeout(() => { b.disabled = false; b.textContent = 'Atualizar dados'; }, 4000); }
}

/* ───────────────────────────────  blocos e barras  ─────────────────────────────── */

function filtrarPor({ grupo = '', classe = '', multi = false }, extra = {}) {
  Object.assign(estado.lista, { grupo, classe, causa: '', multi, pagina: 1 }, extra); estado.selecionados.clear();
  sincronizarCampos(); desenharBlocos(); carregarLista(); if ('plataforma' in extra || 'fulfillment' in extra) carregarResumo();
  raiz.querySelector('#mon-lista-topo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function desenharBlocos() {
  const r = estado.resumo; const caixa = raiz.querySelector('#mon-grupos'); caixa.replaceChildren(); if (!r) return;
  for (const g of estado.cfg.grupos) {
    const total = r.por_grupo[g.id] ?? 0;
    const b = el('button', undefined, 'mon-grupo'); b.type = 'button'; b.setAttribute('aria-pressed', String(estado.lista.grupo === g.id && !estado.lista.classe)); b.title = g.oQueE;
    const nome = el('div', undefined, 'mon-nome'); nome.append(el('span', g.nome), el('span', pct(total, r.total)));
    b.append(nome, el('b', n(total)), el('small', g.dica));
    const pilha = el('div', undefined, 'mon-pilha');
    for (const c of estado.cfg.classes.filter((x) => x.grupo === g.id)) { const v = r.por_classe[c.chave] ?? 0; if (!v) continue; const seg = el('i'); seg.style.width = `${(100 * v / (total || 1))}%`; seg.style.background = g.cor; seg.style.opacity = String(0.45 + 0.55 * (v / (total || 1))); seg.title = `${c.nome}: ${n(v)}`; pilha.append(seg); }
    b.append(pilha);
    b.addEventListener('click', () => filtrarPor(estado.lista.grupo === g.id && !estado.lista.classe ? {} : { grupo: g.id }));
    caixa.append(b);
  }
  const av = raiz.querySelector('#mon-avisos'); av.replaceChildren();
  if (r.verificar) { const b = el('button', `Atenção · A verificar com o dev: ${n(r.verificar)} pedido(s) não encontrados em nenhuma fulfillment (possível falha de ligação no SendTrace)`, 'mon-aviso'); b.type = 'button'; b.addEventListener('click', () => filtrarPor({ grupo: 'semrastreio', classe: 'nao_encontrado' })); av.append(b); }
  if (r.multi_rastreios) { const b = el('button', `${n(r.multi_rastreios)} pedido(s) com mais de um rastreio (possível envio duplicado ou reenvio)`, 'mon-aviso'); b.type = 'button'; b.addEventListener('click', () => filtrarPor({ multi: true })); av.append(b); }
}

function desenharVisaoTodo() {
  const r = estado.resumo; const caixa = raiz.querySelector('#mon-todo-corpo'); caixa.replaceChildren(); if (!r) return;
  const maximo = Math.max(1, ...Object.values(r.por_classe));
  for (const g of estado.cfg.grupos) {
    const classes = estado.cfg.classes.filter((c) => c.grupo === g.id && (r.por_classe[c.chave] ?? 0) > 0); if (!classes.length) continue;
    caixa.append(el('div', g.nome, 'mon-gtit'));
    for (const c of classes) {
      const v = r.por_classe[c.chave]; const b = el('button', undefined, 'mon-barra'); b.type = 'button'; b.title = c.comoTratar;
      const tr = el('span', undefined, 'mon-trilho'); const i = el('i'); i.style.width = `${(100 * v / maximo)}%`; i.style.background = g.cor; tr.append(i);
      b.append(el('span', c.nome), tr, el('span', `${n(v)} · ${pct(v, r.total)}`));
      b.addEventListener('click', () => filtrarPor({ grupo: g.id, classe: c.chave }));
      caixa.append(b);
    }
  }
  if (!caixa.childNodes.length) caixa.append(el('p', 'Nenhum pedido com estes filtros.', 'mon-vazio'));
}

/* ───────────────────────────────  tabela  ─────────────────────────────── */

const linhaVazia = (t) => { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 14; td.className = 'mon-vazio'; td.textContent = t; tr.append(td); return tr; };
const celula = (rotulo, conteudo, classe) => { const td = document.createElement('td'); td.dataset.label = rotulo; if (classe) td.className = classe; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? '—'; return td; };

const COLUNAS = [
  ['Pedido', 'pedido'], ['Cliente', 'nome_cliente'], ['Classificação', 'classe'], ['Causa', null], ['O que a transportadora informou', null], ['Dias desde o evento', 'dias_desde_evento'],
  ['Fulfillment', 'fulfillment'], ['Pagamento', 'plataforma'], ['Reembolso', null], ['E-mails', 'emails_enviados'], ['Código de rastreio', 'rastreio'], ['Data do pedido', 'data_pedido'], ['Dias sem movimentação', 'dias_sem_movimentacao'],
];

function linha(p) {
  const tr = document.createElement('tr'); tr.className = 'sup-linha-clique';
  const marca = document.createElement('input'); marca.type = 'checkbox'; marca.checked = estado.selecionados.has(p.pedido_id); marca.setAttribute('aria-label', `Selecionar o pedido ${p.pedido}`);
  marca.addEventListener('click', (e) => { e.stopPropagation(); if (marca.checked) estado.selecionados.add(p.pedido_id); else estado.selecionados.delete(p.pedido_id); atualizarBarraSelecao(); });
  const tdm = document.createElement('td'); tdm.append(marca); tr.append(tdm);
  const g = grupoDe(p.grupo); const cl = el('span', p.classe_nome, 'mon-cl'); if (g) cl.style.borderColor = g.cor;
  if (p.urgencia) cl.title = p.urgencia;
  tr.append(
    celula('Pedido', p.pedido), celula('Cliente', p.nome_cliente || '—'), celula('Classificação', cl),
    celula('Causa', p.causa ? (classeDe(p.causa)?.nome ?? p.causa) : '—'),
    celula('O que a transportadora informou', p.texto_pt || '—', 'mon-pt'),
    celula('Dias desde o evento', p.dias_desde_evento === null || p.dias_desde_evento === undefined ? '—' : n(p.dias_desde_evento)),
    celula('Fulfillment', rotFul(p.fulfillment)), celula('Pagamento', rotPlat(p.plataforma)), celula('Reembolso', p.reembolso_cb),
    celula('E-mails', p.emails_enviados ? `${p.emails_enviados}${p.tratativas ? ` · ${p.tratativas} trat.` : ''}` : (p.tratativas ? `0 · ${p.tratativas} trat.` : '0')),
    celula('Código de rastreio', p.rastreio ? link(p.rastreio, p.link_rastreio) : '—'),
    celula('Data do pedido', fmtData(p.data_pedido)), celula('Dias sem movimentação', p.dias_sem_movimentacao === null || p.dias_sem_movimentacao === undefined ? '—' : n(p.dias_sem_movimentacao)),
  );
  tr.querySelector('a')?.addEventListener('click', (e) => e.stopPropagation());
  tr.addEventListener('click', () => abrirFicha(p.pedido_id));
  return tr;
}

function desenharTabela() {
  const d = estado.dados; const corpo = raiz.querySelector('#mon-corpo'); corpo.replaceChildren();
  const tit = raiz.querySelector('#mon-lista-titulo');
  const l = estado.lista; const partes = [];
  if (l.classe) partes.push(classeDe(l.classe)?.nome); else if (l.grupo) partes.push(grupoDe(l.grupo)?.nome);
  tit.textContent = `${partes.length ? partes.join(' · ') : 'Todos os pedidos em aberto'} — ${n(d.total)} pedido(s)`;
  if (!d.itens.length) corpo.append(linhaVazia('Nenhum pedido com estes filtros.'));
  for (const p of d.itens) corpo.append(linha(p));
  // cabeçalho com a seta da ordenação
  for (const th of raiz.querySelectorAll('#mon-tabela th[data-ordem]')) { const ativo = th.dataset.ordem === l.ordem; th.dataset.seta = ativo ? (l.dir === 'asc' ? ' ▲' : ' ▼') : ''; th.textContent = th.dataset.rot + th.dataset.seta; }
  const total = Math.max(1, Math.ceil(d.total / estado.tamanho));
  const pag = raiz.querySelector('#mon-paginacao');
  if (d.total > estado.tamanho) montarPaginacao(pag, { pagina: d.pagina, totalPaginas: total, total: d.total, rotuloItem: 'pedido' }, (nova) => { estado.lista.pagina = nova; carregarLista(); });
  else pag.replaceChildren();
  atualizarBarraSelecao();
}

function atualizarBarraSelecao() {
  const m = modulos.tratativas; if (m?.aoMudarSelecao) m.aoMudarSelecao();
  const t = raiz.querySelector('#mon-sel-texto'); if (!t) return;
  const k = estado.selecionados.size;
  t.textContent = k ? `${n(k)} pedido(s) selecionado(s)` : 'Nenhum pedido selecionado';
  for (const id of ['mon-btn-limpar', 'mon-btn-tratativa']) { const b = raiz.querySelector(`#${id}`); if (b) b.hidden = !k; }
  const todos = raiz.querySelector('#mon-marca-todos'); if (todos) todos.checked = Boolean(estado.dados?.itens.length) && estado.dados.itens.every((p) => estado.selecionados.has(p.pedido_id));
}

/** Marca TODOS os pedidos do filtro atual (não só os da página): lê as páginas de 500 até acabar (máx. 20 mil). */
async function selecionarTodosDoFiltro() {
  mensagem(msgEl, 'Selecionando todos do filtro…');
  for (let pagina = 1; pagina <= 40; pagina += 1) {
    const r = await api(`${BASE}/lista?${parametros({ extra: { ordem: 'pedido', dir: 'asc', pagina, tamanho: 500 } })}`); if (!r.ok) break;
    for (const p of r.dados.itens) estado.selecionados.add(p.pedido_id);
    if (pagina * 500 >= r.dados.total) break;
  }
  for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]')) cb.checked = true;
  atualizarBarraSelecao(); mensagem(msgEl, `${n(estado.selecionados.size)} pedido(s) selecionado(s).`);
}

function sincronizarCampos() {
  const l = estado.lista; const set = (id, v) => { const e = raiz.querySelector(`#${id}`); if (e) e.value = v; };
  set('mon-f-ful', l.fulfillment); set('mon-f-plat', l.plataforma); set('mon-f-tratado', l.tratado); set('mon-f-q', l.q);
  const sc = raiz.querySelector('#mon-f-causa'); if (sc) sc.value = l.causa;
  const cl = raiz.querySelector('#mon-f-classe'); if (cl) cl.value = l.classe;
  const gr = raiz.querySelector('#mon-f-grupo'); if (gr) gr.value = l.grupo;
}

/* ───────────────────────────────  ficha do pedido  ─────────────────────────────── */

const jan = () => criarJanela('mon-ficha');
export async function abrirFicha(id) {
  const j = jan(); const corpo = j.refazer('Ficha do pedido', 'carregando…'); j.abrir();
  const r = await api(`${BASE}/pedido/${encodeURIComponent(id)}/folha`);
  if (!r.ok) { corpo.append(el('p', r.dados?.detail ?? 'Não foi possível abrir a ficha.', 'mon-vazio')); return; }
  const f = r.dados; const p = f.pedido; const c = f.classificacao;
  const corpo2 = j.refazer(`Pedido ${p.pedido}`, f.aviso ?? (c ? `${c.classe_nome} · classificação calculada em ${hora(c.calculado_em)}` : ''));
  corpo2.classList.add('mon-ficha');
  if (c) {
    const cx = el('div', undefined, 'mon-caixa'); const g = grupoDe(c.grupo);
    cx.append(el('b', `${c.classe_nome}`), el('span', ` · ${g?.nome ?? ''}${c.urgencia ? ` · ${c.urgencia}` : ''}`));
    if (c.causa) cx.append(el('div', `Causa: ${classeDe(c.causa)?.nome ?? c.causa}`));
    if (c.texto_pt) cx.append(el('div', `A transportadora informou: ${c.texto_pt}`));
    if (c.texto_transportadora && c.texto_transportadora !== c.texto_pt) cx.append(el('div', `Texto original: ${c.texto_transportadora}`));
    cx.append(el('div', `Como tratar: ${c.como_tratar}`));
    if (c.motivo_suporte_ativo) cx.append(el('div', `Motivo no Suporte Ativo: ${c.motivo_suporte_ativo}`));
    corpo2.append(cx);
  }
  const dl = el('dl');
  const campo = (t, v) => { dl.append(el('dt', t)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v === null || v === undefined || v === '' ? '—' : String(v); dl.append(dd); };
  campo('Cliente', p.nome); campo('E-mail', p.email); campo('Endereço', p.endereco); campo('Produtos', p.produtos);
  campo('Pagamento', rotPlat(p.plataforma)); campo('Valor', p.valor === null || p.valor === undefined ? '—' : fmtValor(p.valor)); campo('Data do pedido', fmtDataHora(p.data_pedido));
  campo('Fulfillment', rotFul(p.fulfillment)); campo('Transportadora', p.transportadora); campo('Status interno', p.status_interno); campo('Último status no 17Track', p.ultimo_status_17t);
  campo('Código de rastreio', p.rastreio ? link(`${p.rastreio} (abrir no 17Track)`, p.link_rastreio) : '—');
  if (c) { campo('Última movimentação real', c.ultima_movimentacao ? `${fmtDataHora(c.ultima_movimentacao)} (${n(c.dias_sem_movimentacao)} dia(s))` : '—'); campo('Reembolso / chargeback', c.reembolso_cb); campo('Outros rastreios', c.outros_rastreios); }
  if (p.reembolsado_em) campo('Reembolsado em', fmtDataHora(p.reembolsado_em)); if (p.chargeback_em) campo('Chargeback em', fmtDataHora(p.chargeback_em));
  campo('E-mails enviados', f.emails.enviados ? `${f.emails.enviados} (${f.emails.tipos ?? ''}) · último em ${fmtDataHora(f.emails.ultimo)}` : '0');
  corpo2.append(dl);

  corpo2.append(el('h3', 'Linha do tempo'));
  if (!f.eventos.length) corpo2.append(el('p', 'Sem eventos registrados.', 'mon-vazio'));
  else {
    const tab = el('table', undefined, 'mon-tl'); const th = el('thead'); const trh = el('tr');
    for (const h of ['Quando', 'Tipo', 'O que aconteceu', 'Detalhe (original)', 'Local', 'Rastreio']) trh.append(el('th', h));
    th.append(trh); const tb = el('tbody');
    for (const e of f.eventos) {
      const tr = el('tr'); tr.dataset.atual = e.atual ? '1' : '0'; tr.dataset.relevante = e.relevante || e.tipo !== 'Rastreio' ? '1' : '0';
      const tit = el('td'); tit.append(el('span', e.titulo)); if (e.atual) tit.append(document.createTextNode(' '), selo('evento atual', 'alto')); if (e.tipo === 'Rastreio' && e.relevante) tit.title = 'Movimento real: zera os dias sem movimentação';
      tr.append(el('td', fmtDataHora(e.quando)), el('td', e.tipo), tit, el('td', e.detalhe && e.detalhe !== e.titulo ? e.detalhe : ''), el('td', e.local ?? ''), el('td', e.rastreio ?? ''));
      tb.append(tr);
    }
    tab.append(th, tb); const env = el('div', undefined, 'tabela-envolve'); env.append(tab); corpo2.append(env);
  }
  try { const t = await modulo('tratativas'); corpo2.append(t.fichaTratativas(f)); } catch { /* sem o bloco de tratativas */ }
}

/* ───────────────────────────────  montagem  ─────────────────────────────── */

function montarFiltrosLista() {
  const cx = el('div', undefined, 'sppl-filtros'); const cfg = estado.cfg;
  const b = campoTexto('Buscar', { tipo: 'search', max: 80, placeholder: 'Pedido, cliente, e-mail ou código de rastreio', cresce: true }); b.input.id = 'mon-f-q';
  let t0; b.input.addEventListener('input', () => {
    clearTimeout(t0); t0 = setTimeout(() => { estado.lista.q = b.input.value.trim(); estado.lista.pagina = 1; carregarLista(); modulos.indicadores?.buscar(estado.lista.q); }, 600);
  });
  const mk = (rot, id, ops, chave, extra) => { const c = campoSelect(rot, ops, estado.lista[chave], (v) => { estado.lista[chave] = v; if (extra) extra(v); estado.lista.pagina = 1; estado.selecionados.clear(); desenharBlocos(); carregarLista(); if (chave === 'fulfillment' || chave === 'plataforma') carregarResumo(); }); c.select.id = id; return c; };
  const grupo = mk('Grupo', 'mon-f-grupo', [['', 'Todos'], ...cfg.grupos.map((g) => [g.id, g.nome])], 'grupo');
  const classe = mk('Classe', 'mon-f-classe', [['', 'Todas'], ...cfg.classes.map((c) => [c.chave, c.nome])], 'classe');
  const causa = mk('Causa', 'mon-f-causa', [['', 'Todas'], ...cfg.causas.map((k) => [k, classeDe(k)?.nome ?? k])], 'causa');
  const ful = mk('Fulfillment', 'mon-f-ful', [['', 'Todas'], ['redrock', 'RedRock'], ['fullstack', 'FullStack'], ['jetstream', 'JetPack'], ['sem fulfillment', 'Sem fulfillment']], 'fulfillment');
  const plat = mk('Pagamento', 'mon-f-plat', [['', 'Todos'], ['jvzoo', 'JVZoo'], ['vupim', 'Vupim'], ['buygoods', 'BuyGoods'], ['digistore24', 'DigiStore24'], ['__sem', 'Não identificada']], 'plataforma');
  const trat = mk('Tratado', 'mon-f-tratado', [['', 'Todos'], ['sim', 'Tratados (já receberam e-mail)'], ['nao', 'Não tratados']], 'tratado');
  cx.append(b.rotulo, grupo.rotulo, classe.rotulo, causa.rotulo, ful.rotulo, plat.rotulo, trat.rotulo);
  return cx;
}

function montarClassificacao(pai) {
  const avisos = el('div', undefined, 'mon-avisos'); avisos.id = 'mon-avisos';
  const grupos = el('div', undefined, 'mon-grupos'); grupos.id = 'mon-grupos'; grupos.setAttribute('role', 'group'); grupos.setAttribute('aria-label', 'Resumo por grupo');
  const todo = el('details', undefined, 'mon-todo'); todo.open = true; todo.append(el('summary', 'Visão do todo (clique numa barra para abrir a lista da classe)')); const tc = el('div'); tc.id = 'mon-todo-corpo'; todo.append(tc);
  const ind = el('div'); ind.id = 'mon-indicadores';
  pai.append(avisos, grupos, todo, ind);

  const topo = el('div'); topo.id = 'mon-lista-topo'; const h = el('h3', 'Todos os pedidos em aberto'); h.id = 'mon-lista-titulo'; h.style.margin = '6px 0'; topo.append(h); pai.append(topo, montarFiltrosLista());
  const barra = el('div', undefined, 'sppl-acoes'); barra.id = 'mon-barra-sel';
  const txt = el('span', 'Nenhum pedido selecionado', 'cartao-sub'); txt.id = 'mon-sel-texto';
  const bLimpar = el('button', 'Limpar seleção', 'btn'); bLimpar.type = 'button'; bLimpar.id = 'mon-btn-limpar'; bLimpar.hidden = true; bLimpar.addEventListener('click', () => { estado.selecionados.clear(); for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]')) cb.checked = false; atualizarBarraSelecao(); });
  const bReg = el('button', 'Registrar tratativa', 'btn btn-forte'); bReg.type = 'button'; bReg.id = 'mon-btn-tratativa'; bReg.hidden = true;
  bReg.addEventListener('click', async () => { try { const t = await modulo('tratativas'); t.abrirFormulario([...estado.selecionados], (r) => { estado.selecionados.clear(); for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]')) cb.checked = false; atualizarBarraSelecao(); mensagem(msgEl, `${r.gravadas} tratativa(s) registrada(s).`); carregarLista(); modulos.tratativas?.recarregar?.(); }); } catch { mensagem(msgEl, 'Não foi possível abrir o formulário.', true); } });
  const bTodos = el('button', 'Selecionar todos do filtro', 'btn'); bTodos.type = 'button'; bTodos.addEventListener('click', selecionarTodosDoFiltro);
  const bXls = el('button', 'Baixar relatório (.xlsx)', 'btn'); bXls.type = 'button'; bXls.id = 'mon-btn-xlsx';
  bXls.addEventListener('click', async () => { try { const t = await modulo('tratativas'); await t.baixarRelatorio(parametros({ extra: { ordem: estado.lista.ordem, dir: estado.lista.dir } }), msgEl, bXls); } catch { mensagem(msgEl, 'Não foi possível gerar a planilha.', true); } });
  barra.append(txt, bTodos, bReg, bLimpar, bXls); pai.append(barra);
  const envolve = el('div', undefined, 'tabela-envolve'); const tab = el('table', undefined, 'tabela tabela--empilha tabela--larga mon-tabela'); tab.id = 'mon-tabela';
  const thead = el('thead'); const trh = el('tr');
  const thm = el('th'); thm.scope = 'col'; const todos = document.createElement('input'); todos.type = 'checkbox'; todos.id = 'mon-marca-todos'; todos.setAttribute('aria-label', 'Selecionar todos os pedidos desta página');
  todos.addEventListener('change', () => { for (const p of estado.dados?.itens ?? []) { if (todos.checked) estado.selecionados.add(p.pedido_id); else estado.selecionados.delete(p.pedido_id); } for (const cb of raiz.querySelectorAll('#mon-corpo input[type=checkbox]')) cb.checked = todos.checked; atualizarBarraSelecao(); });
  thm.append(todos); trh.append(thm);
  for (const [rot, ordem] of COLUNAS) {
    const th = el('th', rot); th.scope = 'col';
    if (ordem) { th.dataset.ordem = ordem; th.dataset.rot = rot; th.title = 'Clique para ordenar'; th.addEventListener('click', () => { if (estado.lista.ordem === ordem) estado.lista.dir = estado.lista.dir === 'desc' ? 'asc' : 'desc'; else { estado.lista.ordem = ordem; estado.lista.dir = 'desc'; } estado.lista.pagina = 1; carregarLista(); }); }
    trh.append(th);
  }
  thead.append(trh); const tbody = el('tbody'); tbody.id = 'mon-corpo'; tbody.append(linhaVazia('carregando…'));
  tab.append(thead, tbody); envolve.append(tab); pai.append(envolve);
  const pag = el('div', undefined, 'paginacao'); pag.id = 'mon-paginacao'; pai.append(pag);
}

async function abrirAba(nome) {
  estado.aba = nome;
  for (const b of raiz.querySelectorAll('.mon-abas button')) b.setAttribute('aria-selected', String(b.dataset.aba === nome));
  for (const p of raiz.querySelectorAll('.mon-painel')) p.hidden = p.dataset.aba !== nome;
  if (nome === 'tratativas' || nome === 'prazos') { try { await modulo(nome); } catch { mensagem(msgEl, `Não foi possível carregar a aba ${nome}.`, true); } }
  modulos[nome]?.abrir?.();
}

function montar() {
  raiz = document.getElementById('monit-raiz'); raiz.replaceChildren();
  if (!document.getElementById('monit-css')) { const s = document.createElement('style'); s.id = 'monit-css'; s.textContent = CSS; document.head.append(s); }
  const cab = el('header', undefined, 'cartao-cabeca'); const quem = el('div');
  quem.append(el('h2', 'MONIT-SPPL · Monitoramento Logístico'), el('p', 'Em que situação cada pedido físico está, quem deve agir (logística, cliente, devolução) e quais precisam de contato com o cliente. Lê o rastreio da transportadora (17Track) e classifica os pedidos em aberto.', 'cartao-sub'));
  cab.append(quem); raiz.append(cab);

  const topo = el('div', undefined, 'mon-topo'); const fil = el('div', undefined, 'sppl-filtros');
  const d = campoTexto('Criados a partir de', { tipo: 'date', valor: estado.filtros.desde }); d.input.id = 'mon-f-desde'; d.input.min = '2025-01-01';
  d.input.addEventListener('change', () => { if (!d.input.value) return; estado.filtros.desde = d.input.value; estado.lista.pagina = 1; estado.selecionados.clear(); carregarTudo(); modulos[estado.aba]?.recarregar?.(); });
  const bTodas = el('button', 'Voltar para todas as datas', 'btn'); bTodas.type = 'button'; bTodas.addEventListener('click', () => { estado.filtros.desde = '2026-01-01'; d.input.value = '2026-01-01'; estado.lista.pagina = 1; carregarTudo(); modulos[estado.aba]?.recarregar?.(); });
  const seg = el('div', undefined, 'mon-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Filtro de reembolso');
  const opc = [['todos', 'Todos'], ['sem', 'Sem Reem|Charge'], ['com', 'Com Reem|Charge']];
  const pintar = () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === estado.filtros.reemb)); };
  for (const [v, t] of opc) { const b = el('button', t); b.type = 'button'; b.dataset.v = v; b.addEventListener('click', () => { estado.filtros.reemb = v; estado.lista.pagina = 1; estado.selecionados.clear(); pintar(); carregarTudo(); modulos[estado.aba]?.recarregar?.(); }); seg.append(b); }
  pintar();
  const lReemb = el('label', undefined, 'campo'); lReemb.append(el('span', 'Pedidos'), seg);
  fil.append(d.rotulo, bTodas, lReemb);
  const lido = el('div', undefined, 'mon-lido'); const ld = el('div'); ld.id = 'mon-lido'; lido.append(ld);
  const at = el('button', 'Atualizar dados', 'btn btn-forte'); at.type = 'button'; at.id = 'mon-atualizar'; at.addEventListener('click', atualizarAgora); lido.append(at);
  msgEl = el('span', '', 'cartao-sub'); msgEl.setAttribute('role', 'status'); lido.append(msgEl);
  topo.append(fil, lido); raiz.append(topo);

  const abas = el('div', undefined, 'mon-abas'); abas.setAttribute('role', 'tablist');
  for (const [k, t] of [['classificacao', 'Classificação'], ['tratativas', 'Tratativas'], ['prazos', 'Prazos']]) { const b = el('button', t); b.type = 'button'; b.dataset.aba = k; b.setAttribute('role', 'tab'); b.addEventListener('click', () => abrirAba(k)); abas.append(b); }
  raiz.append(abas);
  for (const k of ['classificacao', 'tratativas', 'prazos']) { const p = el('div', undefined, 'mon-painel'); p.dataset.aba = k; p.hidden = k !== 'classificacao'; raiz.append(p); }
  montarClassificacao(raiz.querySelector('.mon-painel[data-aba=classificacao]'));
  abas.firstChild.setAttribute('aria-selected', 'true');
}

/** Chamado quando a aba é aberta. Monta na primeira vez; com a aba visível, relê o estado a cada 60 s (o servidor recalcula a cada 10 min). */
export async function abrirMonit() {
  if (!iniciado) {
    iniciado = true;
    const r = await api(`${BASE}/config`);
    if (!r.ok) { iniciado = false; document.getElementById('monit-raiz').textContent = 'Não foi possível carregar o Monitoramento Logístico.'; return; }
    estado.cfg = r.dados; estado.filtros.desde = r.dados.desde_padrao ?? estado.filtros.desde;
    montar(); await carregarEstado(); carregarTudo();
    modulo('indicadores', raiz.querySelector('#mon-indicadores')).catch(() => {});
  }
  clearInterval(temporizador);
  temporizador = setInterval(async () => {
    if (document.hidden || document.getElementById('rst-painel-monit')?.hidden) return;
    const antes = estado.leitura?.lido_em; await carregarEstado();
    if (estado.leitura?.lido_em !== antes) { carregarResumo(); if (!estado.selecionados.size) carregarLista(); }   // só recarrega quando houve leitura nova
  }, 60_000);
}
export function fecharMonit() { clearInterval(temporizador); temporizador = null; }
