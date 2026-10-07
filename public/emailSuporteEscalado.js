/**
 * Central de E-mail IA — Tela 5: Suporte Escalado (kanban). Casos que a IA
 * tirou de si — ela nunca mais responde este remetente sozinha até alguém
 * clicar "reativar". Atualiza sozinha a cada 25 segundos, mesmo com a aba
 * escondida (mesmo padrão do resto do painel — ver comentário em suporte.js).
 *
 * Sem filtro de produto/loja/período (a tabela não tem essas colunas) — como
 * o Chat com IA, fica fora de ABAS_COM_FILTRO em emailFiltro.js.
 */
import {
  $, api, debounce, kpiCard, paginar, montarPaginacao, botaoCopiar, abrirFicha,
  tooltip, renderTabela, rotularPlataforma,
} from './emailComum.js';
import { n, relativo, dataHora, duracaoH } from './format.js';
import { desenharColunas } from './charts.js';
import { abrirNaTabela } from './emailTickets.js';
import { abrirModalEmails, itensDaConversa, carregarConversaDoCliente } from './emailDetalhes.js';
import { carregarFormularios } from './formulariosEscalado.js';

/* ═══════════════════════════════  estado  ═══════════════════════════════ */

let itens = [];
// Assinatura da última resposta desenhada: na atualização periódica, se nada mudou não redesenha nada.
let ultimaAssinatura = null;
let kpis = {};
/**
 * Colunas do kanban — vêm do servidor (email_ia.suporte_escalado_colunas),
 * não são mais fixas no código: o usuário cria, renomeia e apaga colunas
 * pela própria tela (ver criarColuna/renomearColuna/apagarColuna abaixo).
 * Cada item: { id, chave, rotulo, descricao, ordem } — `chave` é o que vale
 * como `status` de um caso e nunca muda depois de criada; só `rotulo`/
 * `descricao` (o nome e o "pra que serve" exibidos na tela) são editáveis.
 */
let colunas = [];
let transicoes = [];
let movimentosDiarios = [];
let resumoMovimentos = {};
let busca = '';
let plataforma = ''; // '' (todas) | 'direto' | 'digistore24' | 'jvzoo' | 'buygoods' | ...
let ordem = 'recentes'; // 'recentes' | 'antigos'
/** true quando um carregarDados() foi adiado por a sub-aba "Respostas dos
 *  formulários" estar visível — /api/suporte-escalado?board_id=todos chega
 *  a 2,5 MB, e baixar+parsear+redesenhar isso (Kanban inteiro) toda vez que
 *  o filtro de board/plataforma muda travava a tela mesmo estando na aba de
 *  Formulários, que não usa nada disso. Ver formulariosVisivel() abaixo. */
let dadosPendentes = false;
const expandidos = new Set();
let arrastandoId = null;
const POR_PAGINA_COLUNA = 8;
/** 1 página por coluna, independentes entre si — status → nº da página atual. */
const paginaColuna = new Map();
/** Estado do formulário "+ Nova coluna" — precisa sobreviver ao renderBoard()
 *  automático (a tela recarrega os dados a cada 25s, ver carregarDados no fim
 *  do arquivo); sem isso o formulário fechava e o que a pessoa tinha digitado
 *  sumia no meio da digitação. */
let novaColunaAberta = false;
let novaColunaRascunho = { rotulo: '', descricao: '' };
/** Mesma ideia para o formulário de renomear uma coluna existente. */
let colunaEditandoId = null;
let colunaEditandoRascunho = { rotulo: '', descricao: '' };

/* ═══════════════════════════════  boards  ═══════════════════════════════
 * Cada responsável tem seu próprio kanban (02/09/2026). `boardId` é QUAL
 * board está sendo exibido agora — nada carrega sem ele (ver carregarDados).
 * `boards` vem de GET /api/suporte-escalado/boards: administrador recebe
 * TODOS os boards (+ quantos casos ficaram "órfãos", sem board, quando o
 * roteamento automático não achou ninguém elegível); quem não é
 * administrador só recebe o próprio (lista vazia se ainda não tiver um
 * vinculado). `admin` vem nessa mesma resposta — não precisa descobrir por
 * outro caminho. */
/** `boardId` é o id de um board, OU o literal 'todos' — a visão geral,
 *  admin-only, que agrega TODOS os boards (sem drag-and-drop: cada board
 *  tem suas próprias colunas, não dá pra misturar num board só; ver
 *  renderVisaoGeral). */
let boardId = null;
let boards = [];
let souAdmin = false;
let souGestor = false;   // administrador OU gestor do Suporte Escalado (papel por página): vê todos os boards, transfere casos e edita turnos
let meuBoardId = null;
let orfaos = 0;
/** Resumo por board (dono, pendentes, total) — só preenchido quando
 *  `boardId === 'todos'`; é o que renderVisaoGeral() usa no lugar do
 *  drag-and-drop de sempre. */
let boardsResumo = null;
/** null = formulário fechado; 'novo' = criando; um id = editando aquele board. */
let boardFormAberto = null;
/** Lista de usuários pro <select> de vincular — carregada uma vez (admin ou gestor),
 *  cacheada porque não muda durante a sessão do jeito que os boards mudam. */
let usuariosCache = null;

async function usuariosParaSelect() {
  if (usuariosCache) return usuariosCache;
  const { ok, dados } = await api('/api/suporte-escalado/usuarios');
  usuariosCache = ok ? (dados.usuarios ?? []) : [];
  return usuariosCache;
}

function renderControlesBoard() {
  const campoSel = $('esc-board-campo');
  const sel = $('esc-board-seletor');
  const btnNovo = $('esc-board-novo');
  const btnEditar = $('esc-board-editar');
  const avisoOrfaos = $('esc-orfaos-aviso');

  sel.replaceChildren();
  if (souGestor) {
    const optGeral = document.createElement('option');
    optGeral.value = 'todos';
    optGeral.textContent = '▣ Visão geral (todos os boards)';
    if (boardId === 'todos') optGeral.selected = true;
    sel.append(optGeral);
  }
  for (const b of boards) {
    const opt = document.createElement('option');
    opt.value = String(b.id);
    opt.textContent = b.nome + (b.ativo === false ? ' (inativo)' : '');
    if (b.id === boardId) opt.selected = true;
    sel.append(opt);
  }
  // Usuário comum com um só board nunca precisa escolher; admin sempre pode
  // trocar (mesmo com 1 board só, pra já deixar o controle no lugar quando
  // criar o segundo, e pra sempre poder chegar na visão geral).
  campoSel.hidden = !(souGestor || boards.length > 1);

  btnNovo.hidden = !souGestor;
  btnEditar.hidden = !(souGestor && boardId && boardId !== 'todos');

  if (souGestor && orfaos > 0) {
    avisoOrfaos.hidden = false;
    avisoOrfaos.textContent = `⚠ ${n(orfaos)} caso${orfaos === 1 ? '' : 's'} escalado${orfaos === 1 ? '' : 's'} `
      + 'sem board (nenhum responsável ativo elegível no momento em que o roteamento automático rodou).';
  } else {
    avisoOrfaos.hidden = true;
  }
}

async function renderFormBoard() {
  const container = $('esc-board-form');
  if (!boardFormAberto) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  container.replaceChildren();

  const editando = boardFormAberto !== 'novo';
  const boardAtual = editando ? boards.find((b) => b.id === boardFormAberto) : null;
  const usuarios = await usuariosParaSelect();

  const form = document.createElement('form');
  form.className = 'esc-board-form cartao';

  const inputNome = document.createElement('input');
  inputNome.type = 'text';
  inputNome.placeholder = 'Nome do board';
  inputNome.maxLength = 120;
  inputNome.required = true;
  inputNome.value = editando ? (boardAtual?.nome ?? '') : '';

  const selectUsuario = document.createElement('select');
  const optNenhum = document.createElement('option');
  optNenhum.value = '';
  optNenhum.textContent = '— sem responsável vinculado —';
  selectUsuario.append(optNenhum);
  for (const u of usuarios) {
    const opt = document.createElement('option');
    opt.value = String(u.id);
    opt.textContent = u.nome || u.email;
    if (editando && boardAtual?.usuario_id === u.id) opt.selected = true;
    selectUsuario.append(opt);
  }

  form.append(inputNome, selectUsuario);

  let checkAtivo;
  if (editando) {
    const labelAtivo = document.createElement('label');
    labelAtivo.className = 'esc-board-form-ativo';
    checkAtivo = document.createElement('input');
    checkAtivo.type = 'checkbox';
    checkAtivo.checked = boardAtual?.ativo !== false;
    labelAtivo.append(checkAtivo, document.createTextNode(' Ativo — recebe casos novos automaticamente'));
    form.append(labelAtivo);
  }

  const acoes = document.createElement('div');
  acoes.className = 'esc-board-form-acoes';
  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'submit';
  btnSalvar.className = 'btn btn-forte';
  btnSalvar.textContent = editando ? 'Salvar' : 'Criar board';
  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button';
  btnCancelar.className = 'btn';
  btnCancelar.textContent = 'Cancelar';
  acoes.append(btnSalvar, btnCancelar);
  form.append(acoes);

  btnCancelar.addEventListener('click', () => { boardFormAberto = null; renderFormBoard(); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = inputNome.value.trim();
    if (!nome) return;
    btnSalvar.disabled = true;
    const usuarioId = selectUsuario.value ? Number(selectUsuario.value) : null;
    const ok = editando
      ? await editarBoard(boardAtual.id, { nome, usuario_id: usuarioId, ativo: checkAtivo.checked })
      : await criarBoard(nome, usuarioId);
    if (!ok) btnSalvar.disabled = false;
  });

  container.append(form);
}

async function criarBoard(nome, usuarioId) {
  const { ok, dados: resp } = await api('/api/suporte-escalado/boards', {
    metodo: 'POST', corpo: { nome, usuario_id: usuarioId },
  });
  if (!ok) {
    window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui criar o board.');
    return false;
  }
  boardFormAberto = null;
  boardId = resp.id;
  localStorage.setItem('escBoardId', String(boardId));
  await carregarBoards();
  return true;
}

async function editarBoard(id, corpo) {
  const { ok, dados: resp } = await api(`/api/suporte-escalado/boards/${id}`, {
    metodo: 'PATCH', corpo,
  });
  if (!ok) {
    window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui salvar o board.');
    return false;
  }
  boardFormAberto = null;
  await carregarBoards();
  return true;
}

/** Escolhe qual board mostrar: o salvo em localStorage se ainda existir e a
 *  pessoa puder vê-lo, senão o único que ela tem — senão nenhum (força
 *  escolher, ou mostra o aviso de "ainda sem board"). */
function formulariosVisivel() {
  return !$('esc-subaba-formularios').hidden;
}

/** Mesma coisa que carregarDados(), mas adia a chamada (2,5 MB de payload
 *  do Kanban) se a sub-aba visível agora é "Respostas dos formulários" —
 *  ela não usa nada disso. mostrarSubaba() dispara o carregarDados() real
 *  assim que a pessoa volta pro Kanban/Métricas. */
async function carregarDadosSeVisivel(opcoes) {
  if (formulariosVisivel()) { dadosPendentes = true; return; }
  await carregarDados(opcoes);
}

async function carregarBoards() {
  const { ok, dados } = await api('/api/suporte-escalado/boards');
  if (!ok) {
    boards = [];
    souAdmin = false;
    souGestor = false;
    orfaos = 0;
    boardId = null;
    renderControlesBoard();
    await carregarDadosSeVisivel();
    if (!$('esc-subaba-formularios').hidden) carregarFormularios(boardId);
    return;
  }
  boards = dados.boards ?? [];
  souAdmin = Boolean(dados.admin);
  souGestor = Boolean(dados.admin || dados.gestor);
  meuBoardId = dados.meu_board_id ?? null;
  orfaos = dados.orfaos ?? 0;

  const salvoRaw = localStorage.getItem('escBoardId');
  if (salvoRaw === 'todos' && souGestor) {
    boardId = 'todos';
  } else {
    const salvo = Number(salvoRaw);
    if (salvo && boards.some((b) => b.id === salvo)) {
      boardId = salvo;
    } else if (boards.length === 1) {
      boardId = boards[0].id;
    } else if (souGestor && meuBoardId && boards.some((b) => b.id === meuBoardId)) {
      boardId = meuBoardId;   // gestor com board próprio abre nele; os demais ficam no seletor
    } else {
      boardId = null;
    }
  }
  if (boardId) localStorage.setItem('escBoardId', String(boardId));

  renderControlesBoard();
  await renderFormBoard();
  await carregarDadosSeVisivel();
  // Se a página abriu direto na sub-aba "Respostas dos formulários"
  // (`escSubaba` salvo), a chamada em mostrarSubaba() lá embaixo aconteceu
  // ANTES do board ser resolvido (esta função é assíncrona) — sem isto, o
  // primeiro carregamento sairia sem filtro nenhum de board.
  if (!$('esc-subaba-formularios').hidden) carregarFormularios(boardId);
}

/** Cicla pela mesma paleta de 6 tons que o resto do painel já usa (--st-*)
 *  — como as colunas agora são livres, não dá mais para curar uma cor com
 *  significado fixo por coluna (ex.: vermelho pro travado). */
const TONS_COLUNA = ['travado', 'atrasado', 'em_dia', 'processando', 'finalizado', 'cancelado'];
const tomColuna = (indice) => TONS_COLUNA[indice % TONS_COLUNA.length];

/* ═══════════════════════════  sub-páginas  ═══════════════════════════════
   Kanban e Tempo no kanban são duas telas grandes disputando espaço na
   mesma aba — a de métricas ficava sempre embaixo do board, exigindo rolar
   bastante pra achar. Viram sub-páginas com pílulas de alternância (mesmo
   desenho do filtro da galeria), lembrando a última escolhida como as abas
   principais já fazem. Os dados continuam chegando a cada recarga (25s)
   mesmo com a sub-página escondida — só os GRÁFICOS (desenharColunas, em
   charts.js) precisam ser refeitos ao aparecer: eles medem a largura real
   do container (`container.clientWidth`) pra desenhar o SVG do tamanho
   certo, e um container com `hidden` (display:none) mede 0 — o código do
   gráfico cai num fallback de 640px que não cabe numa tela estreita.
   Redesenhar no momento em que a sub-página fica visível corrige isso: a
   essa altura o container já tem largura real pra medir. */
const SUBABAS = { kanban: 'esc-subaba-kanban', metricas: 'esc-subaba-metricas', formularios: 'esc-subaba-formularios' };

function mostrarSubaba(qual) {
  for (const [nome, id] of Object.entries(SUBABAS)) {
    $(id).hidden = nome !== qual;
    $(`esc-subaba-btn-${nome}`).setAttribute('aria-selected', String(nome === qual));
  }
  localStorage.setItem('escSubaba', qual);
  if (qual === 'metricas') renderGraficosTempo();
  if (qual === 'formularios') carregarFormularios(boardId);
  if (qual !== 'formularios' && dadosPendentes) { dadosPendentes = false; carregarDados(); }
}

for (const nome of Object.keys(SUBABAS)) {
  $(`esc-subaba-btn-${nome}`).addEventListener('click', () => mostrarSubaba(nome));
}
mostrarSubaba(SUBABAS[localStorage.getItem('escSubaba')] ? localStorage.getItem('escSubaba') : 'kanban');

/* ═══════════════════════════════  KPIs  ═══════════════════════════════ */

function renderKpis() {
  $('esc-kpis').replaceChildren(
    ...colunas.map((c, i) => kpiCard({
      icone: '●', tom: tomColuna(i), rotulo: c.rotulo, valor: n(kpis[c.chave] ?? 0), nota: c.descricao ?? '',
    })),
  );
}

/* ═══════════════════════  métricas de tempo (§ pedido do usuário)  ═══════════════
   Duas fontes: (1) client-side, a partir de `itens` — que já vem inteiro (sem
   paginação) a cada carga — pros tempos que os 3 timestamps existentes já dão
   pra calcular sem ambiguidade (até sair de Pendente; total do fluxo); (2) o
   servidor, que devolve `transicoes`/`movimentos_diarios` calculados sobre
   email_ia.suporte_escalado_historico (tabela+trigger novos, 27/08/2026) —
   só essa registra CADA mudança de status, então só ela sabe separar
   Iniciado de Esperando resposta de verdade (os timestamps antigos só dizem
   "saiu de pendente" e "chegou a finalizado", não o caminho no meio). */

function mediana(valores) {
  if (!valores.length) return null;
  const s = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2;
}

const horasEntre = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

const rotularStatus = (s) => (s === null ? 'criado' : (colunas.find((c) => c.chave === s)?.rotulo ?? s));

function renderKpisTempo() {
  const ateSair = itens.filter((i) => i.iniciado_em).map((i) => horasEntre(i.criado_em, i.iniciado_em));
  const totalFluxo = itens.filter((i) => i.finalizado_em).map((i) => horasEntre(i.criado_em, i.finalizado_em));
  const finalizados = itens.filter((i) => i.finalizado_em).length;

  $('esc-kpis-tempo').replaceChildren(
    kpiCard({
      icone: '◔', tom: 'neutro', rotulo: 'Até sair de Pendente',
      valor: ateSair.length ? duracaoH(mediana(ateSair)) : '—',
      nota: `mediana · ${n(ateSair.length)} caso${ateSair.length === 1 ? '' : 's'}`,
    }),
    kpiCard({
      icone: '⏱', tom: 'neutro', rotulo: 'Fluxo completo',
      valor: totalFluxo.length ? duracaoH(mediana(totalFluxo)) : '—',
      nota: totalFluxo.length
        ? `mediana, do escalonamento até Finalizado · ${n(totalFluxo.length)} caso${totalFluxo.length === 1 ? '' : 's'}`
        : 'nenhum caso finalizado ainda',
    }),
    kpiCard({
      icone: '✓', tom: 'finalizado', rotulo: 'Finalizados', valor: n(finalizados),
      nota: 'no total (todo o histórico)',
    }),
    kpiCard({
      icone: '↔', tom: 'neutro', rotulo: 'Movidos por dia',
      valor: resumoMovimentos.media_por_dia !== undefined ? String(resumoMovimentos.media_por_dia).replace('.', ',') : '—',
      nota: `média, últimos ${resumoMovimentos.janela_dias ?? 30} dias · ${n(resumoMovimentos.total ?? 0)} mudanças de coluna`,
    }),
  );
}

/** Últimos 30 dias, um ponto por dia (mesmo padrão de emailTickets.js). */
function ultimosNDias(nDias) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const lista = [];
  for (let i = nDias - 1; i >= 0; i -= 1) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    lista.push(d);
  }
  return lista;
}

function contarPorDia(datas) {
  const porDia = new Map();
  for (const iso of datas) {
    if (!iso) continue;
    const chave = new Date(iso).toISOString().slice(0, 10);
    porDia.set(chave, (porDia.get(chave) ?? 0) + 1);
  }
  return ultimosNDias(30).map((d) => {
    const chave = d.toISOString().slice(0, 10);
    return {
      chave, valor: porDia.get(chave) ?? 0, data: d,
      rotulo: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    };
  });
}

function renderGraficosTempo() {
  desenharColunas($('esc-graf-criados'), contarPorDia(itens.map((i) => i.criado_em)), {
    altura: 170, tooltip, unidade: 'casos', textoVazio: 'Nenhum caso escalado nos últimos 30 dias',
    rotuloEixoX: (d, i) => (i % 4 === 0 ? d.rotulo : ''),
  });

  const movidosPorDia = ultimosNDias(30).map((d) => {
    const chave = d.toISOString().slice(0, 10);
    const linha = movimentosDiarios.find((m) => m.dia === chave);
    return {
      chave, valor: linha?.total ?? 0, data: d,
      rotulo: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    };
  });
  desenharColunas($('esc-graf-movidos'), movidosPorDia, {
    altura: 170, tooltip, unidade: 'mudanças', textoVazio: 'Nenhuma mudança de coluna registrada nos últimos 30 dias',
    rotuloEixoX: (d, i) => (i % 4 === 0 ? d.rotulo : ''),
  });

  desenharColunas($('esc-graf-finalizados'), contarPorDia(itens.filter((i) => i.finalizado_em).map((i) => i.finalizado_em)), {
    altura: 170, tooltip, unidade: 'casos', textoVazio: 'Nenhum caso finalizado nos últimos 30 dias',
    rotuloEixoX: (d, i) => (i % 4 === 0 ? d.rotulo : ''),
  });
}

function renderTabelaTransicoes() {
  const linhas = [...transicoes].sort((a, b) => (b.media_h ?? 0) - (a.media_h ?? 0));
  renderTabela($('esc-transicoes-lista'), linhas, [
    { classe: 'cel-forte', render: (t) => `${rotularStatus(t.status_anterior)} → ${rotularStatus(t.status_novo)}` },
    { classe: 'num', render: (t) => duracaoH(t.media_h) },
    { classe: 'num', render: (t) => duracaoH(t.mediana_h) },
    { classe: 'num', render: (t) => n(t.amostra) },
  ], { vazio: 'Ainda sem transições registradas nesta janela.' });
}

/* ═══════════════════════════════  ações  ═══════════════════════════════ */

async function moverStatus(id, status) {
  const { ok, dados: resp } = await api('/api/suporte-escalado/status', { metodo: 'POST', corpo: { id, status } });
  if (!ok) {
    window.alert(resp?.detail ?? resp?.erro ?? resp?.message ?? 'Não consegui mover o caso.');
    return;
  }
  await carregarDados();
}

/**
 * Abre o e-mail ORIGINAL no webmail (Hostinger) — não é navegação dentro do
 * painel, é o servidor buscando pasta+UID ao vivo via IMAP (ver
 * /api/emails/:id/webmail em emailIACentral.js) e devolvendo a URL exata.
 *
 * A aba é aberta NA HORA DO CLIQUE (com um aviso "abrindo…") e só depois recebe o endereço do webmail. Abrir
 * depois do `await` fazia o navegador perder o vínculo com o clique e bloquear como pop-up (19/09/2026). Se a busca
 * falhar, a aba é fechada; se o navegador não deixar fechar, ela mostra o erro em vez de ficar em branco.
 */
export async function abrirNoWebmail(emailId, botao) {
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = '…';
  // síncrono, dentro do clique: é o que o bloqueador de pop-up exige
  const aba = window.open('about:blank', '_blank');
  if (aba) {
    try {
      aba.opener = null; // o webmail não precisa (e não deve) enxergar o painel
      aba.document.title = 'Abrindo o webmail…';
      aba.document.body.textContent = 'Abrindo o e-mail no webmail…';
    } catch { /* aba já navegou ou é de outra origem: segue */ }
  }
  const falhar = (msg) => {
    if (aba) {
      try { aba.close(); } catch { /* ignora */ }
      if (!aba.closed) { try { aba.document.body.textContent = `${msg} Pode fechar esta aba.`; } catch { /* ignora */ } }
    }
    window.alert(msg);
  };
  try {
    const { ok, dados: resp } = await api(`/api/emails/${emailId}/webmail`);
    if (!ok || !resp?.url) {
      falhar(resp?.erro ?? resp?.detail ?? 'Não consegui achar este e-mail na caixa.');
      return;
    }
    if (aba && !aba.closed) aba.location.replace(resp.url);
    else window.alert(`Seu navegador bloqueou a aba. Abra manualmente:\n${resp.url}`);
  } catch {
    falhar('Não consegui achar este e-mail na caixa.');
  } finally {
    botao.disabled = false;
    botao.textContent = original;
  }
}

async function reativar(id, nome) {
  const confirmou = window.confirm(
    `Reativar resposta automática da IA para ${nome || 'este cliente'}?\n\n`
    + 'A IA volta a responder o próximo e-mail dele sozinha — o card sai do kanban.',
  );
  if (!confirmou) return;
  const { ok, dados: resp } = await api('/api/suporte-escalado/reativar', { metodo: 'POST', corpo: { id } });
  if (!ok) {
    window.alert(resp?.detail ?? resp?.erro ?? resp?.message ?? 'Não consegui reativar.');
    return;
  }
  await carregarDados();
}

/** Transfere um caso pro board de outro responsável — só admin (botão só
 *  aparece pra quem é admin, ver criarCard). O caso some do board atual (a
 *  tela recarrega e ele já não está mais na lista) e entra como "novo" —
 *  pendente — no board de destino. */
async function transferirCaso(id, boardIdDestino) {
  const { ok, dados: resp } = await api('/api/suporte-escalado/transferir', {
    metodo: 'POST', corpo: { id, board_id: boardIdDestino },
  });
  if (!ok) {
    window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui transferir o caso.');
    return;
  }
  await carregarDados();
}

/* ═══════════════════════════  colunas do kanban  ═════════════════════════
   Criar/renomear/apagar coluna. Apagar é bloqueado no servidor se a coluna
   tiver algum caso (ou for a coluna "pendente") — aqui só desabilita o botão
   de antemão (doColuna.length, calculado no renderBoard) e mostra a
   mensagem de erro que a API mandar se, mesmo assim, a chamada for tentada
   (ex.: outra aba moveu um caso pra cá entre o render e o clique). */

async function criarColuna(rotulo, descricao) {
  const { ok, dados: resp } = await api('/api/suporte-escalado/colunas', {
    metodo: 'POST', corpo: { board_id: boardId, rotulo, descricao },
  });
  if (!ok) {
    window.alert(resp?.detail ?? resp?.erro ?? resp?.message ?? 'Não consegui criar a coluna.');
    return false;
  }
  await carregarDados();
  return true;
}

async function editarColuna(id, rotulo, descricao) {
  const { ok, dados: resp } = await api(`/api/suporte-escalado/colunas/${id}`, {
    metodo: 'PUT', corpo: { rotulo, descricao },
  });
  if (!ok) {
    window.alert(resp?.detail ?? resp?.erro ?? resp?.message ?? 'Não consegui salvar a coluna.');
    return false;
  }
  await carregarDados();
  return true;
}

async function apagarColuna(id, rotulo) {
  const confirmou = window.confirm(`Apagar a coluna "${rotulo}"?\n\nEssa ação não pode ser desfeita.`);
  if (!confirmou) return;
  const { ok, dados: resp } = await api(`/api/suporte-escalado/colunas/${id}`, { metodo: 'DELETE' });
  if (!ok) {
    window.alert(resp?.detail ?? resp?.erro ?? resp?.message ?? 'Não consegui apagar a coluna.');
    return;
  }
  await carregarDados();
}

/* ═══════════════════════════  detalhes + notas  ══════════════════════════
   Ficha completa do caso (mesmo modal #modal-ficha reaproveitado em toda a
   Central de E-mail IA) com um campo a mais: notas internas do suporte,
   sempre editáveis — não é um "resumo" fixo, é um bloco vivo que a pessoa
   do suporte vai escrevendo/alterando ao longo do atendimento. */

export function abrirDetalheEscalado(item) {
  const contextoContainer = document.createElement('div');
  contextoContainer.className = 'esc-contexto';
  contextoContainer.textContent = 'Carregando dados do pedido…';

  const notasContainer = document.createElement('div');
  notasContainer.className = 'esc-notas';
  notasContainer.textContent = 'Carregando notas…';


  const propriedadesContainer = document.createElement('div');
  propriedadesContainer.className = 'esc-ficha-bloco';
  propriedadesContainer.textContent = 'Carregando propriedades…';
  const logisticaContainer = document.createElement('div');
  logisticaContainer.className = 'esc-ficha-bloco';
  logisticaContainer.textContent = 'Carregando logística…';
  const ajudaContainer = document.createElement('div');
  ajudaContainer.className = 'esc-ficha-bloco';
  ajudaContainer.textContent = 'Carregando pedidos de ajuda…';

  const rotuloStatus = rotularStatus(item.status);

  // Botão pra timeline completa (10/09/2026): o resumo abaixo é um texto
  // cumulativo reescrito a cada resposta — bom pra ler rápido, mas não
  // mostra a troca real mensagem-a-mensagem. Abre o outro modal (o mesmo
  // usado em Mais Detalhes) por cima deste, sem fechar a ficha do caso.
  const botaoConversa = document.createElement('button');
  botaoConversa.type = 'button';
  botaoConversa.className = 'btn btn-fantasma';
  botaoConversa.textContent = 'Ver conversa completa (cliente ↔ IA) →';
  botaoConversa.disabled = !item.remetente_email;
  botaoConversa.addEventListener('click', async () => {
    // Ticket-mãe: a conversa junta também os e-mails dos tickets-filhos mesclados (PDF de 07/10, item 9).
    let extras = [];
    try {
      const { ok, dados } = await api(`/api/suporte-escalado/${item.id}/ficha`);
      if (ok) extras = (dados.mesclagem?.filhos ?? []).map((f) => f.remetente_email).filter(Boolean);
    } catch { /* abre só a conversa do próprio e-mail */ }
    abrirModalEmails('email', item.remetente_email, `conversa com ${item.nome || item.remetente_email}`, null, 'conversa', extras);
  });
  const atendimentoContainer = document.createElement('div');
  atendimentoContainer.className = 'esc-atendimento';
  botaoConversa.textContent = 'Abrir a conversa em tela cheia →';
  atendimentoContainer.append(montarAtendimento(item, botaoConversa));
  const ticketEl = document.createElement('span');
  ticketEl.textContent = `#${item.id}`;

  const alertaEl = document.createElement('span');
  alertaEl.textContent = ROTULO_AMEACA[item.alerta_ameaca] ? `🚨 ${ROTULO_AMEACA[item.alerta_ameaca]} — responder em até 2 dias úteis` : '—';

  // Ordem pedida pela Késsia (PDF 07/10, item 28): Resumo geral → Dados do
  // pedido → Propriedades → Resumo da IA → Atendimento → Logística → Ajuda.
  // O bloco Retenção saiu (item 14): a Home e o dash leem a retenção de Propriedades (tipo de resolução + %).
  abrirFicha({
    titulo: item.nome || item.remetente_email || '(sem nome)',
    subtitulo: item.remetente_email || '',
    larga: true,
    campos: [
      { rotulo: 'Nº do ticket', valor: ticketEl },
      { rotulo: 'Status no kanban', valor: rotuloStatus },
      { rotulo: 'Escalado em', valor: item.criado_em ? dataHora(item.criado_em) : '—' },
      { rotulo: 'Iniciado em', valor: item.iniciado_em ? dataHora(item.iniciado_em) : '—' },
      { rotulo: 'Finalizado em', valor: item.finalizado_em ? dataHora(item.finalizado_em) : '—' },
      { rotulo: 'Tag do motivo do contato', valor: ROTULO_TAG[item.tag_motivo] || '—' },
      { rotulo: 'Prioridade', valor: ROTULO_NIVEL[item.prioridade_nivel] || '—' },
      { rotulo: 'Alerta', valor: alertaEl },
      { rotulo: 'Última movimentação', largo: true, valor: item.movido_em ? `${item.movido_de ? 'de ' + item.movido_de + ' ' : ''}por ${item.movido_por || 'Sistema (automação)'} em ${dataHora(item.movido_em)}` : '—' },
      { rotulo: 'Dados do pedido', valor: contextoContainer, bloco: true, metade: true },
      { rotulo: 'Propriedades', valor: propriedadesContainer, bloco: true, metade: true },
      { rotulo: 'Mensagem da cliente — foco da reclamação', valor: item.resumo_conversa || '—', recolhivel: true, metade: true },
      { rotulo: 'Motivo do escalonamento', valor: item.motivo_escalonamento || '—', recolhivel: true, metade: true },
      { rotulo: 'Atendimento', valor: atendimentoContainer, bloco: true },
      { rotulo: 'Logística', valor: logisticaContainer, bloco: true, metade: true },
      { rotulo: 'Ajuda — escalar para alguém da equipe', valor: ajudaContainer, bloco: true, metade: true },
      { rotulo: 'Notas internas', valor: notasContainer, bloco: true },
    ],
  });

  carregarContexto(item, contextoContainer);
  carregarFichaAgente(item, propriedadesContainer, logisticaContainer, ajudaContainer, alertaEl, ticketEl);
  carregarNotas(item.id, notasContainer);
}

/* ═══════════════════  Atendimento: conversa em abas + responder pelo SendTrace  ═══════════════════
   PDF de 07/10, itens 2 e 18. Abas dentro da ficha — Atendimento humano (cliente ↔ agentes), Atendimento IA (cliente ↔ IA e e-mails automáticos),
   Tudo e Histórico do ticket — e, abaixo, o campo de resposta: o e-mail sai como support@ pela SMTP da Hostinger, sem abrir o webmail. */
function montarAtendimento(item, botaoTelaCheia) {
  const raiz = document.createElement('div');
  raiz.className = 'esc-atend';
  const ABAS = [['humano', 'Atendimento humano'], ['ia', 'Atendimento IA'], ['tudo', 'Tudo'], ['historico', 'Histórico do ticket']];
  const PAPEIS = { humano: ['cliente', 'agente'], ia: ['cliente', 'ia', 'boasvindas', 'sistema'], tudo: null };
  let aba = 'humano';
  let itens = [];
  let carregado = false;
  let podeResponder = false;
  let destinos = [item.remetente_email];

  const barra = document.createElement('div'); barra.className = 'esc-atend-abas'; barra.setAttribute('role', 'tablist');
  const painel = document.createElement('div'); painel.className = 'esc-atend-painel';
  const compor = document.createElement('form'); compor.className = 'esc-atend-compor';
  const acoes = document.createElement('div'); acoes.className = 'esc-atend-acoes';
  acoes.append(botaoTelaCheia, montarMesclagem(item));

  const caixa = document.createElement('textarea');
  caixa.rows = 4; caixa.maxLength = 8000; caixa.placeholder = 'Escreva a resposta ao cliente… (sai como support@, na mesma conversa do e-mail dele)';
  const contador = document.createElement('span'); contador.className = 'esc-atend-contador'; contador.textContent = '0/8000';
  caixa.addEventListener('input', () => { contador.textContent = `${caixa.value.length}/8000`; });
  const para = document.createElement('select'); para.hidden = true;
  const enviar = document.createElement('button'); enviar.type = 'submit'; enviar.className = 'btn btn-forte'; enviar.textContent = 'Responder';
  const rodape = document.createElement('div'); rodape.className = 'esc-atend-compor-rodape';
  rodape.append(para, contador, enviar);
  compor.append(caixa, rodape);

  const contar = (papeis) => itens.filter((i) => papeis.includes(i.papel)).length;
  function desenhar() {
    barra.replaceChildren();
    for (const [chave, rotulo] of ABAS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'subaba-btn'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(aba === chave));
      const qtd = chave === 'humano' ? contar(['agente']) : chave === 'ia' ? contar(['ia', 'boasvindas', 'sistema']) : null;
      b.textContent = qtd != null && carregado ? `${rotulo} (${qtd})` : rotulo;
      b.addEventListener('click', () => { aba = chave; desenhar(); });
      barra.append(b);
    }
    compor.hidden = !(podeResponder && (aba === 'humano' || aba === 'tudo'));
    if (aba === 'historico') {
      painel.textContent = 'Carregando…';
      carregarAtividades(item.id, painel);
      return;
    }
    if (!carregado) { painel.textContent = 'Carregando a conversa…'; return; }
    const papeis = PAPEIS[aba];
    const visiveis = itens.filter((i) => !papeis || papeis.includes(i.papel));
    if (!visiveis.length) { painel.textContent = 'Nenhuma mensagem nesta aba ainda.'; return; }
    painel.replaceChildren(...visiveis.map((i) => i.b.cloneNode(true)));
    painel.scrollTop = painel.scrollHeight;
  }

  async function carregar() {
    try {
      const { ok, dados } = await api(`/api/suporte-escalado/${item.id}/ficha`);
      const filhos = ok ? (dados.mesclagem?.filhos ?? []).map((f) => f.remetente_email).filter(Boolean) : [];
      podeResponder = ok && !!dados.pode_editar;
      destinos = [item.remetente_email, ...filhos];
      para.hidden = filhos.length === 0;
      para.replaceChildren(...destinos.map((e) => { const o = document.createElement('option'); o.value = e; o.textContent = `Para: ${e}`; return o; }));
      const conv = await carregarConversaDoCliente(item.remetente_email, filhos);
      itens = itensDaConversa(conv);
    } catch { itens = []; }
    carregado = true;
    desenhar();
  }

  compor.addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = caixa.value.trim();
    if (!texto) return;
    const destino = para.hidden ? item.remetente_email : para.value;
    if (!window.confirm(`Enviar esta resposta para ${destino}? O e-mail sai agora, como support@.`)) return;
    enviar.disabled = true;
    const { ok, dados } = await api(`/api/suporte-escalado/${item.id}/responder`, { metodo: 'POST', corpo: { texto, para_email: destino } });
    enviar.disabled = false;
    if (!ok) { window.alert(dados?.erro ?? dados?.detail ?? dados?.message ?? 'Não consegui enviar a resposta.'); return; }
    caixa.value = ''; contador.textContent = '0/8000';
    if (dados.copiado_para_enviados === false) window.alert('Resposta enviada. Aviso: não consegui guardar a cópia na pasta Enviados do webmail.');
    document.dispatchEvent(new CustomEvent('escalado:ficha-salva'));   // a fila e o card andam na hora
    carregado = false; desenhar(); carregar();
  });

  raiz.append(barra, painel, compor, acoes);
  desenhar();
  carregar();
  return raiz;
}

/* ═══════════════════  mesclar tickets  ═══════════════════
   Busca outro ticket (e-mail, nome ou nº) e junta os dois: o mais antigo vira ticket-mãe e o agente dele passa a tratar os dois (PDF de 07/10, item 9). */
function montarMesclagem(item) {
  const caixa = document.createElement('details');
  caixa.className = 'esc-mesclar';
  const sum = document.createElement('summary');
  sum.textContent = '🔗 Mesclar tickets';
  const corpo = document.createElement('div');
  corpo.className = 'esc-mesclar-corpo';
  const busca = document.createElement('input');
  busca.type = 'search'; busca.placeholder = 'E-mail, nome ou nº do outro ticket…'; busca.maxLength = 120;
  const btnBuscar = document.createElement('button');
  btnBuscar.type = 'button'; btnBuscar.className = 'btn'; btnBuscar.textContent = 'Buscar';
  const lista = document.createElement('div');
  lista.className = 'esc-mesclar-lista';
  const buscar = async () => {
    const q = busca.value.trim();
    if (q.length < 2) return;
    lista.textContent = 'Buscando…';
    const { ok, dados } = await api(`/api/suporte-escalado/buscar?q=${encodeURIComponent(q)}`);
    lista.replaceChildren();
    if (!ok) { lista.textContent = 'Não consegui buscar.'; return; }
    const achados = (dados.tickets ?? []).filter((t) => String(t.id) !== String(item.id));
    if (!achados.length) { lista.textContent = 'Nenhum outro ticket encontrado.'; return; }
    for (const t of achados) {
      const linha = document.createElement('div');
      linha.className = 'esc-mesclar-item';
      const txt = document.createElement('span');
      txt.textContent = `#${t.id} · ${t.remetente_email}${t.nome ? ` (${t.nome})` : ''} · ${t.agente || 'sem agente'} · ${t.status}${t.ticket_mae_id ? ` · já é filho de #${t.ticket_mae_id}` : ''}`;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-forte'; b.textContent = 'Juntar';
      b.addEventListener('click', async () => {
        if (!window.confirm(`Mesclar #${item.id} e #${t.id}? O ticket mais antigo vira o ticket-mãe e o outro passa para o agente dele.`)) return;
        b.disabled = true;
        const { ok: okM, dados: r } = await api(`/api/suporte-escalado/${item.id}/mesclar`, { metodo: 'POST', corpo: { outro_id: t.id } });
        if (!okM) { b.disabled = false; window.alert(r?.erro ?? r?.detail ?? r?.message ?? 'Não consegui mesclar.'); return; }
        window.alert(`Pronto: ticket-mãe #${r.mae_id}; ticket-filho #${r.filho_id}.`);
        document.dispatchEvent(new CustomEvent('escalado:ficha-salva'));
        $('modal-ficha').close();
      });
      linha.append(txt, b);
      lista.append(linha);
    }
  };
  btnBuscar.addEventListener('click', buscar);
  busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscar(); } });
  corpo.append(busca, btnBuscar, lista);
  caixa.append(sum, corpo);
  return caixa;
}

/* ═══════════════════  histórico de atividades do ticket  ═══════════════════
   Linha do tempo (PDF de 07/10, item 6): chegada, atribuição, mudança de coluna e de propriedades, notas, ajuda e respostas — com data, hora e quem fez.
   Vem de GET .../atividades. */

const ROTULO_CAMPO = {
  motivo_contato: 'Motivo do contato', detalhamento_motivo: 'Detalhamento do motivo', tipo_resolucao: 'Tipo de resolução',
  percentual_reembolso: 'Percentual do reembolso (%)', valor_compra_usd: 'Valor da compra (US$)', deducao_frascos_usd: 'Dedução de frascos (US$)',
  chargeback_em: 'Data do chargeback', status_ticket: 'Status do ticket', ticket_reaberto_em: 'Ticket reaberto',
  status_logistica: 'Status logística', motivo_reenvio: 'Motivo do reenvio', quantidade_reenvio: 'Quantidade para reenvio',
  produto_reenvio: 'Produto a ser enviado', observacao_reenvio: 'Observação do reenvio', endereco_divergencia: 'Endereço (divergência)',
  novo_rastreio: 'Novo número de rastreio', responsavel_board_id: 'Responsável (logística)', status_ajuda: 'Status de ajuda',
};
const ICONE_ATIVIDADE = { chegada: '📥', coluna: '🔀', atribuicao: '👤', nota: '📝', ajuda: '🆘', resposta_agente: '✉️', cliente: '💬', propriedade: '✏️' };

async function carregarAtividades(casoId, container) {
  try {
    const { ok, dados } = await api(`/api/suporte-escalado/${casoId}/atividades`);
    if (!ok) throw new Error('atividades');
    container.replaceChildren();
    const itens = dados.atividades ?? [];
    if (!itens.length) { container.textContent = 'Nenhuma atividade registrada.'; return; }
    for (const a of itens) {
      const linha = document.createElement('div');
      linha.className = 'esc-atividade';
      const [tipoBase, , campo] = String(a.tipo).split(':');
      const titulo = tipoBase === 'propriedade' ? (ROTULO_CAMPO[campo] ?? a.titulo) : a.titulo;
      const cab = document.createElement('div');
      cab.className = 'esc-atividade-cab';
      const t = document.createElement('strong');
      t.textContent = `${ICONE_ATIVIDADE[tipoBase] ?? '•'} ${titulo}`;
      const q = document.createElement('span');
      q.className = 'esc-atividade-quando';
      q.textContent = `${a.ator || 'Sistema'} · ${dataHora(a.quando)}`;
      cab.append(t, q);
      linha.append(cab);
      if (a.detalhe) { const d = document.createElement('div'); d.className = 'esc-atividade-detalhe'; d.textContent = a.detalhe; linha.append(d); }
      container.append(linha);
    }
  } catch {
    container.textContent = 'Não consegui carregar o histórico.';
  }
}

/* ═══════════════════════════  dados do pedido  ═══════════════════════════
   Ficha de compra (cliente/pedido/produto/status), carregada sob demanda ao
   abrir os detalhes — mesmo padrão de carregarNotas logo abaixo. Tudo vem de
   GET .../contexto, EXCETO "Data de entrega": não existe fonte nenhuma desse
   dado no sistema hoje (sem rastreio/transportadora integrados), então é
   digitada à mão aqui mesmo e salva via PUT .../data-entrega. */

async function carregarContexto(item, container) {
  try {
    const { ok, dados } = await api(`/api/suporte-escalado/${item.id}/contexto`);
    if (!ok) throw new Error('falha ao carregar');
    renderContexto(item, container, dados);
  } catch {
    container.replaceChildren();
    const erro = document.createElement('p');
    erro.className = 'vazio-suave';
    erro.textContent = 'Não consegui carregar os dados do pedido.';
    container.append(erro);
  }
}

function renderContexto(item, container, ctx) {
  container.replaceChildren();

  const lista = document.createElement('dl');
  lista.className = 'esc-contexto-lista';
  const linha = (rotulo, valor) => {
    const dt = document.createElement('dt');
    dt.textContent = rotulo;
    const dd = document.createElement('dd');
    if (valor instanceof Node) dd.append(valor);
    else dd.textContent = valor || '—';
    lista.append(dt, dd);
  };

  const cliente = ctx.cliente ?? {};
  linha('Cliente', `${cliente.nome || item.nome || '(sem nome)'} · ${cliente.email || item.remetente_email || '—'}`);

  const pedidos = ctx.pedidos ?? [];
  const principal = ctx.pedido_principal ?? pedidos[0] ?? null;
  linha('Número do(s) pedido(s)', pedidos.length ? pedidos.map((p) => p.transacao_id).join(', ') : '—');
  linha('Data de compra', principal?.pedido_em ? dataHora(principal.pedido_em) : '—');
  const produtos = [...new Set(pedidos.map((p) => p.produto).filter(Boolean))];
  linha('Produto', produtos.length ? produtos.join(', ') : (principal?.produto || '—'));
  linha('Plataforma', principal?.plataforma ? rotularPlataforma(principal.plataforma) : '—');
  linha('Status do pedido', principal?.status_pedido || '—');
  const detalhe = pedidos.find((p) => p.transacao_id === principal?.transacao_id) ?? pedidos[0] ?? null;
  linha('Valor do pedido', detalhe?.valor != null ? `${(detalhe.moeda || 'USD') === 'USD' ? 'US$' : detalhe.moeda} ${Number(detalhe.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
  linha('Status da entrega', detalhe?.rastreio_status ? (ROTULO_RASTREIO[detalhe.rastreio_status] || detalhe.rastreio_status) : '—');
  linha('Transportadora', detalhe?.carrier_code || '—');
  if (detalhe?.tracking_number && /^https?:\/\//i.test(detalhe.tracking_url || '')) {
    const a = document.createElement('a');
    a.href = detalhe.tracking_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = detalhe.tracking_number;
    linha('Rastreio', a);
  } else {
    linha('Rastreio', detalhe?.tracking_number || '—');
  }
  linha('Data do primeiro e-mail', ctx.primeiro_email_em ? dataHora(ctx.primeiro_email_em) : '—');

  linha('Data de entrega', criarCampoDataEntrega(item.id, ctx.data_entrega));

  container.append(lista);
}

/** "Data de entrega" é o único campo desta ficha SEM fonte automática no
 *  sistema — vira um <input type="date"> editável na hora, com Salvar
 *  próprio (não depende de nenhum outro formulário da tela). */
function criarCampoDataEntrega(casoId, dataEntregaIso) {
  const envolve = document.createElement('div');
  envolve.className = 'esc-contexto-entrega';

  const input = document.createElement('input');
  input.type = 'date';
  input.value = dataEntregaIso ? dataEntregaIso.slice(0, 10) : '';

  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'button';
  btnSalvar.className = 'btn btn-forte';
  btnSalvar.textContent = 'Salvar';

  const status = document.createElement('span');
  status.className = 'esc-contexto-entrega-status';

  btnSalvar.addEventListener('click', async () => {
    btnSalvar.disabled = true;
    status.textContent = '';
    const { ok, dados: resp } = await api(`/api/suporte-escalado/${casoId}/data-entrega`, {
      metodo: 'PUT', corpo: { data_entrega: input.value || null },
    });
    btnSalvar.disabled = false;
    if (!ok) {
      window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui salvar a data de entrega.');
      return;
    }
    status.textContent = 'salvo ✓';
  });

  envolve.append(input, btnSalvar, status);
  return envolve;
}

/* ═══════════════  campos do agente: Propriedades, Logística e Ajuda  ═══════════════
   Pedido da Késsia (PDF de 05/10/2026, migração 066). Tudo vem de GET .../ficha (+ /opcoes, com as listas
   fechadas e a equipe) e salva com PUT .../ficha. Quem só recebeu um pedido de ajuda vê os campos sem editar. */

let opcoesEscalado = null;
export async function obterOpcoes() {
  if (opcoesEscalado) return opcoesEscalado;
  const { ok, dados } = await api('/api/suporte-escalado/opcoes');
  if (!ok) throw new Error('opcoes');
  opcoesEscalado = dados;
  return dados;
}

function selectLista(itens, atual, vazio = '—') {
  const sel = document.createElement('select');
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = vazio; sel.append(o0);
  for (const it of itens) {
    const [v, t] = Array.isArray(it) ? it : [it, it];
    const o = document.createElement('option');
    o.value = String(v); o.textContent = t; sel.append(o);
  }
  sel.value = atual === null || atual === undefined ? '' : String(atual);
  return sel;
}

export function rotuloDe(texto, el) {
  const l = document.createElement('label');
  l.className = 'esc-campo';
  const s = document.createElement('span');
  s.textContent = texto;
  l.append(s, el);
  return l;
}

/** Monta um bloco de campos (uma coluna de rótulos + controles) que salva só os campos dele.
 *  Tipos: lista, texto, area, dinheiro (US$), data e calculo (somente leitura, recalculado a cada digitação; não é enviado).
 *  `obrigatorio` vale só enquanto o campo está visível (item 17 do PDF de 07/10). */
function montarBlocoFicha({ casoId, container, ficha, podeEditar, definicao, recarregar, atualizadoPor, atualizadoEm }) {
  container.replaceChildren();
  const form = document.createElement('form');
  form.className = 'esc-ficha-form';
  const controles = {};
  const rotulos = {};
  for (const d of definicao) {
    let el;
    const atual = ficha[d.chave] ?? d.padrao ?? null;
    if (d.tipo === 'lista') el = selectLista(d.opcoes, ficha[d.chave]);
    else if (d.tipo === 'area') { el = document.createElement('textarea'); el.rows = 2; el.value = ficha[d.chave] ?? ''; el.maxLength = d.max; }
    else if (d.tipo === 'dinheiro') { el = document.createElement('input'); el.type = 'number'; el.min = '0'; el.step = '0.01'; el.value = atual ?? ''; }
    else if (d.tipo === 'data') { el = document.createElement('input'); el.type = 'date'; el.value = atual ? String(atual).slice(0, 10) : ''; }
    else if (d.tipo === 'calculo') { el = document.createElement('output'); el.className = 'esc-calculo'; }
    else { el = document.createElement('input'); el.type = 'text'; el.value = ficha[d.chave] ?? ''; el.maxLength = d.max; }
    if (d.tipo !== 'calculo') el.disabled = !podeEditar;
    controles[d.chave] = el;
    rotulos[d.chave] = rotuloDe(d.obrigatorio ? `${d.rotulo} *` : d.rotulo, el);
    form.append(rotulos[d.chave]);
  }
  // Campo condicional (ex.: percentual do reembolso só aparece com "Reembolso parcial"): mostra ao lado do campo que o controla.
  const visivel = (d) => !d.visivelSe || controles[d.visivelSe.chave].value === d.visivelSe.valor;
  const numero = (chave) => (controles[chave] && controles[chave].value !== '' ? Number(controles[chave].value) : null);
  const recalcular = () => {
    for (const d of definicao) {
      if (d.tipo !== 'calculo') continue;
      const v = d.calcular(numero);
      controles[d.chave].textContent = v == null ? '—' : `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  };
  const atualizarVisibilidade = () => {
    for (const d of definicao) if (d.visivelSe) rotulos[d.chave].hidden = !visivel(d);
  };
  for (const d of definicao) if (d.visivelSe) controles[d.visivelSe.chave].addEventListener('change', atualizarVisibilidade);
  for (const c of Object.values(controles)) { c.addEventListener('input', recalcular); c.addEventListener('change', recalcular); }
  atualizarVisibilidade();
  recalcular();
  if (podeEditar) {
    const btn = document.createElement('button');
    btn.type = 'submit'; btn.className = 'btn btn-forte'; btn.textContent = 'Salvar';
    form.append(btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const corpo = {};
      const faltam = [];
      for (const d of definicao) {
        if (d.tipo === 'calculo') continue;
        const v = visivel(d) ? controles[d.chave].value.trim() : '';
        if (d.obrigatorio && visivel(d) && v === '') faltam.push(d.rotulo);
        corpo[d.chave] = v === '' ? null : ((d.numero || d.tipo === 'dinheiro') ? Number(v) : v);
      }
      if (faltam.length) { window.alert(`Preencha todos os campos antes de salvar: ${faltam.join(', ')}.`); return; }
      btn.disabled = true;
      const { ok, dados: r } = await api(`/api/suporte-escalado/${casoId}/ficha`, { metodo: 'PUT', corpo });
      btn.disabled = false;
      if (!ok) { window.alert(r?.erro ?? r?.detail ?? r?.message ?? 'Não consegui salvar.'); return; }
      document.dispatchEvent(new CustomEvent('escalado:ficha-salva'));   // a fila do Suporte Humano atualiza na hora
      recarregar();
    });
  }
  container.append(form);
  if (atualizadoEm) {
    const nota = document.createElement('p');
    nota.className = 'vazio-suave';
    nota.textContent = `Última alteração: ${atualizadoPor || '—'} em ${dataHora(atualizadoEm)}`;
    container.append(nota);
  }
}

function renderAjuda({ casoId, container, dados, opc, recarregar, montarStatus }) {
  container.replaceChildren();
  const statusEl = document.createElement('div');
  container.append(statusEl);
  montarStatus(statusEl);
  const pedidos = dados.ajudas ?? [];
  if (!pedidos.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio-suave';
    vazio.textContent = 'Nenhum pedido de ajuda neste caso.';
    container.append(vazio);
  }
  for (const a of pedidos) {
    const bloco = document.createElement('div');
    bloco.className = 'esc-ajuda-item';
    const cab = document.createElement('div');
    cab.className = 'esc-nota-cabeca';
    cab.textContent = `${a.pedido_por} pediu ajuda a ${a.para_nome} · ${dataHora(a.criado_em)}`;
    const nota = document.createElement('p');
    nota.className = 'esc-ajuda-texto';
    nota.textContent = a.nota;
    bloco.append(cab, nota);
    if (a.resposta) {
      const r = document.createElement('p');
      r.className = 'esc-ajuda-resposta';
      r.textContent = `${a.respondido_por} respondeu em ${dataHora(a.respondido_em)}: ${a.resposta}`;
      bloco.append(r);
    } else {
      const esp = document.createElement('p');
      esp.className = 'vazio-suave';
      esp.textContent = 'Aguardando resposta.';
      bloco.append(esp);
      if (a.pode_responder) bloco.append(formResposta(a.id, recarregar));
    }
    container.append(bloco);
  }
  if (!dados.pode_editar) return;
  const form = document.createElement('form');
  form.className = 'esc-ficha-form';
  const para = selectLista((opc.equipe ?? []).map((e) => [e.id, e.nome]), null, 'Escolha quem vai ajudar…');
  const texto = document.createElement('textarea');
  texto.rows = 3; texto.maxLength = 4000; texto.required = true;
  texto.placeholder = 'Descreva a dúvida (cole links de prints, se houver)…';
  const btn = document.createElement('button');
  btn.type = 'submit'; btn.className = 'btn btn-forte'; btn.textContent = 'Pedir ajuda';
  form.append(rotuloDe('Para', para), rotuloDe('Dúvida', texto), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!para.value) { window.alert('Escolha quem vai ajudar.'); return; }
    btn.disabled = true;
    const { ok, dados: r } = await api(`/api/suporte-escalado/${casoId}/ajuda`, {
      metodo: 'POST', corpo: { para_board_id: Number(para.value), nota: texto.value.trim() },
    });
    btn.disabled = false;
    if (!ok) { window.alert(r?.erro ?? r?.detail ?? 'Não consegui pedir ajuda.'); return; }
    recarregar();
  });
  container.append(form);
}

function formResposta(ajudaId, aoResponder) {
  const form = document.createElement('form');
  form.className = 'esc-ficha-form';
  const texto = document.createElement('textarea');
  texto.rows = 3; texto.maxLength = 4000; texto.required = true;
  texto.placeholder = 'Escreva a resposta…';
  const btn = document.createElement('button');
  btn.type = 'submit'; btn.className = 'btn btn-forte'; btn.textContent = 'Responder';
  form.append(texto, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const { ok, dados: r } = await api(`/api/suporte-escalado/ajuda/${ajudaId}/responder`, {
      metodo: 'POST', corpo: { resposta: texto.value.trim() },
    });
    btn.disabled = false;
    if (!ok) { window.alert(r?.erro ?? r?.detail ?? 'Não consegui responder.'); return; }
    aoResponder();
  });
  return form;
}

async function carregarFichaAgente(item, contProp, contLog, contAjuda, alertaEl, ticketEl) {
  try {
    const [opc, { ok, dados }] = await Promise.all([obterOpcoes(), api(`/api/suporte-escalado/${item.id}/ficha`)]);
    if (!ok) throw new Error('ficha');
    const recarregar = () => { carregarFichaAgente(item, contProp, contLog, contAjuda, alertaEl, ticketEl); carregarAjudaRecebida(); };
    const f = dados.ficha;
    if (ticketEl) {
      const m = dados.mesclagem ?? {};
      ticketEl.textContent = `#${item.id}${m.mae ? ` · filho do ticket-mãe #${m.mae.id}` : ''}${m.filhos?.length ? ` · ticket-mãe de ${m.filhos.map((x) => `#${x.id}`).join(', ')}` : ''}`;
    }
    const base = { casoId: item.id, ficha: f, podeEditar: dados.pode_editar, recarregar };
    // Alerta "Virou chargeback" (item 11): o tipo de resolução escolhido pelo agente OU o chargeback já registrado no dash para o pedido.
    const avisos = [];
    if (f.tipo_resolucao === 'Virou chargeback' || dados.chargeback_pedido_em) {
      const quando = f.chargeback_em || (typeof dados.chargeback_pedido_em === 'string' ? dados.chargeback_pedido_em : null);
      avisos.push(`🚨 Virou chargeback${quando ? ` em ${String(quando).slice(0, 10).split('-').reverse().join('/')}` : ''}`);
    }
    if (f.ticket_reaberto_em) avisos.push(`🔁 TICKET REABERTO em ${dataHora(f.ticket_reaberto_em)}`);
    if (alertaEl && avisos.length) {
      const txt = avisos.join(' · ');
      if (alertaEl.dataset.base === undefined) alertaEl.dataset.base = alertaEl.textContent;   // recarregar não empilha o aviso
      alertaEl.textContent = alertaEl.dataset.base && alertaEl.dataset.base !== '—' ? `${alertaEl.dataset.base} · ${txt}` : txt;
    }
    montarBlocoFicha({
      ...base, container: contProp, atualizadoPor: f.propriedades_atualizado_por, atualizadoEm: f.propriedades_atualizado_em,
      definicao: [
        { chave: 'motivo_contato', rotulo: 'Motivo do contato', tipo: 'lista', opcoes: opc.motivo_contato, obrigatorio: true },
        { chave: 'detalhamento_motivo', rotulo: 'Detalhamento do motivo do contato', tipo: 'lista', opcoes: opc.detalhamento_motivo, obrigatorio: true },
        { chave: 'tipo_resolucao', rotulo: 'Tipo de resolução', tipo: 'lista', opcoes: opc.tipo_resolucao, obrigatorio: true },
        { chave: 'percentual_reembolso', rotulo: 'Percentual do reembolso', tipo: 'lista', numero: true, obrigatorio: true,
          opcoes: (opc.percentual_reembolso ?? []).map((p) => [p, `${p}%`]), visivelSe: { chave: 'tipo_resolucao', valor: 'Reembolso parcial' } },
        { chave: 'valor_compra_usd', rotulo: 'Valor da compra (US$)', tipo: 'dinheiro', obrigatorio: true, padrao: dados.pedido_sugerido?.valor_usd ?? null,
          visivelSe: { chave: 'tipo_resolucao', valor: 'Reembolso parcial' } },
        { chave: 'deducao_frascos_usd', rotulo: 'Valor do frasco a deduzir (US$, se for o caso)', tipo: 'dinheiro',
          visivelSe: { chave: 'tipo_resolucao', valor: 'Reembolso parcial' } },
        { chave: 'valor_a_reembolsar', rotulo: 'Valor a reembolsar', tipo: 'calculo', visivelSe: { chave: 'tipo_resolucao', valor: 'Reembolso parcial' },
          // MÁX(0; valor × % − dedução): a mesma fórmula da planilha da JVZoo; a API recalcula e grava ao salvar.
          calcular: (n) => {
            const v = n('valor_compra_usd'); const p = n('percentual_reembolso');
            return v == null || p == null ? null : Math.round(Math.max(0, v * (p / 100) - (n('deducao_frascos_usd') ?? 0)) * 100) / 100;
          } },
        { chave: 'chargeback_em', rotulo: 'Data do chargeback', tipo: 'data', visivelSe: { chave: 'tipo_resolucao', valor: 'Virou chargeback' } },
        { chave: 'status_ticket', rotulo: 'Status do ticket', tipo: 'lista', opcoes: opc.status_ticket, obrigatorio: true },
      ],
    });
    montarBlocoFicha({
      ...base, podeEditar: dados.pode_editar_logistica ?? dados.pode_editar, container: contLog, atualizadoPor: f.logistica_atualizado_por, atualizadoEm: f.logistica_atualizado_em,
      definicao: [
        { chave: 'status_logistica', rotulo: 'Status logística', tipo: 'lista', opcoes: opc.status_logistica },
        { chave: 'motivo_reenvio', rotulo: 'Motivo do reenvio', tipo: 'lista', opcoes: opc.motivo_reenvio },
        { chave: 'quantidade_reenvio', rotulo: 'Quantidade para reenvio', tipo: 'lista', numero: true, opcoes: Array.from({ length: 30 }, (_, i) => i + 1) },
        { chave: 'produto_reenvio', rotulo: 'Produto a ser enviado', tipo: 'texto', max: 200 },
        { chave: 'observacao_reenvio', rotulo: 'Observação em caso de reenvio', tipo: 'area', max: 2000 },
        { chave: 'endereco_divergencia', rotulo: 'Endereço (em caso de divergência)', tipo: 'texto', max: 500 },
        { chave: 'novo_rastreio', rotulo: 'Novo número de rastreio', tipo: 'texto', max: 120 },
        { chave: 'responsavel_board_id', rotulo: 'Responsável', tipo: 'lista', numero: true, opcoes: (opc.equipe ?? []).map((e) => [e.id, e.nome]) },
      ],
    });
    renderAjuda({
      casoId: item.id, container: contAjuda, dados, opc, recarregar,
      montarStatus: (cont) => montarBlocoFicha({
        ...base, container: cont, atualizadoPor: f.ajuda_atualizado_por, atualizadoEm: f.ajuda_atualizado_em,
        definicao: [{ chave: 'status_ajuda', rotulo: 'Status de ajuda', tipo: 'lista', opcoes: opc.status_ajuda }],
      }),
    });
  } catch {
    for (const c of [contProp, contLog, contAjuda]) {
      c.replaceChildren();
      const erro = document.createElement('p');
      erro.className = 'vazio-suave';
      erro.textContent = 'Não consegui carregar estes campos.';
      c.append(erro);
    }
  }
}

/** Aviso no topo do Kanban: pedidos de ajuda sem resposta endereçados a quem está logado. */
async function carregarAjudaRecebida() {
  const caixa = $('esc-ajuda-aviso');
  if (!caixa) return;
  let pedidos = [];
  try {
    const { ok, dados } = await api('/api/suporte-escalado/ajuda/para-mim');
    if (ok) pedidos = dados.pedidos ?? [];
  } catch { /* sem aviso: não atrapalha o Kanban */ }
  caixa.replaceChildren();
  caixa.hidden = pedidos.length === 0;
  if (!pedidos.length) return;
  const titulo = document.createElement('strong');
  titulo.textContent = `🙋 ${pedidos.length} pedido${pedidos.length === 1 ? '' : 's'} de ajuda para você`;
  caixa.append(titulo);
  for (const p of pedidos) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-fantasma';
    b.textContent = `${p.cliente_nome || p.remetente_email} · de ${p.pedido_por} · ${relativo(p.criado_em)}`;
    b.addEventListener('click', () => abrirAjudaRecebida(p));
    caixa.append(b);
  }
}

function abrirAjudaRecebida(p) {
  const contexto = document.createElement('div');
  contexto.className = 'esc-contexto';
  contexto.textContent = 'Carregando dados do pedido…';
  const resposta = document.createElement('div');
  resposta.className = 'esc-ficha-bloco';
  resposta.append(formResposta(p.id, () => { $('modal-ficha').close(); carregarAjudaRecebida(); }));
  abrirFicha({
    titulo: p.cliente_nome || p.remetente_email || '(sem nome)',
    subtitulo: p.remetente_email || '',
    campos: [
      { rotulo: `Pedido de ajuda de ${p.pedido_por} · ${dataHora(p.criado_em)}`, valor: p.nota, largo: true },
      { rotulo: 'Tag do motivo do contato', valor: ROTULO_TAG[p.tag_motivo] || '—' },
      { rotulo: 'Prioridade', valor: ROTULO_NIVEL[p.prioridade_nivel] || '—' },
      { rotulo: 'Board de origem', valor: p.board_nome || '—' },
      { rotulo: 'Dados do pedido', valor: contexto, largo: true },
      { rotulo: 'Mensagem da cliente — foco da reclamação', valor: p.resumo_conversa || '—', largo: true },
      { rotulo: 'Sua resposta', valor: resposta, largo: true },
    ],
  });
  carregarContexto({ id: p.caso_id, nome: p.cliente_nome, remetente_email: p.remetente_email }, contexto);
}

/* ═══════════════  turnos e disponibilidade dos agentes (só admin)  ═══════════════
   Pedido da Késsia (PDF de 05/10/2026, migração 067). "Disponível" = o `ativo` do board (quem está indisponível não recebe card
   novo); o turno só vai definir quando o SLA conta. Horário de Brasília, segunda a sexta. Uma pessoa pode estar em vários turnos. */

async function carregarNotas(casoId, container) {
  let notas = [];
  let falhou = false;
  try {
    const { ok, dados } = await api(`/api/suporte-escalado/${casoId}/notas`);
    if (ok) notas = dados.notas ?? [];
    else falhou = true;
  } catch {
    falhou = true;
  }
  renderNotas(casoId, container, notas, falhou);
}

function renderNotas(casoId, container, notas, falhou) {
  container.replaceChildren();

  if (falhou) {
    const erro = document.createElement('p');
    erro.className = 'vazio-suave';
    erro.textContent = 'Não consegui carregar as notas.';
    container.append(erro);
  }

  const lista = document.createElement('div');
  lista.className = 'esc-notas-lista';
  if (!notas.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio-suave';
    vazio.textContent = 'Nenhuma nota registrada ainda.';
    lista.append(vazio);
  } else {
    for (const nota of notas) lista.append(criarNotaItem(casoId, container, nota));
  }

  const form = document.createElement('form');
  form.className = 'esc-notas-form';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Escrever uma nova nota...';
  textarea.rows = 3;
  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'submit';
  btnSalvar.className = 'btn btn-forte';
  btnSalvar.textContent = 'Adicionar nota';
  form.append(textarea, btnSalvar);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const texto = textarea.value.trim();
    if (!texto) return;
    btnSalvar.disabled = true;
    const { ok, dados: resp } = await api(`/api/suporte-escalado/${casoId}/notas`, {
      metodo: 'POST', corpo: { nota: texto },
    });
    btnSalvar.disabled = false;
    if (!ok) {
      window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui salvar a nota.');
      return;
    }
    carregarNotas(casoId, container);
  });

  container.append(lista, form);
}

function criarNotaItem(casoId, container, nota) {
  const item = document.createElement('div');
  item.className = 'esc-nota';

  const cabeca = document.createElement('div');
  cabeca.className = 'esc-nota-cabeca';
  const autor = document.createElement('span');
  autor.className = 'esc-nota-autor';
  autor.textContent = nota.autor || 'Sem autor';
  const editada = nota.atualizado_em && nota.atualizado_em !== nota.criado_em;
  const quando = document.createElement('span');
  quando.className = 'esc-nota-quando';
  // Data e hora exatas visíveis (PDF 07/10, item 15); o relativo vai no tooltip.
  quando.textContent = editada
    ? `${dataHora(nota.criado_em)} · editada em ${dataHora(nota.atualizado_em)}`
    : dataHora(nota.criado_em);
  quando.title = relativo(nota.atualizado_em || nota.criado_em);
  const btnEditar = document.createElement('button');
  btnEditar.type = 'button';
  btnEditar.className = 'btn btn-icone';
  btnEditar.title = 'Editar esta nota';
  btnEditar.textContent = '✎';
  cabeca.append(autor, quando, btnEditar);

  const texto = document.createElement('p');
  texto.className = 'esc-nota-texto';
  texto.textContent = nota.nota;

  item.append(cabeca, texto);

  btnEditar.addEventListener('click', () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'esc-nota-editar';
    textarea.value = nota.nota;
    textarea.rows = 3;

    const acoes = document.createElement('div');
    acoes.className = 'esc-nota-editar-acoes';
    const btnSalvar = document.createElement('button');
    btnSalvar.type = 'button';
    btnSalvar.className = 'btn btn-forte';
    btnSalvar.textContent = 'Salvar';
    const btnCancelar = document.createElement('button');
    btnCancelar.type = 'button';
    btnCancelar.className = 'btn';
    btnCancelar.textContent = 'Cancelar';
    acoes.append(btnSalvar, btnCancelar);

    item.replaceChildren(cabeca, textarea, acoes);
    textarea.focus();

    btnCancelar.addEventListener('click', () => carregarNotas(casoId, container));
    btnSalvar.addEventListener('click', async () => {
      const novoTexto = textarea.value.trim();
      if (!novoTexto) return;
      btnSalvar.disabled = true;
      const { ok, dados: resp } = await api(`/api/suporte-escalado/notas/${nota.id}`, {
        metodo: 'PUT', corpo: { nota: novoTexto },
      });
      btnSalvar.disabled = false;
      if (!ok) {
        window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui salvar a nota.');
        return;
      }
      carregarNotas(casoId, container);
    });
  });

  return item;
}

/* ═══════════════════════════════  cartão  ═══════════════════════════════ */

const ROTULO_AMEACA = { chargeback: 'Chargeback', legal: 'Ameaça legal', ambos: 'Chargeback + ameaça legal' };
/* Tag do motivo do contato e prioridade Alta/Média (065, pedido da Késsia): automáticas, só leitura. */
export const ROTULO_TAG = { reembolso: 'Reembolso', chargeback: 'Chargeback', rastreio: 'Rastreio', outros: 'Outros motivos' };
const ROTULO_NIVEL = { alta: 'Prioridade Alta', media: 'Prioridade Média' };
const ROTULO_RASTREIO = { pending: 'Aguardando envio', shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado', nao_encontrado: 'Não encontrado', pendente_consulta: 'Ainda não consultado' };

function criarCard(item) {
  const card = document.createElement('div');
  card.className = 'esc-card';
  card.draggable = true;
  card.dataset.id = String(item.id);
  // Ameaça de chargeback/ameaça legal: card vermelho com alerta e etiqueta do motivo (só sai quando a equipe troca o status)
  const rotuloAmeaca = ROTULO_AMEACA[item.alerta_ameaca];
  if (rotuloAmeaca) card.dataset.ameaca = item.alerta_ameaca;
  if (expandidos.has(item.id)) card.dataset.expandido = 'sim';

  card.addEventListener('dragstart', () => {
    arrastandoId = item.id;
    card.dataset.arrastando = 'sim';
  });
  card.addEventListener('dragend', () => {
    arrastandoId = null;
    delete card.dataset.arrastando;
  });

  if (rotuloAmeaca) {
    const faixa = document.createElement('div');
    faixa.className = 'esc-card-ameaca';
    faixa.textContent = `🚨 ${rotuloAmeaca}`;
    faixa.title = 'Responder dentro do prazo de 2 dias úteis prometido ao cliente';
    card.append(faixa);
  }

  const nome = document.createElement('div');
  nome.className = 'esc-card-nome';
  nome.textContent = item.nome || item.remetente_email || '(sem nome)';
  card.append(nome);

  if (item.remetente_email) {
    const linhaEmail = document.createElement('div');
    linhaEmail.className = 'esc-card-email-linha';
    const email = document.createElement('span');
    email.className = 'esc-card-email';
    // Cartão de 280px não cabe um e-mail inteiro numa linha — em vez de deixar
    // o CSS quebrar em qualquer ponto (partia no meio do domínio), insere
    // <wbr> (oportunidade de quebra, sem caractere visível) depois do @ e de
    // cada ponto, pra a linha só cortar em lugar que ainda dá pra ler.
    item.remetente_email.split(/([@.])/).forEach((parte) => {
      email.append(document.createTextNode(parte));
      if (parte === '@' || parte === '.') email.append(document.createElement('wbr'));
    });
    linhaEmail.append(email, botaoCopiar(item.remetente_email, { titulo: `Copiar ${item.remetente_email}` }));
    card.append(linhaEmail);
  }

  if (item.produto_pedido) {
    const produto = document.createElement('div');
    produto.className = 'esc-card-produto';
    produto.textContent = `🛒 ${item.produto_pedido}`;
    card.append(produto);
  }

  const plataformaTxt = item.plataforma_origem ? rotularPlataforma(item.plataforma_origem) : 'Direto (nossa caixa)';
  const linhaPlataforma = document.createElement('div');
  linhaPlataforma.className = 'esc-card-plataforma';
  linhaPlataforma.textContent = `✉ ${plataformaTxt}`;
  card.append(linhaPlataforma);

  if (item.tag_motivo) {
    const tags = document.createElement('div');
    tags.className = 'esc-card-tags';
    const tag = document.createElement('span');
    tag.className = 'esc-tag esc-tag--' + item.tag_motivo;
    tag.textContent = ROTULO_TAG[item.tag_motivo] || item.tag_motivo;
    tags.append(tag);
    if (ROTULO_NIVEL[item.prioridade_nivel]) {
      const nivel = document.createElement('span');
      nivel.className = 'esc-nivel esc-nivel--' + item.prioridade_nivel;
      nivel.textContent = ROTULO_NIVEL[item.prioridade_nivel];
      tags.append(nivel);
    }
    card.append(tags);
  }

  if (item.motivo_escalonamento) {
    const motivo = document.createElement('div');
    motivo.className = 'esc-card-motivo';
    motivo.textContent = `⚠ ${item.motivo_escalonamento}`;
    card.append(motivo);
  }

  if (item.movido_em) {
    const mov = document.createElement('div');
    mov.className = 'esc-card-movimento';
    const de = item.movido_de ? `de ${item.movido_de} ` : '';
    mov.textContent = `↪ Movido ${de}por ${item.movido_por || 'Sistema'} · ${dataHora(item.movido_em)}`;
    card.append(mov);
  }

  if (item.resumo_conversa) {
    const resumo = document.createElement('p');
    resumo.className = 'esc-card-resumo';
    resumo.textContent = item.resumo_conversa;
    card.append(resumo);
  }

  // Motivo e resumo colapsam em 3 linhas (CSS) — o clique no cartão expande os
  // dois juntos. Antes só existia se tivesse resumo; um cartão só com motivo
  // longo ficava sem jeito nenhum de ler o texto cortado.
  if (item.motivo_escalonamento || item.resumo_conversa) {
    card.title = 'Clique para ver o texto completo';
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('select, button')) return;
      if (expandidos.has(item.id)) expandidos.delete(item.id);
      else expandidos.add(item.id);
      card.dataset.expandido = expandidos.has(item.id) ? 'sim' : 'nao';
    });
  }

  const rodape = document.createElement('div');
  rodape.className = 'esc-card-rodape';

  const quando = document.createElement('span');
  quando.className = 'esc-card-quando';
  quando.textContent = relativo(item.criado_em);
  quando.title = item.criado_em ? dataHora(item.criado_em) : '';

  const acoesEl = document.createElement('div');
  acoesEl.className = 'esc-card-acoes';

  const sel = document.createElement('select');
  sel.setAttribute('aria-label', `Mover ${item.nome || item.remetente_email} para outra coluna`);
  for (const c of colunas) {
    const opt = document.createElement('option');
    opt.value = c.chave;
    opt.textContent = c.rotulo;
    if (c.chave === item.status) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('click', (ev) => ev.stopPropagation());
  sel.addEventListener('change', (ev) => {
    ev.stopPropagation();
    moverStatus(item.id, sel.value);
  });

  const btnDetalhes = document.createElement('button');
  btnDetalhes.className = 'btn btn-icone';
  btnDetalhes.type = 'button';
  btnDetalhes.title = 'Ver detalhes e notas internas';
  btnDetalhes.textContent = 'ⓘ';
  btnDetalhes.addEventListener('click', (ev) => {
    ev.stopPropagation();
    abrirDetalheEscalado(item);
  });

  const btnAbrir = document.createElement('button');
  btnAbrir.className = 'btn btn-icone';
  btnAbrir.type = 'button';
  btnAbrir.title = 'Abrir este cliente em Tickets de atendimento';
  btnAbrir.textContent = '↗';
  btnAbrir.addEventListener('click', (ev) => {
    ev.stopPropagation();
    $('aba-btn-ticketsia').click();
    abrirNaTabela(item.remetente_email);
  });

  const btnWebmail = document.createElement('button');
  btnWebmail.className = 'btn btn-icone';
  btnWebmail.type = 'button';
  btnWebmail.textContent = '✉';
  if (item.email_id) {
    btnWebmail.title = 'Abrir o e-mail original na caixa (Hostinger)';
    btnWebmail.addEventListener('click', (ev) => {
      ev.stopPropagation();
      abrirNoWebmail(item.email_id, btnWebmail);
    });
  } else {
    btnWebmail.disabled = true;
    btnWebmail.title = 'Nenhum e-mail vinculado a este caso.';
  }

  const btnReativar = document.createElement('button');
  btnReativar.className = 'btn btn-icone';
  btnReativar.type = 'button';
  btnReativar.title = 'Reativar IA — apaga da lista de bloqueio';
  btnReativar.textContent = '↺';
  btnReativar.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reativar(item.id, item.nome || item.remetente_email);
  });

  acoesEl.append(btnDetalhes, sel, btnAbrir, btnWebmail, btnReativar);

  // Transferir pra outro board — administrador ou gestor, e só faz sentido existindo pra
  // onde mandar (outro board além do que já está aberto). Igual ao select
  // de mover coluna: some no card sem virar um modal à parte.
  if (souGestor && boards.length > 1) {
    const selTransferir = document.createElement('select');
    selTransferir.className = 'esc-card-transferir-select';
    selTransferir.setAttribute('aria-label', `Transferir ${item.nome || item.remetente_email} para outro board`);
    const optPlaceholder = document.createElement('option');
    optPlaceholder.value = '';
    optPlaceholder.textContent = 'Transferir para…';
    selTransferir.append(optPlaceholder);
    for (const b of boards) {
      if (b.id === boardId) continue;
      const opt = document.createElement('option');
      opt.value = String(b.id);
      opt.textContent = b.nome;
      selTransferir.append(opt);
    }
    selTransferir.addEventListener('click', (ev) => ev.stopPropagation());
    selTransferir.addEventListener('change', (ev) => {
      ev.stopPropagation();
      const destino = boards.find((b) => b.id === Number(selTransferir.value));
      if (!destino) return;
      const confirmou = window.confirm(
        `Transferir ${item.nome || item.remetente_email} para o board "${destino.nome}"?\n\n`
        + 'O caso volta pra coluna "Pendente" nesse board (perde iniciado/finalizado daqui).',
      );
      if (!confirmou) { selTransferir.value = ''; return; }
      transferirCaso(item.id, destino.id);
    });
    acoesEl.append(selTransferir);
  }

  rodape.append(quando, acoesEl);
  card.append(rodape);

  return card;
}

/* ══════════════════════════  arrastar o board  ══════════════════════════
   Mesmo padrão de pegar-e-arrastar do canvas da régua (ligarArrasto em
   regua.js, "como no n8n") — mouse comum não tem scroll horizontal, só
   Shift+roda ou a barrinha fina. Só em X (o board não rola na vertical) e
   ignora o gesto se começar em cima de um cartão: o cartão já tem o
   próprio arrasto nativo (mover entre colunas) e o próprio clique
   (expandir o resumo) — os dois não podem competir pelo mesmo pointerdown. */
function ligarArrastoBoard(alvo) {
  let apertado = false;
  let arrastou = false;
  let x0 = 0;
  let sx = 0;

  alvo.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.esc-card')) return;
    apertado = true;
    arrastou = false;
    x0 = ev.clientX;
    sx = alvo.scrollLeft;
  });

  alvo.addEventListener('pointermove', (ev) => {
    if (!apertado) return;
    const dx = ev.clientX - x0;
    if (!arrastou) {
      if (Math.abs(dx) < 5) return;
      arrastou = true;
      alvo.setPointerCapture(ev.pointerId);
      alvo.dataset.arrastando = 'sim';
    }
    alvo.scrollLeft = sx - dx;
  });

  const soltar = () => {
    apertado = false;
    delete alvo.dataset.arrastando;
  };
  alvo.addEventListener('pointerup', soltar);
  alvo.addEventListener('pointercancel', soltar);
}

/* ═══════════════════════════════  board  ═══════════════════════════════ */

function itensFiltrados() {
  let lista = itens;
  if (busca) {
    const q = busca.toLowerCase();
    lista = lista.filter((i) => (i.nome ?? '').toLowerCase().includes(q)
      || (i.remetente_email ?? '').toLowerCase().includes(q)
      || (i.resumo_conversa ?? '').toLowerCase().includes(q)
      || (i.motivo_escalonamento ?? '').toLowerCase().includes(q));
  }
  return [...lista].sort((a, b) => {
    const da = new Date(a.criado_em ?? 0).getTime();
    const db = new Date(b.criado_em ?? 0).getTime();
    return ordem === 'antigos' ? da - db : db - da;
  });
}

/**
 * Troca o cabeçalho de uma coluna pelo modo de edição (nome + descrição,
 * com Salvar/Cancelar) — chamado pelo botão ✎, e também de novo a cada
 * renderBoard() automático enquanto `colunaEditandoId` apontar pra essa
 * coluna (ver comentário de `colunaEditandoId` lá em cima): o formulário
 * (e o que já foi digitado, via `colunaEditandoRascunho`) sobrevive ao
 * refresh de 25s em vez de fechar sozinho no meio da digitação.
 * `focar` só é true na abertura pelo clique — nos re-renders automáticos
 * não deve roubar o foco nem re-selecionar o texto (senão a próxima tecla
 * digitada apagaria tudo de novo).
 * `flag.feito` evita rodar commit() duas vezes (Enter chama commit direto;
 * blur do input também dispara commit; sem a trava, Escape+blur poderia
 * mandar a chamada duas vezes ou reabrir a coluna já cancelada).
 */
function editarCabecaColuna(c, cabeca, { focar = false } = {}) {
  colunaEditandoId = c.id;
  if (colunaEditandoRascunho.id !== c.id) {
    colunaEditandoRascunho = { id: c.id, rotulo: c.rotulo, descricao: c.descricao ?? '' };
  }
  const rascunho = colunaEditandoRascunho;

  cabeca.replaceChildren();
  cabeca.classList.add('esc-coluna-cabeca--editando');

  const form = document.createElement('form');
  form.className = 'esc-coluna-editar-form';

  const inputRotulo = document.createElement('input');
  inputRotulo.type = 'text';
  inputRotulo.className = 'esc-coluna-editar-rotulo';
  inputRotulo.value = rascunho.rotulo;
  inputRotulo.maxLength = 60;
  inputRotulo.placeholder = 'Nome da coluna';
  inputRotulo.required = true;
  inputRotulo.addEventListener('input', () => { rascunho.rotulo = inputRotulo.value; });

  const inputDescricao = document.createElement('input');
  inputDescricao.type = 'text';
  inputDescricao.className = 'esc-coluna-editar-descricao';
  inputDescricao.value = rascunho.descricao;
  inputDescricao.maxLength = 300;
  inputDescricao.placeholder = 'Pra que serve esta coluna (opcional)';
  inputDescricao.addEventListener('input', () => { rascunho.descricao = inputDescricao.value; });

  const acoes = document.createElement('div');
  acoes.className = 'esc-coluna-editar-acoes';
  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'submit';
  btnSalvar.className = 'btn btn-forte';
  btnSalvar.textContent = 'Salvar';
  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button';
  btnCancelar.className = 'btn';
  btnCancelar.textContent = 'Cancelar';
  acoes.append(btnSalvar, btnCancelar);

  form.append(inputRotulo, inputDescricao, acoes);
  cabeca.append(form);
  if (focar) { inputRotulo.focus(); inputRotulo.select(); }

  const fecharEdicao = () => {
    colunaEditandoId = null;
    colunaEditandoRascunho = { rotulo: '', descricao: '' };
  };

  const flag = { feito: false };
  btnCancelar.addEventListener('click', () => { flag.feito = true; fecharEdicao(); renderBoard(); });
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); flag.feito = true; fecharEdicao(); renderBoard(); }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (flag.feito) return;
    flag.feito = true;
    const rotulo = inputRotulo.value.trim();
    if (!rotulo) { fecharEdicao(); renderBoard(); return; }
    btnSalvar.disabled = true;
    const ok = await editarColuna(c.id, rotulo, inputDescricao.value.trim());
    if (ok) fecharEdicao();
    else { flag.feito = false; btnSalvar.disabled = false; }
  });
}

function renderBoard() {
  const lista = itensFiltrados();
  const board = $('esc-board');
  board.replaceChildren();

  colunas.forEach((c, indice) => {
    const doColuna = lista.filter((i) => i.status === c.chave);
    const { pagina: paginaAtual, totalPaginas, fatia } = paginar(
      doColuna, paginaColuna.get(c.chave) ?? 1, POR_PAGINA_COLUNA,
    );
    paginaColuna.set(c.chave, paginaAtual);

    const coluna = document.createElement('div');
    coluna.className = 'cartao esc-coluna';
    coluna.dataset.status = c.chave;
    coluna.dataset.tom = tomColuna(indice);

    coluna.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      coluna.dataset.arrasteSobre = 'sim';
    });
    coluna.addEventListener('dragleave', () => { delete coluna.dataset.arrasteSobre; });
    coluna.addEventListener('drop', (ev) => {
      ev.preventDefault();
      delete coluna.dataset.arrasteSobre;
      if (arrastandoId != null) moverStatus(arrastandoId, c.chave);
    });

    const cabeca = document.createElement('div');
    cabeca.className = 'esc-coluna-cabeca';

    if (colunaEditandoId === c.id) {
      editarCabecaColuna(c, cabeca);
    } else {
      const tituloLinha = document.createElement('div');
      tituloLinha.className = 'esc-coluna-titulo-linha';
      const titulo = document.createElement('div');
      titulo.className = 'esc-coluna-titulo';
      const dot = document.createElement('i');
      dot.textContent = '●';
      titulo.append(dot, document.createTextNode(c.rotulo));
      const qtd = document.createElement('span');
      qtd.className = 'esc-coluna-qtd';
      qtd.textContent = n(doColuna.length);
      tituloLinha.append(titulo, qtd);

      const acoesColuna = document.createElement('div');
      acoesColuna.className = 'esc-coluna-acoes';
      const btnEditarColuna = document.createElement('button');
      btnEditarColuna.type = 'button';
      btnEditarColuna.className = 'btn btn-icone';
      btnEditarColuna.title = 'Editar nome e descrição desta coluna';
      btnEditarColuna.textContent = '✎';
      btnEditarColuna.addEventListener('click', () => editarCabecaColuna(c, cabeca, { focar: true }));
      const btnApagarColuna = document.createElement('button');
      btnApagarColuna.type = 'button';
      btnApagarColuna.className = 'btn btn-icone';
      btnApagarColuna.textContent = '🗑';
      if (doColuna.length) {
        btnApagarColuna.disabled = true;
        btnApagarColuna.title = `Só dá para apagar uma coluna vazia — esta tem ${n(doColuna.length)} caso${doColuna.length === 1 ? '' : 's'}.`;
      } else {
        btnApagarColuna.title = 'Apagar esta coluna';
        btnApagarColuna.addEventListener('click', () => apagarColuna(c.id, c.rotulo));
      }
      acoesColuna.append(btnEditarColuna, btnApagarColuna);

      cabeca.append(tituloLinha, acoesColuna);
      if (c.descricao) {
        const descricao = document.createElement('p');
        descricao.className = 'esc-coluna-descricao';
        descricao.textContent = c.descricao;
        cabeca.append(descricao);
      }
    }

    const corpo = document.createElement('div');
    corpo.className = 'esc-coluna-corpo';
    if (!doColuna.length) {
      const vazio = document.createElement('p');
      vazio.className = 'esc-coluna-vazia';
      vazio.textContent = 'vazio';
      corpo.append(vazio);
    } else {
      corpo.append(...fatia.map(criarCard));
    }

    coluna.append(cabeca, corpo);

    if (doColuna.length) {
      const pag = document.createElement('div');
      montarPaginacao(pag, {
        pagina: paginaAtual, totalPaginas, total: doColuna.length, rotuloItem: 'caso',
      }, (novaPagina) => {
        paginaColuna.set(c.chave, novaPagina);
        renderBoard();
      });
      coluna.append(pag);
    }

    board.append(coluna);
  });

  board.append(criarColunaFantasma());
}

/** Última "coluna" do board — não é uma coluna de verdade, é o formulário
 *  de criar uma nova (mesmo padrão de "+ Nova coluna" de kanbans conhecidos:
 *  um botão fantasma que vira formulário ao clicar).
 *  Aberto/fechado e o que já foi digitado ficam em `novaColunaAberta` /
 *  `novaColunaRascunho` (module-level) porque essa função é recriada do
 *  zero a cada renderBoard() — inclusive nos automáticos, a cada 25s (ver
 *  carregarDados) — e sem isso o formulário fechava e o texto digitado
 *  sumia no meio do caminho. */
function criarColunaFantasma() {
  const coluna = document.createElement('div');
  coluna.className = 'cartao esc-coluna esc-coluna--nova';

  const btnAbrir = document.createElement('button');
  btnAbrir.type = 'button';
  btnAbrir.className = 'esc-coluna-nova-btn';
  btnAbrir.textContent = '+ Nova coluna';
  btnAbrir.hidden = novaColunaAberta;

  const form = document.createElement('form');
  form.className = 'esc-coluna-nova-form';
  form.hidden = !novaColunaAberta;
  const inputRotulo = document.createElement('input');
  inputRotulo.type = 'text';
  inputRotulo.placeholder = 'Nome da coluna';
  inputRotulo.maxLength = 60;
  inputRotulo.required = true;
  inputRotulo.value = novaColunaRascunho.rotulo;
  inputRotulo.addEventListener('input', () => { novaColunaRascunho.rotulo = inputRotulo.value; });
  const inputDescricao = document.createElement('input');
  inputDescricao.type = 'text';
  inputDescricao.placeholder = 'Pra que serve esta coluna (opcional)';
  inputDescricao.maxLength = 300;
  inputDescricao.value = novaColunaRascunho.descricao;
  inputDescricao.addEventListener('input', () => { novaColunaRascunho.descricao = inputDescricao.value; });
  const acoes = document.createElement('div');
  acoes.className = 'esc-coluna-nova-acoes';
  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'submit';
  btnSalvar.className = 'btn btn-forte';
  btnSalvar.textContent = 'Criar';
  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button';
  btnCancelar.className = 'btn';
  btnCancelar.textContent = 'Cancelar';
  acoes.append(btnSalvar, btnCancelar);
  form.append(inputRotulo, inputDescricao, acoes);

  btnAbrir.addEventListener('click', () => {
    novaColunaAberta = true;
    btnAbrir.hidden = true;
    form.hidden = false;
    inputRotulo.focus();
  });
  btnCancelar.addEventListener('click', () => {
    novaColunaAberta = false;
    novaColunaRascunho = { rotulo: '', descricao: '' };
    renderBoard();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const rotulo = inputRotulo.value.trim();
    if (!rotulo) return;
    btnSalvar.disabled = true;
    const ok = await criarColuna(rotulo, inputDescricao.value.trim());
    if (ok) {
      novaColunaAberta = false;
      novaColunaRascunho = { rotulo: '', descricao: '' };
    } else {
      btnSalvar.disabled = false;
    }
  });

  coluna.append(btnAbrir, form);
  return coluna;
}

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

let geracao = 0;

/** Mensagem no lugar do board quando ainda não há um `boardId` resolvido —
 *  três casos possíveis: quem não é admin e não tem board vinculado (pede
 *  pra um admin criar), admin sem nenhum board criado ainda (aponta o botão
 *  "+ Novo board"), ou quem tem/vê mais de um board e precisa escolher no
 *  seletor. A aba continua visível nos três casos — nunca se esconde. */
function renderSemBoard() {
  const board = $('esc-board');
  board.replaceChildren();
  const p = document.createElement('p');
  p.className = 'vazio-suave';
  if (!souGestor && !boards.length) {
    p.textContent = 'Você ainda não tem um kanban vinculado — peça a um administrador para criar um board para você.';
  } else if (souGestor && !boards.length) {
    p.textContent = 'Nenhum board criado ainda — use "+ Novo board" para criar o primeiro.';
  } else {
    p.textContent = 'Escolha um board acima para ver o kanban.';
  }
  board.append(p);
}

/** Visão geral (admin, boardId === 'todos'): não existe drag-and-drop porque
 *  cada board tem suas próprias colunas — em vez disso, uma tabela com o
 *  resumo de cada board. Os KPIs do topo e a aba "Tempo no kanban" (mediana
 *  até sair de Pendente, transições, movidos por dia…) continuam os mesmos
 *  componentes de sempre, só que alimentados com dados agregados de todos
 *  os boards — não precisam de nenhuma mudança pra funcionar aqui. */
function renderVisaoGeral() {
  const board = $('esc-board');
  board.replaceChildren();
  if (!boardsResumo || !boardsResumo.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio-suave';
    vazio.textContent = 'Nenhum board criado ainda.';
    board.append(vazio);
    return;
  }
  const envolve = document.createElement('div');
  envolve.className = 'tabela-envolve';
  const tabela = document.createElement('table');
  tabela.className = 'tabela';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th scope="col">Board</th><th scope="col">Responsável</th>'
    + '<th scope="col">Pendentes</th><th scope="col">Total de casos</th></tr>';
  const corpo = document.createElement('tbody');
  for (const b of boardsResumo) {
    const tr = document.createElement('tr');
    const tdNome = document.createElement('td');
    tdNome.className = 'cel-forte';
    tdNome.textContent = b.nome + (b.ativo === false ? ' (inativo)' : '');
    const tdResp = document.createElement('td');
    tdResp.textContent = b.usuario_nome || b.usuario_email || '—';
    const tdPend = document.createElement('td');
    tdPend.className = 'num';
    tdPend.textContent = n(b.pendentes);
    const tdTotal = document.createElement('td');
    tdTotal.className = 'num';
    tdTotal.textContent = n(b.total);
    tr.append(tdNome, tdResp, tdPend, tdTotal);
    corpo.append(tr);
  }
  tabela.append(thead, corpo);
  envolve.append(tabela);
  board.append(envolve);
}

/**
 * "Insights automáticos" — GLOBAL (todos os boards), por isso não depende de
 * `boardId` estar escolhido, diferente de `carregarDados()` abaixo.
 */
async function carregarInsightsEscalado() {
  try {
    const { ok, dados: d } = await api('/api/suporte-escalado/insights');
    if (!ok) return;
    $('esc-insights').replaceChildren(...(d.insights ?? []).map((i) => {
      const li = document.createElement('li');
      li.className = 'sup-insight';
      li.dataset.nivel = i.nivel;
      li.textContent = i.texto;
      return li;
    }));
  } catch { /* silencioso — não é crítico como o kanban */ }
}

export async function carregarDados(opcoes = {}) {
  const meu = ++geracao;
  carregarAjudaRecebida();
  if (!boardId) {
    colunas = [];
    kpis = {};
    itens = [];
    transicoes = [];
    movimentosDiarios = [];
    resumoMovimentos = {};
    boardsResumo = null;
    renderKpis();
    renderSemBoard();
    renderKpisTempo();
    renderGraficosTempo();
    renderTabelaTransicoes();
    return;
  }
  try {
    const p = new URLSearchParams();
    p.set('board_id', boardId);
    if (busca && boardId !== 'todos') p.set('q', busca);
    if (plataforma && boardId !== 'todos') p.set('plataforma', plataforma);
    const { ok, dados: d } = await api(`/api/suporte-escalado?${p}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(d?.detail ?? d?.erro ?? 'falha ao carregar');
    // Atualização periódica sem novidade: não refaz cards, KPIs nem gráficos (era ~1 MB redesenhado a
    // cada 25 s). Chamadas explícas (mover card, trocar filtro...) sempre redesenham.
    const assinatura = JSON.stringify(d);
    if (opcoes?.periodico === true && assinatura === ultimaAssinatura) return;
    ultimaAssinatura = assinatura;
    colunas = d.colunas ?? [];
    kpis = d.kpis ?? {};
    itens = d.itens ?? [];
    transicoes = d.transicoes ?? [];
    movimentosDiarios = d.movimentos_diarios ?? [];
    resumoMovimentos = d.resumo_movimentos ?? {};
    boardsResumo = d.boards_resumo ?? null;
    renderKpis();
    if (boardId === 'todos') renderVisaoGeral(); else renderBoard();
    renderKpisTempo();
    renderGraficosTempo();
    renderTabelaTransicoes();
  } catch (err) {
    if (meu !== geracao) return;
    const board = $('esc-board');
    board.replaceChildren();
    const p2 = document.createElement('p');
    p2.className = 'vazio-suave';
    p2.textContent = `Não consegui carregar: ${err.message}`;
    board.append(p2);
  }
}

$('esc-busca').addEventListener('input', debounce((e) => {
  busca = e.target.value.trim();
  paginaColuna.clear();
  carregarDadosSeVisivel();
}, 350));
$('esc-ordem').addEventListener('change', (e) => {
  ordem = e.target.value || 'recentes';
  paginaColuna.clear();
  if (boardId && boardId !== 'todos') renderBoard();
});
$('esc-plataforma').addEventListener('change', (e) => {
  plataforma = e.target.value || '';
  paginaColuna.clear();
  carregarDadosSeVisivel();
});

$('esc-board-seletor').addEventListener('change', (e) => {
  boardId = e.target.value === 'todos' ? 'todos' : (Number(e.target.value) || null);
  if (boardId) localStorage.setItem('escBoardId', String(boardId));
  paginaColuna.clear();
  expandidos.clear();
  renderControlesBoard();
  carregarDadosSeVisivel();
  // Sub-aba "Respostas dos formulários" tem seu próprio carregamento (só
  // dispara ao abrir a sub-aba) — sem isto, trocar o board com essa sub-aba
  // já aberta deixava a tabela mostrando o board antigo até alguém recarregar.
  if (!$('esc-subaba-formularios').hidden) carregarFormularios(boardId);
});
$('esc-board-novo').addEventListener('click', () => {
  boardFormAberto = 'novo';
  renderFormBoard();
});
$('esc-board-editar').addEventListener('click', () => {
  if (!boardId) return;
  boardFormAberto = boardId;
  renderFormBoard();
});

ligarArrastoBoard($('esc-board'));

carregarBoards();
carregarInsightsEscalado();
// Aba escondida não atualiza (várias abas abertas o dia todo multiplicavam a carga); ao voltar, atualiza na hora.
setInterval(() => { if (!document.hidden) { carregarDadosSeVisivel({ periodico: true }); } }, 30 * 1000);
setInterval(() => { if (!document.hidden) carregarInsightsEscalado(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    carregarDados({ periodico: true });
    carregarInsightsEscalado();
  }
});
