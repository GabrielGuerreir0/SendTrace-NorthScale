/**
 * Componentes da Visão Geral v2 — os formatos da seção 07 da especificação:
 * KPI com sparkline, bullet, barra empilhada, barras horizontais (já existem em
 * emailComum.js), linha no tempo (charts.js) e dumbbell (mediana ● e P90 ○).
 *
 * Tudo em DOM/SVG puro, sem innerHTML com dado: cada texto entra por textContent.
 */
import { n, duracaoH } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

export function el(tag, classe = '', texto = null) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== null && texto !== undefined) e.textContent = texto;
  return e;
}

const NF1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Percentual a partir de fração (0,127 → "12,7"). Casas conforme a grandeza. */
export function pctTxt(fracao, casas = null) {
  if (fracao === null || fracao === undefined || !Number.isFinite(fracao)) return '—';
  const v = fracao * 100;
  const c = casas ?? (Math.abs(v) < 1 ? 2 : 1);
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }).format(v);
}
export const dec1 = (v) => NF1.format(v);
export const dec2 = (v) => NF2.format(v);
export const razao = (a, b) => (b > 0 ? a / b : null);

/**
 * Variação contra o período anterior, sempre com o SINAL e a base.
 * `menorMelhor`: true quando cair é bom (reembolso, tempo, backlog).
 * `pp`: diferença em pontos percentuais (para taxas); senão, variação relativa.
 */
export function variacao(atual, anterior, { menorMelhor = true, pp = false } = {}) {
  if (atual === null || anterior === null || atual === undefined || anterior === undefined) return null;
  const d = pp ? (atual - anterior) * 100 : (anterior === 0 ? null : ((atual - anterior) / anterior) * 100);
  if (d === null || !Number.isFinite(d)) return null;
  const igual = Math.abs(d) < (pp ? 0.05 : 0.5);
  const sobe = d > 0;
  const bom = igual ? null : (menorMelhor ? !sobe : sobe);
  const s = el('span', `vg-var${igual ? '' : (bom ? ' vg-var--bom' : ' vg-var--ruim')}`);
  const seta = igual ? '■' : (sobe ? '▲' : '▼');
  const valor = pp ? `${NF1.format(Math.abs(d))} p.p.` : `${NF1.format(Math.abs(d))}%`;
  s.textContent = `${seta} ${valor} vs anterior`;
  return s;
}

/* ───────────────────────────  sparkline  ─────────────────────────── */

export function sparkline(valores, { cor = 'var(--st-em-dia)', referencia = null } = {}) {
  const w = 120; const h = 30;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'vg-spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const v = valores.filter((x) => x !== null && Number.isFinite(x));
  if (v.length < 2) return null;
  const max = Math.max(...v, referencia ?? 0);
  const min = Math.min(...v, referencia ?? Infinity);
  const span = max - min || 1;
  const x = (i) => (i / (valores.length - 1)) * (w - 2) + 1;
  const y = (val) => h - 3 - ((val - min) / span) * (h - 6);
  const pts = valores.map((val, i) => (Number.isFinite(val) ? `${x(i).toFixed(1)},${y(val).toFixed(1)}` : null)).filter(Boolean);
  if (referencia !== null) {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', 0); l.setAttribute('x2', w); l.setAttribute('y1', y(referencia)); l.setAttribute('y2', y(referencia));
    l.setAttribute('class', 'vg-spark-ref');
    svg.append(l);
  }
  const p = document.createElementNS(NS, 'polyline');
  p.setAttribute('points', pts.join(' '));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', cor);
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(p);
  return svg;
}

/* ─────────────────────────────  bullet  ─────────────────────────────
   Valor contra meta e limite na mesma barra (substitui velocímetro). */

export function bullet({ valor, max, meta = null, atencao = null, limite = null, tom = 'neutro', rotulos = true }) {
  const w = el('div', 'vg-bullet');
  const pos = (v) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  const trilho = el('div', 'vg-bullet-trilho');
  const cheio = el('div', `vg-bullet-cheio vg-tom--${tom}`);
  cheio.style.width = pos(valor ?? 0);
  trilho.append(cheio);
  const marcas = [];
  if (meta !== null) marcas.push(['meta', meta, `meta ${dec1(meta)}%`]);
  if (atencao !== null) marcas.push(['atencao', atencao, `${dec1(atencao)}%`]);
  if (limite !== null) marcas.push(['limite', limite, `${dec1(limite)}%`]);
  for (const [tipo, v] of marcas) {
    const m = el('span', `vg-bullet-marca vg-bullet-marca--${tipo}`);
    m.style.left = pos(v);
    trilho.append(m);
  }
  w.append(trilho);
  if (rotulos && marcas.length) {
    const r = el('div', 'vg-bullet-rotulos');
    for (const [tipo, v, txt] of marcas) {
      const s = el('span', `vg-bullet-rot vg-bullet-rot--${tipo}`, txt);
      s.style.left = pos(v);
      r.append(s);
    }
    w.append(r);
  }
  return w;
}

/* ──────────────────────────  barra empilhada  ─────────────────────── */

/** segmentos: [{ rotulo, valor, tom (índice 1-5 da escala que esquenta), ao? }] */
export function empilhada(segmentos, { legenda = true, titulo = null } = {}) {
  const w = el('div', 'vg-emp');
  if (titulo) w.append(el('div', 'vg-emp-titulo', titulo));
  const total = segmentos.reduce((a, s) => a + s.valor, 0);
  const barra = el('div', 'vg-emp-barra');
  if (!total) barra.classList.add('vg-emp-barra--vazia');
  for (const s of segmentos) {
    if (!s.valor) continue;
    const seg = el(s.ao ? 'button' : 'span', `vg-emp-seg vg-emp-seg--${s.tom ?? 1}`);
    if (s.ao) { seg.type = 'button'; seg.addEventListener('click', s.ao); }
    seg.style.flex = `${s.valor} 1 0`;
    seg.title = `${s.rotulo}: ${n(s.valor)}`;
    barra.append(seg);
  }
  w.append(barra);
  if (legenda) {
    const ul = el('ul', 'vg-emp-legenda');
    for (const s of segmentos) {
      const li = el('li');
      li.append(el('span', `vg-emp-dot vg-emp-seg--${s.tom ?? 1}`));
      li.append(document.createTextNode(`${s.rotulo} `));
      li.append(el('b', '', n(s.valor)));
      ul.append(li);
    }
    w.append(ul);
  }
  return w;
}

/* ────────────────────────────  dumbbell  ──────────────────────────────
   Mediana ● e P90 ○ na mesma linha: mostra o típico e o pior caso sem
   esconder nenhum. Escala compartilhada entre as linhas. */

/** linhas: [{ rotulo, grupo ('ia'|'humano'), mediana, p90, casos, anterior (mediana anterior|null) }] em HORAS */
export function dumbbell(linhas) {
  const w = el('div', 'vg-db');
  const max = Math.max(1, ...linhas.map((l) => l.p90 ?? l.mediana ?? 0));
  const pos = (h) => `${(h / max) * 100}%`;
  for (const l of linhas) {
    const r = el('div', 'vg-db-linha');
    r.append(el('div', 'vg-db-rotulo', l.rotulo));
    const trilho = el('div', 'vg-db-trilho');
    if (l.mediana !== null && l.mediana !== undefined) {
      if (l.p90 !== null && l.p90 !== undefined) {
        const seg = el('span', `vg-db-seg vg-db-seg--${l.grupo}`);
        seg.style.left = pos(l.mediana);
        seg.style.width = `${Math.max(0, ((l.p90 - l.mediana) / max) * 100)}%`;
        trilho.append(seg);
        const o = el('span', `vg-db-ponto vg-db-ponto--p90 vg-db-ponto--${l.grupo}`);
        o.style.left = pos(l.p90);
        o.title = `P90: ${duracaoH(l.p90)}`;
        trilho.append(o);
      }
      const p = el('span', `vg-db-ponto vg-db-ponto--med vg-db-ponto--${l.grupo}`);
      p.style.left = pos(l.mediana);
      p.title = `Mediana: ${duracaoH(l.mediana)}`;
      trilho.append(p);
    }
    r.append(trilho);
    const txt = el('div', 'vg-db-texto');
    if (l.mediana === null || l.mediana === undefined) {
      txt.textContent = 'sem casos no período';
    } else {
      txt.append(el('b', '', duracaoH(l.mediana)));
      txt.append(document.createTextNode(` · P90 ${l.p90 === null ? '—' : duracaoH(l.p90)} · ${n(l.casos)} caso${l.casos === 1 ? '' : 's'}`));
      if (l.variacao) txt.append(document.createTextNode(' '), l.variacao);
    }
    r.append(txt);
    w.append(r);
  }
  const leg = el('div', 'vg-db-leg');
  leg.append(el('span', 'vg-db-leg-med', '● mediana'), el('span', 'vg-db-leg-p90', '○ P90'));
  w.append(leg);
  return w;
}

/* ─────────────────────────────  cartão  ─────────────────────────────── */

/**
 * Cartão de indicador. `codigo` é o do catálogo (R1, F3, T2…), `tag` marca o
 * que é prévia ou aproximação, `ref` traz a referência (meta/limite) e `nota`
 * o que falta para o número ser o oficial.
 */
export function card({
  codigo = null, titulo, valor = null, unidade = null, sub = null, tom = 'neutro',
  tag = null, viz = null, ref = null, nota = null, largo = false, cheio = false, span = null, extra = null, ao = null,
}) {
  const c = el(ao ? 'button' : 'article', `vg-card vg-tom--${tom}${largo ? ' vg-card--largo' : ''}${cheio ? ' vg-card--cheio' : ''}`);
  if (span) c.style.gridColumn = `span ${span}`;
  if (ao) { c.type = 'button'; c.addEventListener('click', ao); c.classList.add('vg-card--clicavel'); }
  const cab = el('header', 'vg-card-cab');
  cab.append(el('span', 'vg-card-tit', titulo));
  if (codigo) cab.append(el('span', 'vg-card-cod', codigo));
  c.append(cab);
  if (valor !== null) {
    const v = el('div', 'vg-card-valor');
    v.append(el('b', '', valor));
    if (unidade) v.append(el('small', '', unidade));
    if (tag) v.append(el('span', 'vg-tag', tag));
    c.append(v);
  } else if (tag) {
    c.append(el('span', 'vg-tag', tag));
  }
  if (sub) c.append(typeof sub === 'string' ? el('p', 'vg-card-sub', sub) : sub);
  if (extra) c.append(extra);
  if (viz) c.append(viz);
  if (ref) c.append(el('p', 'vg-card-ref', ref));
  if (nota) c.append(el('p', 'vg-card-nota', nota));
  return c;
}

/** Bloco (A–G): título, fonte, grade de cartões e a linha do que ainda não existe. */
export function bloco({ id, letra, titulo, pergunta, fonte = null, pendencias = null }, cartoes) {
  const s = el('section', 'vg-bloco');
  s.id = id;
  const cab = el('header', 'vg-bloco-cab');
  const h = el('h3');
  h.append(el('span', 'vg-bloco-letra', letra), document.createTextNode(` · ${titulo}`));
  cab.append(h);
  if (pergunta) cab.append(el('p', 'vg-bloco-perg', pergunta));
  if (fonte) cab.append(el('span', 'vg-bloco-fonte', fonte));
  s.append(cab);
  const g = el('div', 'vg-grade');
  g.append(...cartoes.filter(Boolean));
  s.append(g);
  if (pendencias) {
    const p = el('p', 'vg-pendencia');
    p.append(el('b', '', 'Ainda não disponível: '), document.createTextNode(pendencias));
    s.append(p);
  }
  return s;
}
