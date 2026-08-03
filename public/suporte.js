/**
 * A aba SUPORTE IA — a principal do painel.
 *
 * Em menos de 30 segundos um gestor responde: a IA está resolvendo? Estamos
 * evitando reembolsos? Quais os principais motivos de contato? O que a IA
 * ainda não sabe? Há algo exigindo ação imediata?
 *
 * Tudo vem de `/api/suporte` (o servidor agrega e escreve os insights); aqui
 * é só desenho. Nenhum número aparece só como cor ou barra: todo valor também
 * está em texto.
 */
import { n, relativo, dataHora } from './format.js';

const $ = (id) => document.getElementById(id);

/* ══════════════════════════════  abas  ══════════════════════════════ */

/**
 * A troca de aba é só exibição: as duas <main> continuam no DOM e os timers
 * de cada uma seguem rodando — voltar para uma aba nunca mostra dado velho.
 * A escolha fica salva; "suporte" é o padrão por ser a aba principal.
 */
const ABAS = { suporte: 'aba-suporte', regua: 'aba-regua' };

function mostrarAba(qual) {
  for (const [nome, id] of Object.entries(ABAS)) {
    $(id).hidden = nome !== qual;
    $(`aba-btn-${nome}`).setAttribute('aria-selected', String(nome === qual));
  }
  localStorage.setItem('aba', qual);
}

$('aba-btn-suporte').addEventListener('click', () => mostrarAba('suporte'));
$('aba-btn-regua').addEventListener('click', () => mostrarAba('regua'));
mostrarAba(ABAS[localStorage.getItem('aba')] ? localStorage.getItem('aba') : 'suporte');

/*
 * O menu lateral se recolhe para uma coluna de ícones. O estado é do CSS
 * (body[data-menu]) e fica salvo — quem trabalha com ele fechado não o
 * reabre a cada visita. Abaixo de 720px o CSS força o recolhido; o estado
 * salvo volta a valer no desktop.
 */
function pintarMenu() {
  const fechado = document.body.dataset.menu === 'fechado';
  const btn = $('menu-alternar');
  btn.setAttribute('aria-expanded', String(!fechado));
  btn.title = fechado ? 'Expandir o menu' : 'Recolher o menu';
  btn.querySelector('.menu-rotulo').textContent = fechado ? 'Expandir' : 'Recolher';
}

if (localStorage.getItem('menu') === 'fechado') document.body.dataset.menu = 'fechado';
pintarMenu();

$('menu-alternar').addEventListener('click', () => {
  const fechado = document.body.dataset.menu === 'fechado';
  document.body.dataset.menu = fechado ? 'aberto' : 'fechado';
  localStorage.setItem('menu', document.body.dataset.menu);
  pintarMenu();
});

/* ═════════════════════════════  formato  ════════════════════════════ */

const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);

function duracao(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/* ═════════════════════════════  desenho  ════════════════════════════ */

function renderInsights(s) {
  $('sup-insights').replaceChildren(...(s.insights ?? []).map((i) => {
    const li = document.createElement('li');
    li.className = 'sup-insight';
    li.dataset.nivel = i.nivel;
    li.textContent = i.texto;
    return li;
  }));
}

/**
 * Um KPI. Com `filtro`, o cartão vira botão: clicar recorta a tabela de
 * conversas lá embaixo por aquele número e rola até ela — o KPI é a
 * pergunta, a tabela é o "quais são".
 */
function tile({ icone, tom, rotulo, valor, nota, filtro }) {
  const el = document.createElement(filtro ? 'button' : 'div');
  el.className = filtro ? 'kpi kpi--clique' : 'kpi';
  el.dataset.tom = tom;
  if (filtro) {
    el.type = 'button';
    el.title = 'Ver estas conversas na tabela';
    el.addEventListener('click', () => aplicarFiltroConversas(filtro));
  }

  const topo = document.createElement('div');
  topo.className = 'kpi-topo';
  const ico = document.createElement('span');
  ico.className = 'kpi-ico';
  ico.textContent = icone;
  const rot = document.createElement('span');
  rot.className = 'kpi-rotulo';
  rot.textContent = rotulo;
  topo.append(ico, rot);

  const val = document.createElement('div');
  val.className = 'kpi-valor';
  val.textContent = valor;

  const sub = document.createElement('div');
  sub.className = 'kpi-nota';
  sub.textContent = nota;

  el.append(topo, val, sub);
  return el;
}

function renderKpis(s) {
  const k = s.kpis ?? {};
  const naoCancelaram = Math.max(0, (k.conversas ?? 0) - (k.pedidos_cancelados ?? 0));
  $('sup-kpis').replaceChildren(
    tile({
      icone: '●', tom: 'neutro', rotulo: 'Conversas',
      valor: n(k.conversas ?? 0),
      nota: `iniciadas em ${s.janela_dias} dias`,
      filtro: { rotulo: 'todas as conversas da janela' },
    }),
    tile({
      icone: '✓', tom: 'bom', rotulo: 'Taxa de resolução',
      valor: pct(k.resolution_rate),
      nota: k.classificadas
        ? `${n(k.resolvidas)} de ${n(k.classificadas)} resolvidas pela IA`
        : 'sem conversas classificadas ainda',
      filtro: { resolvido: 'sim', rotulo: 'resolvidas pela IA' },
    }),
    // A taxa de reembolso: de TODAS as conversas com a IA, quantas têm o
    // PEDIDO cancelado de fato na fila — verificado pelo status, não pelo
    // que a conversa registrou. O complemento é quem conversou e não cancelou.
    tile({
      icone: '↩', tom: 'ruim', rotulo: 'Taxa de reembolso',
      valor: pct(k.taxa_reembolso),
      nota: k.conversas
        ? `${n(k.pedidos_cancelados ?? 0)} de ${n(k.conversas)} conversas com pedido cancelado na fila · ${n(naoCancelaram)} não cancelaram`
        : 'nenhuma conversa na janela',
      filtro: { reembolso: 'consumado', rotulo: 'com o pedido cancelado na fila' },
    }),
    tile({
      icone: '✕', tom: 'ruim', rotulo: 'Não resolvidas',
      valor: n(k.nao_resolvidas ?? 0),
      nota: 'escaladas para humano ou perdidas',
      filtro: { resolvido: 'nao', rotulo: 'não resolvidas pela IA' },
    }),
    tile({
      icone: '◔', tom: 'neutro', rotulo: 'Tempo médio',
      valor: duracao(k.tempo_medio_s),
      nota: 'da primeira mensagem ao encerramento',
    }),
    tile({
      icone: '★', tom: 'medio', rotulo: 'CSAT',
      valor: k.csat_media === null || k.csat_media === undefined
        ? '—'
        : String(k.csat_media).replace('.', ','),
      nota: k.csat_respostas
        ? `média de ${n(k.csat_respostas)} avaliação${k.csat_respostas === 1 ? '' : 'ões'} (1–5)`
        : 'nenhuma avaliação ainda',
      filtro: { com_csat: '1', rotulo: 'com avaliação do cliente' },
    }),
    tile({
      icone: '◍', tom: 'neutro', rotulo: 'Utilização do chat',
      valor: pct(k.taxa_utilizacao),
      nota: `${n(k.clientes_chat ?? 0)} de ${n(k.pedidos_fila ?? 0)} pedidos abriram o chat`,
    }),
  );
}

function itemRanking({ rotulo, total, max, sub }) {
  const li = document.createElement('li');
  li.className = 'sup-item';

  const rot = document.createElement('span');
  rot.className = 'sup-item-rotulo';
  rot.textContent = rotulo;

  const num = document.createElement('span');
  num.className = 'sup-item-num';
  num.textContent = n(total);

  const barra = document.createElement('span');
  barra.className = 'sup-item-barra';
  const cheio = document.createElement('span');
  cheio.style.width = `${max > 0 ? Math.max(2, (total / max) * 100) : 0}%`;
  barra.append(cheio);

  li.append(rot, num, barra);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sup-item-sub';
    s.textContent = sub;
    li.append(s);
  }
  return li;
}

/**
 * A tabela de motivos. O % é sobre as conversas CLASSIFICADAS (a soma da
 * própria tabela): as sem motivo — anteriores ao classificador — estão
 * contadas à parte no rodapé, e diluí-las aqui faria os percentuais somarem
 * menos que 100 sem explicação.
 */
function renderMotivos(s) {
  const lista = s.motivos ?? [];
  const corpo = $('sup-motivos');
  if (!lista.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'vazio-suave';
    td.textContent = 'Nenhuma conversa classificada por motivo ainda — a classificação '
      + 'acontece no encerramento de cada conversa.';
    tr.append(td);
    corpo.replaceChildren(tr);
    return;
  }

  const totalClassificadas = lista.reduce((a, m) => a + m.total, 0);
  const max = Math.max(...lista.map((m) => m.total));

  corpo.replaceChildren(...lista.map((m) => {
    const tr = document.createElement('tr');
    // A descrição do tópico — o critério de encaixe que a IA usa — fica no
    // hover da linha; clicar recorta a tabela de conversas por este tópico.
    tr.title = [m.descricao, 'Clique para ver estas conversas'].filter(Boolean).join(' · ');
    tr.className = 'sup-linha-clique';
    tr.addEventListener('click', () => aplicarFiltroConversas({
      motivo: m.motivo,
      rotulo: `motivo “${m.label ?? m.motivo}”`,
    }));

    const tdMotivo = document.createElement('td');
    tdMotivo.className = 'sup-tabela-motivo';
    const rotulo = document.createElement('span');
    rotulo.textContent = m.label ?? m.motivo;
    // A barra é reforço visual da coluna de conversas — o número está na
    // célula ao lado; ninguém precisa ler comprimento de barra.
    const barra = document.createElement('span');
    barra.className = 'sup-item-barra';
    const cheio = document.createElement('span');
    cheio.style.width = `${max > 0 ? Math.max(2, (m.total / max) * 100) : 0}%`;
    barra.append(cheio);
    tdMotivo.append(rotulo, barra);

    const tdTotal = document.createElement('td');
    tdTotal.className = 'num';
    tdTotal.textContent = n(m.total);

    const tdPct = document.createElement('td');
    tdPct.className = 'num';
    tdPct.textContent = totalClassificadas
      ? `${(Math.round((m.total / totalClassificadas) * 1000) / 10).toString().replace('.', ',')}%`
      : '—';

    const tdRes = document.createElement('td');
    tdRes.className = 'num';
    tdRes.textContent = `${n(m.resolvidos)} (${m.total ? Math.round((m.resolvidos / m.total) * 100) : 0}%)`;

    tr.append(tdMotivo, tdTotal, tdPct, tdRes);
    return tr;
  }));
}

function renderPerguntas(s) {
  const lista = s.perguntas ?? [];
  const el = $('sup-perguntas');
  if (!lista.length) {
    const li = document.createElement('li');
    li.className = 'vazio-suave';
    li.textContent = 'Nenhuma pergunta sem resposta registrada — ou a IA está dando conta, '
      + 'ou o bot ainda não começou a reportá-las.';
    el.replaceChildren(li);
    return;
  }
  const max = Math.max(...lista.map((p) => p.total));
  el.replaceChildren(...lista.map((p) => itemRanking({
    rotulo: `“${p.pergunta}”`,
    total: p.total,
    max,
    sub: p.ultima_em ? `última vez ${relativo(p.ultima_em)}` : null,
  })));
}

function renderRegua(s) {
  const lista = s.regua ?? [];
  const el = $('sup-regua');
  if (!lista.length) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Sem contatos ligados a etapas da régua ainda. A etapa é anotada '
      + 'automaticamente quando a conversa pertence a um pedido da fila.';
    el.replaceChildren(p);
    return;
  }

  const max = Math.max(...lista.map((r) => r.total));
  el.replaceChildren(...lista.map((r) => {
    const div = document.createElement('div');
    div.className = 'sup-etapa';
    div.title = `${r.nome}: ${n(r.total)} contato${r.total === 1 ? '' : 's'}, `
      + `${n(r.reembolsos)} com pedido de reembolso`;

    const total = document.createElement('span');
    total.className = 'sup-etapa-total';
    total.textContent = n(r.total);

    const coluna = document.createElement('div');
    coluna.className = 'sup-etapa-coluna';
    coluna.style.height = `${Math.max(10, (r.total / max) * 110)}px`;
    if (r.reembolsos > 0) {
      const fatia = document.createElement('div');
      fatia.className = 'sup-etapa-reembolso';
      fatia.style.height = `${Math.round((r.reembolsos / r.total) * 100)}%`;
      coluna.append(fatia);
    }

    const nome = document.createElement('span');
    nome.className = 'sup-etapa-nome';
    nome.textContent = `${r.etapa} · ${r.nome}`;

    div.append(total, coluna, nome);
    return div;
  }));
}

/* ═════════════════  a tabela de conversas (drill-down)  ═════════════ */

/**
 * O recorte ativo da tabela — vem de um clique num KPI ou num motivo. É
 * estado próprio (não da URL) porque vive só nesta aba; o chip ao lado do
 * título diz o que está valendo, e "Limpar filtro" volta ao tudo.
 */
let filtroConversas = {};

function aplicarFiltroConversas(filtro) {
  filtroConversas = filtro ?? {};
  const chip = $('sup-filtro');
  const temRecorte = Boolean(filtro?.motivo || filtro?.resolvido || filtro?.reembolso || filtro?.com_csat);
  chip.hidden = !temRecorte && !filtro?.rotulo;
  $('sup-filtro-rotulo').textContent = filtro?.rotulo ? `Mostrando: ${filtro.rotulo}` : '';
  carregarConversas();
  $('sup-conversas-cartao').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('sup-filtro-limpar').addEventListener('click', () => {
  filtroConversas = {};
  $('sup-filtro').hidden = true;
  carregarConversas();
});

let geracaoConversas = 0;

async function carregarConversas() {
  const meu = ++geracaoConversas;
  try {
    const qs = new URLSearchParams({ dias: String(Number($('sup-dias').value) || 30) });
    const produto = $('sel-produto').value;
    const plataforma = $('sel-plataforma').value;
    if (produto) qs.set('produto', produto);
    if (plataforma) qs.set('plataforma', plataforma);
    for (const chave of ['motivo', 'resolvido', 'reembolso', 'com_csat']) {
      if (filtroConversas[chave]) qs.set(chave, filtroConversas[chave]);
    }

    const resp = await fetch(`/api/suporte/conversas?${qs}`);
    if (resp.status === 401) { location.replace('/login'); return; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dados = await resp.json();
    if (meu !== geracaoConversas) return;
    renderConversas(dados);
  } catch {
    if (meu !== geracaoConversas) return;
    renderConversas({ total: 0, conversas: [] });
  }
}

function renderConversas({ total, conversas }) {
  const corpo = $('sup-conversas');
  if (!conversas.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'vazio-suave';
    td.textContent = filtroConversas.rotulo
      ? `Nenhuma conversa em “${filtroConversas.rotulo}” nesta janela.`
      : 'Nenhuma conversa registrada nesta janela ainda.';
    tr.append(td);
    corpo.replaceChildren(tr);
    $('sup-conversas-total').textContent = '';
    return;
  }

  const celula = (texto, classe) => {
    const td = document.createElement('td');
    if (classe) td.className = classe;
    td.textContent = texto;
    return td;
  };

  corpo.replaceChildren(...conversas.map((c) => {
    const tr = document.createElement('tr');
    // O resumo inteiro do atendimento mora no hover — a tabela mostra o que
    // se compara; o texto, quem quiser lê.
    if (c.resumo) tr.title = c.resumo;

    tr.append(celula(c.inicio ? dataHora(c.inicio) : '—'));
    tr.append(celula(c.transacao_id ?? c.email ?? '—'));
    tr.append(celula(c.topico_label ?? '—'));
    tr.append(celula(c.resolvido === true ? '✓ resolvida'
      : c.resolvido === false ? '✕ escalada' : '—'));
    // A coluna diz o que a FILA diz: pedido cancelado de verdade, ou pediu e
    // o pedido segue vivo (retido), ou nunca pediu.
    tr.append(celula(c.pedido_cancelado ? 'pedido cancelado'
      : c.reembolso_pedido ? 'pediu · retido' : '—'));
    tr.append(celula(c.csat ? `★ ${c.csat}` : '—', 'num'));
    tr.append(celula(duracao(c.duracao_s), 'num'));
    return tr;
  }));

  $('sup-conversas-total').textContent = total > conversas.length
    ? `Mostrando as ${n(conversas.length)} mais recentes de ${n(total)} conversas.`
    : `${n(total)} conversa${total === 1 ? '' : 's'}.`;
}

/* ══════════════════════════  carregamento  ══════════════════════════ */

let geracao = 0;

export async function carregarSuporte() {
  const meu = ++geracao;
  try {
    const qs = new URLSearchParams({ dias: String(Number($('sup-dias').value) || 30) });
    // Os MESMOS recortes do topo que valem para a régua: a conversa entra
    // quando o pedido dela pertence ao produto/plataforma escolhidos. Os
    // seletores são a fonte da verdade — não há segundo estado a divergir.
    const produto = $('sel-produto').value;
    const plataforma = $('sel-plataforma').value;
    if (produto) qs.set('produto', produto);
    if (plataforma) qs.set('plataforma', plataforma);

    const resp = await fetch(`/api/suporte?${qs}`);
    if (resp.status === 401) { location.replace('/login'); return; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const s = await resp.json();
    if (meu !== geracao) return;   // resposta atrasada: descarta

    renderInsights(s);
    renderKpis(s);
    renderMotivos(s);
    renderPerguntas(s);
    renderRegua(s);
    // A tabela recarrega junto, mantendo o filtro ativo — senão os cards
    // falariam de uma janela e a lista, de outra.
    carregarConversas();
    // O recorte ativo fica ESCRITO no rodapé: um filtro que só se vê no topo
    // é um recorte invisível pesando sobre todos os números da aba.
    const recorte = [produto && `produto “${produto}”`, plataforma && `plataforma ${plataforma}`]
      .filter(Boolean).join(' · ');
    $('sup-rodape').textContent = `KPIs e rankings sobre os últimos ${s.janela_dias} dias · `
      + 'insights comparam as últimas 24 h com as 24 h anteriores · '
      + `sem motivo classificado: ${n(s.sem_motivo ?? 0)} conversa${(s.sem_motivo ?? 0) === 1 ? '' : 's'}`
      + (recorte
        ? ` · recorte ativo: ${recorte} — conversas sem pedido casado ficam de fora.`
        : '.');
  } catch (err) {
    if (meu !== geracao) return;
    const li = document.createElement('li');
    li.className = 'sup-insight';
    li.dataset.nivel = 'alerta';
    li.textContent = `Não consegui ler os dados do suporte: ${err.message}. `
      + 'A aba continua mostrando os últimos números que recebeu.';
    $('sup-insights').prepend(li);
  }
}

$('sup-dias').addEventListener('change', () => { carregarSuporte(); });
