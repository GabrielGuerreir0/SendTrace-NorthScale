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


/* ────────────────────────────  GRÁFICO DE PIZZA  ──────────────────────── */

const polar = (cx, cy, r, anguloDeg) => {
  const rad = ((anguloDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

/** Path de uma fatia de pizza, de anguloIni a anguloFim (graus, 0 = topo, sentido horário). */
function fatiaPath(cx, cy, r, anguloIni, anguloFim) {
  const ini = polar(cx, cy, r, anguloFim);
  const fim = polar(cx, cy, r, anguloIni);
  const grandeArco = anguloFim - anguloIni > 180 ? 1 : 0;
  return `M${cx},${cy} L${ini.x},${ini.y} A${r},${r} 0 ${grandeArco} 0 ${fim.x},${fim.y} Z`;
}

/**
 * Pizza + legenda lado a lado. Cor por ORDEM FIXA de série (classe
 * `pizza-fatia-N`, nunca gerada) — quem chama já deve ter reduzido `data`
 * pra no máximo 6 itens (ex.: top 5 + "Outros") antes de passar aqui; a
 * paleta categórica só foi validada pra esse tamanho.
 *
 * data: [{ chave, rotulo, valor }] — vazio ou tudo zerado mostra o texto
 * de "sem dados", igual ao gráfico de colunas.
 */
export function desenharPizza(container, data, opts = {}) {
  const { tooltip = null, unidade = 'e-mails', textoVazio = 'Sem dados no período.' } = opts;

  limpar(container);
  const total = data.reduce((soma, d) => soma + d.valor, 0);
  if (total <= 0) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = textoVazio;
    container.append(p);
    return;
  }

  const envolt = document.createElement('div');
  envolt.className = 'pizza-envolt';
  container.append(envolt);

  const raio = 78;
  const tam = raio * 2 + 8;
  const svg = svgEl('svg', {
    class: 'gr pizza-svg', width: tam, height: tam, viewBox: `0 0 ${tam} ${tam}`, role: 'img',
  }, envolt);
  const cx = tam / 2;
  const cy = tam / 2;

  const ul = document.createElement('ul');
  ul.className = 'pizza-legenda';
  envolt.append(ul);

  let angulo = 0;
  data.forEach((d, i) => {
    const fracao = d.valor / total;
    const anguloFim = angulo + fracao * 360;
    const serie = (i % 6) + 1;

    if (d.valor > 0) {
      const path = svgEl('path', {
        class: `pizza-fatia pizza-fatia-${serie}`, d: fatiaPath(cx, cy, raio, angulo, anguloFim),
        tabindex: 0, role: 'img', 'aria-label': `${d.rotulo}: ${n(d.valor)} (${nc(fracao * 100)}%)`,
      }, svg);

      // Rótulo direto só em fatias grandes o bastante pra caber o texto —
      // nunca um número espremido em fatia fina, igual à regra do pico.
      if (fracao >= 0.08) {
        const meio = polar(cx, cy, raio * 0.62, angulo + (anguloFim - angulo) / 2);
        svgEl('text', {
          class: 'pizza-rotulo-pct', x: meio.x, y: meio.y + 3.5, text: `${Math.round(fracao * 100)}%`,
        }, svg);
      }

      if (tooltip) {
        const mostrar = (ev) => tooltip.mostrar(
          `<strong>${d.rotulo}</strong><span class="tt-linha"><span class="tt-chave">${unidade}</span>`
          + `<b>${n(d.valor)}</b></span><span class="tt-linha"><span class="tt-chave">do total</span>`
          + `<b>${nc(fracao * 100)}%</b></span>`,
          ev.clientX, ev.clientY,
        );
        path.addEventListener('pointermove', mostrar);
        path.addEventListener('pointerenter', mostrar);
        path.addEventListener('pointerleave', () => tooltip.esconder());
        path.addEventListener('focus', (ev) => mostrar({ clientX: ev.target.getBoundingClientRect().left, clientY: ev.target.getBoundingClientRect().top }));
        path.addEventListener('blur', () => tooltip.esconder());
      }
    }

    const li = document.createElement('li');
    li.className = 'pizza-legenda-item';
    const cor = document.createElement('span');
    cor.className = `pizza-legenda-cor pizza-fatia-${serie}`;
    cor.style.background = `var(--serie-${serie})`;
    const rot = document.createElement('span'); rot.className = 'pizza-legenda-rotulo'; rot.textContent = d.rotulo;
    const num = document.createElement('span'); num.className = 'pizza-legenda-num'; num.textContent = n(d.valor);
    const pct = document.createElement('span'); pct.className = 'pizza-legenda-pct'; pct.textContent = `${Math.round(fracao * 100)}%`;
    li.append(cor, rot, num, pct);
    ul.append(li);

    angulo = anguloFim;
  });
}
