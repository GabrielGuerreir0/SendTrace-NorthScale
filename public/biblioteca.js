/**
 * Biblioteca de materiais (13/10/2026): bônus, áreas VIP, e-books e guias por nicho e produto. Aberta a todos os usuários logados:
 * qualquer um copia o link e baixa o arquivo; só o administrador cadastra, edita e apaga (a API recusa o resto com 403).
 */
import { $, api, debounce } from './emailComum.js';

const TIPOS = ['Bônus', 'E-book', 'Guia de uso', 'Área VIP', 'Rótulo / COA', 'Outro'];
const ICONE = { 'Bônus': '🎁', 'E-book': '📘', 'Guia de uso': '📖', 'Área VIP': '⭐', 'Rótulo / COA': '🏷️', 'Outro': '📄' };
const MAX_ARQUIVO = 40 * 1024 * 1024;

let materiais = [];
let podeEditar = false;
let carregado = false;
let filtros = { q: '', nicho: '', produto: '', tipo: '' };
let formAberto = null;   // null | 'novo' | id

const tamanhoTxt = (b) => (b == null ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const rotuloDe = (texto, input) => { const l = document.createElement('label'); l.className = 'esc-campo'; const sp = document.createElement('span'); sp.textContent = texto; l.append(sp, input); return l; };
const el = (tag, classe, texto) => { const e = document.createElement(tag); if (classe) e.className = classe; if (texto != null) e.textContent = texto; return e; };

function passa(m) {
  if (filtros.nicho && m.nicho !== filtros.nicho) return false;
  if (filtros.produto && m.produto !== filtros.produto) return false;
  if (filtros.tipo && m.tipo !== filtros.tipo) return false;
  if (filtros.q) {
    const alvo = semAcento(`${m.titulo} ${m.produto} ${m.nicho} ${m.tipo} ${m.arquivo_nome ?? ''} ${m.descricao ?? ''}`);
    if (!filtros.q.split(/\s+/).every((p) => alvo.includes(semAcento(p)))) return false;
  }
  return true;
}

async function carregar() {
  const raiz = $('bib-conteudo');
  if (!carregado) raiz.textContent = 'Carregando a biblioteca…';
  const { ok, dados } = await api('/api/biblioteca');
  if (!ok) { raiz.textContent = dados?.erro ?? 'Não consegui carregar a biblioteca.'; return; }
  materiais = dados.materiais ?? []; podeEditar = !!dados.pode_editar; carregado = true;
  desenhar();
}

function listaUnica(chave, base = materiais) { return [...new Set(base.map((m) => m[chave]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt')); }

function barraFiltros() {
  const barra = el('div', 'bib-filtros');
  const busca = document.createElement('input');
  busca.type = 'search'; busca.placeholder = 'Buscar por título, produto, nicho ou nome do arquivo…'; busca.value = filtros.q; busca.className = 'bib-busca';
  busca.addEventListener('input', debounce(() => { filtros.q = busca.value.trim(); desenharLista(); }, 200));
  const sel = (chave, rotulo, itens) => {
    const s = document.createElement('select');
    s.append(new Option(`${rotulo}: todos`, ''));
    for (const i of itens) s.append(new Option(i, i));
    s.value = filtros[chave];
    s.addEventListener('change', () => {
      filtros[chave] = s.value;
      if (chave === 'nicho' && filtros.produto && !materiais.some((m) => m.produto === filtros.produto && (!filtros.nicho || m.nicho === filtros.nicho))) filtros.produto = '';
      desenhar();
    });
    return s;
  };
  const produtos = listaUnica('produto', materiais.filter((m) => !filtros.nicho || m.nicho === filtros.nicho));
  const limpar = el('button', 'btn', 'Limpar filtros'); limpar.type = 'button';
  limpar.addEventListener('click', () => { filtros = { q: '', nicho: '', produto: '', tipo: '' }; desenhar(); });
  barra.append(busca, sel('nicho', 'Nicho', listaUnica('nicho')), sel('produto', 'Produto', produtos), sel('tipo', 'Tipo', TIPOS.filter((t) => materiais.some((m) => m.tipo === t))), limpar);
  if (podeEditar) { const novo = el('button', 'btn btn-forte', '+ Novo material'); novo.type = 'button'; novo.addEventListener('click', () => { formAberto = 'novo'; desenhar(); }); barra.append(novo); }
  return barra;
}

function linhaMaterial(m) {
  const li = el('li', 'bib-item');
  const info = el('div', 'bib-info');
  const titulo = el('div', 'bib-titulo'); titulo.append(el('span', 'bib-icone', ICONE[m.tipo] ?? '📄'), document.createTextNode(` ${m.titulo}`));
  const meta = el('div', 'bib-meta'); meta.append(el('span', 'bib-tipo', m.tipo));
  if (m.tem_arquivo) meta.append(el('span', null, `${m.arquivo_mime === 'application/pdf' ? 'PDF' : 'arquivo'} · ${tamanhoTxt(m.arquivo_tamanho)}`));
  if (m.onde_aparece?.length) { const o = el('span', 'bib-onde', `nos funis: ${m.onde_aparece.join(', ')}`); o.title = 'Pastas onde este mesmo arquivo foi encontrado'; meta.append(o); }
  info.append(titulo, meta);
  if (m.descricao) info.append(el('div', 'bib-desc', m.descricao));
  const acoes = el('div', 'bib-acoes');
  if (m.url) {
    const copiar = el('button', 'btn bib-copiar', '⧉ Copiar link'); copiar.type = 'button'; copiar.title = m.url;
    copiar.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(m.url); } catch { window.prompt('Copie o link:', m.url); return; }
      copiar.textContent = '✓ Link copiado'; copiar.classList.add('btn-copiar--ok');
      setTimeout(() => { copiar.textContent = '⧉ Copiar link'; copiar.classList.remove('btn-copiar--ok'); }, 1500);
    });
    const abrir = el('a', 'btn', 'Abrir'); abrir.href = m.url; abrir.target = '_blank'; abrir.rel = 'noopener noreferrer';
    acoes.append(copiar, abrir);
  }
  if (m.tem_arquivo) {
    const baixar = el('a', 'btn btn-forte', '⬇ Baixar'); baixar.href = `/api/biblioteca/${m.id}/arquivo?baixar=1&nome=${encodeURIComponent(m.arquivo_nome ?? 'arquivo')}`;
    baixar.setAttribute('download', m.arquivo_nome ?? '');
    acoes.append(baixar);
  }
  if (podeEditar) {
    const ed = el('button', 'btn btn-icone', '✎'); ed.type = 'button'; ed.title = 'Editar'; ed.addEventListener('click', () => { formAberto = m.id; desenhar(); });
    const ap = el('button', 'btn btn-icone', '🗑'); ap.type = 'button'; ap.title = 'Apagar';
    ap.addEventListener('click', async () => {
      if (!window.confirm(`Apagar "${m.titulo}" (${m.produto})? O arquivo guardado no sistema também sai.`)) return;
      const { ok, dados } = await api(`/api/biblioteca/${m.id}`, { metodo: 'DELETE' });
      if (!ok) { window.alert(dados?.erro ?? 'Não consegui apagar.'); return; }
      carregar();
    });
    acoes.append(ed, ap);
  }
  li.append(info, acoes);
  return li;
}

function formulario(m) {
  const f = el('form', 'cartao bib-form');
  f.append(el('h3', null, m ? 'Editar material' : 'Novo material'));
  const grade = el('div', 'esc-filtros-grade');
  const campo = (rotulo, input) => rotuloDe(rotulo, input);
  const texto = (v, ph, max = 200) => { const i = document.createElement('input'); i.type = 'text'; i.value = v ?? ''; i.placeholder = ph ?? ''; i.maxLength = max; return i; };
  const produto = texto(m?.produto, 'Ex.: NeuroMind Pro', 120);
  const nicho = texto(m?.nicho, 'Ex.: Memória / Neuro', 80);
  const dlN = document.createElement('datalist'); dlN.id = 'bib-dl-nicho'; for (const n of listaUnica('nicho')) dlN.append(new Option(n)); nicho.setAttribute('list', 'bib-dl-nicho');
  const dlP = document.createElement('datalist'); dlP.id = 'bib-dl-produto'; for (const n of listaUnica('produto')) dlP.append(new Option(n)); produto.setAttribute('list', 'bib-dl-produto');
  const tipo = document.createElement('select'); for (const t of TIPOS) tipo.append(new Option(t, t)); tipo.value = m?.tipo ?? 'Bônus';
  const titulo = texto(m?.titulo, 'Nome do material');
  const url = texto(m?.url, 'https://…', 2000);
  const desc = texto(m?.descricao, 'Observação curta (opcional)', 1000);
  const arquivo = document.createElement('input'); arquivo.type = 'file'; arquivo.accept = 'application/pdf,image/png,image/jpeg,application/zip,.docx';
  grade.append(campo('Produto *', produto), campo('Nicho *', nicho), campo('Tipo *', tipo), campo('Título *', titulo), campo('Link (copiar)', url), campo('Observação', desc),
    campo(m?.tem_arquivo ? `Trocar arquivo (hoje: ${m.arquivo_nome})` : 'Arquivo para baixar (PDF, até 40 MB)', arquivo), dlN, dlP);
  let remover = null;
  if (m?.tem_arquivo) { const l = el('label', 'bib-remover'); remover = document.createElement('input'); remover.type = 'checkbox'; l.append(remover, document.createTextNode(' Remover o arquivo guardado')); grade.append(l); }
  const aviso = el('p', 'rodape-nota'); aviso.hidden = true;
  const salvar = el('button', 'btn btn-forte', 'Salvar'); salvar.type = 'submit';
  const cancelar = el('button', 'btn', 'Cancelar'); cancelar.type = 'button'; cancelar.addEventListener('click', () => { formAberto = null; desenhar(); });
  f.append(grade, aviso, el('div', 'bib-form-botoes'));
  f.lastChild.append(salvar, cancelar);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); aviso.hidden = true;
    const corpo = { produto: produto.value.trim(), nicho: nicho.value.trim(), tipo: tipo.value, titulo: titulo.value.trim(), url: url.value.trim() || null, descricao: desc.value.trim() || null };
    if (!corpo.produto || !corpo.nicho || !corpo.titulo) { aviso.textContent = 'Preencha produto, nicho e título.'; aviso.hidden = false; return; }
    const arq = arquivo.files[0];
    if (arq) {
      if (arq.size > MAX_ARQUIVO) { aviso.textContent = 'O arquivo passa de 40 MB.'; aviso.hidden = false; return; }
      corpo.arquivo_nome = arq.name; corpo.arquivo_mime = arq.type || (arq.name.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '');
      corpo.arquivo_base64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => ok(''); r.readAsDataURL(arq); });
    } else if (remover?.checked) corpo.remover_arquivo = true;
    if (!m && !corpo.url && !arq) { aviso.textContent = 'Informe o link ou envie o arquivo.'; aviso.hidden = false; return; }
    salvar.disabled = true; salvar.textContent = 'Salvando…';
    const { ok, dados } = await api(m ? `/api/biblioteca/${m.id}` : '/api/biblioteca', { metodo: m ? 'PUT' : 'POST', corpo });
    salvar.disabled = false; salvar.textContent = 'Salvar';
    if (!ok) { aviso.textContent = dados?.erro ?? dados?.detail ?? dados?.message ?? 'Não consegui salvar.'; aviso.hidden = false; return; }
    formAberto = null; carregar();
  });
  return f;
}

function desenharLista() {
  const alvo = $('bib-lista');
  if (!alvo) return;
  const visiveis = materiais.filter(passa);
  $('bib-contagem').textContent = `${visiveis.length} de ${materiais.length} materiais`;
  alvo.replaceChildren();
  if (!visiveis.length) { alvo.append(el('p', 'vazio-suave', materiais.length ? 'Nenhum material com estes filtros.' : 'A biblioteca ainda está vazia.')); return; }
  // Agrupa por nicho → produto.
  const porNicho = new Map();
  for (const m of visiveis) { if (!porNicho.has(m.nicho)) porNicho.set(m.nicho, new Map()); const p = porNicho.get(m.nicho); if (!p.has(m.produto)) p.set(m.produto, []); p.get(m.produto).push(m); }
  for (const [nicho, produtos] of porNicho) {
    const bloco = el('section', 'bib-nicho');
    bloco.append(el('h3', 'bib-nicho-titulo', nicho));
    for (const [produto, itens] of produtos) {
      const cartao = el('div', 'cartao bib-produto');
      const cab = el('div', 'bib-produto-cab'); cab.append(el('strong', null, produto), el('span', 'bib-produto-qtd', `${itens.length} material${itens.length > 1 ? 'is' : ''}`));
      const ul = el('ul', 'bib-lista'); for (const m of itens) ul.append(linhaMaterial(m));
      cartao.append(cab, ul); bloco.append(cartao);
    }
    alvo.append(bloco);
  }
}

function desenhar() {
  const raiz = $('bib-conteudo');
  const m = typeof formAberto === 'number' ? materiais.find((x) => x.id === formAberto) : null;
  const corpo = [barraFiltros(), el('p', 'rodape-nota', '')];
  corpo[1].id = 'bib-contagem';
  const lista = el('div'); lista.id = 'bib-lista';
  raiz.replaceChildren(...(formAberto ? [formulario(m)] : []), ...corpo, lista);
  desenharLista();
}

$('aba-btn-biblioteca')?.addEventListener('click', carregar);
// Aba aberta direto pelo último estado salvo (recarga da página): carrega quando ela estiver visível.
if (localStorage.getItem('aba') === 'biblioteca') setTimeout(carregar, 0);
