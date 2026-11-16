/**
 * Aba "Pesquisa de estorno" — perguntas da página pública /pesquisa (migração 129; pedido do Lucas, 15/11/2026).
 *
 * Lista as perguntas atuais (GET /api/pesquisa-estorno/perguntas/) e, para administrador, edita: salvar grava uma VERSÃO NOVA
 * (POST /api/pesquisa-estorno/perguntas/); nada é sobrescrito e cada resposta guarda a versão que o cliente viu.
 * Todo texto vindo da API entra por `textContent`.
 */
import { $, api, usuarioAtual } from './emailComum.js';
import { dataHora } from './format.js';

const GRUPO = { todos: 'Todos', reembolso: 'Só reembolso', banco: 'Só banco' };
const TIPO = { unica: 'Marcar uma opção', nota: 'Nota 0–10', texto: 'Texto livre' };
const ehAdmin = () => Boolean(usuarioAtual()?.admin);
const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined && texto !== null) e.textContent = texto;
  return e;
};

let perguntas = [];
let editando = null;   // pergunta aberta no diálogo (null = nova)

function aviso(id, texto, tom = 'aviso') {
  const p = $(id);
  p.hidden = !texto;
  p.textContent = texto || '';
  p.dataset.tom = tom;
}

function descreverCondicao(p) {
  const c = p.mostrar_se;
  if (!c || !c.pergunta) return 'Sempre';
  const ref = perguntas.find((x) => x.chave === c.pergunta);
  const rot = (v) => ref?.opcoes?.find((o) => o.valor === v)?.rotulo || v;
  return `Se "${c.pergunta}" = ${(c.valores || []).map(rot).join(' ou ')}`;
}

function renderLista() {
  const tabela = el('table', 'tabela');
  tabela.style.minWidth = '760px';
  const cab = tabela.createTHead().insertRow();
  for (const t of ['Ordem', 'Pergunta', 'Para quem', 'Tipo', 'Quando aparece', 'Versão', 'Respostas', '']) cab.append(el('th', '', t));
  const corpo = tabela.createTBody();
  for (const p of perguntas) {
    const tr = corpo.insertRow();
    if (!p.ativa) tr.style.opacity = '.5';
    tr.insertCell().textContent = p.ordem;
    const cel = tr.insertCell();
    cel.append(el('strong', '', p.texto));
    if (p.texto_banco) cel.append(el('div', 'cartao-sub', `Banco: ${p.texto_banco}`));
    if (p.tipo === 'unica') cel.append(el('div', 'cartao-sub', (p.opcoes || []).map((o) => o.rotulo).join(' · ')));
    cel.append(el('div', 'cartao-sub', `${p.chave}${p.obrigatoria ? '' : ' · opcional'}${p.ativa ? '' : ' · DESATIVADA'}`));
    tr.insertCell().textContent = GRUPO[p.grupo] || p.grupo;
    tr.insertCell().textContent = TIPO[p.tipo] || p.tipo;
    tr.insertCell().textContent = descreverCondicao(p);
    tr.insertCell().textContent = `v${p.versao}`;
    tr.insertCell().textContent = p.respostas;
    const acao = tr.insertCell();
    if (ehAdmin()) {
      const b = el('button', 'btn btn-icone', 'Editar');
      b.type = 'button';
      b.addEventListener('click', () => abrir(p));
      acao.append(b);
    }
  }
  const caixa = el('div');
  caixa.style.overflowX = 'auto';
  caixa.append(tabela);
  $('pq-lista').replaceChildren(caixa);
}

async function carregar() {
  const r = await api('/api/pesquisa-estorno/perguntas/');
  if (!r.ok) { aviso('pq-msg', r.dados?.erro || r.dados?.message || 'Não foi possível carregar as perguntas.', 'erro'); return; }
  aviso('pq-msg', '');
  perguntas = r.dados.perguntas || [];
  $('pq-nova').hidden = !ehAdmin();
  renderLista();
}

/* ── diálogo ── */
function linhaOpcao(o = { valor: '', rotulo: '' }) {
  const linha = el('div');
  linha.style.cssText = 'display:flex;gap:6px;margin:0 0 6px';
  const v = el('input'); v.placeholder = 'codigo'; v.value = o.valor; v.maxLength = 40; v.style.width = '150px'; v.dataset.campo = 'valor'; v.spellcheck = false;
  const r = el('input'); r.placeholder = 'Texto que o cliente vê'; r.value = o.rotulo; r.maxLength = 120; r.style.flex = '1'; r.dataset.campo = 'rotulo';
  const x = el('button', 'btn btn-icone', '✕'); x.type = 'button'; x.title = 'Tirar opção'; x.addEventListener('click', () => linha.remove());
  linha.append(v, r, x);
  return linha;
}

function renderCondicao(selecionados = []) {
  const chave = $('pq-cond-pergunta').value;
  const ref = perguntas.find((p) => p.chave === chave);
  $('pq-cond-valores').replaceChildren(...(ref?.opcoes || []).map((o) => {
    const l = el('label');
    const c = el('input'); c.type = 'checkbox'; c.value = o.valor; c.checked = selecionados.includes(o.valor);
    l.append(c, ` ${o.rotulo}`);
    return l;
  }));
}

function ajustarTipo() {
  const tipo = $('pq-tipo').value;
  $('pq-opcoes-box').hidden = tipo !== 'unica';
  $('pq-obrigatoria').disabled = tipo === 'texto';
  if (tipo === 'texto') $('pq-obrigatoria').checked = false;
}

function abrir(p) {
  editando = p || null;
  aviso('pq-erro', '');
  $('pq-historico').replaceChildren();
  $('pq-tit').textContent = p ? `Editar "${p.chave}" (v${p.versao})` : 'Nova pergunta';
  $('pq-chave').value = p?.chave || '';
  $('pq-chave').readOnly = Boolean(p);
  $('pq-texto').value = p?.texto || '';
  $('pq-texto-banco').value = p?.texto_banco || '';
  $('pq-grupo').value = p?.grupo || 'todos';
  $('pq-tipo').value = p?.tipo || 'unica';
  $('pq-ordem').value = p?.ordem ?? (Math.max(0, ...perguntas.map((x) => x.ordem)) + 10);
  $('pq-obrigatoria').checked = p ? p.obrigatoria : true;
  $('pq-ativa').checked = p ? p.ativa : true;
  $('pq-opcoes').replaceChildren(...(p?.opcoes?.length ? p.opcoes : [{ valor: '', rotulo: '' }, { valor: '', rotulo: '' }]).map(linhaOpcao));
  const sel = $('pq-cond-pergunta');
  sel.replaceChildren(el('option', '', '— sempre mostrar —'));
  sel.firstChild.value = '';
  for (const x of perguntas.filter((q) => q.tipo === 'unica' && q.ativa && q.chave !== p?.chave)) {
    const o = el('option', '', `${x.chave} — ${x.texto}`); o.value = x.chave; sel.append(o);
  }
  sel.value = p?.mostrar_se?.pergunta || '';
  renderCondicao(p?.mostrar_se?.valores || []);
  $('pq-versoes').hidden = !p;
  ajustarTipo();
  $('janela-pesquisa').showModal();
}

function lerForm() {
  const tipo = $('pq-tipo').value;
  const opcoes = tipo === 'unica'
    ? [...$('pq-opcoes').children].map((l) => ({ valor: l.querySelector('[data-campo="valor"]').value.trim(), rotulo: l.querySelector('[data-campo="rotulo"]').value.trim() }))
      .filter((o) => o.valor || o.rotulo)
    : [];
  const cond = $('pq-cond-pergunta').value;
  const valores = [...$('pq-cond-valores').querySelectorAll('input:checked')].map((c) => c.value);
  return {
    chave: $('pq-chave').value.trim(), texto: $('pq-texto').value.trim(), texto_banco: $('pq-texto-banco').value.trim() || null,
    grupo: $('pq-grupo').value, tipo, ordem: Number($('pq-ordem').value), obrigatoria: $('pq-obrigatoria').checked, ativa: $('pq-ativa').checked,
    opcoes, mostrar_se: cond ? { pergunta: cond, valores } : null,
  };
}

async function salvar(ev) {
  ev.preventDefault();
  const corpo = lerForm();
  if (editando && !corpo.ativa && editando.ativa && !confirm(`Desativar "${corpo.chave}"? Ela some da página do cliente (as respostas antigas continuam).`)) return;
  $('pq-salvar').disabled = true;
  const r = await api('/api/pesquisa-estorno/perguntas/', { metodo: 'POST', corpo }).finally(() => { $('pq-salvar').disabled = false; });
  if (!r.ok) { aviso('pq-erro', r.dados?.erro || r.dados?.message || 'Não foi possível salvar.', 'erro'); return; }
  $('janela-pesquisa').close();
  aviso('pq-msg', `Gravada a versão ${r.dados.pergunta.versao} de "${r.dados.pergunta.chave}". O cliente já vê esta versão.`, 'ok');
  await carregar();
}

async function verVersoes() {
  if (!editando) return;
  const r = await api(`/api/pesquisa-estorno/perguntas/${encodeURIComponent(editando.chave)}/versoes/`);
  if (!r.ok) return;
  const lista = el('div');
  for (const v of r.dados.versoes || []) {
    const item = el('div', 'cartao-sub');
    item.style.cssText = 'border-top:1px solid var(--eixo);padding:6px 0';
    item.textContent = `v${v.versao} · ${dataHora(v.criado_em)} · ${v.criado_por || '—'} · ${v.respostas} resposta(s) · ${v.ativa ? '' : 'DESATIVADA · '}${v.texto}`;
    lista.append(item);
  }
  $('pq-historico').replaceChildren(lista);
}

$('pq-nova').addEventListener('click', () => abrir(null));
$('pq-fechar').addEventListener('click', () => $('janela-pesquisa').close());
$('pq-add-opcao').addEventListener('click', () => $('pq-opcoes').append(linhaOpcao()));
$('pq-cond-pergunta').addEventListener('change', () => renderCondicao([]));
$('pq-tipo').addEventListener('change', ajustarTipo);
$('pq-versoes').addEventListener('click', verVersoes);
$('pq-form').addEventListener('submit', salvar);
$('aba-btn-pesquisa').addEventListener('click', () => setTimeout(carregar, 0));
if (!$('aba-pesquisa').hidden) carregar();
