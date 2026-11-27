/**
 * MONIT-SPPL — Fase 3, aba "Tratativas" (seção 10): o que a equipe já fez em cada pedido e como ele está agora. As tratativas ficam no Suporte Ativo
 * (sppl_ativo_acoes), não numa tabela paralela. Aqui: cinco números, "Status no Monitoramento Logístico" por classe (tratados / em aberto), "Pedidos para
 * tratar" (lista de trabalho com seleção e registro), "O que foi feito", "Como os pedidos tratados estão agora" e a tabela dos tratados.
 * Também exporta o formulário de registro (usado pela lista e pela ficha) e o bloco de tratativas da ficha. Todo texto da API entra por textContent.
 */
import { el, fmtData, fmtDataHora, campoSelect, campoTexto, criarJanela, mensagem } from './spplComum.js';

const BASE = '/api/rastreio/monit';
let ctx = null; let raiz = null; let dados = null; let carregando = false;
const filtro = { classe: '', grupo: '', tratado: 'nao', q: '', tipo: '', situacao: '', pagina: 1 };
const LIMITE_TELA = 300;
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const SITUACOES = {
  chargeback: 'Chargeback', reembolsado: 'Reembolsado', cancelado: 'Cancelado', devolvido: 'Devolvido', entregue: 'Entregue', nao_encontrado: 'Não encontrado na fulfillment',
  sem_codigo: 'Sem código de rastreio', problema_entrega: 'Problema na entrega', aguardando_coleta: 'Aguardando coleta', em_transito: 'Em trânsito',
};
const tipos = () => ctx.estado.cfg.tipos_tratativa;
const celula = (rotulo, conteudo) => { const td = document.createElement('td'); td.dataset.label = rotulo; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? '—'; return td; };

/* ─────────────────────────  formulário de registro (lista e ficha)  ───────────────────────── */

/** Abre o formulário para registrar a MESMA tratativa em vários pedidos (ids). `aoGravar` roda depois de gravar. */
export function abrirFormulario(ids, aoGravar) {
  const j = criarJanela('mon-trat', { larga: false });
  const corpo = j.refazer('Registrar tratativa', `${n(ids.length)} pedido(s) selecionado(s). Registrar não envia e-mail nenhum: só guarda o que a equipe já fez.`);
  const form = el('form'); const t = campoSelect('Tipo de tratativa', Object.entries(tipos()), 'email_cliente'); const nota = campoTexto('Observação (opcional)', { max: 1000, cresce: true });
  const msg = el('p', '', 'cartao-sub'); msg.setAttribute('role', 'status');
  const ok = el('button', 'Registrar tratativa', 'btn btn-forte'); ok.type = 'submit'; const cancela = el('button', 'Cancelar', 'btn'); cancela.type = 'button'; cancela.addEventListener('click', () => j.fechar());
  const acoes = el('div', undefined, 'sppl-acoes'); acoes.append(ok, cancela);
  form.append(t.rotulo, nota.rotulo, acoes, msg); corpo.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); ok.disabled = true; mensagem(msg, 'Gravando…');
    const r = await ctx.api(`${BASE}/tratativas`, { metodo: 'POST', corpo: { pedidos: ids, tipo: t.select.value, nota: nota.input.value.trim() || undefined } });
    ok.disabled = false;
    if (!r.ok) { mensagem(msg, r.dados?.detail ?? 'Não foi possível registrar.', true); return; }
    j.fechar(); if (aoGravar) aoGravar(r.dados);
  });
  j.abrir();
}

/** Bloco "Tratativas" da ficha do pedido: lista (com Remover) e o formulário rápido. */
export function fichaTratativas(ficha) {
  const caixa = el('div'); caixa.append(el('h3', 'Tratativas'));
  const lista = ficha.tratativas ?? [];
  if (!lista.length) caixa.append(el('p', 'Nenhuma tratativa registrada neste pedido.', 'mon-vazio'));
  for (const x of lista) {
    const linha = el('div', undefined, 'mon-caixa');
    linha.append(el('b', tipos()[x.tipo] ?? x.tipo), el('span', ` · ${fmtDataHora(x.em)} · ${x.por ?? '—'}`));
    if (x.nota) linha.append(el('div', x.nota));
    if (x.modelo || x.assunto) linha.append(el('div', `Modelo: ${x.modelo ?? '—'} · Assunto: ${x.assunto ?? '—'}`));
    const rm = el('button', 'Remover', 'btn'); rm.type = 'button'; rm.style.marginTop = '6px';
    rm.addEventListener('click', async () => {
      if (!confirm('Remover esta tratativa?')) return;
      const r = await ctx.api(`${BASE}/tratativas/${x.id}`, { metodo: 'DELETE' });
      if (r.ok) { ctx.abrirFicha(ficha.pedido.pedido_id); recarregar(); document.dispatchEvent(new CustomEvent('monit:tratativa-mudou')); }
    });
    const dv = el('div'); dv.append(rm); linha.append(dv); caixa.append(linha);
  }
  caixa.append(el('p', `E-mails enviados ao cliente: ${ficha.emails.enviados}${ficha.emails.tipos ? ` (${ficha.emails.tipos})` : ''}.`, 'cartao-sub'));
  const novo = el('button', 'Registrar tratativa', 'btn btn-forte'); novo.type = 'button';
  novo.addEventListener('click', () => abrirFormulario([ficha.pedido.pedido_id], () => { ctx.abrirFicha(ficha.pedido.pedido_id); recarregar(); document.dispatchEvent(new CustomEvent('monit:tratativa-mudou')); }));
  caixa.append(novo); return caixa;
}

/* ───────────────────────────────  a aba  ─────────────────────────────── */

export function iniciar(c) {
  ctx = c; raiz = c.raiz; raiz.replaceChildren();
  const info = el('p', 'O Suporte Ativo é onde a equipe registra o que já fez em cada pedido e acompanha como ele está agora. Aparecer aqui não envia e-mail nenhum.', 'cartao-sub'); raiz.append(info);
  for (const id of ['mt-numeros', 'mt-status', 'mt-tratar', 'mt-feito', 'mt-tratados']) { const d = el('section', undefined, 'mon-bloco'); d.id = id; d.style.margin = '0 0 18px'; raiz.append(d); }
  document.addEventListener('monit:tratativa-mudou', () => recarregar());
}
/** Só busca os dados quando a aba é aberta (a ficha também carrega este módulo, só para o bloco de tratativas). */
export function abrir() { if (raiz && !dados) recarregar(true); }
export function aoMudarSelecao() { /* a seleção da aba Classificação é a mesma `estado.selecionados`; nada a redesenhar aqui */ }

export async function recarregar(forcar = false) {
  if (!ctx || carregando || (!forcar && !dados)) return; carregando = true;
  try {
    const r = await ctx.api(`${BASE}/tratativas/painel?${ctx.parametros({ lista: false })}`);
    if (!r.ok) { raiz.querySelector('#mt-numeros').replaceChildren(el('p', r.dados?.detail ?? 'Não foi possível carregar as tratativas.', 'mon-vazio')); return; }
    dados = r.dados; desenharNumeros(); desenharStatus(); desenharFeito(); desenharTratados(); await carregarLista();
  } finally { carregando = false; }
}

function desenharNumeros() {
  const caixa = raiz.querySelector('#mt-numeros'); caixa.replaceChildren(); const k = dados.numeros; caixa.className = 'sppl-kpis';
  for (const [v, rot, crit] of [[k.pedidos_tratados, 'Pedidos tratados', 'Já receberam e-mail ou têm alguma tratativa.'], [k.tratativas, 'Tratativas registradas', 'Soma de todas as tratativas.'], [k.ja_entregues, 'Já entregues', 'Tratados que a transportadora entregou.'],
    [k.ainda_em_aberto, 'Ainda em aberto', 'Em trânsito, aguardando coleta, com problema na entrega, sem código ou não encontrados.'], [k.viraram_reembolso_etc, 'Reembolso, chargeback, devolução ou cancelamento', 'Tratados que acabaram assim.']]) {
    const b = el('div', undefined, 'sppl-kpi'); b.title = crit; b.append(el('b', n(v)), el('span', rot)); caixa.append(b);
  }
}

function desenharStatus() {
  const caixa = raiz.querySelector('#mt-status'); caixa.replaceChildren(); caixa.append(el('h3', 'Status no Monitoramento Logístico (tratados / em aberto)'));
  const grade = el('div', undefined, 'mon-grupos');
  for (const g of ctx.estado.cfg.grupos.filter((x) => x.id !== 'ok')) {
    const col = el('div', undefined, 'mon-caixa'); col.append(el('b', g.nome));
    for (const c of ctx.estado.cfg.classes.filter((x) => x.grupo === g.id)) {
      const d = dados.classes.find((x) => x.classe === c.chave); if (!d) continue;
      const b = el('button', undefined, 'mon-barra'); b.type = 'button'; b.style.gridTemplateColumns = '1fr 70px'; b.setAttribute('aria-pressed', String(filtro.classe === c.chave));
      const tr = el('span', undefined, 'mon-trilho'); const i = el('i'); i.style.width = `${d.em_aberto ? 100 * d.tratados / d.em_aberto : 0}%`; i.style.background = g.cor; tr.append(i);
      const topo = el('span'); topo.append(el('span', c.nome), el('br'), tr);
      b.append(topo, el('span', `${n(d.tratados)} / ${n(d.em_aberto)}`));
      b.addEventListener('click', () => { filtro.classe = filtro.classe === c.chave ? '' : c.chave; filtro.pagina = 1; desenharStatus(); carregarLista(); }); col.append(b);
    }
    grade.append(col);
  }
  caixa.append(grade);
}

/* ─── pedidos para tratar ─── */
function parametrosLista(extra = {}) {
  const e = { sem_ok: '1', tratado: filtro.tratado, classe: filtro.classe, q: filtro.q, ordem: 'dias_desde_evento', dir: 'desc', ...extra };
  const base = new URLSearchParams(ctx.parametros({ lista: false })); for (const [k, v] of Object.entries(e)) if (v) base.set(k, v);
  return base.toString();
}

async function carregarLista() {
  const caixa = raiz.querySelector('#mt-tratar'); caixa.replaceChildren(); caixa.append(el('h3', 'Pedidos para tratar'));
  const f = el('div', undefined, 'sppl-filtros');
  const st = campoSelect('Mostrar', [['nao', 'Não tratados'], ['sim', 'Tratados'], ['', 'Todos']], filtro.tratado, (v) => { filtro.tratado = v; carregarLista(); });
  const b = campoTexto('Buscar', { tipo: 'search', max: 80, placeholder: 'Pedido, e-mail, nome ou rastreio', valor: filtro.q, cresce: true });
  let t0; b.input.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { filtro.q = b.input.value.trim(); carregarLista(); }, 450); });
  f.append(st.rotulo, b.rotulo); caixa.append(f);
  const barra = el('div', undefined, 'sppl-acoes'); const txt = el('span', '', 'cartao-sub'); const msg = el('span', '', 'cartao-sub'); msg.setAttribute('role', 'status');
  const bSel = el('button', 'Selecionar todos da lista', 'btn'); bSel.type = 'button';
  const bReg = el('button', 'Registrar tratativa', 'btn btn-forte'); bReg.type = 'button';
  const bLimpa = el('button', 'Limpar seleção', 'btn'); bLimpa.type = 'button';
  const bXls = el('button', 'Baixar relatório (.xlsx)', 'btn'); bXls.type = 'button';
  barra.append(txt, bSel, bReg, bLimpa, bXls, msg); caixa.append(barra);
  const envolve = el('div', undefined, 'tabela-envolve'); caixa.append(envolve);
  const sel = ctx.estado.selecionados;
  const atualizarTxt = () => { txt.textContent = sel.size ? `${n(sel.size)} pedido(s) selecionado(s)` : 'Nenhum pedido selecionado'; bReg.disabled = !sel.size; bLimpa.disabled = !sel.size; };
  const r = await ctx.api(`${BASE}/lista?${parametrosLista({ tamanho: LIMITE_TELA, pagina: 1 })}`);
  if (!r.ok) { envolve.append(el('p', r.dados?.detail ?? 'Não foi possível carregar a lista.', 'mon-vazio')); return; }
  const tab = el('table', undefined, 'tabela tabela--empilha tabela--larga mon-tabela'); const th = el('thead'); const trh = el('tr'); trh.append(el('th', ''));
  for (const h of ['Pedido', 'Cliente', 'Classificação', 'Dias desde o evento', 'Fulfillment', 'Tratativas', 'E-mails']) trh.append(el('th', h));
  th.append(trh); const tb = el('tbody');
  for (const p of r.dados.itens) {
    const tr = el('tr'); tr.className = 'sup-linha-clique';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sel.has(p.pedido_id); cb.addEventListener('click', (e) => { e.stopPropagation(); if (cb.checked) sel.add(p.pedido_id); else sel.delete(p.pedido_id); atualizarTxt(); });
    const tdm = document.createElement('td'); tdm.append(cb); tr.append(tdm);
    tr.append(celula('Pedido', p.pedido), celula('Cliente', p.nome_cliente), celula('Classificação', p.classe_nome), celula('Dias desde o evento', p.dias_desde_evento ?? '—'),
      celula('Fulfillment', ctx.estado.cfg.rotulo_fulfillment[p.fulfillment] ?? p.fulfillment), celula('Tratativas', p.tratativas), celula('E-mails', p.emails_enviados));
    tr.addEventListener('click', () => ctx.abrirFicha(p.pedido_id)); tb.append(tr);
  }
  if (!r.dados.itens.length) { const tr = el('tr'); const td = el('td', 'Nenhum pedido com estes filtros.', 'mon-vazio'); td.colSpan = 8; tr.append(td); tb.append(tr); }
  tab.append(th, tb); envolve.append(tab);
  if (r.dados.total > LIMITE_TELA) caixa.append(el('p', `Mostrando os ${LIMITE_TELA} com mais dias desde o evento, de ${n(r.dados.total)}. "Selecionar todos da lista" pega a lista inteira.`, 'cartao-sub'));
  bSel.addEventListener('click', async () => {
    bSel.disabled = true; mensagem(msg, 'Selecionando…');
    for (let pagina = 1; pagina <= 20; pagina += 1) {
      const x = await ctx.api(`${BASE}/lista?${parametrosLista({ tamanho: 500, pagina })}`); if (!x.ok) break;
      for (const p of x.dados.itens) sel.add(p.pedido_id); if (pagina * 500 >= x.dados.total) break;
    }
    for (const c of envolve.querySelectorAll('input[type=checkbox]')) c.checked = true; atualizarTxt(); mensagem(msg, ''); bSel.disabled = false;
  });
  bLimpa.addEventListener('click', () => { sel.clear(); for (const c of envolve.querySelectorAll('input[type=checkbox]')) c.checked = false; atualizarTxt(); });
  bReg.addEventListener('click', () => abrirFormulario([...sel], (res) => { sel.clear(); mensagem(msg, `${res.gravadas} tratativa(s) registrada(s).`); recarregar(); document.dispatchEvent(new CustomEvent('monit:tratativa-mudou')); }));
  bXls.addEventListener('click', () => baixarRelatorio(parametrosLista({ tratado: filtro.tratado }), msg, bXls));
  atualizarTxt();
}

/** Baixa o .xlsx do servidor com os mesmos filtros (nome vem no cabeçalho X-Nome-Arquivo). Compartilhado com a aba Classificação. */
export async function baixarRelatorio(consulta, msg, botao) {
  if (botao) botao.disabled = true; mensagem(msg, 'Gerando a planilha…');
  try {
    const resp = await fetch(`${BASE}/pedidos.xlsx?${consulta}`);
    if (!resp.ok) { let d = {}; try { d = await resp.json(); } catch { /* sem corpo */ } mensagem(msg, d.detail ?? 'Não foi possível gerar a planilha.', true); return; }
    const nome = decodeURIComponent(resp.headers.get('X-Nome-Arquivo') || 'pedidos.xlsx'); const blob = await resp.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    mensagem(msg, `Planilha gerada (${resp.headers.get('X-Linhas') ?? ''} pedidos).`);
  } catch { mensagem(msg, 'Não foi possível gerar a planilha.', true); } finally { if (botao) botao.disabled = false; }
}

/* ─── o que foi feito / como estão agora / tabela ─── */
function barras(titulo, mapa, rotulos, cor, aoClicar, ativo) {
  const c = el('div', undefined, 'mon-caixa'); c.append(el('b', titulo)); const max = Math.max(1, ...Object.values(mapa));
  for (const [k, v] of Object.entries(mapa).sort((a, b) => b[1] - a[1])) {
    const b = el('button', undefined, 'mon-barra'); b.type = 'button'; b.style.gridTemplateColumns = 'minmax(120px, 220px) 1fr 50px'; b.setAttribute('aria-pressed', String(ativo === k));
    const tr = el('span', undefined, 'mon-trilho'); const i = el('i'); i.style.width = `${100 * v / max}%`; i.style.background = cor; tr.append(i);
    b.append(el('span', rotulos[k] ?? k), tr, el('span', n(v))); b.addEventListener('click', () => aoClicar(ativo === k ? '' : k)); c.append(b);
  }
  if (!Object.keys(mapa).length) c.append(el('p', 'Nada registrado ainda.', 'mon-vazio')); return c;
}
function desenharFeito() {
  const caixa = raiz.querySelector('#mt-feito'); caixa.replaceChildren(); const g = el('div', undefined, 'mon-grupos'); g.style.gridTemplateColumns = 'repeat(auto-fit, minmax(320px, 1fr))';
  g.append(barras('O que foi feito (pedidos distintos por tipo)', dados.o_que_foi_feito, tipos(), '#3A3F5C', (k) => { filtro.tipo = k; filtro.pagina = 1; desenharTratados(); desenharFeito(); }, filtro.tipo));
  g.append(barras('Como os pedidos tratados estão agora', dados.situacoes, SITUACOES, '#8FA3F2', (k) => { filtro.situacao = k; filtro.pagina = 1; desenharTratados(); desenharFeito(); }, filtro.situacao));
  caixa.append(g);
}

function desenharTratados() {
  const caixa = raiz.querySelector('#mt-tratados'); caixa.replaceChildren(); caixa.append(el('h3', 'Pedidos tratados'));
  let itens = dados.tratados;
  if (filtro.tipo) itens = itens.filter((t) => (t.tratativas_tipos ?? []).includes(filtro.tipo));
  if (filtro.situacao) itens = itens.filter((t) => t.situacao === filtro.situacao);
  caixa.append(el('p', `${n(itens.length)} pedido(s)${filtro.tipo ? ` com "${tipos()[filtro.tipo]}"` : ''}${filtro.situacao ? ` · agora: ${SITUACOES[filtro.situacao]}` : ''}. Clique numa linha para abrir a ficha.`, 'cartao-sub'));
  const env = el('div', undefined, 'tabela-envolve'); const tab = el('table', undefined, 'tabela tabela--empilha tabela--larga mon-tabela'); const th = el('thead'); const trh = el('tr');
  for (const h of ['Pedido', 'Tratativas feitas', 'Última tratativa', 'Dias desde a última', 'Situação agora', 'Última movimentação', 'Dias sem movimentação', 'Pagamento', 'Fulfillment']) trh.append(el('th', h));
  th.append(trh); const tb = el('tbody');
  for (const t of itens.slice(0, 500)) {
    const tr = el('tr'); tr.className = 'sup-linha-clique';
    const feitas = (t.tratativas_tipos ?? []).map((k) => tipos()[k] ?? k).join(', '); const x = t.tratativas ? `${feitas} (×${t.tratativas})` : 'Só e-mail do SendTrace';
    tr.append(celula('Pedido', t.pedido), celula('Tratativas feitas', x), celula('Última tratativa', t.ultima_em ? `${fmtData(t.ultima_em)} · ${t.ultima_por ?? '—'}` : '—'), celula('Dias desde a última', t.dias_desde_ultima ?? '—'),
      celula('Situação agora', SITUACOES[t.situacao] ?? t.situacao), celula('Última movimentação', t.ultima_movimentacao ? fmtData(t.ultima_movimentacao) : '—'), celula('Dias sem movimentação', t.dias_sem_movimentacao ?? '—'),
      celula('Pagamento', t.plataforma ?? 'Não identificada'), celula('Fulfillment', ctx.estado.cfg.rotulo_fulfillment[t.fulfillment] ?? t.fulfillment));
    tr.addEventListener('click', () => ctx.abrirFicha(t.pedido_id)); tb.append(tr);
  }
  if (!itens.length) { const tr = el('tr'); const td = el('td', 'Nenhum pedido tratado com estes filtros.', 'mon-vazio'); td.colSpan = 9; tr.append(td); tb.append(tr); }
  tab.append(th, tb); env.append(tab); caixa.append(env);
  if (itens.length > 500) caixa.append(el('p', 'Mostrando os 500 mais recentes.', 'cartao-sub'));
}
