/**
 * Suporte Humano — a fila de respostas do agente em lista e o painel da equipe (pedido da Késsia, PDF de 05/10/2026, itens 7 e 8; migrações 073–076).
 * Página própria no menu, separada do Suporte Escalado (Kanban): usa os MESMOS casos (email_ia.suporte_escalado), só que vistos pelo que está pendente de
 * resposta do agente, não pela coluna do card. O agente vê só o próprio board; administrador e gestor (papel do Suporte Escalado) veem todos.
 */
import { $, api, kpiCard, renderTabela, botaoCopiar, debounce, baixarCsv } from './emailComum.js';
import { n, dataHora } from './format.js';
import { abrirDetalheEscalado, abrirNoWebmail, ROTULO_TAG, rotuloDe, obterOpcoes } from './emailSuporteEscalado.js';

let boardId = null;          // id de um board, ou 'todos' (só admin/gestor)
let boards = [];
let souGestor = false;
let meuBoardId = null;
let boardFormAberto = null;   // null = fechado; 'novo' = criando; um id = editando aquele board
let usuariosCache = null;

/* ── período (pedido do Lucas 07/10; 3º momento da Késsia, item 9) ──
   Um só filtro, nas duas telas (Fila de respostas e Painel da equipe): Hoje, Ontem, Esta semana, Semana passada, Este mês, Mês passado ou
   Personalizado (de/até, dia inclusive, horário de Brasília). Semana = segunda a domingo. Vale para os SLAs e para os contadores das duas telas
   e fica guardado no navegador. Os atalhos viram datas (de/até) aqui no navegador; "Hoje" usa o próprio "hoje" do servidor. */
const PERIODOS_SLA = [
  { chave: 'hoje', rotulo: 'Hoje', texto: 'hoje' }, { chave: 'ontem', rotulo: 'Ontem', texto: 'ontem' },
  { chave: 'semana', rotulo: 'Esta semana', texto: 'nesta semana' }, { chave: 'semana_passada', rotulo: 'Semana passada', texto: 'na semana passada' },
  { chave: 'mes', rotulo: 'Este mês', texto: 'neste mês' }, { chave: 'mes_passado', rotulo: 'Mês passado', texto: 'no mês passado' },
];
let periodoSla = (() => {
  try {
    const salvo = JSON.parse(localStorage.getItem('shPeriodoSla') ?? 'null');
    if (salvo?.tipo === 'personalizado' && /^\d{4}-\d{2}-\d{2}$/.test(salvo.de) && /^\d{4}-\d{2}-\d{2}$/.test(salvo.ate)) return salvo;
    if (salvo?.tipo === 'preset' && PERIODOS_SLA.some((p) => p.chave === salvo.chave)) return salvo;
  } catch { /* sem armazenamento: usa o padrão */ }
  return { tipo: 'preset', chave: 'hoje' };
})();
/** Data de hoje em Brasília como Date em UTC (só a parte da data vale). */
const hojeBrasilia = () => {
  const [a, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
};
const isoDia = (d) => d.toISOString().slice(0, 10);
const somaDias = (d, k) => new Date(d.getTime() + k * 86400000);
/** { de, ate } (AAAA-MM-DD) do período escolhido; null = "hoje" (o servidor resolve). */
function intervaloPeriodo() {
  if (periodoSla.tipo === 'personalizado') return { de: periodoSla.de, ate: periodoSla.ate };
  const hoje = hojeBrasilia();
  const segunda = somaDias(hoje, -((hoje.getUTCDay() + 6) % 7));
  switch (periodoSla.chave) {
    case 'ontem': return { de: isoDia(somaDias(hoje, -1)), ate: isoDia(somaDias(hoje, -1)) };
    case 'semana': return { de: isoDia(segunda), ate: isoDia(hoje) };
    case 'semana_passada': return { de: isoDia(somaDias(segunda, -7)), ate: isoDia(somaDias(segunda, -1)) };
    case 'mes': return { de: isoDia(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1))), ate: isoDia(hoje) };
    case 'mes_passado': return { de: isoDia(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1))), ate: isoDia(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 0))) };
    default: return null;
  }
}
const paramsPeriodo = () => { const i = intervaloPeriodo(); return i ? `de=${i.de}&ate=${i.ate}` : 'dias=0'; };
const diaBR = (iso) => iso.split('-').reverse().join('/');
function rotuloPeriodo() {
  if (periodoSla.tipo === 'personalizado') return periodoSla.de === periodoSla.ate ? `em ${diaBR(periodoSla.de)}` : `de ${diaBR(periodoSla.de)} a ${diaBR(periodoSla.ate)}`;
  return PERIODOS_SLA.find((p) => p.chave === periodoSla.chave)?.texto ?? 'hoje';
}
function definirPeriodo(novo) {
  periodoSla = novo;
  try { localStorage.setItem('shPeriodoSla', JSON.stringify(novo)); } catch { /* só não lembra na próxima visita */ }
  // A tela que está aberta recarrega já; a outra recarrega quando for aberta (as duas buscam ao abrir).
  if (!$('sh-subaba-fila').hidden) carregarFila();
  if (!$('sh-subaba-equipe').hidden) carregarEquipe();
}
function seletorPeriodoSla() {
  const caixa = document.createElement('div');
  caixa.className = 'esc-fila-abas esc-periodo';
  const rot = document.createElement('span');
  rot.className = 'rodape-nota';
  rot.textContent = 'Período:';
  caixa.append(rot);
  for (const p of PERIODOS_SLA) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'subaba-btn';
    b.setAttribute('aria-selected', String(periodoSla.tipo === 'preset' && periodoSla.chave === p.chave));
    b.textContent = p.rotulo;
    b.addEventListener('click', () => definirPeriodo({ tipo: 'preset', chave: p.chave }));
    caixa.append(b);
  }
  const hojeISO = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
  const pers = document.createElement('button');
  pers.type = 'button'; pers.className = 'subaba-btn';
  pers.setAttribute('aria-selected', String(periodoSla.tipo === 'personalizado'));
  pers.textContent = 'Personalizado';
  const campos = document.createElement('span');
  campos.className = 'esc-periodo-datas';
  campos.hidden = periodoSla.tipo !== 'personalizado';
  const de = document.createElement('input'); de.type = 'date'; de.max = hojeISO; de.value = periodoSla.tipo === 'personalizado' ? periodoSla.de : hojeISO;
  const ate = document.createElement('input'); ate.type = 'date'; ate.max = hojeISO; ate.value = periodoSla.tipo === 'personalizado' ? periodoSla.ate : hojeISO;
  const aplicar = document.createElement('button');
  aplicar.type = 'button'; aplicar.className = 'btn btn-forte'; aplicar.textContent = 'Aplicar';
  const aviso = document.createElement('span'); aviso.className = 'rodape-nota';
  aplicar.addEventListener('click', () => {
    if (!de.value || !ate.value) { aviso.textContent = 'Escolha as duas datas.'; return; }
    if (de.value > ate.value) { aviso.textContent = 'A data inicial precisa ser anterior à final.'; return; }
    if ((new Date(ate.value) - new Date(de.value)) / 86400000 > 366) { aviso.textContent = 'O período vai até 366 dias.'; return; }
    definirPeriodo({ tipo: 'personalizado', de: de.value, ate: ate.value });
  });
  pers.addEventListener('click', () => { campos.hidden = false; pers.setAttribute('aria-selected', 'true'); de.focus(); });
  campos.append(rotuloDe('De', de), rotuloDe('Até', ate), aplicar, aviso);
  caixa.append(pers, campos);
  return caixa;
}

const SUBABAS = { fila: 'sh-subaba-fila', equipe: 'sh-subaba-equipe', turnos: 'sh-subaba-turnos' };
const paginaVisivel = () => !$('aba-suportehumano').hidden && !document.hidden;

function mostrarSubaba(qual) {
  for (const [nome, id] of Object.entries(SUBABAS)) {
    $(id).hidden = nome !== qual;
    $(`sh-subaba-btn-${nome}`).setAttribute('aria-selected', String(nome === qual));
  }
  localStorage.setItem('shSubaba', qual);
  if (qual === 'fila') carregarFila();
  if (qual === 'equipe') carregarEquipe();
  if (qual === 'turnos') carregarTurnos();
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
  $('sh-subaba-btn-turnos').hidden = !souGestor;
  $('sh-board-novo').hidden = !souGestor;
  $('sh-board-editar').hidden = !(souGestor && boardId && boardId !== 'todos');
}

/* ── criar / editar board (fila): mesmo formulário do Suporte Escalado — gestor é um papel só, vale nas duas páginas ── */
async function usuariosParaSelect() {
  if (usuariosCache) return usuariosCache;
  const { ok, dados } = await api('/api/suporte-escalado/usuarios');
  usuariosCache = ok ? (dados.usuarios ?? []) : [];
  return usuariosCache;
}

async function renderFormBoard() {
  const container = $('sh-board-form');
  if (!boardFormAberto) { container.hidden = true; container.replaceChildren(); return; }
  container.hidden = false;
  container.replaceChildren();
  const editando = boardFormAberto !== 'novo';
  const boardAtual = editando ? boards.find((b) => b.id === boardFormAberto) : null;
  const usuarios = await usuariosParaSelect();

  const form = document.createElement('form');
  form.className = 'esc-board-form cartao';
  const inputNome = document.createElement('input');
  inputNome.type = 'text'; inputNome.placeholder = 'Nome do board'; inputNome.maxLength = 120; inputNome.required = true;
  inputNome.value = editando ? (boardAtual?.nome ?? '') : '';
  const selectUsuario = document.createElement('select');
  const optNenhum = document.createElement('option');
  optNenhum.value = ''; optNenhum.textContent = '— sem responsável vinculado —';
  selectUsuario.append(optNenhum);
  for (const u of usuarios) {
    const opt = document.createElement('option');
    opt.value = String(u.id); opt.textContent = u.nome || u.email;
    if (editando && boardAtual?.usuario_id === u.id) opt.selected = true;
    selectUsuario.append(opt);
  }
  form.append(inputNome, selectUsuario);
  let checkAtivo;
  if (editando) {
    const labelAtivo = document.createElement('label');
    labelAtivo.className = 'esc-board-form-ativo';
    checkAtivo = document.createElement('input');
    checkAtivo.type = 'checkbox'; checkAtivo.checked = boardAtual?.ativo !== false;
    labelAtivo.append(checkAtivo, document.createTextNode(' Ativo — recebe casos novos automaticamente'));
    form.append(labelAtivo);
  }
  const acoes = document.createElement('div');
  acoes.className = 'esc-board-form-acoes';
  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'submit'; btnSalvar.className = 'btn btn-forte'; btnSalvar.textContent = editando ? 'Salvar' : 'Criar board';
  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button'; btnCancelar.className = 'btn'; btnCancelar.textContent = 'Cancelar';
  acoes.append(btnSalvar, btnCancelar);
  form.append(acoes);
  btnCancelar.addEventListener('click', () => { boardFormAberto = null; renderFormBoard(); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = inputNome.value.trim();
    if (!nome) return;
    btnSalvar.disabled = true;
    const usuarioId = selectUsuario.value ? Number(selectUsuario.value) : null;
    const { ok, dados: resp } = editando
      ? await api(`/api/suporte-escalado/boards/${boardAtual.id}`, { metodo: 'PATCH', corpo: { nome, usuario_id: usuarioId, ativo: checkAtivo.checked } })
      : await api('/api/suporte-escalado/boards', { metodo: 'POST', corpo: { nome, usuario_id: usuarioId } });
    if (!ok) { window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui salvar o board.'); btnSalvar.disabled = false; return; }
    boardFormAberto = null;
    if (!editando && resp?.id) { boardId = resp.id; localStorage.setItem('shBoardId', String(boardId)); }
    await carregarBoards();
    renderFormBoard();
  });
  container.append(form);
}

async function carregarBoards() {
  const { ok, dados } = await api('/api/suporte-escalado/boards');
  if (!ok) { boardId = null; return; }
  boards = dados.boards ?? [];
  souGestor = Boolean(dados.admin || dados.gestor_humano);
  meuBoardId = dados.meu_board_id ?? null;
  const salvoRaw = localStorage.getItem('shBoardId');
  const salvo = Number(salvoRaw);
  if (salvoRaw === 'todos' && souGestor) boardId = 'todos';
  else if (salvo && boards.some((b) => b.id === salvo)) boardId = salvo;
  else if (meuBoardId && boards.some((b) => b.id === meuBoardId)) boardId = meuBoardId;
  else if (boards.length === 1) boardId = boards[0].id;
  else boardId = souGestor ? 'todos' : null;
  renderSeletor();
  const salva = localStorage.getItem('shSubaba');
  mostrarSubaba(souGestor && SUBABAS[salva] ? salva : 'fila');
}

/* ═══════════════════  fila de respostas em lista (item 8 do PDF da Késsia)  ═══════════════════
   Para o agente não importa o status do card: importa o que está pendente de resposta dele. 3 filas: 1º e-mail pendente, 2º em
   diante pendente e todos os atribuídos. O tempo restante vem do SLA dentro do turno (GET /api/suporte-escalado/fila, migrações 073/074). */
let filaDados = null;
let filaAba = 'primeiro';
const POR_PAGINA_FILA = 100;   // a lista pode ter ~900 tickets; desenhar tudo travava a tela. O resto entra em "Mostrar mais" (filtros e busca valem para todos).
let linhasVisiveis = POR_PAGINA_FILA;
const FILAS = [
  { chave: 'primeiro', rotulo: '1º e-mail — pendente de resposta' },
  { chave: 'segundo', rotulo: '2º e-mail em diante — pendente de resposta' },
  { chave: 'todos', rotulo: 'Todos os atribuídos' },
  { chave: 'internas', rotulo: 'Pendências internas' },   // logística e ajuda pedidas por outros agentes (item 27) — fora das duas filas de resposta
];

/* ── filtros (itens 3, 4 e 13 do PDF de 07/10) ──
   Os filtros por lista suspensa e por tempo restante rodam no navegador (a fila já vem com até 1.000 casos); a busca roda no servidor
   porque procura também pelo nº do pedido do cliente. */
const FILTROS_LISTA = [
  { chave: 'tag_motivo', rotulo: 'Motivo (tag automática)', opcoes: () => Object.entries(ROTULO_TAG) },
  { chave: 'motivo_contato', rotulo: 'Motivo do contato', opcoes: (o) => o.motivo_contato },
  { chave: 'detalhamento_motivo', rotulo: 'Detalhamento do motivo', opcoes: (o) => o.detalhamento_motivo },
  { chave: 'tipo_resolucao', rotulo: 'Tipo de resolução', opcoes: (o) => o.tipo_resolucao },
  { chave: 'status_ticket', rotulo: 'Status do ticket', opcoes: (o) => o.status_ticket },
  { chave: 'motivo_reenvio', rotulo: 'Motivo do reenvio', opcoes: (o) => o.motivo_reenvio },
  { chave: 'status_logistica', rotulo: 'Status logística', opcoes: (o) => o.status_logistica },
  { chave: 'responsavel_logistica_id', rotulo: 'Responsável (logística)', opcoes: (o) => (o.equipe ?? []).map((e) => [e.id, e.nome]) },
  { chave: 'status_ajuda', rotulo: 'Status de ajuda', opcoes: (o) => o.status_ajuda },
  { chave: 'ajuda_para_id', rotulo: 'Ajuda pedida a', opcoes: (o) => (o.equipe ?? []).map((e) => [e.id, e.nome]) },
  { chave: 'quantidade_reenvio', rotulo: 'Quantidade para reenvio', opcoes: () => Array.from({ length: 30 }, (_, i) => i + 1) },
  { chave: 'percentual_reembolso', rotulo: 'Percentual do reembolso', opcoes: (o) => (o.percentual_reembolso ?? []).map((p) => [p, `${p}%`]) },
];
const VENCE_EM = [
  ['30', 'Vence em 30 minutos', (r) => r >= 0 && r <= 30],
  ['60', 'Vence em 1 hora', (r) => r > 30 && r <= 60],
  ['120', 'Vence em 2 horas', (r) => r > 60 && r <= 120],
  ['180', 'Vence em 3 horas', (r) => r > 120 && r <= 180],
  ['240', 'Vence em 4 horas', (r) => r > 180 && r <= 240],
  ['vencido', 'Vencido', (r) => r < 0],
];
let filtros = {};            // chave → valor escolhido ('' = sem filtro)
let busca = '';
let barraFiltros = null;     // montada uma vez e reaproveitada a cada renderFila (não perde o foco do campo de busca)
let selecionados = new Set();
let pendenciasInternas = [];

/** Filtros por lista suspensa vão ao servidor (acham também tickets resolvidos/fechados); só "tempo restante" roda no navegador. */
const paramsFiltros = () => Object.entries(filtros).filter(([k, v]) => v && k !== 'vence').map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
const emConsulta = () => Boolean(busca) || Object.entries(filtros).some(([k, v]) => v && k !== 'vence');

function passaFiltros(c) {
  for (const f of FILTROS_LISTA) {
    const v = filtros[f.chave];
    if (v && String(c[f.chave] ?? '') !== v) return false;
  }
  if (filtros.vence) {
    const regra = VENCE_EM.find((x) => x[0] === filtros.vence)[2];
    if (c.restante_min === null || c.restante_min === undefined || c.fila === 'outros' || !regra(c.restante_min)) return false;
  }
  return true;
}

/* ── relatório (item 21): todas as informações da ficha do ticket, exceto e-mails e notas, num período personalizado (CSV) ── */
const ROTULO_ALERTA = { chargeback: 'Chargeback', legal: 'Ameaça legal', ambos: 'Chargeback + ameaça legal' };
const dt = (v) => (v ? dataHora(v) : '');
const dia = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');
const COLUNAS_RELATORIO = [
  ['Nº do ticket', (r) => `#${r.numero}`], ['Ticket-mãe', (r) => (r.ticket_mae_id ? `#${r.ticket_mae_id}` : '')],
  ['E-mail do cliente', (r) => r.remetente_email], ['Nome', (r) => r.nome], ['Assunto', (r) => r.assunto],
  ['Agente responsável', (r) => r.agente], ['Status no Kanban', (r) => r.status_kanban],
  ['Escalado em', (r) => dt(r.criado_em)], ['Iniciado em', (r) => dt(r.iniciado_em)], ['Finalizado em', (r) => dt(r.finalizado_em)],
  ['Tag do motivo do contato', (r) => ROTULO_TAG[r.tag_motivo] || ''], ['Prioridade', (r) => (r.prioridade_nivel === 'alta' ? 'Alta' : r.prioridade_nivel === 'media' ? 'Média' : '')],
  ['Alerta', (r) => ROTULO_ALERTA[r.alerta_ameaca] || ''],
  ['Última movimentação (de)', (r) => r.movido_de], ['Última movimentação (por)', (r) => (r.movido_em ? (r.movido_por || 'Sistema') : '')], ['Última movimentação (em)', (r) => dt(r.movido_em)],
  ['Produto', (r) => r.produto], ['Plataforma', (r) => r.plataforma], ['Status do pedido', (r) => r.status_pedido], ['Data da compra', (r) => dt(r.pedido_em)],
  ['Valor do pedido', (r) => r.valor_pedido], ['Status da entrega', (r) => r.rastreio_status], ['Transportadora', (r) => r.carrier_code], ['Rastreio', (r) => r.tracking_number],
  ['Data do 1º e-mail', (r) => dt(r.primeiro_email_em)], ['Data de entrega', (r) => dia(r.data_entrega)],
  ['Mensagem da cliente — foco da reclamação', (r) => r.resumo_conversa], ['Motivo do escalonamento', (r) => r.motivo_escalonamento],
  ['Motivo do contato', (r) => r.motivo_contato], ['Detalhamento do motivo', (r) => r.detalhamento_motivo], ['Tipo de resolução', (r) => r.tipo_resolucao],
  ['% do reembolso', (r) => r.percentual_reembolso], ['Valor da compra (reembolso)', (r) => r.valor_compra_usd], ['Dedução de frascos', (r) => r.deducao_frascos_usd],
  ['Valor a reembolsar', (r) => r.valor_a_reembolsar_usd], ['Status do ticket', (r) => r.status_ticket],
  ['Virou chargeback', (r) => (r.tipo_resolucao === 'Virou chargeback' || r.chargeback_em ? 'Sim' : 'Não')], ['Virou chargeback em', (r) => dia(r.chargeback_em)],
  ['Ticket reaberto em', (r) => dt(r.ticket_reaberto_em)], ['Propriedades — última alteração por', (r) => r.propriedades_atualizado_por], ['Propriedades — última alteração em', (r) => dt(r.propriedades_atualizado_em)],
  ['Status logística', (r) => r.status_logistica], ['Motivo do reenvio', (r) => r.motivo_reenvio], ['Quantidade para reenvio', (r) => r.quantidade_reenvio],
  ['Produto a ser enviado', (r) => r.produto_reenvio], ['Observação do reenvio', (r) => r.observacao_reenvio], ['Endereço (divergência)', (r) => r.endereco_divergencia],
  ['Novo rastreio', (r) => r.novo_rastreio], ['Responsável (logística)', (r) => r.responsavel_logistica],
  ['Logística — última alteração por', (r) => r.logistica_atualizado_por], ['Logística — última alteração em', (r) => dt(r.logistica_atualizado_em)],
  ['Status de ajuda', (r) => r.status_ajuda], ['Pedidos de ajuda', (r) => r.pedidos_ajuda], ['Ajuda — última alteração por', (r) => r.ajuda_atualizado_por], ['Ajuda — última alteração em', (r) => dt(r.ajuda_atualizado_em)],
  ['1ª resposta do agente em', (r) => dt(r.primeira_resposta_agente_em)], ['Última resposta do agente em', (r) => dt(r.ultima_resposta_agente_em)],
  ['Meta de SLA (min de turno)', (r) => r.meta_min], ['Tempo da 1ª resposta (min de turno)', (r) => (r.primeira_resposta_min == null ? '' : Math.round(Number(r.primeira_resposta_min)))],
  ['SLA da 1ª resposta', (r) => r.primeira_resposta_sla], ['SLA suspenso (Pendente)', (r) => (r.pausado ? 'Sim' : 'Não')],
];

function montarRelatorio() {
  const detalhes = document.createElement('details');
  detalhes.className = 'esc-filtros-lista';
  const sum = document.createElement('summary');
  sum.textContent = 'Relatório (CSV)';
  const grade = document.createElement('div');
  grade.className = 'esc-filtros-grade';
  const hoje = new Date();
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const de = document.createElement('input'); de.type = 'date'; de.value = iso(new Date(hoje.getTime() - 29 * 86400000));
  const ate = document.createElement('input'); ate.type = 'date'; ate.value = iso(hoje);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-forte'; btn.textContent = 'Baixar relatório';
  const aviso = document.createElement('p');
  aviso.className = 'rodape-nota';
  aviso.textContent = 'Todos os tickets que chegaram no período (do board escolhido acima), com todas as informações da ficha — menos e-mails e notas.';
  btn.addEventListener('click', async () => {
    if (!boardId) { window.alert('Escolha um board.'); return; }
    if (!de.value || !ate.value || de.value > ate.value) { window.alert('Confira o período: a data inicial precisa ser anterior à final.'); return; }
    btn.disabled = true;
    const { ok, dados } = await api(`/api/suporte-escalado/relatorio?board_id=${boardId}&de=${de.value}&ate=${ate.value}`);
    btn.disabled = false;
    if (!ok) { window.alert(dados?.erro ?? dados?.detail ?? dados?.message ?? 'Não consegui gerar o relatório.'); return; }
    if (!dados.linhas.length) { window.alert('Nenhum ticket neste período.'); return; }
    baixarCsv(`tickets-suporte-humano_${de.value}_a_${ate.value}.csv`, COLUNAS_RELATORIO.map(([t]) => t), dados.linhas.map((r) => COLUNAS_RELATORIO.map(([, f]) => f(r))));
    if (dados.truncado) window.alert('O relatório foi limitado a 20.000 tickets. Reduza o período para ver o resto.');
  });
  grade.append(rotuloDe('De', de), rotuloDe('Até', ate), btn, aviso);
  detalhes.append(sum, grade);
  return detalhes;
}

async function montarBarraFiltros() {
  let opc = {};
  try { opc = await obterOpcoes(); } catch { /* sem listas: a barra mostra só a busca e o tempo */ }
  const barra = document.createElement('div');
  barra.className = 'esc-filtros';
  const campoBusca = document.createElement('input');
  campoBusca.type = 'search'; campoBusca.placeholder = 'Buscar por e-mail, nº do ticket, nº do pedido…'; campoBusca.className = 'esc-filtros-busca';
  campoBusca.addEventListener('input', debounce(() => { busca = campoBusca.value.trim(); selecionados.clear(); linhasVisiveis = POR_PAGINA_FILA; if (busca && filaAba !== 'internas') filaAba = 'todos'; carregarFila(); }, 350));
  const detalhes = document.createElement('details');
  detalhes.className = 'esc-filtros-lista';
  const sum = document.createElement('summary');
  sum.textContent = 'Filtros';
  const grade = document.createElement('div');
  grade.className = 'esc-filtros-grade';
  const atualizarTitulo = () => {
    const ativos = Object.values(filtros).filter(Boolean).length;
    sum.textContent = ativos ? `Filtros (${ativos} ativo${ativos > 1 ? 's' : ''})` : 'Filtros';
  };
  const aoMudar = (chave) => {
    atualizarTitulo(); selecionados.clear(); linhasVisiveis = POR_PAGINA_FILA;
    if (chave === 'vence') { renderFila(); return; }     // só no navegador
    if (emConsulta() && filaAba !== 'internas') filaAba = 'todos';   // filtro/busca mostram tudo (inclusive encerrados) na lista "Todos"
    carregarFila();
  };
  const campo = (chave, rotulo, itens) => {
    const sel = document.createElement('select');
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Todos'; sel.append(o0);
    for (const it of itens) {
      const [v, t] = Array.isArray(it) ? it : [it, it];
      const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.append(o);
    }
    sel.value = filtros[chave] ?? '';
    sel.addEventListener('change', () => { filtros[chave] = sel.value; aoMudar(chave); });
    return rotuloDe(rotulo, sel);
  };
  grade.append(campo('vence', 'Tempo restante para responder', VENCE_EM.map(([v, t]) => [v, t])));
  for (const f of FILTROS_LISTA) grade.append(campo(f.chave, f.rotulo, f.opcoes(opc) ?? []));
  const limpar = document.createElement('button');
  limpar.type = 'button'; limpar.className = 'btn'; limpar.textContent = 'Limpar filtros';
  limpar.addEventListener('click', () => {
    filtros = {};
    for (const sel of grade.querySelectorAll('select')) sel.value = '';
    aoMudar('*');
  });
  grade.append(limpar);
  detalhes.append(sum, grade);
  barra.append(detalhes, montarRelatorio());
  barra.campoBusca = campoBusca;   // fica na linha das abas (PDF 07/10, item 13)
  return barra;
}

function minutosTxt(min) {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

function selarSla(caso) {
  const el = document.createElement('span');
  el.className = 'esc-sla';
  if (caso.pausado) {
    el.dataset.estado = 'espera';
    el.textContent = 'SLA suspenso (Pendente)';
    el.title = 'O ticket está como Pendente: o SLA não conta até voltar para Aberto.';
    return el;
  }
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
  if (!s || s.media_min === null) return { valor: '—', nota: `sem respostas medidas ${rotuloPeriodo()}` };
  return { valor: minutosTxt(s.media_min), nota: `média ${rotuloPeriodo()} · ${s.dentro} de ${s.medidas} dentro da meta` };
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
  if (!barraFiltros) barraFiltros = await montarBarraFiltros();
  const [{ ok, dados }, pend] = await Promise.all([
    api(`/api/suporte-escalado/fila?board_id=${boardId}&${paramsPeriodo()}${busca ? `&q=${encodeURIComponent(busca)}` : ''}${paramsFiltros()}`),
    api(`/api/suporte-escalado/pendencias-internas?board_id=${boardId}`),
  ]);
  if (!ok) {
    if (!filaDados) raiz.textContent = 'Não consegui carregar a fila.';
    return;
  }
  filaDados = dados;
  pendenciasInternas = pend.ok ? (pend.dados.pendencias ?? []) : [];
  const vivos = new Set(dados.casos.map((c) => c.id));
  for (const id of [...selecionados]) if (!vivos.has(id)) selecionados.delete(id);
  renderFila();
}

/** Ranking anônimo do dia (3º momento, item 5): a posição do agente entre os colegas, só com a quantidade de e-mails respondidos — sem nomes —,
    e o SLA dele comparado com a média do time (menos tempo = melhor). */
function painelRanking(resumo) {
  const r = resumo.ranking;
  const sec = document.createElement('section');
  sec.className = 'cartao esc-dash esc-ranking';
  const h = document.createElement('h3');
  h.textContent = `Seu desempenho no time (${rotuloPeriodo()})`;
  const eu = r.barras.find((b) => b.voce);
  const resumoTxt = document.createElement('p');
  resumoTxt.className = 'rodape-nota';
  resumoTxt.textContent = r.posicao && r.total_agentes
    ? `Você está em ${r.posicao}º de ${r.total_agentes} agentes em e-mails respondidos${eu ? ` (${n(eu.respostas)})` : ''}. Os outros aparecem só pela posição.`
    : 'Você ainda não aparece no ranking deste período.';
  const ul = document.createElement('ul');
  ul.className = 'esc-barras';
  const maior = Math.max(1, ...r.barras.map((b) => b.respostas));
  for (const b of r.barras) {
    const li = document.createElement('li');
    if (b.voce) li.className = 'esc-barras-voce';
    const nome = document.createElement('span'); nome.className = 'esc-barras-nome'; nome.textContent = b.voce ? `${b.posicao}º · Você` : `${b.posicao}º`;
    const trilho = document.createElement('span'); trilho.className = 'esc-barras-trilho';
    const barra = document.createElement('span'); barra.className = 'esc-barras-barra'; barra.style.width = b.respostas ? `${Math.max(2, (b.respostas / maior) * 100)}%` : '0';   // 0 e-mails = barra vazia
    trilho.append(barra);
    const num = document.createElement('span'); num.className = 'esc-barras-num'; num.textContent = n(b.respostas);
    li.append(nome, trilho, num);
    ul.append(li);
  }
  const compara = (rotulo, meu, equipe) => {
    const li = document.createElement('li');
    li.className = 'esc-ranking-sla';
    if (meu == null || equipe == null) { li.textContent = `${rotulo}: ainda sem respostas medidas no período.`; return li; }
    const dif = meu - equipe;
    const veredito = Math.abs(dif) <= Math.max(1, equipe * 0.05) ? 'na média do time' : dif < 0 ? 'melhor que a média do time' : 'acima da média do time (mais lento)';
    li.textContent = `${rotulo}: você ${minutosTxt(meu)} · time ${minutosTxt(equipe)} → ${veredito}`;
    return li;
  };
  const sla = document.createElement('ul');
  sla.className = 'esc-ranking-lista';
  sla.append(compara('SLA 1ª resposta', resumo.sla_primeira.media_min, r.sla_equipe_primeira_min), compara('SLA 2ª em diante', resumo.sla_segunda.media_min, r.sla_equipe_segunda_min));
  sec.append(h, resumoTxt, ul, sla);
  return sec;
}

function renderFila() {
  const raiz = $('sh-subaba-fila');
  const { resumo, casos, truncado } = filaDados;
  const casosAba = (chave) => (chave === 'internas' ? pendenciasInternas : (chave === 'todos' ? casos : casos.filter((c) => c.fila === chave)).filter(passaFiltros));

  const painel = document.createElement('section');
  painel.className = 'kpis kpis--suporte';
  const sla1 = slaResumo(resumo.sla_primeira);
  const sla2 = slaResumo(resumo.sla_segunda);
  painel.append(
    kpiCard({ icone: '●', tom: 'atrasado', rotulo: 'Pendentes de 1ª resposta', valor: n(resumo.pendentes_primeira), nota: 'sem nenhuma resposta do agente', onClick: () => { filaAba = 'primeiro'; linhasVisiveis = POR_PAGINA_FILA; renderFila(); }, ativo: filaAba === 'primeiro' }),
    kpiCard({ icone: '●', tom: 'travado', rotulo: 'Pendentes de 2ª resposta em diante', valor: n(resumo.pendentes_segunda), nota: 'o cliente escreveu de novo', onClick: () => { filaAba = 'segundo'; linhasVisiveis = POR_PAGINA_FILA; renderFila(); }, ativo: filaAba === 'segundo' }),
    kpiCard({ icone: '●', tom: 'finalizado', rotulo: 'E-mails respondidos', valor: n(resumo.respondidos_hoje), nota: `${n(resumo.respondidos_tickets ?? 0)} tickets · ${rotuloPeriodo()} (1ª e 2ª resposta em diante)` }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'SLA de 1ª resposta', valor: sla1.valor, nota: sla1.nota }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'SLA de 2ª resposta em diante', valor: sla2.valor, nota: sla2.nota }),
  );

  const abas = document.createElement('div');
  abas.className = 'esc-fila-abas';
  abas.setAttribute('role', 'tablist');
  const grupoAbas = document.createElement('div');
  grupoAbas.className = 'esc-fila-abas-grupo';
  for (const f of FILAS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'subaba-btn';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(filaAba === f.chave));
    b.textContent = `${f.rotulo} (${n(casosAba(f.chave).length)})`;
    b.addEventListener('click', () => { filaAba = f.chave; linhasVisiveis = POR_PAGINA_FILA; renderFila(); });
    grupoAbas.append(b);
  }
  abas.append(grupoAbas, barraFiltros.campoBusca);

  const interna = filaAba === 'internas';
  const linhas = casosAba(filaAba);
  const podeSelecionar = souGestor && !interna;
  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela esc-fila-tabela';
  const cab = tabela.createTHead().insertRow();
  const titulos = interna
    ? ['Tipo', 'E-mail do cliente', 'Assunto', 'Pedido por', 'Para', 'O que fazer', 'Desde']
    : ['Nº', 'E-mail do cliente', 'Assunto', 'Motivo', 'Prioridade', 'Virou chargeback', 'Tempo para responder', 'Agente responsável'];
  if (podeSelecionar) {
    const th = document.createElement('th');
    const todosMarcados = linhas.length > 0 && linhas.every((c) => selecionados.has(c.id));
    const marca = document.createElement('input');
    marca.type = 'checkbox'; marca.checked = todosMarcados; marca.title = 'Marcar todos os tickets desta lista';
    marca.addEventListener('change', () => { for (const c of linhas) (marca.checked ? selecionados.add(c.id) : selecionados.delete(c.id)); renderFila(); });
    th.append(marca); cab.append(th);
  }
  for (const t of titulos) { const th = document.createElement('th'); th.textContent = t; cab.append(th); }
  const corpo = tabela.createTBody();

  const celulaEmail = (c) => {
    const d = document.createElement('div');
    const linha = document.createElement('div');
    linha.className = 'esc-fila-email';
    const txt = document.createElement('span'); txt.textContent = c.remetente_email;
    const webmail = document.createElement('button');
    webmail.type = 'button'; webmail.className = 'btn btn-icone'; webmail.textContent = '✉';
    if (c.email_id) {
      webmail.title = 'Abrir o e-mail original na caixa (Hostinger)';
      webmail.addEventListener('click', (ev) => { ev.stopPropagation(); abrirNoWebmail(c.email_id, webmail); });
    } else { webmail.disabled = true; webmail.title = 'Nenhum e-mail vinculado a este caso.'; }
    linha.append(txt, botaoCopiar(c.remetente_email, { titulo: `Copiar ${c.remetente_email}` }), webmail);
    d.append(linha);
    if (c.nome) { const s2 = document.createElement('small'); s2.textContent = c.nome; d.append(s2); }
    return d;
  };
  const colunasBase = interna
    ? [
      { render: (p) => (p.tipo === 'ajuda' ? 'Ajuda' : 'Logística') },
      { render: (p) => celulaEmail(p) },
      { classe: 'esc-fila-assunto', render: (p) => p.assunto || '—' },
      { render: (p) => p.pedido_por || '—' },
      { render: (p) => p.para_nome || '—' },
      { render: (p) => (p.tipo === 'ajuda' ? `Responder o pedido de ajuda${p.nota ? `: ${p.nota.slice(0, 80)}` : ''}` : `Logística — ${p.detalhe}${p.nota ? ` (${p.nota})` : ''}`) },
      { render: (p) => (p.desde ? dataHora(p.desde) : '—') },
    ]
    : [
      { render: (c) => `#${c.id}` },
      { render: celulaEmail },
      { classe: 'esc-fila-assunto', render: (c) => c.assunto || '—' },
      { render: (c) => `${ROTULO_TAG[c.tag_motivo] || '—'}${c.ticket_reaberto_em ? ' · 🔁 reaberto' : ''}` },
      { render: (c) => (c.prioridade_nivel === 'alta' ? 'Alta' : c.prioridade_nivel === 'media' ? 'Média' : '—') },
      { render: (c) => (c.tipo_resolucao === 'Virou chargeback' || c.chargeback_em ? `🚨 Sim${c.chargeback_em ? ` · ${dia(c.chargeback_em)}` : ''}` : '—') },
      { render: selarSla },
      { render: (c) => c.agente || '—' },
    ];
  const colunasFila = podeSelecionar
    ? [{ render: (c) => {
      const cx = document.createElement('input');
      cx.type = 'checkbox'; cx.checked = selecionados.has(c.id);
      cx.addEventListener('click', (ev) => ev.stopPropagation());
      cx.addEventListener('change', () => { (cx.checked ? selecionados.add(c.id) : selecionados.delete(c.id)); renderFila(); });
      return cx;
    } }, ...colunasBase]
    : colunasBase;
  colunasFila.aoClicarLinha = interna
    ? (p) => abrirDetalheEscalado({ ...p, id: p.caso_id, criado_em: p.caso_criado_em })
    : (c) => abrirDetalheEscalado(c);   // de outro agente abre só para leitura (a ficha vem com pode_editar = false)
  renderTabela(corpo, linhas.slice(0, linhasVisiveis), colunasFila, {
    vazio: interna ? 'Nenhuma pendência interna para este board. 🎉'
      : (Object.values(filtros).some(Boolean) || busca ? 'Nenhum ticket encontrado com estes filtros.'
        : (filaAba === 'todos' ? 'Nenhum ticket em aberto atribuído.' : 'Nada pendente de resposta nesta fila. 🎉')),
  });

  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = (filaDados.consulta && !interna ? `${busca ? 'A busca vale para todos os tickets e todos os agentes, em qualquer fila. ' : ''}Com busca ou filtro a lista inclui tickets resolvidos e fechados. ` : '') + (interna
    ? 'Pendências que outro agente pediu a este board (logística e ajuda). Ficam fora das filas de resposta ao cliente. Clique numa linha para abrir o ticket.'
    : (truncado
      ? 'Mostrando os 1.000 mais urgentes. Ordenado por tempo restante (estourados primeiro). O tempo conta só dentro do turno (seg–sex, horário de Brasília).'
      : 'Ordenado por tempo restante (estourados primeiro). O tempo conta só dentro do turno (seg–sex, horário de Brasília). Clique numa linha para abrir o ticket.'));
  const extras = [];
  if (linhas.length > linhasVisiveis) {
    const mais = document.createElement('button');
    mais.type = 'button'; mais.className = 'btn esc-fila-mais';
    mais.textContent = `Mostrar mais ${Math.min(POR_PAGINA_FILA, linhas.length - linhasVisiveis)} (exibindo ${n(linhasVisiveis)} de ${n(linhas.length)})`;
    mais.addEventListener('click', () => { linhasVisiveis += POR_PAGINA_FILA; renderFila(); });
    extras.push(mais);
  }
  // Respostas que não saíram depois de 3 tentativas (migração 087): o agente precisa saber, mesmo sem abrir o ticket.
  const avisos = [];
  if (resumo.envios_falhos > 0) {
    const av = document.createElement('p');
    av.className = 'esc-aviso-falha';
    av.textContent = `⚠ ${n(resumo.envios_falhos)} resposta${resumo.envios_falhos > 1 ? 's' : ''} não saiu${resumo.envios_falhos > 1 ? 'ram' : ''} (últimas 48 h). Abra o ticket e use "Tentar de novo".`;
    avisos.push(av);
  }
  raiz.replaceChildren(seletorPeriodoSla(), painel, ...(resumo.ranking ? [painelRanking(resumo)] : []), ...avisos, barraFiltros, abas, ...(podeSelecionar ? [barraSelecao(linhas)] : []), tabela, ...extras, nota);
}

/** Barra da seleção em massa: transferir os tickets marcados para outro agente de uma vez (item 7). */
function barraSelecao(linhasVisiveis) {
  const barra = document.createElement('div');
  barra.className = 'esc-selecao';
  const info = document.createElement('span');
  info.textContent = selecionados.size ? `${n(selecionados.size)} ticket${selecionados.size > 1 ? 's' : ''} marcado${selecionados.size > 1 ? 's' : ''}` : 'Marque tickets na lista para transferi-los em massa.';
  barra.append(info);

  const qtd = document.createElement('input');
  qtd.type = 'number'; qtd.min = '1'; qtd.max = String(linhasVisiveis.length || 1); qtd.placeholder = 'Qtd.'; qtd.className = 'esc-selecao-qtd';
  const marcarN = document.createElement('button');
  marcarN.type = 'button'; marcarN.className = 'btn'; marcarN.textContent = 'Marcar os primeiros';
  marcarN.title = 'Marca os N primeiros da lista (a ordem é a de urgência)';
  marcarN.addEventListener('click', () => {
    const k = Math.max(0, Math.min(Number(qtd.value) || 0, linhasVisiveis.length));
    if (!k) return;
    selecionados = new Set(linhasVisiveis.slice(0, k).map((c) => c.id));
    renderFila();
  });
  barra.append(qtd, marcarN);

  if (selecionados.size) {
    const destino = document.createElement('select');
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Transferir para…'; destino.append(o0);
    // Qualquer agente serve de destino, ativo ou não (decisão do Lucas, 07/10): "inativo" só quer dizer que não recebe casos novos sozinho.
    for (const b of boards.filter((x) => boardId === 'todos' || x.id !== boardId)) {
      const o = document.createElement('option'); o.value = String(b.id);
      o.textContent = `${b.nome}${b.ativo === false ? ' (inativo)' : ''}${b.usuario_id ? '' : ' (sem responsável)'}`;
      destino.append(o);
    }
    const ir = document.createElement('button');
    ir.type = 'button'; ir.className = 'btn btn-forte'; ir.textContent = 'Transferir';
    ir.addEventListener('click', async () => {
      if (!destino.value) { window.alert('Escolha para quem transferir.'); return; }
      const nome = destino.options[destino.selectedIndex].textContent;
      if (!window.confirm(`Transferir ${selecionados.size} ticket(s) para ${nome}? Eles voltam para "Pendente" no board de destino.`)) return;
      ir.disabled = true;
      const { ok, dados } = await api('/api/suporte-escalado/transferir-em-massa', { metodo: 'POST', corpo: { ids: [...selecionados], board_id: Number(destino.value) } });
      ir.disabled = false;
      if (!ok) { window.alert(dados?.erro ?? dados?.detail ?? dados?.message ?? 'Não consegui transferir.'); return; }
      selecionados.clear();
      await carregarFila();
    });
    const limpa = document.createElement('button');
    limpa.type = 'button'; limpa.className = 'btn'; limpa.textContent = 'Desmarcar';
    limpa.addEventListener('click', () => { selecionados.clear(); renderFila(); });
    barra.append(destino, ir, limpa);
  }
  return barra;
}

/* ═══════════════════  painel da equipe (item 7 do PDF da Késsia)  ═══════════════════
   10 indicadores: SLA por agente e geral (1ª e 2ª em diante), tickets novos / respondidos pelos clientes / respondidos pelos agentes no dia,
   tickets atribuídos, fila nova e aguardando 2ª em diante por agente. Só admin/gestor (GET /api/suporte-escalado/kpis-equipe). */
let equipeDados = null;
let dashDados = null;
let efetDados = null;
let efetModo = 'ranking';   // 'ranking' (por agente, do melhor ao pior) ou 'geral' (equipe toda)
let dashBoard = '';   // '' = equipe toda; id do board = só aquele agente (3º momento, item 7)
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
  const [{ ok, dados }, dash, efet] = await Promise.all([
    api(`/api/suporte-escalado/kpis-equipe?${paramsPeriodo()}`),
    api(`/api/suporte-escalado/dashboard-propriedades?${paramsPeriodo()}${dashBoard ? `&board_id=${dashBoard}` : ''}`),
    api(`/api/suporte-escalado/efetividade?${paramsPeriodo()}`),
  ]);
  if (!ok) { if (!equipeDados) raiz.textContent = 'Não consegui carregar o painel da equipe.'; return; }
  equipeDados = dados;
  dashDados = dash.ok ? dash.dados : null;
  efetDados = efet.ok ? efet.dados : null;
  renderEquipe();
}

function renderEquipe() {
  const raiz = $('sh-subaba-equipe');
  const { equipe: e, agentes } = equipeDados;
  const periodo = rotuloPeriodo();
  const seletor = seletorPeriodoSla();

  const painel = document.createElement('section');
  painel.className = 'kpis kpis--suporte';
  painel.append(
    kpiCard({ icone: '●', tom: 'finalizado', rotulo: 'Tickets novos', valor: n(e.novos_hoje), nota: `chegaram ${periodo}` }),
    kpiCard({ icone: '●', tom: 'travado', rotulo: 'Clientes que responderam', valor: n(e.clientes_responderam_hoje), nota: `tickets com novo e-mail do cliente ${periodo}` }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'E-mails respondidos pelos agentes', valor: n(e.agentes_responderam_hoje), nota: `${n(e.agentes_responderam_tickets ?? 0)} tickets · ${periodo} (1ª e 2ª resposta em diante)` }),
    kpiCard({ icone: '●', tom: 'atrasado', rotulo: 'Novos na fila, sem atendimento', valor: n(e.sem_atendimento), nota: 'aguardando a 1ª resposta' }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'Aguardando 2ª resposta em diante', valor: n(e.aguardando_segunda), nota: 'o cliente escreveu de novo' }),
    kpiCard({ icone: '●', tom: 'em_dia', rotulo: 'SLA geral — 1ª resposta', valor: slaTexto(e.sla_primeira), nota: slaNota(e.sla_primeira, periodo) }),
    kpiCard({ icone: '●', tom: 'processando', rotulo: 'SLA geral — 2ª resposta em diante', valor: slaTexto(e.sla_segunda), nota: slaNota(e.sla_segunda, periodo) }),
  );

  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela esc-fila-tabela';
  const cab = tabela.createTHead().insertRow();
  for (const t of ['Agente', 'Atribuídos (em aberto)', 'Novos sem atendimento', 'Aguardando 2ª em diante', 'E-mails respondidos (tickets)', `SLA 1ª resposta (${periodo})`, `SLA 2ª em diante (${periodo})`]) {
    const th = document.createElement('th'); th.textContent = t; cab.append(th);
  }
  const corpo = tabela.createTBody();
  const colunasEq = [
    { render: (a) => (a.disponivel ? a.nome : `${a.nome} (indisponível)`) },
    { classe: 'num', render: (a) => n(a.atribuidos) },
    { classe: 'num', render: (a) => n(a.sem_atendimento) },
    { classe: 'num', render: (a) => n(a.aguardando_segunda) },
    { classe: 'num', render: (a) => `${n(a.respondidos_hoje)} (${n(a.respondidos_tickets ?? 0)})` },
    { classe: 'num', render: (a) => `${slaTexto(a.sla_primeira)}${a.sla_primeira.medidas ? ` (${a.sla_primeira.dentro}/${a.sla_primeira.medidas})` : ''}` },
    { classe: 'num', render: (a) => `${slaTexto(a.sla_segunda)}${a.sla_segunda.medidas ? ` (${a.sla_segunda.dentro}/${a.sla_segunda.medidas})` : ''}` },
  ];
  renderTabela(corpo, agentes, colunasEq, { vazio: 'Nenhum agente com board vinculado.' });

  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = 'Tempos em minutos de turno (seg–sex, horário de Brasília); entre parênteses, quantas respostas ficaram dentro da meta (3 h Alta, 4 h Média). O agente é o dono do board. Os contadores de e-mails, tickets novos e respostas seguem o período escolhido acima (dias em horário de Brasília; semana de segunda a domingo); as filas (sem atendimento, 2ª em diante, atribuídos) são o retrato de agora.';
  const escolha = document.createElement('div');
  escolha.className = 'esc-fila-abas';
  const sel = document.createElement('select');
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Equipe toda'; sel.append(o0);
  for (const a of agentes) { const o = document.createElement('option'); o.value = String(a.board_id); o.textContent = a.nome; sel.append(o); }
  sel.value = dashBoard;
  sel.addEventListener('change', () => { dashBoard = sel.value; carregarEquipe(); });
  escolha.append(rotuloDe('Dashboards de Propriedades — ver', sel));
  raiz.replaceChildren(seletor, painel, tabela, nota, painelEfetividade(), escolha, ...dashboardsPropriedades());
}

/* ── efetividade dos agentes na reversão (3º momento, item 12) ──
   Só tickets que entraram como Reembolso ou Chargeback; resultado = Tipo de resolução da ficha. Ranking do melhor ao pior (maior % de reversão total)
   ou visão geral da equipe. O que não tem desfecho definitivo aparece em "Sem classificação definitiva" (quantidade e %), com o detalhe ao lado. */
function painelEfetividade() {
  const sec = document.createElement('section');
  sec.className = 'cartao esc-dash';
  const h = document.createElement('h3'); h.textContent = `Efetividade na reversão de Reembolso e Chargeback (${rotuloPeriodo()})`;
  sec.append(h);
  if (!efetDados) { const p = document.createElement('p'); p.className = 'vazio-suave'; p.textContent = 'Não consegui carregar a efetividade.'; sec.append(p); return sec; }
  const sel = document.createElement('select');
  for (const [v, t] of [['ranking', 'Ranking por agente (melhor → pior)'], ['geral', 'Geral (equipe toda)']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
  sel.value = efetModo;
  sel.addEventListener('change', () => { efetModo = sel.value; renderEquipe(); });
  sec.append(rotuloDe('Ver', sel));
  const fmt = (i) => `${n(i.n)} · ${String(i.pct).replace('.', ',')}%`;
  const semTxt = (a) => `${fmt(a.sem_classificacao)}`;
  const detalheSem = (a) => a.sem_classificacao.detalhe.filter((d) => d.n).map((d) => `${d.rotulo}: ${n(d.n)} (${String(d.pct).replace('.', ',')}%)`).join(' · ') || '—';
  if (efetModo === 'geral') {
    const e = efetDados.equipe;
    if (!e.total) { const p = document.createElement('p'); p.className = 'vazio-suave'; p.textContent = 'Nenhum ticket de Reembolso ou Chargeback no período.'; sec.append(p); return sec; }
    sec.append(barras('Equipe toda', [...e.itens, { rotulo: 'Sem classificação definitiva', n: e.sem_classificacao.n, pct: e.sem_classificacao.pct }].map((i) => ({ valor: i.rotulo, n: i.n, pct: i.pct })), e.total));
    const det = document.createElement('p'); det.className = 'rodape-nota'; det.textContent = `Sem classificação definitiva — ${detalheSem(e)}`; sec.append(det);
    return sec;
  }
  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela';
  const cab = tabela.createTHead().insertRow();
  ['#', 'Agente', 'Tickets (Reemb. + Charge.)', ...efetDados.equipe.itens.map((i) => i.rotulo), 'Sem classificação definitiva'].forEach((t, i) => { const th = document.createElement('th'); th.textContent = t; if (i > 1) th.style.textAlign = 'right'; cab.append(th); });
  const corpo = tabela.createTBody();
  const colunas = [
    { render: (a) => `${a.posicao}º` }, { render: (a) => a.agente },
    { classe: 'num', render: (a) => n(a.total) },
    ...efetDados.equipe.itens.map((_, k) => ({ classe: 'num', render: (a) => fmt(a.itens[k]) })),
    { classe: 'num', render: (a) => { const sp = document.createElement('span'); sp.textContent = semTxt(a); sp.title = detalheSem(a); return sp; } },
  ];
  renderTabela(corpo, efetDados.agentes, colunas, { vazio: 'Nenhum ticket de Reembolso ou Chargeback no período.' });
  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = 'Conta só tickets que entraram como Reembolso ou Chargeback (tag automática ou motivo do contato), criados no período; % sobre o total de cada agente. Ordem: maior % de reversão total primeiro. Passe o mouse em "Sem classificação definitiva" para ver o detalhe (não preenchido, verificando, cliente não retornou, não respondido/autorizado pelo líder).';
  sec.append(tabela, nota);
  return sec;
}

/* ── dashboards de Propriedades (itens 22 e 23): quantidade e % por tag de motivo × status e por campo de Propriedades ──
   Barras de uma cor só (magnitude), com o valor e o percentual escritos ao lado: o número está sempre à vista, não depende da cor. */
const ROTULO_STATUS_VAZIO = { sem_tag: 'Sem tag' };

function barras(titulo, itens, total) {
  const sec = document.createElement('section');
  sec.className = 'cartao esc-dash';
  const h = document.createElement('h3');
  h.textContent = titulo;
  const ul = document.createElement('ul');
  ul.className = 'esc-barras';
  const maior = Math.max(1, ...itens.map((i) => i.n));
  for (const i of itens) {
    const li = document.createElement('li');
    const nome = document.createElement('span'); nome.className = 'esc-barras-nome'; nome.textContent = i.valor; nome.title = i.valor;
    const trilho = document.createElement('span'); trilho.className = 'esc-barras-trilho';
    const barra = document.createElement('span'); barra.className = 'esc-barras-barra'; barra.style.width = `${Math.max(2, (i.n / maior) * 100)}%`;
    trilho.append(barra);
    const num = document.createElement('span'); num.className = 'esc-barras-num'; num.textContent = `${n(i.n)} · ${String(i.pct).replace('.', ',')}%`;
    li.append(nome, trilho, num);
    ul.append(li);
  }
  const rodape = document.createElement('p');
  rodape.className = 'rodape-nota';
  rodape.textContent = `Total no período: ${n(total)} tickets${dashBoard ? ' do agente escolhido' : ''}.`;
  sec.append(h, ul, rodape);
  return sec;
}

function dashboardsPropriedades() {
  if (!dashDados) return [];
  const d = dashDados;
  if (!d.total) { const p = document.createElement('p'); p.className = 'vazio-suave'; p.textContent = 'Nenhum ticket no período para os dashboards de Propriedades.'; return [p]; }
  const pct = (v, t) => (t ? `${Math.round((v / t) * 1000) / 10}`.replace('.', ',') : '0') + '%';

  // tag do motivo × status do ticket (quantidade e % do total da tag)
  const sec = document.createElement('section');
  sec.className = 'cartao esc-dash';
  const h = document.createElement('h3'); h.textContent = 'Tickets por tag do motivo do contato e status';
  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela';
  const cab = tabela.createTHead().insertRow();
  ['Tag do motivo', ...d.status_ordem, 'Total'].forEach((t, i) => { const th = document.createElement('th'); th.textContent = t; if (i > 0) th.style.textAlign = 'right'; cab.append(th); });
  const corpo = tabela.createTBody();
  const linhas = d.por_tag;
  const colunas = [
    { render: (l) => `${ROTULO_TAG[l.tag] || ROTULO_STATUS_VAZIO[l.tag] || l.tag}` },
    ...d.status_ordem.map((st) => ({ classe: 'num', render: (l) => `${n(l.status[st] ?? 0)} (${pct(l.status[st] ?? 0, l.total)})` })),
    { classe: 'num', render: (l) => `${n(l.total)} (${pct(l.total, d.total)})` },
  ];
  renderTabela(corpo, linhas, colunas, { vazio: 'Sem tickets.' });
  const nota = document.createElement('p');
  nota.className = 'rodape-nota';
  nota.textContent = 'Em cada status: quantidade e % do total daquela tag. Na última coluna: % do total do período. Ticket sem status na ficha conta como Aberto; tickets mesclados (filhos) não entram.';
  sec.append(h, tabela, nota);

  const p = d.propriedades;
  return [
    sec,
    barras('Motivo do contato', p.motivo_contato, d.total),
    barras('Detalhamento do motivo do contato', p.detalhamento_motivo, d.total),
    barras('Tipo de resolução', p.tipo_resolucao, d.total),
    barras('Status do ticket', p.status_ticket, d.total),
  ];
}


async function carregarTurnos() {
  const raiz = $('sh-subaba-turnos');
  if (!souGestor) {
    raiz.replaceChildren();
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Só administradores e gestores veem e alteram turnos e disponibilidade.';
    raiz.append(p);
    return;
  }
  const { ok, dados } = await api('/api/suporte-escalado/turnos');
  if (!ok) { raiz.textContent = 'Não consegui carregar os turnos.'; return; }
  renderTurnos(raiz, dados);
}

function renderTurnos(raiz, dados) {
  raiz.replaceChildren();
  const trocar = (novo) => renderTurnos(raiz, novo);
  const erro = (r) => window.alert(r?.erro ?? r?.detail ?? 'Não consegui salvar.');

  const cartao = document.createElement('section');
  cartao.className = 'cartao';
  const titulo = document.createElement('h2');
  titulo.textContent = 'Turnos e disponibilidade';
  const sub = document.createElement('p');
  sub.className = 'cartao-sub';
  sub.textContent = 'Horário de Brasília, segunda a sexta. "Disponível" define quem recebe cards novos (a qualquer hora); o turno define quando o SLA de cada pessoa conta.';
  cartao.append(titulo, sub);

  const tabela = document.createElement('table');
  tabela.className = 'sup-tabela esc-turnos-tabela';
  const cab = tabela.createTHead().insertRow();
  const th = (t) => { const c = document.createElement('th'); c.textContent = t; cab.append(c); };
  th('Agente'); th('Disponível');
  for (const t of dados.turnos) th(`${t.nome} (${t.inicio}–${t.fim})`);
  const corpo = tabela.createTBody();
  for (const ag of dados.agentes) {
    const tr = corpo.insertRow();
    tr.insertCell().textContent = ag.nome;
    const cDisp = tr.insertCell();
    const disp = document.createElement('input');
    disp.type = 'checkbox'; disp.checked = ag.disponivel; disp.title = 'Recebe cards novos';
    disp.addEventListener('change', async () => {
      disp.disabled = true;
      const { ok, dados: r } = await api(`/api/suporte-escalado/boards/${ag.board_id}`, { metodo: 'PATCH', corpo: { ativo: disp.checked } });
      if (!ok) { disp.checked = !disp.checked; disp.disabled = false; erro(r); return; }
      await carregarBoards();
      carregarTurnos();
    });
    cDisp.append(disp);
    for (const t of dados.turnos) {
      const c = tr.insertCell();
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = t.board_ids.includes(ag.board_id);
      cb.dataset.turno = String(t.id); cb.dataset.board = String(ag.board_id);
      cb.addEventListener('change', async () => {
        const ids = [...tabela.querySelectorAll(`input[data-turno="${t.id}"]:checked`)].map((x) => Number(x.dataset.board));
        cb.disabled = true;
        const { ok, dados: r } = await api(`/api/suporte-escalado/turnos/${t.id}/agentes`, { metodo: 'PUT', corpo: { board_ids: ids } });
        if (!ok) { cb.checked = !cb.checked; cb.disabled = false; erro(r); return; }
        trocar(r);
      });
      c.append(cb);
    }
  }
  if (!dados.agentes.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio-suave';
    vazio.textContent = 'Nenhum board com pessoa vinculada.';
    cartao.append(vazio);
  } else cartao.append(tabela);

  const grupos = document.createElement('div');
  grupos.className = 'esc-ficha-bloco';
  const tg = document.createElement('h3');
  tg.textContent = 'Grupos de turno';
  grupos.append(tg);
  const formGrupo = (t) => {
    const f = document.createElement('form');
    f.className = 'esc-ficha-form';
    const nome = document.createElement('input'); nome.type = 'text'; nome.maxLength = 60; nome.required = true; nome.value = t?.nome ?? '';
    const ini = document.createElement('input'); ini.type = 'time'; ini.required = true; ini.value = t?.inicio ?? '';
    const fim = document.createElement('input'); fim.type = 'time'; fim.required = true; fim.value = t?.fim ?? '';
    const salvar = document.createElement('button'); salvar.type = 'submit'; salvar.className = 'btn btn-forte'; salvar.textContent = t ? 'Salvar' : 'Criar turno';
    f.append(rotuloDe('Nome', nome), rotuloDe('Início', ini), rotuloDe('Fim', fim), salvar);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (fim.value <= ini.value) { window.alert('O fim do turno precisa ser depois do início.'); return; }
      salvar.disabled = true;
      const corpo = { nome: nome.value.trim(), inicio: ini.value, fim: fim.value };
      const { ok, dados: r } = t
        ? await api(`/api/suporte-escalado/turnos/${t.id}`, { metodo: 'PUT', corpo })
        : await api('/api/suporte-escalado/turnos', { metodo: 'POST', corpo });
      salvar.disabled = false;
      if (!ok) { erro(r); return; }
      trocar(r);
    });
    if (t) {
      const apagar = document.createElement('button');
      apagar.type = 'button'; apagar.className = 'btn btn-fantasma'; apagar.textContent = 'Apagar';
      apagar.addEventListener('click', async () => {
        if (!window.confirm(`Apagar o turno "${t.nome}"? As pessoas dele ficam sem esse turno.`)) return;
        const { ok, dados: r } = await api(`/api/suporte-escalado/turnos/${t.id}`, { metodo: 'DELETE' });
        if (!ok) { erro(r); return; }
        trocar(r);
      });
      f.append(apagar);
    }
    return f;
  };
  for (const t of dados.turnos) grupos.append(formGrupo(t));
  const novoTitulo = document.createElement('h3');
  novoTitulo.textContent = 'Novo turno';
  grupos.append(novoTitulo, formGrupo(null));
  cartao.append(grupos);
  raiz.append(cartao);
}


$('sh-board-novo').addEventListener('click', () => { boardFormAberto = 'novo'; renderFormBoard(); });
$('sh-board-editar').addEventListener('click', () => { if (boardId && boardId !== 'todos') { boardFormAberto = boardId; renderFormBoard(); } });
$('sh-board-seletor').addEventListener('change', (e) => {
  boardId = e.target.value === 'todos' ? 'todos' : (Number(e.target.value) || null);
  if (boardId) localStorage.setItem('shBoardId', String(boardId));
  filaDados = null;
  boardFormAberto = null;
  renderSeletor();
  renderFormBoard();
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
document.addEventListener('escalado:ficha-salva', () => { if (!$('sh-subaba-fila').hidden) carregarFila(); if (!$('sh-subaba-equipe').hidden) carregarEquipe(); });
document.addEventListener('visibilitychange', () => {
  if (paginaVisivel()) {
    if (!$('sh-subaba-fila').hidden) carregarFila(); if (!$('sh-subaba-equipe').hidden) carregarEquipe(); }
});
