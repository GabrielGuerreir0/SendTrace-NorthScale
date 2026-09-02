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
  tooltip, renderTabela,
} from './emailComum.js';
import { n, relativo, dataHora, duracaoH } from './format.js';
import { desenharColunas } from './charts.js';
import { abrirNaTabela } from './emailTickets.js';

/* ═══════════════════════════════  estado  ═══════════════════════════════ */

let itens = [];
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
let ordem = 'recentes'; // 'recentes' | 'antigos'
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
let orfaos = 0;
/** Resumo por board (dono, pendentes, total) — só preenchido quando
 *  `boardId === 'todos'`; é o que renderVisaoGeral() usa no lugar do
 *  drag-and-drop de sempre. */
let boardsResumo = null;
/** null = formulário fechado; 'novo' = criando; um id = editando aquele board. */
let boardFormAberto = null;
/** Lista de usuários pro <select> de vincular — carregada uma vez (admin),
 *  cacheada porque não muda durante a sessão do jeito que os boards mudam. */
let usuariosCache = null;

async function usuariosParaSelect() {
  if (usuariosCache) return usuariosCache;
  const { ok, dados } = await api('/api/usuarios');
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
  if (souAdmin) {
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
  campoSel.hidden = !(souAdmin || boards.length > 1);

  btnNovo.hidden = !souAdmin;
  btnEditar.hidden = !(souAdmin && boardId && boardId !== 'todos');

  if (souAdmin && orfaos > 0) {
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
async function carregarBoards() {
  const { ok, dados } = await api('/api/suporte-escalado/boards');
  if (!ok) {
    boards = [];
    souAdmin = false;
    orfaos = 0;
    boardId = null;
    renderControlesBoard();
    await carregarDados();
    return;
  }
  boards = dados.boards ?? [];
  souAdmin = Boolean(dados.admin);
  orfaos = dados.orfaos ?? 0;

  const salvoRaw = localStorage.getItem('escBoardId');
  if (salvoRaw === 'todos' && souAdmin) {
    boardId = 'todos';
  } else {
    const salvo = Number(salvoRaw);
    if (salvo && boards.some((b) => b.id === salvo)) {
      boardId = salvo;
    } else if (boards.length === 1) {
      boardId = boards[0].id;
    } else {
      boardId = null;
    }
  }
  if (boardId) localStorage.setItem('escBoardId', String(boardId));

  renderControlesBoard();
  await renderFormBoard();
  await carregarDados();
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
const SUBABAS = { kanban: 'esc-subaba-kanban', metricas: 'esc-subaba-metricas' };

function mostrarSubaba(qual) {
  for (const [nome, id] of Object.entries(SUBABAS)) {
    $(id).hidden = nome !== qual;
    $(`esc-subaba-btn-${nome}`).setAttribute('aria-selected', String(nome === qual));
  }
  localStorage.setItem('escSubaba', qual);
  if (qual === 'metricas') renderGraficosTempo();
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
 * SÓ abre a aba depois que a URL chega. A versão anterior pré-abria uma aba
 * em branco para driblar bloqueador de pop-up e trocava o endereço dela
 * depois — mas se a busca no IMAP demorasse ou falhasse, sobrava uma aba
 * `about:blank` travada (alguns navegadores ignoram `.close()` numa aba que
 * o usuário já olhou). Preferível arriscar o pop-up ser bloqueado (o
 * `window.open` ainda roda perto o bastante do clique pra maioria dos
 * navegadores aceitar) do que garantir uma aba fantasma no erro.
 */
async function abrirNoWebmail(emailId, botao) {
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = '…';
  try {
    const { ok, dados: resp } = await api(`/api/emails/${emailId}/webmail`);
    if (!ok || !resp?.url) {
      window.alert(resp?.erro ?? resp?.detail ?? 'Não consegui achar este e-mail na caixa.');
      return;
    }
    const aba = window.open(resp.url, '_blank', 'noopener,noreferrer');
    if (!aba) window.alert(`Seu navegador bloqueou a aba. Abra manualmente:\n${resp.url}`);
  } catch {
    window.alert('Não consegui achar este e-mail na caixa.');
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

function abrirDetalheEscalado(item) {
  const notasContainer = document.createElement('div');
  notasContainer.className = 'esc-notas';
  notasContainer.textContent = 'Carregando notas…';

  const rotuloStatus = rotularStatus(item.status);

  abrirFicha({
    titulo: item.nome || item.remetente_email || '(sem nome)',
    subtitulo: item.remetente_email || '',
    campos: [
      { rotulo: 'Status', valor: rotuloStatus },
      { rotulo: 'Escalado em', valor: item.criado_em ? dataHora(item.criado_em) : '—' },
      { rotulo: 'Iniciado em', valor: item.iniciado_em ? dataHora(item.iniciado_em) : '—' },
      { rotulo: 'Finalizado em', valor: item.finalizado_em ? dataHora(item.finalizado_em) : '—' },
      { rotulo: 'Motivo do escalonamento', valor: item.motivo_escalonamento || '—', largo: true },
      { rotulo: 'Resumo da conversa', valor: item.resumo_conversa || '—', largo: true },
      { rotulo: 'Notas internas', valor: notasContainer, largo: true },
    ],
  });

  carregarNotas(item.id, notasContainer);
}

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
  quando.textContent = (editada ? 'editada ' : '') + relativo(nota.atualizado_em || nota.criado_em);
  quando.title = editada
    ? `Criada em ${dataHora(nota.criado_em)} · editada em ${dataHora(nota.atualizado_em)}`
    : `Criada em ${dataHora(nota.criado_em)}`;
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

function criarCard(item) {
  const card = document.createElement('div');
  card.className = 'esc-card';
  card.draggable = true;
  card.dataset.id = String(item.id);
  if (expandidos.has(item.id)) card.dataset.expandido = 'sim';

  card.addEventListener('dragstart', () => {
    arrastandoId = item.id;
    card.dataset.arrastando = 'sim';
  });
  card.addEventListener('dragend', () => {
    arrastandoId = null;
    delete card.dataset.arrastando;
  });

  const nome = document.createElement('div');
  nome.className = 'esc-card-nome';
  nome.textContent = item.nome || item.remetente_email || '(sem nome)';
  card.append(nome);

  if (item.remetente_email) {
    const linhaEmail = document.createElement('div');
    linhaEmail.className = 'esc-card-email-linha';
    const email = document.createElement('span');
    email.className = 'esc-card-email';
    email.textContent = item.remetente_email;
    linhaEmail.append(email, botaoCopiar(item.remetente_email, { titulo: `Copiar ${item.remetente_email}` }));
    card.append(linhaEmail);
  }

  if (item.motivo_escalonamento) {
    const motivo = document.createElement('div');
    motivo.className = 'esc-card-motivo';
    motivo.textContent = `⚠ ${item.motivo_escalonamento}`;
    card.append(motivo);
  }

  if (item.resumo_conversa) {
    const resumo = document.createElement('p');
    resumo.className = 'esc-card-resumo';
    resumo.textContent = item.resumo_conversa;
    card.append(resumo);
    card.title = 'Clique para ver o resumo completo';
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
  if (!souAdmin && !boards.length) {
    p.textContent = 'Você ainda não tem um kanban vinculado — peça a um administrador para criar um board para você.';
  } else if (souAdmin && !boards.length) {
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

export async function carregarDados() {
  const meu = ++geracao;
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
    const { ok, dados: d } = await api(`/api/suporte-escalado?${p}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(d?.detail ?? d?.erro ?? 'falha ao carregar');
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
  carregarDados();
}, 350));
$('esc-ordem').addEventListener('change', (e) => {
  ordem = e.target.value || 'recentes';
  paginaColuna.clear();
  if (boardId && boardId !== 'todos') renderBoard();
});

$('esc-board-seletor').addEventListener('change', (e) => {
  boardId = e.target.value === 'todos' ? 'todos' : (Number(e.target.value) || null);
  if (boardId) localStorage.setItem('escBoardId', String(boardId));
  paginaColuna.clear();
  expandidos.clear();
  renderControlesBoard();
  carregarDados();
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
setInterval(carregarDados, 25 * 1000);
