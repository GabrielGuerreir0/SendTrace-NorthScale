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
  $, api, debounce, kpiCard, paginar, montarPaginacao, botaoCopiar,
} from './emailComum.js';
import { n, relativo, dataHora } from './format.js';

/* ═══════════════════════════════  estado  ═══════════════════════════════ */

let itens = [];
let kpis = {};
let busca = '';
let ordem = 'recentes'; // 'recentes' | 'antigos'
const expandidos = new Set();
let arrastandoId = null;
const POR_PAGINA_COLUNA = 8;
/** 1 página por coluna, independentes entre si — status → nº da página atual. */
const paginaColuna = new Map();

const COLUNAS = [
  { status: 'pendente', rotulo: 'Pendente' },
  { status: 'iniciado', rotulo: 'Iniciado' },
  { status: 'esperando_resposta', rotulo: 'Esperando resposta' },
  { status: 'finalizado', rotulo: 'Finalizado' },
];

/* ═══════════════════════════════  KPIs  ═══════════════════════════════ */

function renderKpis() {
  $('esc-kpis').replaceChildren(
    kpiCard({
      icone: '●', tom: 'travado', rotulo: 'Pendente', valor: n(kpis.pendente ?? 0),
      nota: 'aguardando o primeiro atendimento',
    }),
    kpiCard({
      icone: '●', tom: 'atrasado', rotulo: 'Iniciado', valor: n(kpis.iniciado ?? 0),
      nota: 'em atendimento humano',
    }),
    kpiCard({
      icone: '●', tom: 'em_dia', rotulo: 'Esperando resposta', valor: n(kpis.esperando_resposta ?? 0),
      nota: 'aguardando o cliente responder',
    }),
    kpiCard({
      icone: '●', tom: 'finalizado', rotulo: 'Finalizado', valor: n(kpis.finalizado ?? 0),
      nota: 'atendimento concluído',
    }),
  );
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
  for (const c of COLUNAS) {
    const opt = document.createElement('option');
    opt.value = c.status;
    opt.textContent = c.rotulo;
    if (c.status === item.status) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('click', (ev) => ev.stopPropagation());
  sel.addEventListener('change', (ev) => {
    ev.stopPropagation();
    moverStatus(item.id, sel.value);
  });

  const btnReativar = document.createElement('button');
  btnReativar.className = 'btn btn-icone';
  btnReativar.type = 'button';
  btnReativar.title = 'Reativar IA — apaga da lista de bloqueio';
  btnReativar.textContent = '↺';
  btnReativar.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reativar(item.id, item.nome || item.remetente_email);
  });

  acoesEl.append(sel, btnReativar);
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

function renderBoard() {
  const lista = itensFiltrados();
  const board = $('esc-board');
  board.replaceChildren();

  for (const c of COLUNAS) {
    const doColuna = lista.filter((i) => i.status === c.status);
    const { pagina: paginaAtual, totalPaginas, fatia } = paginar(
      doColuna, paginaColuna.get(c.status) ?? 1, POR_PAGINA_COLUNA,
    );
    paginaColuna.set(c.status, paginaAtual);

    const coluna = document.createElement('div');
    coluna.className = 'cartao esc-coluna';
    coluna.dataset.status = c.status;

    coluna.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      coluna.dataset.arrasteSobre = 'sim';
    });
    coluna.addEventListener('dragleave', () => { delete coluna.dataset.arrasteSobre; });
    coluna.addEventListener('drop', (ev) => {
      ev.preventDefault();
      delete coluna.dataset.arrasteSobre;
      if (arrastandoId != null) moverStatus(arrastandoId, c.status);
    });

    const cabeca = document.createElement('div');
    cabeca.className = 'esc-coluna-cabeca';
    const titulo = document.createElement('div');
    titulo.className = 'esc-coluna-titulo';
    const dot = document.createElement('i');
    dot.textContent = '●';
    titulo.append(dot, document.createTextNode(c.rotulo));
    const qtd = document.createElement('span');
    qtd.className = 'esc-coluna-qtd';
    qtd.textContent = n(doColuna.length);
    cabeca.append(titulo, qtd);

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
        paginaColuna.set(c.status, novaPagina);
        renderBoard();
      });
      coluna.append(pag);
    }

    board.append(coluna);
  }
}

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

let geracao = 0;

export async function carregarDados() {
  const meu = ++geracao;
  try {
    const p = new URLSearchParams();
    if (busca) p.set('q', busca);
    const { ok, dados: d } = await api(`/api/suporte-escalado?${p}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(d?.detail ?? d?.erro ?? 'falha ao carregar');
    kpis = d.kpis ?? {};
    itens = d.itens ?? [];
    renderKpis();
    renderBoard();
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
  renderBoard();
});

ligarArrastoBoard($('esc-board'));

carregarDados();
setInterval(carregarDados, 25 * 1000);
