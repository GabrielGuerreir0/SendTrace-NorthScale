/**
 * MONIT-SPPL — Fase 4, aba "Prazos" (seção 9): média e mediana (dias corridos) de cada etapa — pedido → código, código → 1º movimento, 1º movimento →
 * entrega, código → entrega e pedido → entrega — por fulfillment e por mês do pedido. Respeita os filtros do topo (desde e reembolso). Valor calculado sobre
 * menos de 30 pedidos aparece em cinza claro; o mouse mostra em quantos pedidos foi calculado. Só carrega quando a aba é aberta.
 */
import { el } from './spplComum.js';

const BASE = '/api/rastreio/monit';
const ETAPAS = [['ped_cod', 'Pedido → rastreio'], ['cod_mov', 'Rastreio → 1º movimento'], ['mov_ent', '1º movimento → entrega'], ['cod_ent', 'Rastreio → entrega'], ['ped_ent', 'Pedido → entrega']];
const FULFILLMENTS = [['redrock', 'RedRock'], ['fullstack', 'FullStack'], ['jetstream', 'JetPack']];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
let ctx = null; let raiz = null; let carregou = false;

const dec = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const rotMes = (m) => { const [a, mm] = String(m).split('-'); return `${MESES[Number(mm) - 1] ?? mm}/${String(a).slice(2)}`; };

/** Faixas de ritmo (a jornada do pedido): até 2 dias é rápido, 3 a 6 médio, 7 ou mais lento. */
const ritmo = (v) => (v === null || v === undefined ? '' : v <= 2 ? 'rapido' : v < 7 ? 'medio' : 'lento');

export function iniciar(c) { ctx = c; raiz = c.raiz; raiz.replaceChildren(); }
export function abrir() { if (raiz && !carregou) recarregar(); }

export async function recarregar() {
  if (!ctx || (!carregou && raiz.hidden)) return; raiz.replaceChildren(el('p', 'carregando…', 'mon-vazio'));
  const r = await ctx.api(`${BASE}/prazos?${ctx.parametros({ lista: false })}`);
  raiz.replaceChildren();
  if (!r.ok) { raiz.append(el('p', r.dados?.detail ?? 'Não foi possível carregar os prazos.', 'mon-vazio')); return; }
  carregou = true; desenhar(r.dados);
}

function desenhar(d) {
  const f = ctx.estado.filtros; const itens = d.itens;
  const total = itens.find((x) => x.nivel === 'total');
  const reemb = { sem: 'sem reembolso/chargeback', com: 'só com reembolso/chargeback', todos: 'todos os pedidos' }[f.reemb];
  raiz.append(el('h3', `Prazos médios — pedidos criados desde ${f.desde.split('-').reverse().join('/')} · ${reemb} · dias corridos`));
  const cartoes = el('div', undefined, 'sppl-kpis');
  for (const [k, rot] of ETAPAS) {
    const b = el('div', undefined, 'sppl-kpi'); const destaque = k === 'ped_cod' || k === 'ped_ent';
    if (destaque) b.setAttribute('aria-pressed', 'true');
    b.title = `Mediana: ${dec(total?.[`${k}_med`])} dia(s)`; b.append(el('b', total?.[k] === null || total?.[k] === undefined ? '—' : `${dec(total[k])} d`), el('span', rot), el('small', `${(total?.[`${k}_n`] ?? 0).toLocaleString('pt-BR')} pedidos`, 'sppl-kpi-criterio'));
    cartoes.append(b);
  }
  raiz.append(cartoes);
  raiz.append(el('p', 'O 17Track acompanha só parte dos pacotes da RedRock, o que afeta a etapa de 1º movimento. Cada etapa só conta pedidos que já têm as duas datas, por isso meses recentes ficam curtos em "entrega" e as etapas não somam exatamente o total.', 'cartao-sub'));

  raiz.append(el('h3', 'Por fulfillment'));
  const linhasF = FULFILLMENTS.map(([k, rot]) => [rot, itens.find((x) => x.nivel === 'ful' && x.chave === k)]).filter(([, x]) => x);
  raiz.append(tabela(linhasF, total, true));
  raiz.append(el('h3', 'Por mês do pedido'));
  const linhasM = itens.filter((x) => x.nivel === 'mes').sort((a, b) => String(b.chave).localeCompare(String(a.chave))).map((x) => [rotMes(x.chave), x]);
  raiz.append(tabela(linhasM, total, false));
}

/** Tabela com as cinco etapas (média, em cinza se < 30 pedidos) e a linha Total. `ranking`: verde = menor prazo da coluna, azul = 2º menor (3+ valores distintos), laranja = maior. */
function tabela(linhas, total, ranking) {
  const env = el('div', undefined, 'tabela-envolve'); const tab = el('table', undefined, 'tabela tabela--larga'); const th = el('thead'); const trh = el('tr');
  trh.append(el('th', 'Grupo'), el('th', 'Pedidos'));
  for (const [, rot] of ETAPAS) trh.append(el('th', rot));
  th.append(trh); const tb = el('tbody');
  const cor = {};
  if (ranking) for (const k of ['ped_cod', 'ped_ent']) {
    const vals = linhas.map(([, x]) => Number(x[k])).filter((v) => Number.isFinite(v)); const distintos = [...new Set(vals)].sort((a, b) => a - b);
    cor[k] = new Map(); if (distintos.length >= 2) { cor[k].set(distintos[0], '#1c8f4f'); cor[k].set(distintos[distintos.length - 1], '#d9822b'); if (distintos.length >= 3) cor[k].set(distintos[1], '#2f6fd0'); }
  }
  const linha = ([rot, x], ehTotal) => {
    const tr = el('tr'); if (ehTotal) tr.style.fontWeight = '600';
    tr.append(el('td', rot), el('td', (x.pedidos ?? 0).toLocaleString('pt-BR')));
    for (const [k] of ETAPAS) {
      const v = x[k]; const nn = x[`${k}_n`] ?? 0; const td = el('td', v === null || v === undefined ? '—' : `${dec(v)} d`);
      td.title = `Média em ${nn.toLocaleString('pt-BR')} pedido(s) · mediana ${dec(x[`${k}_med`])} d`; td.dataset.ritmo = ritmo(Number(v));
      if (nn < 30) td.style.opacity = '.45';
      const c = !ehTotal && cor[k]?.get(Number(v)); if (c) { td.style.color = c; td.style.fontWeight = '700'; }
      tr.append(td);
    }
    return tr;
  };
  for (const l of linhas) tb.append(linha(l, false));
  if (total) tb.append(linha(['Total', total], true));
  if (!linhas.length) { const tr = el('tr'); const td = el('td', 'Sem dados para estes filtros.', 'mon-vazio'); td.colSpan = 7; tr.append(td); tb.append(tr); }
  tab.append(th, tb); env.append(tab); return env;
}
