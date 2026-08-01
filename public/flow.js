import { svgEl, limpar, desenharAnel, desenharMicroBarras, envolverTexto } from './charts.js';
import { n, nc, relativo, dataHora, duracaoH } from './format.js';

/* Geometria do nó. Tudo aqui é coordenada interna do SVG: o canvas é TRAVADO
   (sem pan, sem zoom, sem arrastar nó) e se ajusta sozinho à largura do card,
   quebrando a régua em serpentina quando não cabe numa linha só. */
const NO_L = 274;
const NO_A = 230;
const VAO_X = 112;   // precisa caber a etiqueta de espera entre dois nós
const VAO_Y = 86;
const MEIO_Y = 115;

export const CORES_ESTADO = {
  em_dia: 'var(--st-em-dia)',
  atrasado: 'var(--st-atrasado)',
  processando: 'var(--st-processando)',
  travado: 'var(--st-travado)',
  finalizado: 'var(--st-finalizado)',
};

const SEGMENTOS_ANEL = ['em_dia', 'atrasado', 'processando', 'travado'];

/* Glifos de canal, desenhados em traço num quadro de 16×16.
   O canal nunca é comunicado por cor — sempre glifo + palavra. */
const GLIFOS = {
  envelope: 'M2.2 4h11.6v8H2.2z M2.2 4.4l5.8 4.1 5.8-4.1',
  sms: 'M2.2 3.2h11.6v7.2H7.4L4.4 13v-2.6H2.2z',
  interrogacao: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z M6.4 6.3c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6c0 1.2-1.6 1.1-1.6 2.6 M8 11.2v.1',
};

/**
 * O que o nó mostra como texto da mensagem.
 *
 * O assunto do e-mail é a frase mais descritiva que a etapa tem — diz do que a
 * comunicação trata melhor que o nome da etapa. Sem e-mail, cai no texto do
 * SMS. Os marcadores {nome}/{produto} viram o exemplo que o comprador veria,
 * senão o nó exibiria chave de template em vez de mensagem.
 */
const AMOSTRA = { '{nome}': 'Ana', '{produto}': 'Memopryl', '{uso}': 'as directed' };
const preencher = (t) =>
  String(t ?? '').replace(/\{(nome|produto|uso)\}/g, (m) => AMOSTRA[m] ?? m);

function previaMensagem(d) {
  const msgs = d.mensagens ?? [];
  const email = msgs.find((m) => m.canal === 'email' && m.ativo !== false);
  const sms = msgs.find((m) => m.canal === 'sms' && m.ativo !== false);
  return preencher(email?.assunto || email?.texto || sms?.texto || '');
}

/** Canais com mensagem cadastrada, na ordem em que aparecem no nó. */
function canaisDaEtapa(d) {
  const ordem = { email: 0, sms: 1 };
  return (d.mensagens ?? [])
    .slice()
    .sort((a, b) => (ordem[a.canal] ?? 9) - (ordem[b.canal] ?? 9))
    .map((m) => ({ canal: m.canal, ativo: m.ativo !== false }));
}

const menosMovimento = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Nível de tráfego de uma conexão: quantos itens da etapa disparam em 1 h. */
function nivelFluxo(prestes) {
  if (!prestes) return 0;
  if (prestes < 10) return 1;
  if (prestes < 100) return 2;
  return 3;
}

/**
 * A linha de destaque do nó. Mostra UMA coisa: a mais urgente. Um número em
 * cada estado dentro de cada nó viraria ruído — a leitura completa vive no
 * tooltip, na legenda e na tabela lá embaixo.
 */
function linhaAlerta(d) {
  if (d.terminal) return { icone: '✓', txt: 'saíram da régua', tom: 'final' };
  if (d.ativo === false) return { icone: '○', txt: 'etapa desativada na régua', tom: 'neutro' };
  if (d.travado > 0) return { icone: '■', txt: `${n(d.travado)} travado${d.travado > 1 ? 's' : ''}`, tom: 'travado' };
  if (d.atrasado > 0) return { icone: '▲', txt: `${n(d.atrasado)} atrasado${d.atrasado > 1 ? 's' : ''}`, tom: 'atrasado' };
  if (d.com_erro > 0) return { icone: '▲', txt: `${n(d.com_erro)} com erro`, tom: 'travado' };
  if (d.prestes > 0) return { icone: '●', txt: `${n(d.prestes)} dispara${d.prestes > 1 ? 'm' : ''} em 1 h`, tom: 'ativo' };
  if (d.na_etapa === 0) return { icone: '·', txt: 'nenhum pedido aqui', tom: 'neutro' };
  if (d.proximo_em) return { icone: '●', txt: `próximo ${relativo(d.proximo_em)}`, tom: 'ativo' };
  return { icone: '●', txt: 'tudo em dia', tom: 'ativo' };
}

/**
 * Rótulo da conexão: a espera configurada e, quando há dados, a observada.
 * A observada vem da mediana de (proximo_disparo − criado_em); a diferença
 * entre as duas é a deriva entre a régua escrita e a régua que roda.
 */
function rotuloEspera(origem, destino) {
  if (origem?.terminal || destino?.terminal) return null;

  const cfg = Number.isFinite(origem?.espera_h) ? origem.espera_h : null;

  let obs = null;
  if (destino && origem
      && destino.observado_h !== null && origem.observado_h !== null
      && destino.observado_amostra > 0 && origem.observado_amostra > 0) {
    const delta = destino.observado_h - origem.observado_h;
    if (delta > 0) obs = delta;
  }

  if (cfg === null && obs === null) return null;

  // Deriva relevante: mais de 25% de diferença sobre a espera configurada.
  const derivou = cfg !== null && obs !== null && cfg > 0
    && Math.abs(obs - cfg) / cfg > 0.25;

  // A segunda linha ("real X") só aparece quando há deriva. Carimbar o valor
  // observado em toda conexão só empilharia número onde nada está errado —
  // rótulo seletivo é o que faz o rótulo funcionar.
  return {
    linha1: cfg !== null ? duracaoH(cfg) : `real ${duracaoH(obs)}`,
    linha2: derivou ? `real ${duracaoH(obs)}` : null,
    derivou,
  };
}

export function criarFluxo(container, { aoClicarEtapa, tooltip }) {
  const svg = svgEl('svg', { class: 'fluxo', xmlns: 'http://www.w3.org/2000/svg' });
  container.appendChild(svg);

  let assinatura = '';
  let refs = new Map();
  let itens = [];
  let porLinha = 0;

  /* ── posição de cada nó na serpentina ── */
  function posicao(i) {
    const linha = Math.floor(i / porLinha);
    let col = i % porLinha;
    if (linha % 2 === 1) col = porLinha - 1 - col;   // linha ímpar corre ao contrário
    return { x: col * (NO_L + VAO_X), y: linha * (NO_A + VAO_Y), linha, col };
  }

  function caminhoConexao(i) {
    const a = posicao(i);
    const b = posicao(i + 1);
    if (a.linha === b.linha) {
      const paraDireita = a.x < b.x;
      const x1 = paraDireita ? a.x + NO_L : a.x;
      const x2 = paraDireita ? b.x : b.x + NO_L;
      const y = a.y + MEIO_Y;
      return { d: `M${x1},${y} L${x2},${y}`, px: x1, py: y, qx: x2, qy: y, dir: paraDireita ? 1 : -1 };
    }
    // Virada de linha: desce pela mesma coluna.
    const x = a.x + NO_L / 2;
    return { d: `M${x},${a.y + NO_A} L${x},${b.y}`, px: x, py: a.y + NO_A, qx: x, qy: b.y, dir: 0 };
  }

  /* ── construção (só quando o conjunto de etapas muda) ── */
  function construir() {
    limpar(svg);
    refs = new Map();

    const defs = svgEl('defs', {}, svg);
    const brilho = svgEl('filter', {
      id: 'brilho-fluxo', x: '-50%', y: '-50%', width: '200%', height: '200%',
    }, defs);
    svgEl('feGaussianBlur', { stdDeviation: 2.4, result: 'b' }, brilho);
    const merge = svgEl('feMerge', {}, brilho);
    svgEl('feMergeNode', { in: 'b' }, merge);
    svgEl('feMergeNode', { in: 'SourceGraphic' }, merge);

    const gConexoes = svgEl('g', { class: 'conexoes' }, svg);
    const gNos = svgEl('g', { class: 'nos' }, svg);

    // Coto de entrada, à esquerda do primeiro nó.
    const p0 = posicao(0);
    const gEntrada = svgEl('g', { class: 'entrada' }, svg);
    svgEl('path', { class: 'entrada-linha', d: `M${p0.x - 46},${p0.y + MEIO_Y} L${p0.x},${p0.y + MEIO_Y}` }, gEntrada);
    svgEl('circle', { class: 'entrada-ponto', cx: p0.x - 46, cy: p0.y + MEIO_Y, r: 4 }, gEntrada);
    svgEl('text', {
      class: 'entrada-txt', x: p0.x - 46, y: p0.y + MEIO_Y - 14, 'text-anchor': 'middle', text: 'entrada',
    }, gEntrada);

    itens.forEach((_, i) => {
      if (i >= itens.length - 1) return;
      const c = caminhoConexao(i);
      const g = svgEl('g', { class: 'conexao' }, gConexoes);
      svgEl('path', { class: 'conexao-trilho', d: c.d }, g);
      const fluxo = svgEl('path', { class: 'conexao-fluxo', d: c.d, id: `fluxo-${i}` }, g);
      svgEl('circle', { class: 'conexao-porta', cx: c.px, cy: c.py, r: 3.5 }, g);
      // Seta na ponta de chegada. Sem ela a linha invertida da serpentina fica
      // ambígua: o olho lê da esquerda para a direita e inverteria a ordem.
      const giro = c.dir === 0 ? 90 : c.dir === 1 ? 0 : 180;
      svgEl('path', {
        class: 'conexao-seta', d: 'M-4,-4.6 L4.2,0 L-4,4.6 Z',
        transform: `translate(${c.qx},${c.qy}) rotate(${giro})`,
      }, g);

      // Etiqueta da espera entre uma mensagem e a próxima. Fica FORA da linha
      // (acima, na horizontal; ao lado, na vertical) para os pacotes animados
      // não passarem por cima do texto.
      const mx = (c.px + c.qx) / 2;
      const my = (c.py + c.qy) / 2;
      const ex = c.dir === 0 ? mx + 70 : mx;
      const ey = c.dir === 0 ? my : my - 28;
      const gEsp = svgEl('g', { class: 'espera', transform: `translate(${ex},${ey})` }, g);
      const espFundo = svgEl('rect', { class: 'espera-fundo', x: -34, y: -10, width: 68, height: 20, rx: 9 }, gEsp);
      const espTxt1 = svgEl('text', { class: 'espera-txt', x: 0, y: 3.6, 'text-anchor': 'middle' }, gEsp);
      const espTxt2 = svgEl('text', { class: 'espera-real', x: 0, y: 15, 'text-anchor': 'middle' }, gEsp);

      refs.set(`conexao-${i}`, { g, fluxo, gEsp, espFundo, espTxt1, espTxt2, caminho: c, pacotes: 0 });
    });

    itens.forEach((d, i) => {
      const p = posicao(i);
      const g = svgEl('g', {
        class: `no${d.terminal ? ' no--terminal' : ''}`,
        transform: `translate(${p.x},${p.y})`,
        tabindex: '0', role: 'button',
      }, gNos);

      svgEl('rect', { class: 'no-cartao', x: 0, y: 0, width: NO_L, height: NO_A, rx: 16 }, g);
      svgEl('rect', { class: 'no-foco', x: -3, y: -3, width: NO_L + 6, height: NO_A + 6, rx: 19 }, g);

      // rotate(-90) faz o anel começar no topo em vez das 3 horas.
      const gAnel = svgEl('g', { class: 'no-anel', transform: 'translate(40,44) rotate(-90)' }, g);
      svgEl('text', {
        class: 'no-anel-idx', x: 40, y: 48, 'text-anchor': 'middle',
        text: d.terminal ? '✓' : String(d.etapa),
      }, g);

      svgEl('text', {
        class: 'no-sobrancelha', x: 74, y: 36,
        text: d.terminal ? 'SAÍDA' : `ETAPA ${d.etapa}`,
      }, g);
      svgEl('text', { class: 'no-nome', x: 74, y: 57, text: d.nome }, g);

      // Selos de canal, no canto superior direito. São DOIS: toda etapa
      // dispara e-mail e SMS ao mesmo tempo. Um canal desativado na régua
      // continua desenhado, apagado — sumir esconderia justamente a mudança.
      // Montados da direita para a esquerda, medindo cada rótulo de verdade.
      if (!d.terminal) {
        const gCanais = svgEl('g', { class: 'no-canais' }, g);
        let borda = NO_L - 18;
        for (const c of canaisDaEtapa(d).reverse()) {
          const meta = CANAIS_META[c.canal] ?? CANAIS_META.indefinido;
          const gc = svgEl('g', {
            class: 'no-canal', 'data-canal': c.canal, 'data-ativo': c.ativo ? 'sim' : 'nao',
          }, gCanais);
          const rot = svgEl('text', {
            class: 'no-canal-txt', x: borda, y: 30, 'text-anchor': 'end', text: meta.label,
          }, gc);
          // O texto é ancorado no fim, então ocupa [borda-largura, borda].
          // O glifo (16 × 0,72 ≈ 11,5) vai à esquerda disso, com 5px de respiro.
          const larguraRot = rot.getComputedTextLength?.() || meta.label.length * 5.4;
          svgEl('path', {
            class: 'no-canal-glifo', d: GLIFOS[meta.glifo] ?? GLIFOS.interrogacao,
            transform: `translate(${borda - larguraRot - 16.5}, 20) scale(0.72)`,
          }, gc);
          borda -= larguraRot + 16.5 + 11;   // + respiro entre um selo e o outro
        }
      }

      // Texto da mensagem, quebrado em até 2 linhas medidas de verdade.
      const gMsg = svgEl('text', { class: 'no-mensagem', x: 24, y: 88 }, g);

      const valor = svgEl('text', { class: 'no-valor', x: 24, y: 143, text: '0' }, g);
      const unidade = svgEl('text', { class: 'no-unidade', x: 24, y: 143, text: 'pedidos' }, g);

      const gMicro = svgEl('g', { class: 'no-micro', transform: 'translate(24,157)' }, g);
      svgEl('text', {
        class: 'no-legenda', x: 24, y: 196,
        text: d.terminal ? 'total acumulado' : 'próximos disparos · 48 h',
      }, g);

      const gAlerta = svgEl('g', { class: 'no-alerta', transform: 'translate(24,216)' }, g);
      const alertaIco = svgEl('text', { class: 'no-alerta-ico', x: 0, y: 0, text: '·' }, gAlerta);
      const alertaTxt = svgEl('text', { class: 'no-alerta-txt', x: 13, y: 0, text: '—' }, gAlerta);

      const titulo = svgEl('title', {}, g);

      // Alvo de interação cobrindo o cartão inteiro — nunca um alvo minúsculo.
      const alvo = svgEl('rect', {
        class: 'no-alvo', x: 0, y: 0, width: NO_L, height: NO_A, rx: 16, fill: 'transparent',
      }, g);

      const abrirTooltip = (cx, cy) => tooltip.mostrar(htmlTooltip(itens[i]), cx, cy);
      alvo.addEventListener('pointermove', (ev) => abrirTooltip(ev.clientX, ev.clientY));
      alvo.addEventListener('pointerleave', () => tooltip.esconder());
      // Foco de teclado mostra exatamente o mesmo conteúdo do hover.
      g.addEventListener('focus', () => {
        const r = g.getBoundingClientRect();
        abrirTooltip(r.left + r.width / 2, r.top + r.height / 2);
      });
      g.addEventListener('blur', () => tooltip.esconder());
      const acionar = () => aoClicarEtapa(itens[i]);
      g.addEventListener('click', acionar);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); acionar(); }
      });

      refs.set(`no-${i}`, { g, gAnel, gMsg, valor, unidade, gMicro, alertaIco, alertaTxt, titulo });

      // Quebra da mensagem depende do nó já estar no DOM para medir.
      envolverTexto(gMsg, d.terminal ? '' : previaMensagem(d), NO_L - 48, 2, 15);
    });
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function htmlTooltip(d) {
    if (d.terminal) {
      return `<strong>Finalizados</strong><span class="tt-sub">Pedidos que saíram da régua</span>`
        + `<span class="tt-linha"><span class="tt-chave">total</span><b>${n(d.total)}</b></span>`
        + (d.porEtapa?.length
          ? `<span class="tt-sep"></span>` + d.porEtapa
            .map((e) => `<span class="tt-linha"><span class="tt-chave">etapa ${e.etapa}</span><b>${n(e.finalizado)}</b></span>`)
            .join('')
          : '');
    }

    const linhas = SEGMENTOS_ANEL.map((k) => {
      const rot = { em_dia: 'Em dia', atrasado: 'Atrasado', processando: 'Processando', travado: 'Travado' }[k];
      return `<span class="tt-linha"><span class="tt-chave"><i class="tt-ponto" style="background:${CORES_ESTADO[k]}"></i>${rot}</span><b>${n(d[k])}</b></span>`;
    }).join('');

    // Os dois canais, cada um com a sua copy — é a informação que mais mudou
    // de lugar: a etapa não tem "um canal", ela tem uma mensagem por canal.
    const canais = canaisDaEtapa(d);
    const subCanais = canais.length
      ? canais.map((c) => {
        const meta = CANAIS_META[c.canal] ?? CANAIS_META.indefinido;
        return esc(meta.label) + (c.ativo ? '' : ' (off)');
      }).join(' + ')
      : 'nenhuma mensagem cadastrada';

    const copy = (d.mensagens ?? []).map((m) => {
      const meta = CANAIS_META[m.canal] ?? CANAIS_META.indefinido;
      const linha = preencher(m.assunto || m.texto);
      return `<span class="tt-copy"><i>${esc(meta.label)}</i>${esc(linha)}</span>`;
    }).join('');

    return `<strong>Etapa ${d.etapa} · ${esc(d.nome)}</strong>`
      + `<span class="tt-sub">${subCanais}`
      + `${d.ativo === false ? ' · <b>desativada</b>' : ''}</span>`
      + copy
      + `<span class="tt-linha tt-total"><span class="tt-chave">Nesta etapa</span><b>${n(d.na_etapa)}</b></span>`
      + `<span class="tt-sep"></span>${linhas}<span class="tt-sep"></span>`
      + `<span class="tt-linha"><span class="tt-chave">Espera até a próxima</span><b>${Number.isFinite(d.espera_h) ? duracaoH(d.espera_h) : '—'}</b></span>`
      + (d.observado_h !== null && d.observado_amostra > 0
        ? `<span class="tt-linha"><span class="tt-chave">Agendado (mediana real)</span><b>${duracaoH(d.observado_h)} após a entrada</b></span>`
        : '')
      + `<span class="tt-linha"><span class="tt-chave">Próximo disparo</span><b>${d.proximo_em ? relativo(d.proximo_em) : '—'}</b></span>`
      + (d.proximo_em ? `<span class="tt-linha"><span class="tt-chave"></span><b class="tt-fraco">${dataHora(d.proximo_em)}</b></span>` : '')
      + `<span class="tt-linha"><span class="tt-chave">Já finalizados aqui</span><b>${n(d.finalizado)}</b></span>`
      + `<span class="tt-dica">Clique para filtrar a tabela</span>`;
  }

  /* ── atualização de valores (sem recriar o DOM, para não reiniciar animações) ── */
  function pintar() {
    const reduzido = menosMovimento();

    itens.forEach((d, i) => {
      const r = refs.get(`no-${i}`);
      if (!r) return;

      const valorNo = d.terminal ? d.total : d.na_etapa;
      r.valor.textContent = nc(valorNo);

      // "pedidos" encosta no número, então precisa ser medido depois de escrito.
      const larg = r.valor.getComputedTextLength?.() ?? 0;
      r.unidade.setAttribute('x', 24 + larg + 9);

      const segs = d.terminal
        ? [{ valor: d.total, cor: CORES_ESTADO.finalizado }]
        : SEGMENTOS_ANEL.map((k) => ({ valor: d[k] || 0, cor: CORES_ESTADO[k] }));
      desenharAnel(r.gAnel, segs);

      desenharMicroBarras(r.gMicro, d.onda48h ?? new Array(12).fill(0), { w: NO_L - 48, h: 24 });

      const al = linhaAlerta(d);
      r.alertaIco.textContent = al.icone;
      r.alertaTxt.textContent = al.txt;
      r.g.setAttribute('data-tom', al.tom);
      r.g.setAttribute('data-vazio', valorNo === 0 ? 'sim' : 'nao');
      r.g.setAttribute('data-inativa', d.ativo === false ? 'sim' : 'nao');
      r.titulo.textContent = d.terminal
        ? `Finalizados: ${n(d.total)} pedidos`
        : `Etapa ${d.etapa} — ${d.nome}: ${n(d.na_etapa)} pedidos`;

      // Conexão que SAI deste nó, com intensidade proporcional ao que vai andar.
      const c = refs.get(`conexao-${i}`);
      if (c) {
        const nivel = nivelFluxo(d.prestes);
        c.g.setAttribute('data-nivel', String(nivel));
        c.fluxo.style.animationDuration = nivel ? `${[0, 2.6, 1.7, 1.1][nivel]}s` : '';

        const esp = rotuloEspera(d, itens[i + 1]);
        if (esp) {
          c.gEsp.style.display = '';
          c.espTxt1.textContent = esp.linha1;
          c.espTxt2.textContent = esp.linha2 ?? '';
          c.espTxt2.style.display = esp.linha2 ? '' : 'none';

          const medir = (el, txt) => (el.getComputedTextLength?.() || txt.length * 5.6);
          const w = Math.max(
            medir(c.espTxt1, esp.linha1),
            esp.linha2 ? medir(c.espTxt2, esp.linha2) : 0,
          ) + 20;
          const h = esp.linha2 ? 32 : 20;
          c.espFundo.setAttribute('x', -w / 2);
          c.espFundo.setAttribute('width', w);
          c.espFundo.setAttribute('y', esp.linha2 ? -17 : -10);
          c.espFundo.setAttribute('height', h);
          c.espTxt1.setAttribute('y', esp.linha2 ? -3.4 : 3.6);
          c.gEsp.setAttribute('data-derivou', esp.derivou ? 'sim' : 'nao');
        } else {
          c.gEsp.style.display = 'none';
        }

        const querPacotes = reduzido ? 0 : nivel;
        if (querPacotes !== c.pacotes) {
          c.g.querySelectorAll('.pacote').forEach((p) => p.remove());
          for (let k = 0; k < querPacotes; k++) {
            // Antes da etiqueta no DOM, para o pacote passar POR BAIXO dela.
            const dot = svgEl('circle', { class: 'pacote', r: 3.2 });
            c.g.insertBefore(dot, c.gEsp);
            const mov = svgEl('animateMotion', {
              dur: `${[0, 2.6, 1.7, 1.1][nivel]}s`,
              repeatCount: 'indefinite',
              begin: `${(k * [0, 2.6, 1.7, 1.1][nivel]) / querPacotes}s`,
            }, dot);
            const mp = svgEl('mpath', {}, mov);
            mp.setAttribute('href', `#fluxo-${i}`);
            mp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#fluxo-${i}`);
          }
          c.pacotes = querPacotes;
        }
      }
    });
  }

  /* ── dimensiona o canvas; nunca amplia além do tamanho natural ── */
  let larguraAnterior = -1;

  function ajustar() {
    if (!itens.length) return;
    // clientWidth INCLUI o padding lateral do container, mas o SVG só pode
    // ocupar a caixa de conteúdo. Usar o valor cheio fazia o desenho ser
    // escalado para uma largura maior que a disponível e ser cortado na borda.
    const estilo = getComputedStyle(container);
    const respiro = parseFloat(estilo.paddingLeft) + parseFloat(estilo.paddingRight);
    const dispW = Math.max(160, (container.clientWidth || 900) - (respiro || 0));

    // O próprio SVG muda a altura do container, o que reacorda o ResizeObserver.
    // Só a largura importa para o layout, então ignoramos o eco.
    if (dispW === larguraAnterior && porLinha > 0) return;
    larguraAnterior = dispW;

    // Quantos cabem por linha…
    const cabem = Math.max(
      1,
      Math.min(itens.length, Math.floor((dispW + VAO_X) / (NO_L + VAO_X))),
    );
    // …e depois equilibra: 6 nós com espaço para 4 viram 3+3, não 4+2.
    const linhasNec = Math.ceil(itens.length / cabem);
    const novoPorLinha = Math.ceil(itens.length / linhasNec);

    if (novoPorLinha !== porLinha) {
      porLinha = novoPorLinha;
      construir();
      pintar();
    }

    const linhas = Math.ceil(itens.length / porLinha);
    const colunas = Math.min(itens.length, porLinha);
    const vbL = colunas * NO_L + (colunas - 1) * VAO_X + 60;  // 60 = folga p/ o coto de entrada
    const vbA = linhas * NO_A + (linhas - 1) * VAO_Y + 26;
    const escala = Math.min(1, dispW / vbL);

    svg.setAttribute('viewBox', `-54 -14 ${vbL} ${vbA}`);
    svg.setAttribute('width', Math.round(vbL * escala));
    svg.setAttribute('height', Math.round(vbA * escala));
  }

  new ResizeObserver(ajustar).observe(container);
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', pintar);

  return {
    atualizar(etapas, totais) {
      const terminal = {
        terminal: true,
        nome: 'Finalizados',
        total: totais.finalizado,
        onda48h: new Array(12).fill(0),
        porEtapa: etapas.filter((e) => e.finalizado > 0).map((e) => ({ etapa: e.etapa, finalizado: e.finalizado })),
      };
      itens = [...etapas, terminal];

      // A assinatura inclui o que é ESTRUTURAL (identidade, texto, canais): se
      // mudar, o DOM é reconstruído. Números sozinhos nunca reconstroem nada.
      const nova = itens
        .map((d) => (d.terminal ? 'fim' : [
          d.etapa, d.nome, previaMensagem(d),
          canaisDaEtapa(d).map((c) => `${c.canal}${c.ativo ? '' : '-off'}`).join(','),
        ].join(':')))
        .join('|');
      if (nova !== assinatura) {
        assinatura = nova;
        porLinha = 0;      // zera para forçar reconstrução dentro de ajustar()
      }
      ajustar();           // reconstrói o DOM só se o layout mudou
      pintar();            // valores sempre; não recria nada, não reinicia animação
    },
  };
}

/* Preenchido por app.js a partir do snapshot, para o servidor continuar sendo
   a única fonte da lista de canais. `indefinido` fica como rede: um canal que
   apareça no banco sem estar no config é desenhado com "?" em vez de sumir. */
export const CANAIS_META = {
  email: { label: 'E-mail', glifo: 'envelope' },
  sms: { label: 'SMS', glifo: 'sms' },
  indefinido: { label: 'Sem canal', glifo: 'interrogacao' },
};

export function definirCanais(canais) {
  for (const [id, meta] of Object.entries(canais ?? {})) CANAIS_META[id] = meta;
}
