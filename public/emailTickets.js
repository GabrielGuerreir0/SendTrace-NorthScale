/**
 * Central de E-mail IA — Tela 1: Tickets de Atendimento (aba principal desta
 * seção). Foco operacional: acompanhar e agir sobre o atendimento em
 * andamento. §3 da especificação.
 *
 * Atualiza sozinha a cada 5 minutos (dados) e a cada 8 segundos (automação
 * "ao vivo") — os dois timers seguem rodando mesmo com a aba escondida,
 * igual ao resto do painel (ver comentário em suporte.js).
 */
import {
  $, api, debounce, tooltip, kpiCard, barraHorizontal, renderTabela, paginar,
  montarPaginacao, baixarCsv, chipTicket, chipEtapaAutomacao, rotularPlataforma, celCliente,
} from './emailComum.js';
import { n, duracaoH } from './format.js';
import { desenharColunas } from './charts.js';
import { qsFiltroCE, aoMudarFiltroCE } from './emailFiltro.js';
import { abrirModalTicket } from './emailDetalhes.js';

/* ═══════════════════════════════  estado  ═══════════════════════════════ */

let dados = null;
let filtroStatus = null; // null | 'nao_iniciado' | 'em_aberto' | 'resolvido'
let busca = '';
let pagina = 1;
const POR_PAGINA = 25;

/* ═══════════════════════════════  automação  ══════════════════════════════ */

async function carregarAutomacao() {
  try {
    const { ok, dados: d } = await api('/api/automacao');
    if (!ok) return;
    const itens = d.itens ?? [];
    const emAndamento = itens.filter((i) => i.etapa === 'gerando_resposta' || i.etapa === 'enviando').length;
    $('tk-automacao-status').textContent = emAndamento > 0
      ? `respondendo agora (${emAndamento} em andamento)`
      : 'ocioso, sem pendência no momento';

    renderTabela($('tk-automacao-lista'), itens.slice(0, 12), [
      {
        classe: 'cel-mono',
        render: (i) => (i.atualizado_em ? new Date(i.atualizado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'),
      },
      { classe: 'cel-forte', render: (i) => i.remetente_nome || i.remetente_email || '—' },
      {
        render: (i) => {
          const div = document.createElement('div');
          div.textContent = i.assunto ?? '—';
          if (i.detalhe) {
            const sub = document.createElement('span');
            sub.className = 'cel-sub cel-erro';
            sub.textContent = i.detalhe;
            div.append(sub);
          }
          return div;
        },
      },
      { render: (i) => chipEtapaAutomacao(i.etapa) },
    ], { vazio: 'Nenhuma execução recente.' });
  } catch { /* polling silencioso — não interrompe a tela por uma falha isolada */ }
}

/* ══════════════════════════════  KPIs de status  ═══════════════════════════ */

function aplicarFiltroStatus(status) {
  filtroStatus = filtroStatus === status ? null : status;
  $('tk-tabela-status').value = filtroStatus ?? '';
  pagina = 1;
  renderTabelaTickets();
  renderKpisStatus();
}

function renderInsights() {
  $('tickets-insights').replaceChildren(...(dados?.tickets_insights ?? []).map((i) => {
    const li = document.createElement('li');
    li.className = 'sup-insight';
    li.dataset.nivel = i.nivel;
    li.textContent = i.texto;
    return li;
  }));
}

function renderKpisStatus() {
  const k = dados?.tickets_kpis ?? {};
  const totalPlataformas = (dados?.plataformas ?? []).reduce((a, p) => a + p.total, 0);
  const total = (k.nao_iniciado ?? 0) + (k.em_aberto ?? 0) + (k.resolvido ?? 0);
  $('tk-kpis').replaceChildren(
    kpiCard({
      icone: '●', tom: (k.nao_iniciado ?? 0) > 0 ? 'travado' : 'neutro', rotulo: 'Não iniciados',
      valor: n(k.nao_iniciado ?? 0), nota: 'aguardando o primeiro atendimento',
      ativo: filtroStatus === 'nao_iniciado', onClick: () => aplicarFiltroStatus('nao_iniciado'),
    }),
    kpiCard({
      icone: '●', tom: 'atrasado', rotulo: 'Em aberto', valor: n(k.em_aberto ?? 0),
      nota: 'em andamento', ativo: filtroStatus === 'em_aberto', onClick: () => aplicarFiltroStatus('em_aberto'),
    }),
    kpiCard({
      icone: '●', tom: 'finalizado', rotulo: 'Resolvidos', valor: n(k.resolvido ?? 0),
      nota: 'atendimento concluído', ativo: filtroStatus === 'resolvido', onClick: () => aplicarFiltroStatus('resolvido'),
    }),
    kpiCard({ icone: '◍', tom: 'neutro', rotulo: 'Total de tickets', valor: n(total), nota: '1 por cliente' }),
    kpiCard({
      icone: '▤', tom: 'neutro', rotulo: 'E-mails de plataformas', valor: n(totalPlataformas),
      nota: 'não geram ticket',
    }),
  );
}

/* ═══════════════════════════  KPIs de tempo (client-side)  ══════════════════ */

function mediana(valores) {
  if (!valores.length) return null;
  const s = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2;
}

function renderKpisTempo() {
  const tickets = dados?.tickets ?? [];
  const horasEntre = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

  const paraInicio = tickets
    .filter((t) => t.primeiro_email_em && t.iniciado_em)
    .map((t) => horasEntre(t.primeiro_email_em, t.iniciado_em));
  const paraResolucao = tickets
    .filter((t) => t.primeiro_email_em && t.resolvido_em)
    .map((t) => horasEntre(t.primeiro_email_em, t.resolvido_em));
  const agora = Date.now();
  const esperando48h = tickets.filter((t) => t.status !== 'resolvido' && t.ultimo_email_em
    && (agora - new Date(t.ultimo_email_em).getTime()) > 48 * 3_600_000).length;
  const reaberturas = tickets.reduce((a, t) => a + (t.reaberturas ?? 0), 0);

  $('tk-kpis-tempo').replaceChildren(
    kpiCard({
      icone: '◔', tom: 'neutro', rotulo: 'Chegada → início',
      valor: paraInicio.length ? duracaoH(mediana(paraInicio)) : '—',
      nota: `mediana · ${n(paraInicio.length)} ticket${paraInicio.length === 1 ? '' : 's'}`,
    }),
    kpiCard({
      icone: '◔', tom: 'neutro', rotulo: 'Chegada → resolução',
      valor: paraResolucao.length ? duracaoH(mediana(paraResolucao)) : '—',
      nota: `mediana · ${n(paraResolucao.length)} ticket${paraResolucao.length === 1 ? '' : 's'}`,
    }),
    kpiCard({
      icone: '⏱', tom: esperando48h > 0 ? 'travado' : 'neutro', rotulo: 'Esperando 48h+',
      valor: n(esperando48h), nota: 'sem resposta há mais de 2 dias',
    }),
    kpiCard({ icone: '↺', tom: 'neutro', rotulo: 'Reaberturas', valor: n(reaberturas), nota: 'no total dos tickets listados' }),
  );
}

/* ═══════════════════════════════  gráficos  ═════════════════════════════ */

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

function serieDiaria(linhas, campoData, campoValor) {
  const porDia = new Map(linhas.map((l) => [l[campoData], l[campoValor] ?? 0]));
  return ultimosNDias(30).map((d) => {
    const chave = d.toISOString().slice(0, 10);
    return {
      chave, valor: porDia.get(chave) ?? 0, data: d,
      rotulo: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    };
  });
}

function renderGraficos() {
  const evolucaoTickets = dados?.tickets_evolucao ?? [];
  const evolucaoEmails = dados?.evolucao ?? [];

  desenharColunas($('tk-graf-resolvidos-dia'), serieDiaria(evolucaoTickets, 'dia', 'resolvidos'), {
    altura: 170, tooltip, unidade: 'resolvidos', textoVazio: 'Nenhum ticket resolvido nos últimos 30 dias',
    rotuloEixoX: (d, i) => (i % 4 === 0 ? d.rotulo : ''),
  });

  const porMes = new Map();
  for (const l of evolucaoTickets) {
    const mes = String(l.dia).slice(0, 7);
    porMes.set(mes, (porMes.get(mes) ?? 0) + (l.resolvidos ?? 0));
  }
  const meses = [];
  const base = new Date();
  base.setDate(1);
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const chave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    meses.push({
      chave, valor: porMes.get(chave) ?? 0, data: d,
      rotulo: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
    });
  }
  desenharColunas($('tk-graf-resolvidos-mes'), meses, {
    altura: 170, tooltip, unidade: 'resolvidos', textoVazio: 'Nenhum ticket resolvido nos últimos 12 meses',
    rotuloEixoX: (d) => d.rotulo,
  });

  desenharColunas($('tk-graf-emails-dia'), serieDiaria(evolucaoEmails, 'dia', 'total'), {
    altura: 170, tooltip, unidade: 'e-mails', textoVazio: 'Nenhum e-mail recebido nos últimos 30 dias',
    rotuloEixoX: (d, i) => (i % 4 === 0 ? d.rotulo : ''),
  });
}

/* ═══════════════════════════  plataformas × clientes  ═══════════════════════ */

function renderPlataformas() {
  const itens = dados?.plataformas ?? [];
  barraHorizontal($('tk-plataformas'), itens, 'plataforma_origem', {
    rotular: rotularPlataforma, vazio: 'Nenhum e-mail de plataforma no período.',
  });
  const totalPlataformas = itens.reduce((a, p) => a + p.total, 0);
  const totalEmails = (dados?.kpis?.total_emails) ?? null;
  if (totalEmails === null) { $('tk-plataformas-resumo').textContent = ''; return; }
  const clientesReais = Math.max(0, totalEmails - totalPlataformas);
  $('tk-plataformas-resumo').textContent = `chegaram ${n(totalEmails)} e-mails: ${n(clientesReais)} de `
    + `clientes reais e ${n(totalPlataformas)} automáticos de plataformas/loja.`;
}

/* ═══════════════════════════════  tabela  ═══════════════════════════════ */

function espera(ticket) {
  if (ticket.status === 'resolvido' || !ticket.ultimo_email_em) return '—';
  return duracaoH((Date.now() - new Date(ticket.ultimo_email_em).getTime()) / 3_600_000);
}

function acoesTicket(ticket) {
  const div = document.createElement('div');
  div.className = 'tk-acoes';
  const botao = (rotulo, status) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = rotulo;
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      const { ok, dados: resp } = await api('/api/ticket', { metodo: 'POST', corpo: { email: ticket.remetente_email, status } });
      if (!ok) { window.alert(resp?.erro ?? 'Não consegui mudar o status.'); b.disabled = false; return; }
      await carregarDados();
    });
    return b;
  };
  if (ticket.status === 'nao_iniciado') { div.append(botao('Iniciar', 'em_aberto'), botao('Resolver', 'resolvido')); }
  else if (ticket.status === 'em_aberto') { div.append(botao('Resolver', 'resolvido')); }
  else { div.append(botao('Reabrir', 'nao_iniciado')); }
  return div;
}

function renderTabelaTickets() {
  let linhas = dados?.tickets ?? [];
  if (filtroStatus) linhas = linhas.filter((t) => t.status === filtroStatus);

  const { pagina: p, totalPaginas, fatia } = paginar(linhas, pagina, POR_PAGINA);
  pagina = p;

  const corpo = $('tk-tabela-corpo');
  corpo.replaceChildren();
  if (!fatia.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'vazio-suave';
    td.textContent = 'Nenhum ticket encontrado com este filtro.';
    tr.append(td);
    corpo.append(tr);
  }

  for (const t of fatia) {
    const tr = document.createElement('tr');
    tr.dataset.email = t.remetente_email;
    tr.classList.add('sup-linha-clique');
    tr.title = 'Clique para ver todos os detalhes deste ticket';
    tr.addEventListener('click', () => abrirModalTicket(t));

    const tdCliente = document.createElement('td');
    tdCliente.append(celCliente(t.nome, t.remetente_email));

    const tdStatus = document.createElement('td');
    tdStatus.append(chipTicket(t.status));

    const tdEmails = document.createElement('td'); tdEmails.className = 'num'; tdEmails.textContent = n(t.qtd_emails);
    const tdPedidos = document.createElement('td'); tdPedidos.className = 'num'; tdPedidos.textContent = n(t.pedidos_unicos);
    const tdReab = document.createElement('td'); tdReab.className = 'num'; tdReab.textContent = n(t.reaberturas);

    const tdDatas = document.createElement('td');
    tdDatas.className = 'cel-mono';
    tdDatas.textContent = `${t.primeiro_email_em ? new Date(t.primeiro_email_em).toLocaleDateString('pt-BR') : '—'} · `
      + `${t.ultimo_email_em ? new Date(t.ultimo_email_em).toLocaleDateString('pt-BR') : '—'}`;

    const tdEspera = document.createElement('td'); tdEspera.textContent = espera(t);
    const tdAcoes = document.createElement('td'); tdAcoes.append(acoesTicket(t));

    tr.append(tdCliente, tdStatus, tdEmails, tdPedidos, tdReab, tdDatas, tdEspera, tdAcoes);
    corpo.append(tr);
  }

  montarPaginacao($('tk-tabela-paginacao'), { pagina, totalPaginas, total: linhas.length, rotuloItem: 'ticket' }, (p2) => {
    pagina = p2;
    renderTabelaTickets();
  });
}

/* ═══════════════════════════════  CSV  ═══════════════════════════════════ */

$('tk-tabela-csv').addEventListener('click', () => {
  let linhas = dados?.tickets ?? [];
  if (filtroStatus) linhas = linhas.filter((t) => t.status === filtroStatus);
  baixarCsv(
    'tickets.csv',
    ['nome', 'remetente_email', 'status', 'qtd_emails', 'pedidos_unicos', 'reaberturas',
      'primeiro_email_em', 'ultimo_email_em', 'iniciado_em', 'resolvido_em'],
    linhas.map((t) => [
      t.nome ?? '', t.remetente_email, t.status, t.qtd_emails, t.pedidos_unicos, t.reaberturas,
      t.primeiro_email_em ?? '', t.ultimo_email_em ?? '', t.iniciado_em ?? '', t.resolvido_em ?? '',
    ]),
  );
});

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

function qsPeriodo() {
  const p = qsFiltroCE();
  if (busca) { p.set('q', busca); p.set('tq', busca); }
  return p;
}

let geracao = 0;

export async function carregarDados() {
  const meu = ++geracao;
  try {
    const { ok, dados: d } = await api(`/api/dados?${qsPeriodo()}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(d?.erro ?? 'falha ao carregar');
    dados = d;
    renderInsights();
    renderKpisStatus();
    renderKpisTempo();
    renderGraficos();
    renderPlataformas();
    renderTabelaTickets();
  } catch (err) {
    if (meu !== geracao) return;
    $('tk-automacao-status').textContent = `Não consegui carregar os dados: ${err.message}`;
  }
}

/**
 * Ponto de entrada para "ir direto pro atendimento deste cliente" — chamado
 * pelo kanban de Suporte Escalado (ver emailSuporteEscalado.js). Busca só
 * este e-mail (sobrescrevendo qualquer filtro de status), recarrega e rola
 * até a linha, destacando-a por alguns segundos.
 */
export async function abrirNaTabela(email) {
  busca = email;
  $('tk-busca').value = email;
  filtroStatus = null;
  $('tk-tabela-status').value = '';
  pagina = 1;
  await carregarDados();
  const linha = $('tk-tabela-corpo').querySelector(`tr[data-email="${CSS.escape(email)}"]`);
  if (!linha) return;
  linha.scrollIntoView({ behavior: 'smooth', block: 'center' });
  linha.classList.add('tk-linha-destaque');
  setTimeout(() => linha.classList.remove('tk-linha-destaque'), 2400);
}

aoMudarFiltroCE(() => { pagina = 1; carregarDados(); });
$('tk-busca').addEventListener('input', debounce((e) => {
  busca = e.target.value.trim();
  pagina = 1;
  carregarDados();
}, 450));
$('tk-tabela-status').addEventListener('change', (e) => {
  filtroStatus = e.target.value || null;
  pagina = 1;
  renderTabelaTickets();
  renderKpisStatus();
});

carregarDados();
carregarAutomacao();
setInterval(carregarDados, 5 * 60 * 1000);
setInterval(carregarAutomacao, 8 * 1000);
