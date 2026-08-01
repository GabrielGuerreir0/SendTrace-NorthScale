import { n, nc } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

/** Cria um elemento SVG com atributos. `class` e `text` são atalhos. */
export function svgEl(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

export const limpar = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

/**
 * SVG não quebra linha sozinho. Quebra o texto em tspans medindo de verdade
 * com getComputedTextLength, com reticências quando não cabe.
 *
 * Se o SVG estiver oculto a medição devolve 0 — nesse caso caímos numa
 * estimativa por caractere em vez de entrar em laço infinito.
 */
export function envolverTexto(textEl, texto, larguraMax, maxLinhas = 2, alturaLinha = 15) {
  limpar(textEl);
  if (!texto) return;

  const x = textEl.getAttribute('x') ?? 0;
  const medidor = svgEl('tspan', {}, textEl);

  const medir = (s) => {
    medidor.textContent = s;
    const w = medidor.getComputedTextLength?.() ?? 0;
    return w > 0 ? w : s.length * 5.4;   // fallback quando não há layout
  };

  const palavras = String(texto).split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';

  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (atual && medir(tentativa) > larguraMax) {
      linhas.push(atual);
      atual = p;
      if (linhas.length === maxLinhas) break;
    } else {
      atual = tentativa;
    }
  }
  if (linhas.length < maxLinhas && atual) linhas.push(atual);

  // Sobrou texto: encurta a última linha até a reticência caber.
  const usadas = linhas.join(' ').split(/\s+/).length;
  if (usadas < palavras.length && linhas.length) {
    let ultima = `${linhas[linhas.length - 1]}…`;
    while (ultima.length > 2 && medir(ultima) > larguraMax) {
      ultima = `${ultima.slice(0, -2)}…`;
    }
    linhas[linhas.length - 1] = ultima;
  }

  limpar(textEl);
  linhas.forEach((linha, i) => {
    svgEl('tspan', { x, dy: i === 0 ? 0 : alturaLinha, text: linha }, textEl);
  });
}

/**
 * Barra com a ponta arredondada (4px) e a base quadrada, ancorada na linha
 * de base — conforme a especificação de marcas. Um `rect` com `rx` arredonda
 * os quatro cantos, inclusive os da base, o que solta a barra do eixo.
 */
export function barPath(x, y, w, h, r = 4) {
  const base = y + h;
  const raio = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.5) return `M${x},${base} L${x + w},${base}`;
  return `M${x},${base} L${x},${y + raio} Q${x},${y} ${x + raio},${y} `
       + `L${x + w - raio},${y} Q${x + w},${y} ${x + w},${y + raio} L${x + w},${base} Z`;
}

/** Escala com topo em número redondo, para os ticks caírem em valores limpos. */
export function escalaTopo(max) {
  if (max <= 0) return { topo: 1, ticks: [0, 1] };
  const mag = 10 ** Math.floor(Math.log10(max));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => max / p <= 4) ?? mag * 10;
  const topo = Math.ceil(max / passo) * passo;
  const ticks = [];
  for (let v = 0; v <= topo + 1e-9; v += passo) ticks.push(Math.round(v * 1000) / 1000);
  return { topo, ticks };
}

/* ─────────────────────────  ANEL (parte-do-todo)  ───────────────────────── */

/**
 * Anel de estados de uma etapa. Os segmentos são mutuamente exclusivos e somam
 * o total, então isto é uma leitura parte-do-todo honesta.
 * A separação entre segmentos é um vão de 2px que revela a trilha — nunca um
 * contorno desenhado em volta da marca.
 */
export function desenharAnel(g, segmentos, { r = 18, sw = 6, vao = 2 } = {}) {
  limpar(g);
  const C = 2 * Math.PI * r;
  const total = segmentos.reduce((a, s) => a + s.valor, 0);

  svgEl('circle', {
    class: 'anel-trilha', cx: 0, cy: 0, r,
    fill: 'none', 'stroke-width': sw,
  }, g);

  if (total <= 0) return;

  const visiveis = segmentos.filter((s) => s.valor > 0);
  let acumulado = 0;
  for (const seg of visiveis) {
    const comp = (seg.valor / total) * C;
    // Com um único segmento não há vizinho de quem se separar: anel fechado.
    const vaoReal = visiveis.length > 1 ? Math.min(vao, comp * 0.5) : 0;
    const desenho = Math.max(comp - vaoReal, 0.6);
    svgEl('circle', {
      cx: 0, cy: 0, r, fill: 'none',
      stroke: seg.cor, 'stroke-width': sw, 'stroke-linecap': 'butt',
      'stroke-dasharray': `${desenho} ${C - desenho}`,
      'stroke-dashoffset': -acumulado,
    }, g);
    acumulado += comp;
  }
}

/* ──────────────────  MICRO-HISTOGRAMA (dentro do nó)  ────────────────── */

/**
 * Onda de disparos da etapa nas próximas 48h, em 12 baldes de 4h.
 * Série única: uma cor só, com ênfase no primeiro balde não-vazio — que é o
 * próximo lote a disparar. Nunca um degradê por valor (isso duplicaria a
 * altura da barra num segundo canal sem acrescentar informação).
 */
export function desenharMicroBarras(g, valores, { w = 208, h = 26, vao = 2 } = {}) {
  limpar(g);
  const nb = valores.length;
  const larg = (w - (nb - 1) * vao) / nb;
  const max = Math.max(...valores, 1);
  const proximo = valores.findIndex((v) => v > 0);

  // Linha de base: sempre visível, para as barras terem de onde crescer.
  svgEl('line', { class: 'micro-base', x1: 0, y1: h, x2: w, y2: h }, g);

  valores.forEach((v, i) => {
    const x = i * (larg + vao);
    const altura = v > 0 ? Math.max((v / max) * (h - 3), 2.5) : 0;
    if (altura <= 0) {
      svgEl('rect', { class: 'micro-vazio', x, y: h - 1.5, width: larg, height: 1.5, rx: 0.75 }, g);
      return;
    }
    svgEl('path', {
      class: i === proximo ? 'micro-barra micro-barra--proxima' : 'micro-barra',
      d: barPath(x, h - altura, larg, altura, 2),
    }, g);
  });
}

/* ───────────────────────────  GRÁFICO DE COLUNAS  ─────────────────────── */

/**
 * Colunas responsivas com eixo, grade e camada de ponto-mais-próximo.
 * O container é dimensionado para incluir a faixa do eixo x — o gráfico nunca
 * gera um scroll vertical interno só para caber os rótulos.
 *
 * data: [{ chave, valor, rotulo, sub }]
 */
export function desenharColunas(container, data, opts = {}) {
  const {
    altura = 190,
    margem = { topo: 22, dir: 8, base: 30, esq: 40 },
    rotuloEixoX = () => '',
    marcarIndice = null,        // índice que recebe a régua "agora"
    tooltip = null,
    unidade = 'pedidos',
    barraMax = 24,
  } = opts;

  limpar(container);
  const w = Math.max(container.clientWidth || 640, 320);
  const svg = svgEl('svg', {
    class: 'gr', width: w, height: altura, viewBox: `0 0 ${w} ${altura}`,
    role: 'img',
  }, container);

  const plotW = w - margem.esq - margem.dir;
  const plotH = altura - margem.topo - margem.base;

  const max = data.length ? Math.max(...data.map((d) => d.valor), 0) : 0;

  // Tudo zerado: um eixo com escala inventada (0–1) sugere precisão que não
  // existe. Melhor dizer que não há nada do que desenhar uma régua vazia.
  if (max <= 0) {
    svgEl('text', {
      class: 'gr-vazio', x: w / 2, y: altura / 2, 'text-anchor': 'middle',
      text: opts.textoVazio ?? 'Nada agendado nesta janela',
    }, svg);
    return;
  }

  const { topo, ticks } = escalaTopo(max);
  const y = (v) => margem.topo + plotH - (v / topo) * plotH;

  // Grade + eixo y (hairline sólida, recuada).
  const gGrade = svgEl('g', { class: 'gr-grade' }, svg);
  for (const t of ticks) {
    svgEl('line', { x1: margem.esq, y1: y(t), x2: margem.esq + plotW, y2: y(t) }, gGrade);
    svgEl('text', {
      class: 'gr-tick', x: margem.esq - 8, y: y(t) + 3.5, 'text-anchor': 'end', text: nc(t),
    }, svg);
  }

  const slot = plotW / data.length;
  const vao = 2;
  const larg = Math.min(Math.max(slot - vao, 1), barraMax);
  const desloc = (slot - larg) / 2;

  const gBarras = svgEl('g', { class: 'gr-barras' }, svg);
  const iMax = data.reduce((best, d, i) => (d.valor > data[best].valor ? i : best), 0);

  data.forEach((d, i) => {
    const x = margem.esq + i * slot + desloc;
    if (d.valor <= 0) return;
    const alt = Math.max(margem.topo + plotH - y(d.valor), 2);
    svgEl('path', {
      class: 'gr-barra', d: barPath(x, y(d.valor), larg, alt, 4), 'data-i': i,
    }, gBarras);
  });

  // Rótulo direto apenas no pico — nunca um número em cada coluna.
  if (max > 0) {
    const x = margem.esq + iMax * slot + slot / 2;
    svgEl('text', {
      class: 'gr-rotulo-pico', x, y: y(data[iMax].valor) - 7, 'text-anchor': 'middle',
      text: n(data[iMax].valor),
    }, svg);
  }

  // Eixo x
  const eixoY = margem.topo + plotH;
  svgEl('line', { class: 'gr-base', x1: margem.esq, y1: eixoY, x2: margem.esq + plotW, y2: eixoY }, svg);
  data.forEach((d, i) => {
    const r = rotuloEixoX(d, i);
    if (!r) return;
    svgEl('text', {
      class: 'gr-tick', x: margem.esq + i * slot + slot / 2, y: eixoY + 15,
      'text-anchor': 'middle', text: r,
    }, svg);
  });

  if (marcarIndice !== null && marcarIndice >= 0) {
    const x = margem.esq + marcarIndice * slot + slot / 2;
    svgEl('line', { class: 'gr-agora', x1: x, y1: margem.topo - 8, x2: x, y2: eixoY }, svg);
    svgEl('text', {
      class: 'gr-agora-txt', x, y: margem.topo - 12, 'text-anchor': 'middle', text: 'agora',
    }, svg);
  }

  /* Camada de interação: em vez de exigir a mira exata numa coluna de ~14px,
     detectamos o índice mais próximo em toda a altura do plot. */
  if (tooltip) {
    const foco = svgEl('rect', {
      class: 'gr-foco', x: 0, y: margem.topo, width: larg + vao, height: plotH, rx: 3, opacity: 0,
    }, svg);
    const captura = svgEl('rect', {
      class: 'gr-captura', x: margem.esq, y: margem.topo, width: plotW, height: plotH, fill: 'transparent',
    }, svg);

    const emIndice = (i, clientX, clientY) => {
      const d = data[i];
      foco.setAttribute('x', margem.esq + i * slot + desloc - vao / 2);
      foco.setAttribute('opacity', 1);
      tooltip.mostrar(
        `<strong>${d.rotulo}</strong>`
        + (d.sub ? `<span class="tt-sub">${d.sub}</span>` : '')
        + `<span class="tt-linha"><span class="tt-chave">${unidade}</span><b>${n(d.valor)}</b></span>`,
        clientX, clientY,
      );
    };

    captura.addEventListener('pointermove', (ev) => {
      const cx = ev.clientX - svg.getBoundingClientRect().left;
      const i = Math.max(0, Math.min(data.length - 1, Math.floor((cx - margem.esq) / slot)));
      emIndice(i, ev.clientX, ev.clientY);
    });
    captura.addEventListener('pointerleave', () => {
      foco.setAttribute('opacity', 0);
      tooltip.esconder();
    });
  }
}
