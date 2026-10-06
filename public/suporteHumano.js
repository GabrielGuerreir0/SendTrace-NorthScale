/**
 * Suporte Humano — a fila de respostas do agente em lista e o painel da equipe (pedido da Késsia, PDF de 05/10/2026, itens 7 e 8; migrações 073–076).
 * Página própria no menu, separada do Suporte Escalado (Kanban): usa os MESMOS casos (email_ia.suporte_escalado), só que vistos pelo que está pendente de
 * resposta do agente, não pela coluna do card. O agente vê só o próprio board; administrador e gestor (papel do Suporte Escalado) veem todos.
 */
import { $, api, kpiCard, renderTabela } from './emailComum.js';
import { n } from './format.js';
import { abrirDetalheEscalado, ROTULO_TAG } from './emailSuporteEscalado.js';

let boardId = null;          // id de um board, ou 'todos' (só admin/gestor)
let boards = [];
let souGestor = false;
let meuBoardId = null;

const SUBABAS = { fila: 'sh-subaba-fila', equipe: 'sh-subaba-equipe' };
const paginaVisivel = () => !$('aba-suportehumano').hidden && !document.hidden;

function mostrarSubaba(qual) {
  for (const [nome, id] of Object.entries(SUBABAS)) {
    $(id).hidden = nome !== qual;
    $(`sh-subaba-btn-${nome}`).setAttribute('aria-selected', String(nome === qual));
  }
  localStorage.setItem('shSubaba', qual);
  if (qual === 'fila') carregarFila();
  if (qual === 'equipe') carregarEquipe();
}

function renderSeletor() {
  const sel = $('sh-board-seletor');
  sel.replaceChildren();
  if (souGestor) {
    const o = document.createElement('option'); o.value = 'todos'; o.textContent = '▣ Todos os boards'; sel.append(o);
  }
  for (const b of boards) {
    const o = document.createElement('option'); o.value = String(b.id);
    o.textContent = b.nome + (b.ativo === false ? ' (inativo)' : ''); sel.append(o);
  }
  sel.value = String(boardId ?? '');
  $('sh-board-campo').hidden = !(souGestor || boards.length > 1);
  $('sh-subaba-btn-equipe').hidden = !souGestor;
}

async function carregarBoards() {
  const { ok, dados } = await api('/api/suporte-escalado/boards');
  if (!ok) { boardId = null; return; }
  boards = dados.boards ?? [];
  souGestor = Boolean(dados.admin || dados.gestor);
  meuBoardId = dados.meu_board_id ?? null;
  const salvoRaw = localStorage.getItem('shBoardId');
  const salvo = Number(salvoRaw);
  if (salvoRaw === 'todos' && souGestor) boardId = 'todos';
  else if (salvo && boards.some((b) => b.id === salvo)) boardId = salvo;
  else if (meuBoardId && boards.some((b) => b.id === meuBoardId)) boardId = meuBoardId;
  else if (boards.length === 1) boardId = boards[0].id;
  else boardId = souGestor ? 'todos' : null;
  renderSeletor();
  if (!souGestor && localStorage.getItem('shSubaba') === 'equipe') localStorage.setItem('shSubaba', 'fila');
  mostrarSubaba(localStorage.getItem('shSubaba') === 'equipe' && souGestor ? 'equipe' : 'fila');
}

/* ═══════════════════  fila de respostas em lista (item 8 do PDF da Késsia)  ═══════════════════
   Para o agente não importa o status do card: importa o que está pendente de resposta dele. 3 filas: 1º e-mail pendente, 2º em
   diante pendente e todos os atribuídos. O tempo restante vem do SLA dentro do turno (GET /api/suporte-escalado/fila, migrações 073/074). */
let filaDados = null;
let filaAba = 'primeiro';
const FILAS = [
  { chave: 'primeiro', rotulo: '1º e-mail — pendente de resposta' },
  { chave: 'segundo', rotulo: '2º e-mail em diante — pendente de resposta' },
  { chave: 'todos', rotulo: 'Todos os atribuídos' },
];

function minutosTxt(min) {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

function selarSla(caso) {
  const el = document.createElement('span');
  el.className = 'esc-sla';
  if (caso.restante_min === null || caso.fila === 'outros') {
    el.dataset.estado = 'espera';
    el.textContent = caso.fila === 'outros' ? 'aguardando o cliente' : '—';
    return el;
  }
  if (caso.restante_min < 0) { el.dataset.estado = 'estourado'; el.textContent = `estourado há ${minutosTxt(caso.restante_min)}`; }
  else {
    el.dataset.estado = caso.restante_min <= 30 ? 'perto' : 'ok';
    el.textContent = `restam ${minutosTxt(caso.restante_min)}`;
  }
  el.title = `Meta ${minutosTxt(caso.meta_min)} de turno; já se passaram ${minutosTxt(caso.espera_min)} dentro do turno.`;
  return el;
}

function slaResumo(s) {
  if (!s || s.media_min === null) return { valor: '—', nota: `sem respostas medidas nos últimos ${filaDados?.resumo?.janela_dias ?? 7} dias` };
  return { valor: minutosTxt(s.media_min), nota: `média dos últimos ${filaDados.resumo.janela_dias} dias · ${s.dentro} de ${s.medidas} dentro da meta` };
}

async function carregarFila() {
  const raiz = $('sh-subaba-fila');
  if (!boardId) {
    raiz.replaceChildren();
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Escolha um board para ver a fila de respostas.';
    raiz.append(p);
    return;
  }
  const { ok, dados } = await api(`/api/suporte-escalado/fila?board_id=${boardId}`);
  if (!ok) {
    if (!filaDados) raiz.textContent = 'Não consegui carregar a fila.';
    return;
  }
  filaDados = dados;
  renderFila();
}

function renderFila() {
  const raiz = $('sh-subaba-fila');
  const { resumo, casos, truncado } = filaDados;
  const casosAba = (chave) => (chave === 'todos' ? casos : casos.filter((c) => c.fila === chave));

  const painel = document.createElement('section');
  painel.className = 'kpis kpis--suporte';
  const sla1 = slaResumo(resumo.sla_primeira);
  const sla2 = slaResumo(resumo.sla_segunda);
  painel.append(
    kpiCard({ icone: '●', tom: 'atrasado', rotulo: 'Pendentes de 1ª resposta', valor: n(resumo.pendentes_primeira), nota: 'sem nenhuma resposta do agente', onClick: () => { filaAba = 'primeiro'; renderFila(); }, ativo: filaAba === 'primeiro' }),
    kpiCard({ icone: '●', tom: 'travado', rotulo: 'Pendentes de 2ª resposta em diante', valor: n(resumo.pendentes_segunda), nota: 'o cliente escreveu de novo', onClick: () => { filaAba = 'segundo'; renderFila(); }, ativo: filaAba === 'segundo' }),
    kpiCard({ icone: '●', tom: 'finalizado', rotulo: 'Respondidos hoje', valor: n(resumo.respondidos_hoje), nota: 'tickets com resposta enviada hoje' }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'SLA de 1ª resposta', valor: sla1.valor, nota: sla1.nota }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'SLA de 2ª resposta em diante', valor: sla2.valor, nota: sla2.nota }),
  );

  const abas = document.createElement('div');
  abas.className = 'esc-fila-abas';
  abas.setAttribute('role', 'tablist');
  for (const f of FILAS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'subaba-btn';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(filaAba === f.chave));
    b.textContent = `${f.rotulo} (${n(casosAba(f.chave).length)})`;
    b.addEventListener('click', () => { filaAba = f.chave; renderFila(); });
    abas.append(b);
  }

  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela esc-fila-tabela';
  const cab = tabela.createTHead().insertRow();
  for (const t of ['E-mail do cliente', 'Assunto', 'Motivo', 'Prioridade', 'Tempo para responder', 'Agente responsável']) {
    const th = document.createElement('th'); th.textContent = t; cab.append(th);
  }
  const corpo = tabela.createTBody();
  const linhas = casosAba(filaAba);
  const colunasFila = [
    { render: (c) => { const d = document.createElement('div'); d.textContent = c.remetente_email; if (c.nome) { const s = document.createElement('small'); s.textContent = c.nome; d.append(s); } return d; } },
    { classe: 'esc-fila-assunto', render: (c) => c.assunto || '—' },
    { render: (c) => ROTULO_TAG[c.tag_motivo] || '—' },
    { render: (c) => (c.prioridade_nivel === 'alta' ? 'Alta' : c.prioridade_nivel === 'media' ? 'Média' : '—') },
    { render: selarSla },
    { render: (c) => c.agente || '—' },
  ];
  colunasFila.aoClicarLinha = (c) => abrirDetalheEscalado(c);
  renderTabela(corpo, linhas, colunasFila, { vazio: filaAba === 'todos' ? 'Nenhum ticket em aberto atribuído.' : 'Nada pendente de resposta nesta fila. 🎉' });

  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = truncado
    ? 'Mostrando os 1.000 mais urgentes. Ordenado por tempo restante (estourados primeiro). O tempo conta só dentro do turno (seg–sex, horário de Brasília).'
    : 'Ordenado por tempo restante (estourados primeiro). O tempo conta só dentro do turno (seg–sex, horário de Brasília). Clique numa linha para abrir o ticket.';
  raiz.replaceChildren(painel, abas, tabela, nota);
}

/* ═══════════════════  painel da equipe (item 7 do PDF da Késsia)  ═══════════════════
   10 indicadores: SLA por agente e geral (1ª e 2ª em diante), tickets novos / respondidos pelos clientes / respondidos pelos agentes no dia,
   tickets atribuídos, fila nova e aguardando 2ª em diante por agente. Só admin/gestor (GET /api/suporte-escalado/kpis-equipe). */
let equipeDias = 7;
let equipeDados = null;
const PERIODOS_SLA = [{ dias: 0, rotulo: 'Hoje' }, { dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }];

function slaTexto(s) {
  if (!s || s.media_min === null) return '—';
  return minutosTxt(s.media_min);
}
function slaNota(s, periodo) {
  if (!s || s.media_min === null) return `sem respostas medidas (${periodo})`;
  return `${s.dentro} de ${s.medidas} dentro da meta · ${periodo}`;
}

async function carregarEquipe() {
  const raiz = $('sh-subaba-equipe');
  if (!souGestor) {
    raiz.replaceChildren();
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Só administradores e gestores veem o painel da equipe.';
    raiz.append(p);
    return;
  }
  const { ok, dados } = await api(`/api/suporte-escalado/kpis-equipe?dias=${equipeDias}`);
  if (!ok) { if (!equipeDados) raiz.textContent = 'Não consegui carregar o painel da equipe.'; return; }
  equipeDados = dados;
  renderEquipe();
}

function renderEquipe() {
  const raiz = $('sh-subaba-equipe');
  const { equipe: e, agentes } = equipeDados;
  const periodo = PERIODOS_SLA.find((p) => p.dias === equipeDias)?.rotulo.toLowerCase() ?? '';

  const seletor = document.createElement('div');
  seletor.className = 'esc-fila-abas';
  const rot = document.createElement('span');
  rot.className = 'rodape-nota';
  rot.textContent = 'Período dos SLAs:';
  seletor.append(rot);
  for (const p of PERIODOS_SLA) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'subaba-btn';
    b.setAttribute('aria-selected', String(p.dias === equipeDias));
    b.textContent = p.rotulo;
    b.addEventListener('click', () => { equipeDias = p.dias; carregarEquipe(); });
    seletor.append(b);
  }

  const painel = document.createElement('section');
  painel.className = 'kpis kpis--suporte';
  painel.append(
    kpiCard({ icone: '●', tom: 'finalizado', rotulo: 'Tickets novos hoje', valor: n(e.novos_hoje), nota: 'chegaram no dia' }),
    kpiCard({ icone: '●', tom: 'travado', rotulo: 'Clientes que responderam hoje', valor: n(e.clientes_responderam_hoje), nota: 'tickets com novo e-mail do cliente' }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'Respondidos pelos agentes hoje', valor: n(e.agentes_responderam_hoje), nota: 'tickets com resposta enviada' }),
    kpiCard({ icone: '●', tom: 'atrasado', rotulo: 'Novos na fila, sem atendimento', valor: n(e.sem_atendimento), nota: 'aguardando a 1ª resposta' }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'Aguardando 2ª resposta em diante', valor: n(e.aguardando_segunda), nota: 'o cliente escreveu de novo' }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'SLA geral — 1ª resposta', valor: slaTexto(e.sla_primeira), nota: slaNota(e.sla_primeira, periodo) }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'SLA geral — 2ª resposta em diante', valor: slaTexto(e.sla_segunda), nota: slaNota(e.sla_segunda, periodo) }),
  );

  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela esc-fila-tabela';
  const cab = tabela.createTHead().insertRow();
  for (const t of ['Agente', 'Atribuídos (em aberto)', 'Novos sem atendimento', 'Aguardando 2ª em diante', 'Respondidos hoje', `SLA 1ª resposta (${periodo})`, `SLA 2ª em diante (${periodo})`]) {
    const th = document.createElement('th'); th.textContent = t; cab.append(th);
  }
  const corpo = tabela.createTBody();
  const colunasEq = [
    { render: (a) => (a.disponivel ? a.nome : `${a.nome} (indisponível)`) },
    { classe: 'num', render: (a) => n(a.atribuidos) },
    { classe: 'num', render: (a) => n(a.sem_atendimento) },
    { classe: 'num', render: (a) => n(a.aguardando_segunda) },
    { classe: 'num', render: (a) => n(a.respondidos_hoje) },
    { classe: 'num', render: (a) => `${slaTexto(a.sla_primeira)}${a.sla_primeira.medidas ? ` (${a.sla_primeira.dentro}/${a.sla_primeira.medidas})` : ''}` },
    { classe: 'num', render: (a) => `${slaTexto(a.sla_segunda)}${a.sla_segunda.medidas ? ` (${a.sla_segunda.dentro}/${a.sla_segunda.medidas})` : ''}` },
  ];
  renderTabela(corpo, agentes, colunasEq, { vazio: 'Nenhum agente com board vinculado.' });

  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = 'Tempos em minutos de turno (seg–sex, horário de Brasília); entre parênteses, quantas respostas ficaram dentro da meta (3 h Alta, 4 h Média). O agente é o dono do board. "Hoje" = dia atual em Brasília.';
  raiz.replaceChildren(seletor, painel, tabela, nota);
}


$('sh-board-seletor').addEventListener('change', (e) => {
  boardId = e.target.value === 'todos' ? 'todos' : (Number(e.target.value) || null);
  if (boardId) localStorage.setItem('shBoardId', String(boardId));
  filaDados = null;
  if (!$('sh-subaba-fila').hidden) carregarFila();
});
for (const nome of Object.keys(SUBABAS)) $(`sh-subaba-btn-${nome}`).addEventListener('click', () => mostrarSubaba(nome));
$('aba-btn-suportehumano').addEventListener('click', () => { if (boardId) { carregarFila(); if (souGestor) carregarEquipe(); } else carregarBoards(); });

carregarBoards();
setInterval(() => {
  if (!paginaVisivel()) return;
  if (!$('sh-subaba-fila').hidden) carregarFila();
  if (!$('sh-subaba-equipe').hidden) carregarEquipe();
}, 30 * 1000);
document.addEventListener('visibilitychange', () => {
  if (paginaVisivel()) { if (!$('sh-subaba-fila').hidden) carregarFila(); if (!$('sh-subaba-equipe').hidden) carregarEquipe(); }
});
