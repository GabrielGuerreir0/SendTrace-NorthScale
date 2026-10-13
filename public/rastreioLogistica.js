/**
 * SPPL — três blocos da aba "Rastreio de Pedidos": Saúde (semáforo), Relatório de logística (7/14/30 dias, com "copiar resumo") e
 * Não encontrados na Red Rock (lista separada dos alertas, com exportação CSV). Só leitura. Texto da API entra sempre por textContent.
 */
import { $, api, montarPaginacao } from './emailComum.js';
import { dataHora } from './format.js';
import { criarTradutor } from './i18n.js';

const DIC = {
  carregando: { en: 'loading…', pt: 'carregando…' }, colPlataforma: { en: 'Platform', pt: 'Plataforma' }, colPedido: { en: 'Order', pt: 'Pedido' }, colProduto: { en: 'Product', pt: 'Produto' },
  alBuscar: { en: 'Search', pt: 'Buscar' },
  saTitulo: { en: 'SPPL health', pt: 'Saúde do SPPL' }, saSub: { en: 'Is the tracking pipeline working? Shows anything that needs attention: 17TRACK webhook, Red Rock status refresh and 17TRACK quota.', pt: 'O rastreio está funcionando? Mostra o que pede atenção: webhook do 17TRACK, atualização de status da Red Rock e cota do 17TRACK.' },
  saTudoOk: { en: 'All good: no problem detected.', pt: 'Tudo certo: nenhum problema detectado.' }, saErro: { en: 'Could not read the health status.', pt: 'Não foi possível ler a saúde.' },
  saMotor: { en: 'Alert engine', pt: 'Motor de alertas' }, saRegistro: { en: 'Automatic 17TRACK registration', pt: 'Registro automático no 17TRACK' }, saReconc: { en: '17TRACK daily refresh', pt: 'Reconsulta diária do 17TRACK' },
  saSorteio: { en: 'Owner draw', pt: 'Sorteio do responsável' }, saCards: { en: 'Cards in Escalated Support', pt: 'Cards no Suporte Escalado' }, saLigado: { en: 'on', pt: 'ligado' }, saDesligado: { en: 'off', pt: 'desligado' },
  saCota: { en: '17TRACK quota left', pt: 'Cota restante do 17TRACK' }, saDesconhecida: { en: 'unknown yet', pt: 'ainda desconhecida' }, saUltWebhook: { en: 'Last 17TRACK notice', pt: 'Último aviso do 17TRACK' },
  saUltReconc: { en: 'Last 17TRACK refresh', pt: 'Última reconsulta do 17TRACK' }, saUltRedRock: { en: 'Last Red Rock refresh', pt: 'Última reconsulta da Red Rock' }, saNunca: { en: 'never', pt: 'nunca' },
  saAcompanhando: { en: 'Codes being tracked', pt: 'Códigos em acompanhamento' }, saRecusados: { en: 'Codes 17TRACK refused / no data', pt: 'Códigos recusados / sem dado no 17TRACK' }, saAbertas: { en: 'Open alerts', pt: 'Alertas abertos' },
  reTitulo: { en: 'Logistics report', pt: 'Relatório de logística' }, reSub: { en: 'Alerts opened and closed, backlog, who holds what, charges to fulfillment/carriers. Pick the period and copy the summary to share.', pt: 'Alertas abertos e fechados, backlog, quem está com o quê, cobranças à fulfillment/transportadoras. Escolha o período e copie o resumo para compartilhar.' },
  reDias: { en: 'Period', pt: 'Período' }, reUltimos7: { en: 'Last 7 days', pt: 'Últimos 7 dias' }, reUltimos14: { en: 'Last 14 days', pt: 'Últimos 14 dias' }, reUltimos30: { en: 'Last 30 days', pt: 'Últimos 30 dias' },
  reCopiar: { en: 'Copy summary', pt: 'Copiar resumo' }, reCopiado: { en: 'Summary copied.', pt: 'Resumo copiado.' }, reNaoCopiou: { en: 'Could not copy; select the text below.', pt: 'Não consegui copiar; selecione o texto abaixo.' },
  reErro: { en: 'Could not load the report.', pt: 'Não foi possível carregar o relatório.' },
  reAbertasPeriodo: { en: 'Alerts opened in the period', pt: 'Alertas abertos no período' }, reResolvidas: { en: 'Resolved', pt: 'Resolvidos' }, reCanceladas: { en: 'Cancelled (delivered/refunded/closed)', pt: 'Cancelados' },
  reHoras: { en: 'Average time to resolve (hours)', pt: 'Tempo médio até resolver (horas)' }, reBacklog: { en: 'Backlog now', pt: 'Backlog agora' }, reVencidas: { en: 'overdue', pt: 'vencidos' }, reAbertasAgora: { en: 'open', pt: 'abertos' },
  rePorAgente: { en: 'By owner', pt: 'Por responsável' }, reAgente: { en: 'Owner', pt: 'Responsável' }, reColAbertas: { en: 'Open', pt: 'Abertos' }, reColVencidas: { en: 'Overdue', pt: 'Vencidos' }, reColResolvidas: { en: 'Resolved', pt: 'Resolvidos' },
  rePorFulfillment: { en: 'Open alerts by fulfillment and carrier', pt: 'Alertas abertos por fulfillment e transportadora' }, reProvedor: { en: 'Fulfillment', pt: 'Fulfillment' }, reTransportadora: { en: 'Carrier', pt: 'Transportadora' },
  reCobrancas: { en: 'Charges in the period', pt: 'Cobranças no período' }, reCobTotal: { en: 'registered', pt: 'registradas' }, reCobResp: { en: 'answered', pt: 'respondidas' }, reCobSem: { en: 'unanswered past the deadline', pt: 'sem resposta no prazo' }, reCobHoras: { en: 'avg hours to answer', pt: 'horas médias para responder' },
  reTrack: { en: '17TRACK', pt: '17TRACK' }, reTrackEntregas: { en: 'deliveries confirmed in the period', pt: 'entregas confirmadas no período' }, reTrackRecusados: { en: 'codes refused', pt: 'códigos recusados' }, reTrackSemDado: { en: 'without data', pt: 'sem dado' },
  reResumoTitulo: { en: 'Logistics report — last {dias} days', pt: 'Relatório de logística — últimos {dias} dias' },
  neTitulo: { en: 'Not found at Red Rock', pt: 'Não encontrados na Red Rock' }, neSub: { en: 'Orders Red Rock does not know (404). Kept apart from the alerts: the action is to send examples to the fulfillment center, not to chase a carrier. No customer data here.', pt: 'Pedidos que a Red Rock não conhece (404). Ficam fora dos alertas: a ação é levar exemplos à fulfillment, não cobrar transportadora. Sem dado de cliente aqui.' },
  neAte7: { en: 'Up to 7 days', pt: 'Até 7 dias' }, ne7a30: { en: '7 to 30 days', pt: '7 a 30 dias' }, neMais30: { en: 'Over 30 days', pt: 'Mais de 30 dias' }, neTotal: { en: 'Total', pt: 'Total' },
  neBuscaPh: { en: 'Order or product', pt: 'Pedido ou produto' }, neLimpar: { en: 'Clear filters', pt: 'Limpar filtros' }, neExportar: { en: 'Export CSV', pt: 'Exportar CSV' },
  neIdConsulta: { en: 'Lookup id', pt: 'ID da consulta' }, neDias: { en: 'Days since purchase', pt: 'Dias desde a compra' }, neVazio: { en: 'Nothing found with these filters.', pt: 'Nada encontrado com estes filtros.' },
  neErro: { en: 'Could not load the list.', pt: 'Não foi possível carregar a lista.' }, nePag: { en: 'order', pt: 'pedido' }, neExportado: { en: 'Exported {n} orders.', pt: '{n} pedidos exportados.' },
  cat_sem_codigo_rastreio: { en: 'No tracking code', pt: 'Sem código de rastreio' }, cat_etiqueta_sem_coleta: { en: 'Label created, not picked up', pt: 'Etiqueta sem coleta' },
  cat_sem_movimento_5d: { en: 'No movement 5+ days', pt: 'Sem movimento há 5+ dias' }, cat_sem_movimento_10d: { en: 'No movement 10+ days', pt: 'Sem movimento há 10+ dias' }, cat_sem_movimento_15d: { en: 'No movement 15+ days (critical)', pt: 'Sem movimento há 15+ dias (crítico)' },
  cat_excecao_grave: { en: 'Serious carrier exception', pt: 'Exceção grave da transportadora' }, cat_falha_entrega: { en: 'Delivery failure', pt: 'Falha de entrega' }, cat_alfandega: { en: 'Customs', pt: 'Alfândega' },
  dest_fulfillment: { en: 'Fulfillment', pt: 'Fulfillment' }, dest_transportadora: { en: 'Carrier', pt: 'Transportadora' }, dest_parceiro_logistico: { en: 'Logistics partner', pt: 'Parceiro logístico' }, dest_plataforma_de_venda: { en: 'Sales platform', pt: 'Plataforma de venda' }, dest_cliente: { en: 'Customer', pt: 'Cliente' },
};
const t = criarTradutor(DIC);
const el = (tag, texto, classe) => { const e = document.createElement(tag); if (texto !== undefined && texto !== null) e.textContent = texto; if (classe) e.className = classe; return e; };
const rotulo = (prefixo, c) => (DIC[`${prefixo}_${c}`] ? t(`${prefixo}_${c}`) : c);
const quando = (iso) => (iso ? dataHora(iso) : t('saNunca'));

function aplicarEstaticos() {
  for (const id of ['saude-cartao', 'relatorio-cartao', 'naoenc-cartao']) {
    const raiz = $(id); if (!raiz) continue;
    raiz.querySelectorAll('[data-t]').forEach((e) => { if (DIC[e.dataset.t]) e.textContent = t(e.dataset.t); });
    raiz.querySelectorAll('[data-t-placeholder]').forEach((e) => { if (DIC[e.dataset.tPlaceholder]) e.placeholder = t(e.dataset.tPlaceholder); });
  }
}

/* ══════════════════════  saúde  ══════════════════════ */
let ultimaSaude = null;
function desenharSaude() {
  const s = ultimaSaude; if (!s) return;
  const caixa = $('saude-problemas');
  const msg = (g, icone, titulo, detalhe) => { const d = el('div', undefined, `sppl-saude-msg saude-problema${g === 'ok' ? ' sppl-saude-msg--ok' : ''}`); if (g !== 'ok') d.dataset.g = g;
    const ic = el('span', icone, 'ic'); ic.setAttribute('aria-hidden', 'true'); const corpo = el('div'); corpo.append(el('strong', titulo)); if (detalhe) corpo.append(el('span', detalhe, 'det')); d.append(ic, corpo); return d; };
  if (s.ok) caixa.replaceChildren(msg('ok', '✓', t('saTudoOk')));
  else caixa.replaceChildren(...s.problemas.map((p) => msg(p.gravidade, p.gravidade === 'alta' ? '▲' : '◆', p.titulo, p.detalhe)));
  const onoff = (b) => ({ txt: b ? t('saLigado') : t('saDesligado'), on: b ? '1' : '0' });
  const linhas = [
    [t('saMotor'), onoff(s.interruptores.motor)], [t('saRegistro'), onoff(s.interruptores.registro_17track)], [t('saReconc'), onoff(s.interruptores.reconciliacao_17track)],
    [t('saCota'), s.cota_restante === null ? t('saDesconhecida') : String(s.cota_restante)],
    [t('saUltWebhook'), quando(s.ultimo_webhook_em)], [t('saUltReconc'), quando(s.ultima_reconciliacao_em)], [t('saUltRedRock'), quando(s.ultima_consulta_redrock)],
    [t('saAcompanhando'), String(s.em_acompanhamento)], [t('saRecusados'), `${s.registros_17track.recusado} / ${s.registros_17track.sem_dado}`], [t('saAbertas'), String(s.ocorrencias_abertas)],
  ];
  $('saude-metricas').replaceChildren(...linhas.map(([k, v]) => { const d = el('div', undefined, 'sppl-metrica'); const dd = el('dd', typeof v === 'object' ? v.txt : v); if (typeof v === 'object') dd.dataset.on = v.on; d.append(el('dt', k), dd); return d; }));
}
async function carregarSaude() {
  const r = await api('/api/rastreio/sppl/saude');
  if (!r.ok || !Array.isArray(r.dados?.problemas) || !r.dados.interruptores || !r.dados.registros_17track) { $('saude-problemas').replaceChildren(el('p', t('saErro'), 'saude-problema')); return; }
  ultimaSaude = r.dados; desenharSaude();
}

/* ══════════════════════  relatório  ══════════════════════ */
let ultimoRelatorio = null;
function tabela(cabecalhos, linhas) {
  const tb = el('table', undefined, 'tabela tabela--empilha'); const th = el('thead'); const trh = el('tr'); cabecalhos.forEach((c) => trh.append(el('th', c))); th.append(trh);
  const body = el('tbody'); linhas.forEach((l) => { const tr = el('tr'); l.forEach((c, i) => { const td = el('td', c); td.dataset.label = cabecalhos[i]; tr.append(td); }); body.append(tr); }); tb.append(th, body);
  const w = el('div', undefined, 'tabela-envolve'); w.append(tb); return w;
}
function textoResumo(r) {
  const L = [t('reResumoTitulo', { dias: r.dias }), ''];
  L.push(`${t('reAbertasPeriodo')}: ${r.total_abertas_no_periodo}${r.abertas_no_periodo.length ? ` (${r.abertas_no_periodo.map((c) => `${rotulo('cat', c.categoria)}: ${c.n}`).join('; ')})` : ''}`);
  L.push(`${t('reResolvidas')}: ${r.resolvidas} · ${t('reCanceladas')}: ${r.canceladas}${r.horas_ate_resolver !== null ? ` · ${t('reHoras')}: ${r.horas_ate_resolver}` : ''}`);
  L.push(`${t('reBacklog')}: ${r.backlog.abertas} ${t('reAbertasAgora')}, ${r.backlog.vencidas} ${t('reVencidas')} (P0 ${r.backlog.p0} · P1 ${r.backlog.p1} · P2 ${r.backlog.p2} · P3 ${r.backlog.p3})`);
  if (r.por_agente.length) { L.push('', `${t('rePorAgente')}:`); r.por_agente.forEach((a) => L.push(`- ${a.agente}: ${a.abertas} ${t('reAbertasAgora')}, ${a.vencidas} ${t('reVencidas')}, ${a.resolvidas} ${t('reResolvidas').toLowerCase()}`)); }
  if (r.por_fulfillment.length) { L.push('', `${t('rePorFulfillment')}:`); r.por_fulfillment.slice(0, 8).forEach((f) => L.push(`- ${f.provedor} / ${f.transportadora}: ${f.abertas}`)); }
  const c = r.cobrancas;
  L.push('', `${t('reCobrancas')}: ${c.total} ${t('reCobTotal')}, ${c.respondidas} ${t('reCobResp')}, ${c.sem_resposta_no_prazo} ${t('reCobSem')}${c.horas_ate_responder !== null ? `, ${c.horas_ate_responder} ${t('reCobHoras')}` : ''}`);
  L.push(`${t('reTrack')}: ${r.track17.entregas_confirmadas} ${t('reTrackEntregas')}, ${r.track17.recusados} ${t('reTrackRecusados')}, ${r.track17.sem_dado} ${t('reTrackSemDado')}`);
  return L.join('\n');
}
function desenharRelatorio() {
  const r = ultimoRelatorio; const corpo = $('relatorio-corpo'); if (!r) return;
  const blocos = [];
  const num = (v, rot) => { const d = el('div'); d.append(el('b', v), el('span', rot)); return d; };
  const grade = el('div', undefined, 'sppl-resumo-num');
  grade.append(num(r.total_abertas_no_periodo, t('reAbertasPeriodo')), num(r.resolvidas, t('reResolvidas')), num(r.canceladas, t('reCanceladas')), num(r.horas_ate_resolver !== null ? r.horas_ate_resolver : '—', t('reHoras')),
    num(r.backlog.abertas, `${t('reBacklog')}: ${t('reAbertasAgora')}`), num(r.backlog.vencidas, `${t('reBacklog')}: ${t('reVencidas')}`));
  blocos.push(grade);
  blocos.push(el('p', `${t('reBacklog')}: P0 ${r.backlog.p0} · P1 ${r.backlog.p1} · P2 ${r.backlog.p2} · P3 ${r.backlog.p3}`, 'cartao-sub'));
  if (r.abertas_no_periodo.length) blocos.push(tabela([t('reAbertasPeriodo'), '#'], r.abertas_no_periodo.map((c) => [rotulo('cat', c.categoria), c.n])));
  if (r.por_agente.length) { blocos.push(el('h3', t('rePorAgente'), 'sppl-relatorio-titulo')); blocos.push(tabela([t('reAgente'), t('reColAbertas'), t('reColVencidas'), t('reColResolvidas')], r.por_agente.map((a) => [a.agente, a.abertas, a.vencidas, a.resolvidas]))); }
  if (r.por_fulfillment.length) { blocos.push(el('h3', t('rePorFulfillment'), 'sppl-relatorio-titulo')); blocos.push(tabela([t('reProvedor'), t('reTransportadora'), t('reColAbertas')], r.por_fulfillment.map((f) => [f.provedor, f.transportadora, f.abertas]))); }
  const c = r.cobrancas; blocos.push(el('h3', t('reCobrancas'), 'sppl-relatorio-titulo'));
  blocos.push(el('p', `${c.total} ${t('reCobTotal')} · ${c.respondidas} ${t('reCobResp')} · ${c.sem_resposta_no_prazo} ${t('reCobSem')}${c.horas_ate_responder !== null ? ` · ${c.horas_ate_responder} ${t('reCobHoras')}` : ''}`, 'cartao-sub'));
  if (c.por_destino.length) blocos.push(tabela([t('reCobrancas'), '#'], c.por_destino.map((d) => [rotulo('dest', d.destino), d.n])));
  blocos.push(el('p', `${t('reTrack')}: ${r.track17.entregas_confirmadas} ${t('reTrackEntregas')} · ${r.track17.recusados} ${t('reTrackRecusados')} · ${r.track17.sem_dado} ${t('reTrackSemDado')}`, 'cartao-sub'));
  const pre = el('pre', textoResumo(r), 'sppl-texto-resumo'); pre.id = 'relatorio-texto';
  corpo.replaceChildren(...blocos, pre);
}
async function carregarRelatorio() {
  const r = await api(`/api/rastreio/sppl/relatorio?dias=${$('relatorio-dias').value}`);
  const d = r.dados;
  if (!r.ok || !d || !Array.isArray(d.abertas_no_periodo) || !Array.isArray(d.por_agente) || !Array.isArray(d.por_fulfillment) || !d.backlog || !d.cobrancas || !d.track17) { $('relatorio-corpo').replaceChildren(el('p', t('reErro'), 'cartao-sub')); return; }
  ultimoRelatorio = r.dados; desenharRelatorio();
}
async function copiarResumo() {
  if (!ultimoRelatorio) await carregarRelatorio();
  const texto = textoResumo(ultimoRelatorio); const aviso = $('relatorio-aviso');
  try { await navigator.clipboard.writeText(texto); aviso.textContent = t('reCopiado'); } catch { aviso.textContent = t('reNaoCopiou'); }
}

/* ══════════════════════  não encontrados  ══════════════════════ */
const ne = { faixa: '', plataforma: '', busca: '', pagina: 1 };
const NE_POR_PAGINA = 25;
const neParams = (extra = {}) => { const q = new URLSearchParams(); if (ne.faixa) q.set('faixa', ne.faixa); if (ne.plataforma) q.set('plataforma', ne.plataforma); if (ne.busca) q.set('busca', ne.busca); for (const [k, v] of Object.entries(extra)) q.set(k, String(v)); return q; };
function vazioNe(msg) { const tr = document.createElement('tr'); const td = el('td', msg, 'vazio-suave'); td.colSpan = 5; tr.append(td); return tr; }
async function carregarNaoEncontrados() {
  const r = await api(`/api/rastreio/sppl/nao-encontrados?${neParams({ page: ne.pagina, page_size: NE_POR_PAGINA })}`);
  if (!r.ok || !Array.isArray(r.dados?.pedidos) || !Array.isArray(r.dados.resumo)) { $('naoenc-corpo').replaceChildren(vazioNe(t('neErro'))); return; }
  const d = r.dados;
  $('naoenc-resumo-corpo').replaceChildren(...d.resumo.map((x) => {
    const tr = document.createElement('tr'); const t0 = el('td', x.plataforma); t0.dataset.label = t('colPlataforma'); tr.append(t0);
    for (const [k, f, rot] of [['ate7', 'ate7', 'neAte7'], ['de7a30', 'de7a30', 'ne7a30'], ['mais30', 'mais30', 'neMais30'], ['total', '', 'neTotal']]) { const td = el('td', x[k]); td.dataset.f = f; td.dataset.p = x.plataforma; td.dataset.k = k; td.dataset.label = t(rot); tr.append(td); }
    return tr;
  }));
  $('naoenc-corpo').replaceChildren(...(d.pedidos.length ? d.pedidos.map((p) => { const tr = document.createElement('tr'); const c = (rot, v) => { const td = el('td', v); td.dataset.label = rot; return td; }; tr.append(c(t('colPedido'), p.transacao_id), c(t('neIdConsulta'), p.id_consulta), c(t('colProduto'), p.produto ?? '—'), c(t('colPlataforma'), p.plataforma ?? '—'), c(t('neDias'), p.dias ?? '—')); return tr; }) : [vazioNe(t('neVazio'))]));
  montarPaginacao($('naoenc-paginacao'), { pagina: ne.pagina, totalPaginas: Math.max(1, Math.ceil(d.total / NE_POR_PAGINA)), total: d.total, rotuloItem: t('nePag') }, (p) => { ne.pagina = p; carregarNaoEncontrados(); });
}
const csvCelula = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function exportarNaoEncontrados() {
  const r = await api(`/api/rastreio/sppl/nao-encontrados?${neParams({ todos: 1 })}`);
  if (!r.ok) { $('naoenc-aviso').textContent = t('neErro'); return; }
  const linhas = [['order', 'lookup_id', 'product', 'platform', 'purchased_at', 'days_since_purchase'], ...r.dados.pedidos.map((p) => [p.transacao_id, p.id_consulta, p.produto, p.plataforma, p.comprado_em, p.dias])];
  const blob = new Blob([`${linhas.map((l) => l.map(csvCelula).join(',')).join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nao-encontrados-red-rock-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(a); a.click(); a.remove();
  $('naoenc-aviso').textContent = t('neExportado', { n: r.dados.pedidos.length });
}

function ligar() {
  if (!$('saude-cartao')) return;
  let relCarregado = false; let neCarregado = false;
  $('relatorio-detalhes').addEventListener('toggle', () => { if ($('relatorio-detalhes').open && !relCarregado) { relCarregado = true; carregarRelatorio(); } });
  $('naoenc-detalhes').addEventListener('toggle', () => { if ($('naoenc-detalhes').open && !neCarregado) { neCarregado = true; carregarNaoEncontrados(); } });
  $('relatorio-dias').addEventListener('change', carregarRelatorio);
  $('relatorio-copiar').addEventListener('click', copiarResumo);
  $('naoenc-resumo').addEventListener('click', (ev) => { const td = ev.target.closest('td[data-p]'); if (!td) return; ne.plataforma = td.dataset.p === '(sem plataforma)' ? '' : td.dataset.p; ne.faixa = td.dataset.f; ne.pagina = 1; carregarNaoEncontrados(); });
  let tmr; $('naoenc-busca').addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { ne.busca = e.target.value.trim(); ne.pagina = 1; carregarNaoEncontrados(); }, 350); });
  $('naoenc-limpar').addEventListener('click', () => { ne.faixa = ''; ne.plataforma = ''; ne.busca = ''; ne.pagina = 1; $('naoenc-busca').value = ''; carregarNaoEncontrados(); });
  $('naoenc-exportar').addEventListener('click', exportarNaoEncontrados);
  document.addEventListener('click', (ev) => { if (ev.target.closest?.('#rst-idioma-seletor')) setTimeout(() => { aplicarEstaticos(); desenharSaude(); desenharRelatorio(); if (neCarregado) carregarNaoEncontrados(); }, 0); });
  aplicarEstaticos(); carregarSaude();
}
ligar();
