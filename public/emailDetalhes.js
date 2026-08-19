/**
 * Central de E-mail IA — Tela 2: Mais Detalhes / Dashboard. Visão analítica
 * completa — todos os cortes e séries históricas do §4. Usa o MESMO endpoint
 * GET /api/dados da Tela 1, só que consumindo mais chaves do JSON.
 *
 * Dois tipos de clique clicável:
 * - Nos KPIs do topo: recorta PRATICAMENTE TODOS os cartões da página —
 *   não só o que foi clicado (§4.1) — refazendo a consulta inteira com o
 *   filtro aplicado (ver aplicarFiltro/filtroAtivo).
 * - Nas barras (motivos, categorias, sentimento, área, responsável,
 *   pagamento, plataforma): abre um modal com a lista de e-mails que caem
 *   naquele filtro (ver abrirModalEmails) — mais direto que recortar a
 *   página inteira para "quem são esses e-mails".
 */
import {
  $, api, debounce, tooltip, kpiCard, barraHorizontal, renderTabela, paginar,
  montarPaginacao, baixarCsv, chipTicket, chipSentimento, chipUrgencia, chipSituacaoPedido,
  rotularCategoria, rotularMotivo, rotularArea, rotularResponsavel, rotularPagamento, rotularPlataforma,
  celCliente, abrirFicha, renderFicha,
} from './emailComum.js';
import { n, dataHora, truncar } from './format.js';
import { desenharColunas } from './charts.js';
import { qsFiltroCE, aoMudarFiltroCE } from './emailFiltro.js';

/* ═══════════════════════════════  estado  ═══════════════════════════════ */

let dados = null;
let busca = '';
/** { tipo: 'cat'|'sent'|'urg'|'pede'|'area'|'resp'|'pgto'|'plat', valor, rotulo } | null */
let filtroAtivo = null;
let paginaTickets = 1;
const PT_POR_PAGINA = 10;

function qsCompleto() {
  const p = qsFiltroCE();
  if (busca) { p.set('q', busca); p.set('tq', busca); }
  if (filtroAtivo) p.set(filtroAtivo.tipo, filtroAtivo.valor);
  return p;
}

function aplicarFiltro(tipo, valor, rotulo) {
  filtroAtivo = (filtroAtivo?.tipo === tipo && filtroAtivo?.valor === valor) ? null : { tipo, valor, rotulo };
  renderChipFiltro();
  carregarDados();
}

function renderChipFiltro() {
  const chip = $('dt-filtro-chip');
  chip.hidden = !filtroAtivo;
  $('dt-filtro-rotulo').textContent = filtroAtivo ? `filtrando: ${filtroAtivo.rotulo}` : '';
}

$('dt-filtro-limpar').addEventListener('click', () => { filtroAtivo = null; renderChipFiltro(); carregarDados(); });

/* ═══════════════════════  modal: e-mails filtrados  ═══════════════════════
   Abre ao clicar numa barra (motivo, categoria, sentimento, área,
   responsável, pagamento, plataforma) — pede só a LISTA de e-mails daquele
   recorte (GET /api/emails, mesmo período/produto/loja do resto da tela),
   sem pagar o custo dos ~15 agregados de /api/dados.

   TAMBÉM reaproveitado (com `ficha` preenchida) por qualquer linha que
   representa UM CLIENTE — ticket, reincidente, reclamante, cliente de risco
   — tanto aqui quanto em emailTickets.js: em vez de só listar os e-mails,
   mostra primeiro a ficha completa do registro clicado (todos os campos que
   a linha da tabela não tinha espaço para mostrar) e, embaixo, a lista de
   e-mails trocados com aquele cliente (tipo='email', valor=e-mail exato). */

let emailsModalGeracao = 0;
let emailsModalTodos = [];
let emailsModalPagina = 1;
const EM_POR_PAGINA = 15;

function renderEmailsModal() {
  const { pagina, totalPaginas, fatia } = paginar(emailsModalTodos, emailsModalPagina, EM_POR_PAGINA);
  emailsModalPagina = pagina;
  renderTabela($('dt-emails-corpo'), fatia, [
    { render: (l) => (l.data_email ? dataHora(l.data_email) : '—'), classe: 'cel-mono' },
    { render: (l) => celCliente(l.remetente_nome, l.remetente_email) },
    { render: (l) => l.assunto ?? '—' },
    { render: (l) => rotularCategoria(l.categoria) },
    { render: (l) => chipSentimento(l.sentimento) },
    { render: (l) => chipUrgencia(l.urgencia) },
    { render: (l) => (l.erro_analise ? '⚠ falha na análise' : truncar(l.resumo ?? '', 90)) },
  ], { vazio: 'Nenhum e-mail encontrado com este filtro.' });
  montarPaginacao($('dt-emails-pag'), {
    pagina, totalPaginas, total: emailsModalTodos.length, rotuloItem: 'e-mail',
  }, (p) => { emailsModalPagina = p; renderEmailsModal(); });
}

function celulaCarregandoEmails(texto) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 7;
  td.className = 'vazio-suave';
  td.textContent = texto;
  tr.append(td);
  $('dt-emails-corpo').replaceChildren(tr);
}

export async function abrirModalEmails(tipo, valor, rotulo, ficha = null) {
  $('dt-emails-sub').textContent = `filtrando: ${rotulo}`;
  const elFicha = $('dt-emails-ficha');
  elFicha.hidden = !ficha;
  if (ficha) renderFicha(elFicha, ficha);
  celulaCarregandoEmails('carregando…');
  $('dt-emails-pag').replaceChildren();
  $('dt-emails-modal').showModal();

  const meu = ++emailsModalGeracao;
  const p = qsFiltroCE();
  p.set(tipo, valor);
  try {
    const { ok, dados: resp } = await api(`/api/emails?${p}`);
    if (meu !== emailsModalGeracao) return;
    if (!ok) throw new Error(resp?.erro ?? resp?.detail ?? 'falha ao carregar');
    emailsModalTodos = resp.itens ?? [];
    emailsModalPagina = 1;
    renderEmailsModal();
  } catch (err) {
    if (meu !== emailsModalGeracao) return;
    celulaCarregandoEmails(`Não consegui carregar: ${err.message}`);
  }
}

$('dt-emails-fechar').addEventListener('click', () => $('dt-emails-modal').close());

/**
 * Ficha de UM ticket (linha da tabela compacta aqui, ou da tabela dedicada em
 * emailTickets.js) + a lista de e-mails trocados com aquele cliente — tudo
 * que a linha não tinha espaço para mostrar, num clique só.
 */
export function abrirModalTicket(t) {
  abrirModalEmails('email', t.remetente_email, `ticket de ${t.nome || t.remetente_email}`, [
    { rotulo: 'Cliente', valor: t.nome || '—' },
    { rotulo: 'E-mail', valor: t.remetente_email },
    { rotulo: 'Status', valor: chipTicket(t.status) },
    { rotulo: 'E-mails trocados', valor: n(t.qtd_emails) },
    { rotulo: 'Pedidos únicos', valor: n(t.pedidos_unicos) },
    { rotulo: 'Reaberturas', valor: n(t.reaberturas) },
    { rotulo: 'Primeiro e-mail', valor: t.primeiro_email_em ? dataHora(t.primeiro_email_em) : '—' },
    { rotulo: 'Último e-mail', valor: t.ultimo_email_em ? dataHora(t.ultimo_email_em) : '—' },
    { rotulo: 'Iniciado em', valor: t.iniciado_em ? dataHora(t.iniciado_em) : '—' },
    { rotulo: 'Resolvido em', valor: t.resolvido_em ? dataHora(t.resolvido_em) : '—' },
    t.resumo_conversa && {
      rotulo: `Resumo da IA${t.resumo_conversa_em ? ` · atualizado em ${dataHora(t.resumo_conversa_em)}` : ''}`,
      valor: t.resumo_conversa,
      largo: true,
    },
  ]);
}

/* ═══════════════════════════════  KPIs principais  ═══════════════════════ */

function renderKpis() {
  const k = dados?.kpis ?? {};
  const dc = dados?.devolucao_conf ?? {};
  $('dt-kpis').replaceChildren(
    kpiCard({
      icone: '✉', tom: 'neutro', rotulo: 'E-mails no período', valor: n(k.total_emails ?? 0),
      nota: `${n(k.clientes_unicos ?? 0)} clientes únicos`,
    }),
    kpiCard({
      icone: '◔', tom: 'neutro', rotulo: 'Aguardando resposta', valor: n(k.pendentes ?? 0),
      nota: 'precisam de resposta humana/IA',
      ativo: filtroAtivo?.tipo === 'pede', onClick: () => aplicarFiltro('pede', 'true', 'aguardando resposta'),
    }),
    kpiCard({
      icone: '▲', tom: (k.urgencia_alta ?? 0) > 0 ? 'travado' : 'neutro', rotulo: 'Urgência alta',
      valor: n(k.urgencia_alta ?? 0), nota: 'pedem resposta com urgência alta',
      ativo: filtroAtivo?.tipo === 'urg', onClick: () => aplicarFiltro('urg', 'alta', 'urgência alta'),
    }),
    kpiCard({
      icone: '↩', tom: 'atrasado', rotulo: 'Devoluções / trocas', valor: n(k.devolucoes ?? 0),
      nota: `${n(k.clientes_devolucao ?? 0)} clientes`,
      ativo: filtroAtivo?.tipo === 'cat', onClick: () => aplicarFiltro('cat', 'devolucao,troca', 'devolução/troca'),
    }),
    kpiCard({
      icone: '✓', tom: 'neutro', rotulo: 'Devoluções confirmadas',
      valor: dc.pediram ? `${n(dc.cancelados ?? 0)} de ${n(dc.pediram)}` : '—',
      nota: 'pedido já cancelado na fila',
    }),
    kpiCard({
      icone: '⚠', tom: (k.cobranca_indevida ?? 0) > 0 ? 'travado' : 'neutro', rotulo: 'Cobrança indevida',
      valor: n(k.cobranca_indevida ?? 0), nota: 'compra não reconhecida / cobrança duplicada ou maior',
      ativo: filtroAtivo?.tipo === 'pgto' && filtroAtivo?.valor?.includes('compra_nao_reconhecida'),
      onClick: () => aplicarFiltro('pgto', 'compra_nao_reconhecida,cobranca_duplicada,cobranca_valor_maior', 'cobrança indevida'),
    }),
    kpiCard({
      icone: '☹', tom: 'atrasado', rotulo: 'Sentimento negativo', valor: k.pct_negativo !== null && k.pct_negativo !== undefined ? `${k.pct_negativo}%` : '—',
      nota: 'negativo + muito negativo',
      ativo: filtroAtivo?.tipo === 'sent', onClick: () => aplicarFiltro('sent', 'negativo,muito_negativo', 'sentimento negativo'),
    }),
    kpiCard({ icone: '📷', tom: 'neutro', rotulo: 'Fotos com defeito', valor: n(k.fotos_defeito ?? 0), nota: 'anexos com defeito identificado' }),
    kpiCard({
      icone: '🖼', tom: 'neutro', rotulo: 'Anexos no banco', valor: n(k.anexos ?? 0),
      nota: (k.com_erro ?? 0) > 0 ? `⚠ ${n(k.com_erro)} e-mail(is) com erro de análise` : 'nenhum erro de análise',
    }),
  );
}

/* ═══════════════════════════════  tickets (compacto)  ═══════════════════ */

function renderTicketsCompacto() {
  const k = dados?.tickets_kpis ?? {};
  $('dt-tickets-kpis').replaceChildren(
    kpiCard({ icone: '●', tom: 'travado', rotulo: 'Não iniciados', valor: n(k.nao_iniciado ?? 0) }),
    kpiCard({ icone: '●', tom: 'atrasado', rotulo: 'Em aberto', valor: n(k.em_aberto ?? 0) }),
    kpiCard({ icone: '●', tom: 'finalizado', rotulo: 'Resolvidos', valor: n(k.resolvido ?? 0) }),
  );

  const linhas = dados?.tickets ?? [];
  const { pagina, totalPaginas, fatia } = paginar(linhas, paginaTickets, PT_POR_PAGINA);
  paginaTickets = pagina;

  const colunasTickets = [
    { render: (t) => chipTicket(t.status) },
    { render: (t) => celCliente(t.nome, t.remetente_email) },
    { classe: 'num', render: (t) => n(t.qtd_emails) },
    { classe: 'num', render: (t) => n(t.pedidos_unicos) },
    { render: (t) => (t.ultimo_email_em ? new Date(t.ultimo_email_em).toLocaleDateString('pt-BR') : '—') },
    {
      render: (t) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = t.status === 'nao_iniciado' ? 'Iniciar' : t.status === 'em_aberto' ? 'Resolver' : 'Reabrir';
        const proximo = t.status === 'nao_iniciado' ? 'em_aberto' : t.status === 'em_aberto' ? 'resolvido' : 'nao_iniciado';
        b.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          b.disabled = true;
          await api('/api/ticket', { metodo: 'POST', corpo: { email: t.remetente_email, status: proximo } });
          await carregarDados();
        });
        return b;
      },
    },
  ];
  colunasTickets.aoClicarLinha = abrirModalTicket;
  renderTabela($('dt-tickets-corpo'), fatia, colunasTickets, { vazio: 'Nenhum ticket no período.' });

  montarPaginacao($('dt-tickets-paginacao'), { pagina: paginaTickets, totalPaginas, total: linhas.length, rotuloItem: 'ticket' }, (p) => {
    paginaTickets = p;
    renderTicketsCompacto();
  });

  barraHorizontal($('dt-plataformas'), dados?.plataformas ?? [], 'plataforma_origem', {
    rotular: rotularPlataforma, onClick: (v) => abrirModalEmails('plat', v, `plataforma ${rotularPlataforma(v)}`),
    vazio: 'Nenhum e-mail de plataforma no período.',
  });
}

/* ═══════════════════════  motivos / categorias / sentimentos  ═══════════════ */

const rotularSentimento = (v) => ({
  positivo: 'Positivo', neutro: 'Neutro', negativo: 'Negativo', muito_negativo: 'Muito negativo',
}[v] ?? v);

function renderBarrasSimples() {
  barraHorizontal($('dt-motivos'), dados?.motivos ?? [], 'motivo_devolucao', {
    rotular: rotularMotivo, vazio: 'Sem devoluções/trocas classificadas por motivo.',
    onClick: (v) => abrirModalEmails('motivo', v, `motivo de devolução “${rotularMotivo(v)}”`),
  });
  barraHorizontal($('dt-categorias'), dados?.categorias ?? [], 'categoria', {
    rotular: rotularCategoria,
    onClick: (v) => abrirModalEmails('cat', v, `categoria “${rotularCategoria(v)}”`),
  });
  barraHorizontal($('dt-sentimentos'), dados?.sentimentos ?? [], 'sentimento', {
    rotular: rotularSentimento,
    onClick: (v) => abrirModalEmails('sent', v, `sentimento “${rotularSentimento(v)}”`),
  });
}

/* ═══════════════════════════════  e-mails por dia  ═══════════════════════ */

function renderEvolucao() {
  const linhas = dados?.evolucao ?? [];
  const serie = linhas.map((l) => ({
    chave: l.dia, valor: l.total, sub: `${n(l.devolucoes)} devolução/troca`,
    rotulo: new Date(`${l.dia}T00:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
  }));
  desenharColunas($('dt-evolucao'), serie, {
    altura: 190, tooltip, unidade: 'e-mails', textoVazio: 'Nenhum e-mail no período',
    rotuloEixoX: (d, i) => (i % Math.max(1, Math.ceil(serie.length / 12)) === 0 ? d.rotulo : ''),
  });
}

/* ═══════════════════  estudo de devoluções e reembolsos  ═══════════════════ */

function renderEstudoDevolucoes() {
  barraHorizontal($('dt-areas'), dados?.areas ?? [], 'area_problema', {
    rotular: rotularArea, onClick: (v) => abrirModalEmails('area', v, `área “${rotularArea(v)}”`),
  });
  barraHorizontal($('dt-responsaveis'), dados?.responsaveis ?? [], 'responsavel', {
    rotular: rotularResponsavel, onClick: (v) => abrirModalEmails('resp', v, `responsável “${rotularResponsavel(v)}”`),
  });
  barraHorizontal($('dt-pagamento'), dados?.pagamento ?? [], 'problema_pagamento', {
    rotular: rotularPagamento, onClick: (v) => abrirModalEmails('pgto', v, `pagamento “${rotularPagamento(v)}”`),
  });

  renderTabela($('dt-taxa-mensal'), dados?.taxa_mensal ?? [], [
    { render: (l) => l.mes },
    { classe: 'num', render: (l) => n(l.total) },
    { classe: 'num', render: (l) => n(l.devolucoes) },
    { classe: 'num', render: (l) => (l.pct === null ? '—' : `${String(l.pct).replace('.', ',')}%`) },
  ], { vazio: 'Sem dados nos últimos 12 meses.' });

  const motivosMes = dados?.motivos_mes ?? [];
  const totalPorMotivo = new Map();
  for (const l of motivosMes) totalPorMotivo.set(l.motivo_devolucao, (totalPorMotivo.get(l.motivo_devolucao) ?? 0) + l.total);
  const top5 = [...totalPorMotivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m]) => m);
  const meses = [...new Set(motivosMes.map((l) => l.mes))].sort();
  const cabecalho = $('dt-motivos-mes-cab');
  cabecalho.replaceChildren(
    Object.assign(document.createElement('th'), { textContent: 'Motivo', scope: 'col' }),
    ...meses.map((m) => Object.assign(document.createElement('th'), { textContent: m, scope: 'col', className: 'num' })),
  );
  const porCelula = new Map(motivosMes.map((l) => [`${l.motivo_devolucao}|${l.mes}`, l.total]));
  renderTabela($('dt-motivos-mes'), top5.map((motivo) => ({ motivo, meses })), [
    { render: (l) => rotularMotivo(l.motivo) },
    ...meses.map((m) => ({ classe: 'num', render: (l) => n(porCelula.get(`${l.motivo}|${m}`) ?? 0) })),
  ], { vazio: 'Sem devoluções classificadas nos últimos 12 meses.' });
  if (!top5.length) $('dt-motivos-mes-cab').replaceChildren();

  barraHorizontal($('dt-defeito-tags'), dados?.defeito_tags ?? [], 'tag', { vazio: 'Nenhuma foto marcada com defeito no período.' });
}

/* ═══════════════════════  tabela paginada genérica (local)  ═══════════════ */

function criarTabelaPaginada({
  corpoId, paginacaoId, buscaId, colunas, porPagina = 12, camposBusca = [], rotuloItem = 'item', vazio = 'Nada encontrado.',
  csvBotaoId = null, csvArquivo = 'dados.csv', csvColunas = null, aoClicarLinha = null,
}) {
  let todas = [];
  let linhasFiltradas = [];
  let pagina = 1;
  let filtro = '';
  if (aoClicarLinha) colunas.aoClicarLinha = aoClicarLinha;

  function aplicar() {
    let linhas = todas;
    if (filtro) {
      const alvo = filtro.toLowerCase();
      linhas = linhas.filter((l) => camposBusca.some((c) => String(l[c] ?? '').toLowerCase().includes(alvo)));
    }
    linhasFiltradas = linhas;
    const p = paginar(linhas, pagina, porPagina);
    pagina = p.pagina;
    renderTabela($(corpoId), p.fatia, colunas, { vazio });
    montarPaginacao($(paginacaoId), { pagina, totalPaginas: p.totalPaginas, total: linhas.length, rotuloItem }, (p2) => { pagina = p2; aplicar(); });
  }

  if (buscaId) {
    $(buscaId).addEventListener('input', debounce((e) => { filtro = e.target.value.trim(); pagina = 1; aplicar(); }, 300));
  }
  if (csvBotaoId && csvColunas) {
    $(csvBotaoId).addEventListener('click', () => {
      baixarCsv(csvArquivo, csvColunas.map((c) => c.cabecalho), linhasFiltradas.map((l) => csvColunas.map((c) => c.valor(l))));
    });
  }

  return { atualizar(linhas) { todas = linhas ?? []; pagina = 1; filtro = ''; if (buscaId) $(buscaId).value = ''; aplicar(); } };
}

const tabelaProdutoMotivo = criarTabelaPaginada({
  corpoId: 'dt-produto-motivo', paginacaoId: 'dt-produto-motivo-pag', porPagina: 10, rotuloItem: 'produto',
  colunas: [
    { classe: 'cel-forte', render: (l) => l.produto },
    { render: (l) => l.top.map((m) => `${rotularMotivo(m.motivo_devolucao)} (${n(m.total)})`).join(', ') },
    { classe: 'num', render: (l) => n(l.total) },
  ],
  csvBotaoId: 'dt-produto-motivo-csv', csvArquivo: 'produto_motivo.csv',
  csvColunas: [
    { cabecalho: 'produto', valor: (l) => l.produto },
    { cabecalho: 'motivos', valor: (l) => l.top.map((m) => `${rotularMotivo(m.motivo_devolucao)} (${m.total})`).join(' | ') },
    { cabecalho: 'total', valor: (l) => l.total },
  ],
});

function renderProdutoMotivo() {
  const bruto = dados?.produto_motivo ?? [];
  const porProduto = new Map();
  for (const l of bruto) {
    const grupo = porProduto.get(l.produto_mencionado) ?? [];
    grupo.push(l);
    porProduto.set(l.produto_mencionado, grupo);
  }
  const linhas = [...porProduto.entries()].map(([produto, itens]) => ({
    produto,
    total: itens.reduce((a, i) => a + i.total, 0),
    top: itens.sort((a, b) => b.total - a.total).slice(0, 3),
  })).sort((a, b) => b.total - a.total);
  tabelaProdutoMotivo.atualizar(linhas);
}

const tabelaReincidentes = criarTabelaPaginada({
  corpoId: 'dt-reincidentes', paginacaoId: 'dt-reincidentes-pag', buscaId: 'dt-reincidentes-busca',
  camposBusca: ['nome', 'remetente_email'], porPagina: 10, rotuloItem: 'cliente',
  colunas: [
    { render: (l) => celCliente(l.nome, l.remetente_email) },
    { classe: 'num', render: (l) => n(l.devolucoes) },
    { render: (l) => truncar(l.motivos ?? '', 60) },
    { render: (l) => truncar(l.produtos ?? '', 60) },
    { render: (l) => (l.ultimo ? new Date(l.ultimo).toLocaleDateString('pt-BR') : '—') },
  ],
  aoClicarLinha: (l) => abrirModalEmails('email', l.remetente_email, `reincidente ${l.nome || l.remetente_email}`, [
    { rotulo: 'Cliente', valor: l.nome || '—' },
    { rotulo: 'E-mail', valor: l.remetente_email },
    { rotulo: 'Devoluções/trocas', valor: n(l.devolucoes) },
    { rotulo: 'Último contato', valor: l.ultimo ? dataHora(l.ultimo) : '—' },
    { rotulo: 'Motivos', valor: l.motivos || '—', largo: true },
    { rotulo: 'Produtos', valor: l.produtos || '—', largo: true },
  ]),
  csvBotaoId: 'dt-reincidentes-csv', csvArquivo: 'reincidentes.csv',
  csvColunas: [
    { cabecalho: 'nome', valor: (l) => l.nome ?? '' },
    { cabecalho: 'remetente_email', valor: (l) => l.remetente_email },
    { cabecalho: 'devolucoes', valor: (l) => l.devolucoes },
    { cabecalho: 'motivos', valor: (l) => l.motivos ?? '' },
    { cabecalho: 'produtos', valor: (l) => l.produtos ?? '' },
    { cabecalho: 'ultimo', valor: (l) => l.ultimo ?? '' },
  ],
});

const tabelaReclamantes = criarTabelaPaginada({
  corpoId: 'dt-reclamantes', paginacaoId: 'dt-reclamantes-pag', buscaId: 'dt-reclamantes-busca',
  camposBusca: ['nome', 'remetente_email', 'pedido'], porPagina: 12, rotuloItem: 'cliente',
  colunas: [
    { render: (l) => chipSituacaoPedido(l.situacao) },
    { render: (l) => celCliente(l.nome, l.remetente_email) },
    { render: (l) => l.pedido ?? '—', classe: 'cel-mono' },
    { render: (l) => l.produto ?? '—' },
    { render: (l) => rotularPlataforma(l.plataforma) },
    { render: (l) => truncar(l.motivos ?? '', 50) },
    { classe: 'num', render: (l) => n(l.emails) },
    { render: (l) => (l.ultimo_email ? new Date(l.ultimo_email).toLocaleDateString('pt-BR') : '—') },
  ],
  aoClicarLinha: (l) => abrirModalEmails('email', l.remetente_email, `reclamante ${l.nome || l.remetente_email}`, [
    { rotulo: 'Cliente', valor: l.nome || '—' },
    { rotulo: 'E-mail', valor: l.remetente_email },
    { rotulo: 'Situação do pedido', valor: chipSituacaoPedido(l.situacao) },
    { rotulo: 'Pedido', valor: l.pedido || '—' },
    { rotulo: 'Produto', valor: l.produto || '—' },
    { rotulo: 'Plataforma', valor: rotularPlataforma(l.plataforma) },
    { rotulo: 'E-mails trocados', valor: n(l.emails) },
    { rotulo: 'Último e-mail', valor: l.ultimo_email ? dataHora(l.ultimo_email) : '—' },
    { rotulo: 'Motivos', valor: l.motivos || '—', largo: true },
  ]),
  csvBotaoId: 'dt-reclamantes-csv', csvArquivo: 'reclamantes.csv',
  csvColunas: [
    { cabecalho: 'situacao', valor: (l) => l.situacao },
    { cabecalho: 'nome', valor: (l) => l.nome ?? '' },
    { cabecalho: 'remetente_email', valor: (l) => l.remetente_email },
    { cabecalho: 'pedido', valor: (l) => l.pedido ?? '' },
    { cabecalho: 'produto', valor: (l) => l.produto ?? '' },
    { cabecalho: 'plataforma', valor: (l) => l.plataforma ?? '' },
    { cabecalho: 'motivos', valor: (l) => l.motivos ?? '' },
    { cabecalho: 'emails', valor: (l) => l.emails },
    { cabecalho: 'ultimo_email', valor: (l) => l.ultimo_email ?? '' },
  ],
});

const tabelaProdutos = criarTabelaPaginada({
  corpoId: 'dt-produtos', paginacaoId: 'dt-produtos-pag', buscaId: 'dt-produtos-busca',
  camposBusca: ['produto_mencionado'], porPagina: 10, rotuloItem: 'produto',
  colunas: [
    { render: (l) => l.produto_mencionado, classe: 'cel-forte' },
    { classe: 'num', render: (l) => n(l.total) },
    { classe: 'num', render: (l) => n(l.devolucoes) },
    { classe: 'num', render: (l) => n(l.reclamacoes) },
  ],
  csvBotaoId: 'dt-produtos-csv', csvArquivo: 'produtos.csv',
  csvColunas: [
    { cabecalho: 'produto', valor: (l) => l.produto_mencionado },
    { cabecalho: 'total', valor: (l) => l.total },
    { cabecalho: 'devolucoes', valor: (l) => l.devolucoes },
    { cabecalho: 'reclamacoes', valor: (l) => l.reclamacoes },
  ],
});

const tabelaClientesRisco = criarTabelaPaginada({
  corpoId: 'dt-clientes-risco', paginacaoId: 'dt-clientes-risco-pag', buscaId: 'dt-clientes-risco-busca',
  camposBusca: ['nome', 'remetente_email'], porPagina: 10, rotuloItem: 'cliente',
  colunas: [
    { render: (l) => celCliente(l.nome, l.remetente_email) },
    { classe: 'num', render: (l) => n(l.emails_negativos) },
    { render: (l) => (l.ultimo_contato ? dataHora(l.ultimo_contato) : '—') },
  ],
  aoClicarLinha: (l) => abrirModalEmails('email', l.remetente_email, `cliente de risco ${l.nome || l.remetente_email}`, [
    { rotulo: 'Cliente', valor: l.nome || '—' },
    { rotulo: 'E-mail', valor: l.remetente_email },
    { rotulo: 'E-mails negativos (30 dias)', valor: n(l.emails_negativos) },
    { rotulo: 'Último contato', valor: l.ultimo_contato ? dataHora(l.ultimo_contato) : '—' },
  ]),
  csvBotaoId: 'dt-clientes-risco-csv', csvArquivo: 'clientes_risco.csv',
  csvColunas: [
    { cabecalho: 'nome', valor: (l) => l.nome ?? '' },
    { cabecalho: 'remetente_email', valor: (l) => l.remetente_email },
    { cabecalho: 'emails_negativos', valor: (l) => l.emails_negativos },
    { cabecalho: 'ultimo_contato', valor: (l) => l.ultimo_contato ?? '' },
  ],
});

const tabelaUltimos = criarTabelaPaginada({
  corpoId: 'dt-ultimos', paginacaoId: 'dt-ultimos-pag', buscaId: 'dt-ultimos-busca',
  camposBusca: ['remetente_nome', 'remetente_email', 'assunto', 'resumo'], porPagina: 15, rotuloItem: 'e-mail',
  aoClicarLinha: (l) => abrirFicha({
    titulo: l.assunto || '(sem assunto)',
    subtitulo: [l.remetente_nome, l.remetente_email].filter(Boolean).join(' · '),
    campos: [
      { rotulo: 'Quando', valor: l.data_email ? dataHora(l.data_email) : '—' },
      { rotulo: 'Categoria', valor: rotularCategoria(l.categoria) },
      { rotulo: 'Sentimento', valor: chipSentimento(l.sentimento) },
      { rotulo: 'Urgência', valor: chipUrgencia(l.urgencia) },
      { rotulo: 'Pede resposta', valor: l.pede_resposta ? 'Sim' : 'Não' },
      { rotulo: 'Anexo', valor: l.tem_anexo ? 'Sim' : 'Não' },
      { rotulo: 'Pedido', valor: l.numero_pedido || '—' },
      { rotulo: 'Produto mencionado', valor: l.produto_mencionado || '—' },
      l.motivo_devolucao && { rotulo: 'Motivo de devolução', valor: rotularMotivo(l.motivo_devolucao) },
      { rotulo: 'Erro de análise', valor: l.erro_analise || 'nenhum' },
      { rotulo: 'Resumo', valor: l.resumo || '—', largo: true },
    ],
  }),
  csvBotaoId: 'dt-ultimos-csv', csvArquivo: 'ultimos_emails.csv',
  csvColunas: [
    { cabecalho: 'data_email', valor: (l) => l.data_email ?? '' },
    { cabecalho: 'remetente_nome', valor: (l) => l.remetente_nome ?? '' },
    { cabecalho: 'remetente_email', valor: (l) => l.remetente_email },
    { cabecalho: 'assunto', valor: (l) => l.assunto ?? '' },
    { cabecalho: 'categoria', valor: (l) => l.categoria ?? '' },
    { cabecalho: 'sentimento', valor: (l) => l.sentimento ?? '' },
    { cabecalho: 'urgencia', valor: (l) => l.urgencia ?? '' },
    { cabecalho: 'numero_pedido', valor: (l) => l.numero_pedido ?? '' },
  ],
  colunas: [
    { render: (l) => (l.data_email ? dataHora(l.data_email) : '—'), classe: 'cel-mono' },
    { render: (l) => celCliente(l.remetente_nome, l.remetente_email) },
    {
      render: (l) => {
        const div = document.createElement('div');
        div.textContent = l.assunto ?? '—';
        const notas = [];
        if (l.tem_anexo) notas.push('📎 anexo');
        if (l.numero_pedido) notas.push(`pedido ${l.numero_pedido}`);
        if (notas.length) { const s = document.createElement('span'); s.className = 'cel-sub'; s.textContent = notas.join(' · '); div.append(s); }
        return div;
      },
    },
    { render: (l) => rotularCategoria(l.categoria) },
    { render: (l) => chipSentimento(l.sentimento) },
    { render: (l) => chipUrgencia(l.urgencia) },
    {
      classe: 'cel-erro',
      render: (l) => (l.erro_analise ? '⚠ falha na análise' : truncar(l.resumo ?? '', 90)),
    },
  ],
});

/* ═══════════════════════  pendentes + gerar rascunho  ═══════════════════════ */

let emailModal = null;

function abrirModalResposta(email) {
  emailModal = email;
  $('dt-resposta-cliente').textContent = `${email.remetente_nome || email.remetente_email} · ${email.assunto ?? ''}`;
  $('dt-resposta-texto').value = email.resposta_sugerida ?? '';
  $('dt-resposta-status').textContent = email.resposta_sugerida ? '' : 'Clique em “Gerar” para criar um rascunho com IA.';
  $('dt-resposta-regenerar').textContent = email.resposta_sugerida ? 'Regenerar' : 'Gerar';
  $('dt-resposta-modal').showModal();
}

$('dt-resposta-fechar').addEventListener('click', () => $('dt-resposta-modal').close());
$('dt-resposta-copiar').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('dt-resposta-texto').value);
  $('dt-resposta-status').textContent = 'Copiado.';
});
$('dt-resposta-regenerar').addEventListener('click', async () => {
  if (!emailModal) return;
  const botao = $('dt-resposta-regenerar');
  botao.disabled = true;
  $('dt-resposta-status').textContent = 'Gerando com IA…';
  const forcar = Boolean(emailModal.resposta_sugerida);
  const { ok, dados: resp } = await api('/api/resposta', { metodo: 'POST', corpo: { id: emailModal.id, forcar } });
  botao.disabled = false;
  if (!ok || resp.erro) { $('dt-resposta-status').textContent = resp?.erro ?? 'Não consegui gerar a resposta.'; return; }
  $('dt-resposta-texto').value = resp.resposta ?? '';
  emailModal.resposta_sugerida = resp.resposta;
  botao.textContent = 'Regenerar';
  $('dt-resposta-status').textContent = 'Rascunho pronto — revise antes de enviar.';
});

function renderPendentes() {
  const linhas = dados?.pendentes ?? [];
  const colunas = [
    { render: (l) => (l.data_email ? dataHora(l.data_email) : '—'), classe: 'cel-mono' },
    { render: (l) => celCliente(l.remetente_nome, l.remetente_email) },
    { render: (l) => l.assunto ?? '—' },
    { render: (l) => rotularCategoria(l.categoria) },
    { render: (l) => chipUrgencia(l.urgencia) },
    { render: (l) => truncar(l.resumo ?? '', 70) },
    {
      render: (l) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = l.resposta_sugerida ? 'Ver' : 'Gerar';
        b.addEventListener('click', (ev) => { ev.stopPropagation(); abrirModalResposta(l); });
        return b;
      },
    },
  ];
  colunas.aoClicarLinha = abrirModalResposta;
  renderTabela($('dt-pendentes'), linhas, colunas, { vazio: 'Nenhum e-mail aguardando resposta no período.' });
}

/* ═══════════════════════════════  mini-galeria  ═══════════════════════════ */

// Não há rota própria — esta seção é uma aba a mais dentro do mesmo painel
// (ver suporte.js), então "ver galeria completa" é só trocar de aba.
$('dt-ver-galeria').addEventListener('click', (ev) => {
  ev.preventDefault();
  $('aba-btn-galeriaia').click();
});

function renderImagens() {
  const container = $('dt-imagens');
  const itens = (dados?.imagens ?? []).slice(0, 12);
  container.replaceChildren();
  if (!itens.length) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Nenhum anexo no período.';
    container.append(p);
    return;
  }
  for (const img of itens) {
    const a = document.createElement('a');
    a.className = 'gal-card gal-card--mini';
    a.href = img.mime_type?.startsWith('image/') ? `/api/imagem/${img.id}` : '#galeria-ia';
    a.target = img.mime_type?.startsWith('image/') ? '_blank' : '_self';
    a.rel = 'noopener noreferrer';
    if (img.mime_type?.startsWith('image/')) {
      const im = document.createElement('img');
      im.src = `/api/imagem/${img.id}`;
      im.alt = img.nome_arquivo ?? '';
      im.loading = 'lazy';
      a.append(im);
    } else {
      const ic = document.createElement('span');
      ic.className = 'gal-icone';
      ic.textContent = '📄';
      a.append(ic);
    }
    container.append(a);
  }
}

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

let geracao = 0;

export async function carregarDados() {
  const meu = ++geracao;
  try {
    const { ok, dados: d } = await api(`/api/dados?${qsCompleto()}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(d?.erro ?? 'falha ao carregar');
    dados = d;
    renderKpis();
    renderTicketsCompacto();
    renderBarrasSimples();
    renderEvolucao();
    renderEstudoDevolucoes();
    renderProdutoMotivo();
    tabelaReincidentes.atualizar(dados.reincidentes ?? []);
    renderPendentes();
    tabelaReclamantes.atualizar(dados.reclamantes ?? []);
    tabelaProdutos.atualizar(dados.produtos ?? []);
    tabelaClientesRisco.atualizar(dados.clientes_risco ?? []);
    renderImagens();
    tabelaUltimos.atualizar(dados.ultimos ?? []);
  } catch (err) {
    if (meu !== geracao) return;
    $('dt-erro').hidden = false;
    $('dt-erro').textContent = `Não consegui carregar os dados: ${err.message}`;
  }
}

aoMudarFiltroCE(carregarDados);
$('dt-busca').addEventListener('input', debounce((e) => { busca = e.target.value.trim(); carregarDados(); }, 450));

carregarDados();
setInterval(carregarDados, 30 * 1000);
