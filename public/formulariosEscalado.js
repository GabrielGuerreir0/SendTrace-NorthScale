/**
 * Suporte Escalado → sub-aba "Respostas dos formulários" (19/09/2026).
 *
 * Mostra as respostas dos Google Forms de reembolso e de devolução (importadas pelo n8n) agrupadas por PERFIL.
 * Cada grupo é um acordeão; ao abrir, carrega a tabela com TODAS as respostas daquele perfil (uma chamada por
 * grupo, na primeira abertura). "Ver" abre a resposta inteira. A coluna "Sugestão" é só um ponto de partida:
 * quem responde cada grupo (IA sozinha ou CS) ainda será decidido pela equipe.
 * Todo texto vindo das respostas entra por `textContent`.
 */
import { $, api, kpiCard, paginar, montarPaginacao, celCliente, abrirFicha } from './emailComum.js';
import { n, dataHora, relativo } from './format.js';

const POR_PAGINA = 25;
const ROT_FORM = { reembolso: 'Reembolso', envio: 'Devolução' };
const ROT_SUGESTAO = { automatica: 'IA responde', escalada: 'CS responde' };

const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined && texto !== null) e.textContent = texto;
  return e;
};

let carregando = false;
const abertos = new Set();          // perfis com o acordeão aberto (sobrevive a "Atualizar")
const cacheLinhas = new Map();      // perfil → linhas já baixadas

const filtroForm = () => $('fm-formulario').value || '';
const qsForm = () => (filtroForm() ? `&formulario=${encodeURIComponent(filtroForm())}` : '');

/* ── ficha de uma resposta ── */
async function abrirResposta(id) {
  const { ok, dados } = await api(`/api/formularios/${id}`);
  if (!ok) return;
  const campos = Object.entries(dados.dados ?? {})
    .filter(([k, v]) => k && String(v ?? '').trim() && !/^carimbo/i.test(k))
    .map(([rotulo, valor]) => ({ rotulo, valor, largo: String(valor).length > 60 }));
  campos.unshift(
    { rotulo: 'Perfil', valor: dados.perfil_rotulo ?? dados.perfil },
    { rotulo: 'Sugestão (a decidir)', valor: `${ROT_SUGESTAO[dados.destino] ?? '—'} — ${dados.motivo_destino ?? ''}`, largo: true },
    { rotulo: 'Caso no Kanban', valor: dados.caso_coluna ?? 'sem caso aberto' },
    { rotulo: 'Respondido em', valor: dados.respondido_em ? dataHora(dados.respondido_em) : '—' },
  );
  abrirFicha({
    titulo: `${ROT_FORM[dados.formulario] ?? dados.formulario} — ${dados.nome ?? dados.email ?? 'sem nome'}`,
    subtitulo: dados.email ?? '',
    campos,
  });
}

/* ── tabela de um grupo ── */
function tabelaDoGrupo(perfil, linhas, corpo) {
  let pagina = 1;
  const envolve = el('div', 'sup-tabela-envolve');
  const tabela = el('table', 'sup-tabela fm-tabela');
  const cabeca = el('thead');
  const trc = el('tr');
  for (const t of ['Respondido', 'Cliente', 'Pedido / produto', 'Motivo / devolução', 'Caso no Kanban', 'Sugestão', '']) {
    trc.append(el('th', '', t));
  }
  cabeca.append(trc);
  const tbody = el('tbody');
  tabela.append(cabeca, tbody);
  envolve.append(tabela);
  const pag = el('div', 'paginacao');
  corpo.replaceChildren(envolve, pag);

  function desenhar() {
    const { pagina: p, totalPaginas, fatia } = paginar(linhas, pagina, POR_PAGINA);
    pagina = p;
    tbody.replaceChildren(...fatia.map((r) => {
      const tr = el('tr');
      const td = (conteudo, classe) => {
        const c = el('td', classe);
        if (conteudo instanceof Node) c.append(conteudo); else c.textContent = conteudo ?? '—';
        tr.append(c);
      };
      const quando = el('div', 'fm-nowrap', r.respondido_em ? dataHora(r.respondido_em) : '—');
      const chip = el('span', 'fm-chip fm-sub', ROT_FORM[r.formulario] ?? r.formulario); chip.dataset.form = r.formulario;
      quando.append(chip);
      td(quando);
      td(celCliente(r.nome, r.email));
      const ped = el('div', '', r.pedido ? String(r.pedido).slice(0, 40) : '—');
      ped.append(el('span', 'fm-sub', [r.produto, r.qtd_potes].filter(Boolean).join(' · ').slice(0, 60)));
      td(ped);
      td(r.formulario === 'envio'
        ? [r.transportadora, r.rastreio, r.lacrado ? `lacrado: ${r.lacrado}` : ''].filter(Boolean).join(' · ').slice(0, 90) || '—'
        : (r.motivo ?? '—').slice(0, 90));
      td(r.caso_coluna ?? 'sem caso');
      const sug = el('span', 'fm-chip fm-chip--sug', ROT_SUGESTAO[r.destino] ?? '—'); sug.dataset.destino = r.destino ?? '';
      td(sug, 'fm-nowrap');
      const btn = el('button', 'btn btn-fantasma', 'Ver'); btn.type = 'button';
      btn.addEventListener('click', () => abrirResposta(r.id));
      td(btn, 'fm-nowrap');
      return tr;
    }));
    montarPaginacao(pag, { pagina, totalPaginas, total: linhas.length, rotuloItem: 'resposta' }, (novaPagina) => { pagina = novaPagina; desenhar(); });
  }
  desenhar();
}

async function carregarLinhas(perfil, corpo) {
  corpo.replaceChildren(el('p', 'vazio-suave', 'carregando…'));
  const { ok, dados } = await api(`/api/formularios/respostas?perfil=${encodeURIComponent(perfil)}${qsForm()}`);
  if (!ok) { corpo.replaceChildren(el('p', 'vazio-suave', 'Não consegui carregar as respostas deste grupo.')); return; }
  cacheLinhas.set(perfil, dados.itens);
  if (!dados.itens.length) { corpo.replaceChildren(el('p', 'vazio-suave', 'Nenhuma resposta neste grupo.')); return; }
  tabelaDoGrupo(perfil, dados.itens, corpo);
}

/* ── grupos ── */
function renderGrupos(grupos) {
  if (!grupos.length) {
    $('fm-grupos').replaceChildren(el('p', 'vazio-suave', 'Nenhuma resposta importada ainda. O fluxo do n8n importa as planilhas a cada 15 minutos.'));
    return;
  }
  $('fm-grupos').replaceChildren(...grupos.map((g) => {
    const det = el('details', 'fm-grupo');
    det.dataset.perfil = g.perfil;
    const sum = el('summary', 'fm-grupo-cab');
    const titulo = el('div', 'fm-grupo-tit');
    titulo.append(el('strong', '', g.rotulo), el('span', 'fm-grupo-desc', g.descricao));
    const nums = el('div', 'fm-grupo-nums');
    nums.append(el('span', 'fm-num', `${n(g.total)} resposta${g.total === 1 ? '' : 's'}`), el('span', 'fm-num-sub', `${n(g.clientes)} cliente${g.clientes === 1 ? '' : 's'}`));
    const sug = el('div', 'fm-grupo-sug');
    if (g.sug_automatica) { const c = el('span', 'fm-chip fm-chip--sug', `${n(g.sug_automatica)} IA`); c.dataset.destino = 'automatica'; sug.append(c); }
    if (g.sug_escalada) { const c = el('span', 'fm-chip fm-chip--sug', `${n(g.sug_escalada)} CS`); c.dataset.destino = 'escalada'; sug.append(c); }
    sum.append(titulo, nums, sug);
    const corpo = el('div', 'fm-grupo-corpo');
    det.append(sum, corpo);
    det.addEventListener('toggle', () => {
      if (det.open) {
        abertos.add(g.perfil);
        if (!cacheLinhas.has(g.perfil)) carregarLinhas(g.perfil, corpo);
        else if (cacheLinhas.get(g.perfil).length) tabelaDoGrupo(g.perfil, cacheLinhas.get(g.perfil), corpo);
      } else abertos.delete(g.perfil);
    });
    if (abertos.has(g.perfil)) { det.open = true; }
    return det;
  }));
}

function renderKpis(meta, grupos) {
  const sugIA = grupos.reduce((s, g) => s + g.sug_automatica, 0);
  const sugCS = grupos.reduce((s, g) => s + g.sug_escalada, 0);
  $('fm-kpis').replaceChildren(
    kpiCard({ icone: '✎', tom: 'neutro', rotulo: 'Respostas', valor: n(meta.total), nota: `${n(meta.clientes)} clientes diferentes` }),
    kpiCard({ icone: '◔', tom: 'neutro', rotulo: 'Últimos 7 dias', valor: n(meta.ultimos_7_dias), nota: 'respostas novas' }),
    kpiCard({ icone: '▦', tom: 'neutro', rotulo: 'Grupos de perfil', valor: n(grupos.length), nota: meta.sem_perfil ? `${n(meta.sem_perfil)} ainda sem perfil` : 'todas classificadas' }),
    kpiCard({ icone: '↹', tom: 'neutro', rotulo: 'Sugestão inicial', valor: `${n(sugIA)} IA · ${n(sugCS)} CS`, nota: 'só um ponto de partida — a decisão é da equipe' }),
  );
  $('fm-status').textContent = meta.ultima_importacao
    ? `Última importação das planilhas: ${dataHora(meta.ultima_importacao)} (${relativo(meta.ultima_importacao)}). O n8n importa a cada 15 minutos.`
    : 'As planilhas ainda não foram importadas. O n8n importa a cada 15 minutos.';
}

export async function carregarFormularios() {
  if (carregando) return;
  carregando = true;
  cacheLinhas.clear();
  const { ok, dados } = await api(`/api/formularios/grupos?${qsForm().slice(1)}`);
  carregando = false;
  if (!ok) { $('fm-grupos').replaceChildren(el('p', 'vazio-suave', 'Não consegui carregar as respostas dos formulários agora.')); return; }
  renderKpis(dados.meta, dados.grupos);
  renderGrupos(dados.grupos);
}

$('fm-formulario')?.addEventListener('change', () => { abertos.clear(); carregarFormularios(); });
$('fm-atualizar')?.addEventListener('click', carregarFormularios);
