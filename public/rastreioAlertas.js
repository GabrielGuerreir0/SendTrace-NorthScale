/**
 * SPPL — "Alertas de logística": ocorrências abertas pelo motor (sem código, etiqueta sem coleta, parado 5/10/15 dias, exceção grave),
 * com filtros, janela de trabalho (responsável, próxima ação, resultado) e registro de cobranças à fulfillment/transportadora.
 * Qualquer conta com a página "Rastreio" trabalha as ocorrências. Texto vindo da API entra sempre por textContent.
 */
import { $, api, montarPaginacao } from './emailComum.js';
import { dataHora } from './format.js';
import { criarTradutor } from './i18n.js';

const DIC = {
  carregando: { en: 'loading…', pt: 'carregando…' },
  alTitulo: { en: 'Logistics alerts', pt: 'Alertas de logística' },
  alSub: { en: 'Orders that need action: no tracking code, label without pickup, stalled in transit and serious carrier exceptions. Work each one, register the charge to the fulfillment center or carrier, and close it with the result.', pt: 'Pedidos que pedem ação: sem código de rastreio, etiqueta sem coleta, parados em trânsito e exceções graves da transportadora. Trabalhe cada um, registre a cobrança à fulfillment ou à transportadora e encerre com o resultado.' },
  alColSituacao: { en: 'Status', pt: 'Situação' }, alColPrio: { en: 'Priority', pt: 'Prioridade' }, alColCaso: { en: 'Case', pt: 'Caso' },
  alColPrazo: { en: 'Due', pt: 'Prazo' }, alColDias: { en: 'Alert open (days)', pt: 'Alerta aberto (dias)' }, alColDiasPedido: { en: 'Order age (days)', pt: 'Pedido há (dias)' }, colPedido: { en: 'Order', pt: 'Pedido' }, colProduto: { en: 'Product', pt: 'Produto' },
  alSitAbertas: { en: 'Open', pt: 'Abertas' }, alSitTodas: { en: 'All', pt: 'Todas' }, alSitAberta: { en: 'New', pt: 'Nova' }, alSitCobranca: { en: 'Being chased', pt: 'Em cobrança' },
  alSitCliente: { en: 'Waiting for customer', pt: 'Aguardando cliente' }, alSitResolvida: { en: 'Resolved', pt: 'Resolvida' }, alSitCancelada: { en: 'Cancelled', pt: 'Cancelada' },
  alPrioTodas: { en: 'All priorities', pt: 'Todas as prioridades' }, alBuscar: { en: 'Search', pt: 'Buscar' }, alBuscarPh: { en: 'Order, tracking code or owner', pt: 'Pedido, código de rastreio ou responsável' },
  alKpiAbertas: { en: 'Open', pt: 'Abertas' }, alKpiVencidas: { en: 'Overdue', pt: 'Vencidas' }, alKpiCobranca: { en: 'Being chased', pt: 'Em cobrança' }, alKpiResolvidas: { en: 'Resolved (7 days)', pt: 'Resolvidas (7 dias)' },
  alVazio: { en: 'No alerts with these filters.', pt: 'Nenhum alerta com estes filtros.' }, alErroLista: { en: 'Could not load the alerts.', pt: 'Não foi possível carregar os alertas.' },
  alVencida: { en: 'overdue', pt: 'vencida' }, alSemPrazo: { en: 'no deadline', pt: 'sem prazo' },
  alDestinoRot: { en: 'Charge to', pt: 'Cobrar de' }, alCanalRot: { en: 'Channel', pt: 'Canal' }, alMsgRot: { en: 'What was asked', pt: 'O que foi pedido' }, alVenceu: { en: 'overdue', pt: 'vencida' },
  alProxAcao: { en: 'Next action', pt: 'Próxima ação' }, alProxAte: { en: 'Next action by', pt: 'Próxima ação até' }, alResultado: { en: 'Result (required to close)', pt: 'Resultado (obrigatório para encerrar)' },
  alAbrirPedido: { en: 'Open order sheet', pt: 'Abrir ficha do pedido' }, alFechar: { en: 'Close', pt: 'Fechar' }, spplSalvar: { en: 'Save', pt: 'Salvar' },
  alCobrancas: { en: 'Charges to fulfillment / carrier', pt: 'Cobranças à fulfillment / transportadora' }, alNovaCobranca: { en: 'Register a charge', pt: 'Registrar uma cobrança' },
  alDestFulfillment: { en: 'Fulfillment center', pt: 'Fulfillment' }, alDestTransp: { en: 'Carrier', pt: 'Transportadora' }, alDestParceiro: { en: 'Logistics partner', pt: 'Parceiro logístico' },
  alDestPlataforma: { en: 'Sales platform', pt: 'Plataforma de venda' }, alDestCliente: { en: 'Customer', pt: 'Cliente' },
  alCanalPh: { en: 'Channel (e-mail, portal, phone)', pt: 'Canal (e-mail, portal, telefone)' }, alMsgPh: { en: 'What was asked', pt: 'O que foi pedido' },
  alPrazoResp: { en: 'Days to answer (business days)', pt: 'Dias para responder (dias úteis)' }, alRegistrar: { en: 'Register charge', pt: 'Registrar cobrança' },
  alSemCobrancas: { en: 'No charge registered yet.', pt: 'Nenhuma cobrança registrada ainda.' }, alAnswerPh: { en: 'Answer received', pt: 'Resposta recebida' }, alRegistrarResp: { en: 'Register answer', pt: 'Registrar resposta' },
  alRespondida: { en: 'Answered', pt: 'Respondida' }, alResposta: { en: 'Answer', pt: 'Resposta' }, alPrazoRespAte: { en: 'answer due {data}', pt: 'resposta até {data}' }, alPor: { en: 'by {quem}', pt: 'por {quem}' },
  alSalvo: { en: 'Saved.', pt: 'Salvo.' }, alErro: { en: 'Could not save: ', pt: 'Não foi possível salvar: ' }, alPag: { en: 'alert', pt: 'alerta' },
  cat_sem_codigo_rastreio: { en: 'No tracking code', pt: 'Sem código de rastreio' }, cat_etiqueta_sem_coleta: { en: 'Label created, not picked up', pt: 'Etiqueta sem coleta' },
  cat_sem_movimento_5d: { en: 'No movement 5+ days', pt: 'Sem movimento há 5+ dias' }, cat_sem_movimento_10d: { en: 'No movement 10+ days', pt: 'Sem movimento há 10+ dias' }, cat_sem_movimento_15d: { en: 'No movement 15+ days (critical)', pt: 'Sem movimento há 15+ dias (crítico)' },
  cat_excecao_grave: { en: 'Serious carrier exception', pt: 'Exceção grave da transportadora' }, cat_falha_entrega: { en: 'Delivery failure', pt: 'Falha de entrega' }, cat_alfandega: { en: 'Customs', pt: 'Alfândega' },
  cat_retirada: { en: 'Available for pickup', pt: 'Disponível para retirada' }, cat_rastreio_nao_localizado: { en: 'Tracking not found', pt: 'Rastreio não localizado' }, cat_rastreio_expirado: { en: 'Tracking expired', pt: 'Rastreamento expirado' },
  cat_entregue_contestado: { en: 'Delivered, customer disputes', pt: 'Entregue, cliente contesta' },
};
const t = criarTradutor(DIC);
const SITUACAO = { aberta: 'alSitAberta', em_cobranca: 'alSitCobranca', aguardando_cliente: 'alSitCliente', resolvida: 'alSitResolvida', cancelada: 'alSitCancelada' };
const DESTINO = { fulfillment: 'alDestFulfillment', transportadora: 'alDestTransp', parceiro_logistico: 'alDestParceiro', plataforma_de_venda: 'alDestPlataforma', cliente: 'alDestCliente' };
const categoria = (c) => (DIC[`cat_${c}`] ? t(`cat_${c}`) : c);
const el = (tag, texto, classe) => { const e = document.createElement(tag); if (texto !== undefined && texto !== null) e.textContent = texto; if (classe) e.className = classe; return e; };

const estado = { situacao: 'abertas', prioridade: '', busca: '', vencidas: false, pagina: 1 };
const POR_PAGINA = 25;
let atual = null;   // ocorrência aberta na janela
let ultimoResumo = null;

function aplicarEstaticos() {
  for (const raiz of [$('alertas-cartao'), $('alertas-modal')]) {
    if (!raiz) continue;
    raiz.querySelectorAll('[data-t]').forEach((e) => { if (DIC[e.dataset.t]) e.textContent = t(e.dataset.t); });
    raiz.querySelectorAll('[data-t-placeholder]').forEach((e) => { if (DIC[e.dataset.tPlaceholder]) e.placeholder = t(e.dataset.tPlaceholder); });
  }
}

/* ── cartões do topo (também são filtros rápidos) ── */
function desenharResumo() {
  const r = ultimoResumo; const caixa = $('alertas-kpis');
  if (!r || !caixa) return;
  const itens = [
    ['abertas', t('alKpiAbertas'), r.abertas, () => { estado.situacao = 'abertas'; estado.prioridade = ''; estado.vencidas = false; }, estado.situacao === 'abertas' && !estado.prioridade && !estado.vencidas],
    ['vencidas', t('alKpiVencidas'), r.vencidas, () => { estado.situacao = 'abertas'; estado.prioridade = ''; estado.vencidas = true; }, estado.vencidas],
    ['p0', 'P0', r.p0, () => { estado.situacao = 'abertas'; estado.prioridade = 'P0'; estado.vencidas = false; }, estado.prioridade === 'P0'],
    ['p1', 'P1', r.p1, () => { estado.situacao = 'abertas'; estado.prioridade = 'P1'; estado.vencidas = false; }, estado.prioridade === 'P1'],
    ['cobranca', t('alKpiCobranca'), r.em_cobranca, () => { estado.situacao = 'em_cobranca'; estado.prioridade = ''; estado.vencidas = false; }, estado.situacao === 'em_cobranca'],
    ['resolvidas', t('alKpiResolvidas'), r.resolvidas_7d, () => { estado.situacao = 'resolvida'; estado.prioridade = ''; estado.vencidas = false; }, estado.situacao === 'resolvida'],
  ];
  caixa.replaceChildren(...itens.map(([chave, rotulo, valor, acao, ativo]) => {
    const b = el('button', undefined, 'sppl-kpi'); b.type = 'button'; b.setAttribute('aria-pressed', String(Boolean(ativo)));
    if ((chave === 'vencidas' || chave === 'p0') && Number(valor) > 0) b.dataset.tom = 'alto';
    b.append(el('b', valor ?? 0), document.createTextNode(rotulo));
    b.addEventListener('click', () => { acao(); estado.pagina = 1; sincronizarFiltros(); carregarLista(); desenharResumo(); });
    return b;
  }));
}
function sincronizarFiltros() { $('alertas-f-situacao').value = estado.situacao; $('alertas-f-prio').value = estado.prioridade; }

async function carregarResumo() {
  const r = await api('/api/rastreio/sppl/ocorrencias/resumo');
  if (r.ok) { ultimoResumo = r.dados; desenharResumo(); }
}

/* ── lista ── */
async function carregarLista() {
  const q = new URLSearchParams({ page: String(estado.pagina), page_size: String(POR_PAGINA) });
  if (estado.situacao) q.set('situacao', estado.situacao); if (estado.prioridade) q.set('prioridade', estado.prioridade);
  if (estado.busca) q.set('busca', estado.busca); if (estado.vencidas) q.set('vencidas', 'true');
  const r = await api(`/api/rastreio/sppl/ocorrencias?${q}`);
  const corpo = $('alertas-corpo');
  if (!r.ok) { corpo.replaceChildren(vazio(t('alErroLista'))); return; }
  const lista = r.dados.ocorrencias ?? [];
  if (!lista.length) corpo.replaceChildren(vazio(t('alVazio')));
  else corpo.replaceChildren(...lista.map(linha));
  montarPaginacao($('alertas-paginacao'), { pagina: estado.pagina, totalPaginas: Math.max(1, Math.ceil((r.dados.total ?? 0) / POR_PAGINA)), total: r.dados.total ?? 0, rotuloItem: t('alPag') }, (p) => { estado.pagina = p; carregarLista(); });
}
function vazio(msg) { const tr = document.createElement('tr'); const td = el('td', msg, 'vazio-suave'); td.colSpan = 8; tr.append(td); return tr; }
const celAl = (rotulo, conteudo) => { const td = document.createElement('td'); td.dataset.label = rotulo; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? ''; return td; };
function linha(o) {
  const tr = document.createElement('tr'); tr.classList.add('sup-linha-clique');
  if (o.vencida) tr.classList.add('sppl-linha--vencida');
  const prio = el('span', o.prioridade, `sppl-selo sppl-selo--${String(o.prioridade).toLowerCase()}`);
  const sit = el('span', t(SITUACAO[o.situacao] ?? 'alSitAberta'), 'sppl-sit'); sit.dataset.s = o.situacao;
  const prazo = el('span', o.prazo_ate ? `${dataHora(o.prazo_ate)}${o.vencida ? ` · ${t('alVencida')}` : ''}` : t('alSemPrazo'), o.vencida ? 'sppl-prazo--vencido' : '');
  tr.append(celAl(t('alColPrio'), prio), celAl(t('alColCaso'), categoria(o.categoria)), celAl(t('colPedido'), o.transacao_id), celAl(t('colProduto'), o.produto ?? '—'),
    celAl(t('alColSituacao'), sit), celAl(t('alColPrazo'), prazo), celAl(t('alColDiasPedido'), o.dias_pedido ?? '—'), celAl(t('alColDias'), o.dias_aberta ?? '—'));
  tr.addEventListener('click', () => abrirModal(o.id));
  return tr;
}

/* ── janela de trabalho ── */
const paraInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

async function abrirModal(id) {
  const r = await api(`/api/rastreio/sppl/ocorrencias/${id}`);
  if (!r.ok) { $('alertas-aviso').textContent = r.dados?.erro ?? t('alErroLista'); return; }
  atual = r.dados; const o = atual;
  $('alertas-m-titulo').textContent = `${o.prioridade} · ${categoria(o.categoria)}`;
  $('alertas-m-sub').textContent = [o.transacao_id, o.produto, o.carrier_code, o.tracking_number].filter(Boolean).join(' · ');
  $('alertas-m-acao').textContent = o.proxima_acao ? `${t('alProxAcao')}: ${o.proxima_acao}` : ''; $('alertas-m-acao').hidden = !o.proxima_acao;
  $('alertas-m-situacao').value = o.situacao; $('alertas-m-prox').value = o.proxima_acao ?? '';
  $('alertas-m-ate').value = paraInput(o.proxima_acao_ate); $('alertas-m-resultado').value = o.resultado ?? '';
  $('alertas-m-erro').hidden = true; $('alertas-m-cobform').hidden = ['resolvida', 'cancelada'].includes(o.situacao);
  desenharCobrancas(o.cobrancas ?? []);
  aplicarEstaticos(); $('alertas-modal').showModal();
}

function desenharCobrancas(lista) {
  const caixa = $('alertas-m-cobrancas');
  if (!lista.length) { caixa.replaceChildren(el('p', t('alSemCobrancas'), 'cartao-sub')); return; }
  caixa.replaceChildren(...lista.map((c) => {
    const d = el('div', undefined, 'sppl-cobranca');
    d.append(el('strong', t(DESTINO[c.destino] ?? 'alDestFulfillment')), el('span', ` · ${dataHora(c.cobrado_em)}${c.cobrado_por ? ` · ${t('alPor', { quem: c.cobrado_por })}` : ''}${c.canal ? ` · ${c.canal}` : ''}`));
    if (c.mensagem) d.append(el('p', c.mensagem));
    if (c.respondida_em) d.append(el('p', `${t('alRespondida')} ${dataHora(c.respondida_em)} — ${c.resposta ?? ''}`, 'cartao-sub'));
    else {
      if (c.prazo_resposta_ate) d.append(el('p', t('alPrazoRespAte', { data: dataHora(c.prazo_resposta_ate) }), 'cartao-sub'));
      const ta = el('textarea'); ta.rows = 2; ta.maxLength = 2000; ta.placeholder = t('alAnswerPh');
      const b = el('button', t('alRegistrarResp'), 'btn'); b.type = 'button';
      b.addEventListener('click', async () => {
        const r = await api(`/api/rastreio/sppl/cobrancas/${c.id}`, { metodo: 'PATCH', corpo: { resposta: ta.value } });
        if (!r.ok) { erroModal(r); return; }
        await abrirModal(atual.id);
      });
      d.append(ta, b);
    }
    return d;
  }));
}
function erroModal(r) { const e = $('alertas-m-erro'); e.textContent = t('alErro') + (r.dados?.erro ?? r.status); e.hidden = false; }

function ligar() {
  if (!$('alertas-cartao')) return;
  $('alertas-f-situacao').addEventListener('change', (e) => { estado.situacao = e.target.value; estado.vencidas = false; $('alertas-aviso').textContent = ''; estado.pagina = 1; carregarLista(); desenharResumo(); });
  $('alertas-f-prio').addEventListener('change', (e) => { estado.prioridade = e.target.value; estado.vencidas = false; $('alertas-aviso').textContent = ''; estado.pagina = 1; carregarLista(); desenharResumo(); });
  let tmr; $('alertas-f-busca').addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { estado.busca = e.target.value.trim(); estado.pagina = 1; $('alertas-aviso').textContent = ''; carregarLista(); }, 350); });
  const fecharModal = () => $('alertas-modal').close();
  $('alertas-m-fechar').addEventListener('click', fecharModal); $('alertas-m-x').addEventListener('click', fecharModal);
  $('alertas-modal').addEventListener('click', (ev) => { if (ev.target === $('alertas-modal')) fecharModal(); });   // clique no fundo escuro fecha
  $('alertas-m-pedido').addEventListener('click', () => { if (atual) document.dispatchEvent(new CustomEvent('rastreio:abrir-pedido', { detail: { transacao_id: atual.transacao_id } })); });
  $('alertas-form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); if (!atual) return;
    const ate = $('alertas-m-ate').value;
    const corpo = { situacao: $('alertas-m-situacao').value, proxima_acao: $('alertas-m-prox').value, proxima_acao_ate: ate ? new Date(ate).toISOString() : null, resultado: $('alertas-m-resultado').value };
    const r = await api(`/api/rastreio/sppl/ocorrencias/${atual.id}`, { metodo: 'PATCH', corpo });
    if (!r.ok) { erroModal(r); return; }
    $('alertas-modal').close(); $('alertas-aviso').textContent = t('alSalvo'); carregarLista(); carregarResumo();
  });
  $('alertas-c-registrar').addEventListener('click', async () => {
    if (!atual) return;
    const corpo = { destino: $('alertas-c-destino').value, canal: $('alertas-c-canal').value, mensagem: $('alertas-c-msg').value, prazo_resposta_dias: $('alertas-c-dias').value };
    const r = await api(`/api/rastreio/sppl/ocorrencias/${atual.id}/cobrancas`, { metodo: 'POST', corpo });
    if (!r.ok) { erroModal(r); return; }
    $('alertas-c-canal').value = ''; $('alertas-c-msg').value = ''; await abrirModal(atual.id); carregarLista(); carregarResumo();
  });
  document.addEventListener('click', (ev) => { if (ev.target.closest?.('#rst-idioma-seletor')) setTimeout(() => { aplicarEstaticos(); desenharResumo(); carregarLista(); }, 0); });
  aplicarEstaticos(); sincronizarFiltros(); carregarResumo(); carregarLista();
}

ligar();
