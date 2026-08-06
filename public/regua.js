/**
 * O fluxo da régua num componente só, desenhado como o editor do n8n:
 * cada mensagem é um NÓ pequeno de ícone (e-mail azul, SMS violeta), a espera
 * entre etapas é o nó laranja de relógio, e a compra é o nó verde de entrada.
 *
 * Ele junta as duas metades que antes eram dois cards:
 *   — o canvas de números (quantos pedidos em cada etapa, alertas, tooltip,
 *     clique que filtra a tabela) e
 *   — a trilha de copy (o que cada mensagem diz, medição de SMS, e o clique
 *     que abre a mensagem para ver e editar).
 *
 * Feito em HTML, não em SVG: o conteúdo é texto de tamanho variável, e em HTML
 * ele quebra sozinho, é focável e é lido por leitor de tela. Sem zoom, mas o
 * fundo aceita pegar-e-arrastar (como no n8n) além da rolagem normal.
 */
import { n, relativo, dataHora, duracaoH, truncar } from './format.js';
// Medidor compartilhado com o editor e com o servidor: uma regra de SMS só.
import { medirSms } from './copy.js';

export const CORES_ESTADO = {
  em_dia: 'var(--st-em-dia)',
  atrasado: 'var(--st-atrasado)',
  processando: 'var(--st-processando)',
  travado: 'var(--st-travado)',
  finalizado: 'var(--st-finalizado)',
  cancelado: 'var(--st-cancelado)',
};

const SEGMENTOS = ['em_dia', 'atrasado', 'processando', 'travado'];
const ROTULO_ESTADO = {
  em_dia: 'Em dia', atrasado: 'Atrasado', processando: 'Processando', travado: 'Travado',
};

/**
 * Qual dos quatro estados vivos tem mais pedidos NESTA etapa agora — é a cor
 * que a bolinha do número usa. Sem pedido nenhum, não há "predominante": a
 * bolinha fica neutra em vez de sortear uma cor que não significa nada.
 */
function estadoDominante(d) {
  let melhor = null;
  let max = 0;
  for (const k of SEGMENTOS) {
    const v = d[k] || 0;
    if (v > max) { max = v; melhor = k; }
  }
  return melhor;
}

/* Glifos em traço num quadro de 16×16, desenhados em branco dentro do quadrado
   colorido do nó. O canal nunca é comunicado por cor sozinha — o nó tem sempre
   glifo + rótulo escrito embaixo. */
const GLIFOS = {
  compra: 'M3.6 5.6h8.8l-.7 7.6H4.3z M5.9 5.6V4.7a2.1 2.1 0 0 1 4.2 0v.9',
  envelope: 'M2.2 4h11.6v8H2.2z M2.2 4.4l5.8 4.1 5.8-4.1',
  sms: 'M2.2 3.2h11.6v7.2H7.4L4.4 13v-2.6H2.2z',
  relogio: 'M8 2.9a5.1 5.1 0 1 0 0 10.2A5.1 5.1 0 0 0 8 2.9z M8 5.3V8l2 1.5',
  fim: 'M3.4 8.5l3.1 3.1 6.1-6.7',
  mais: 'M8 4.6v6.8 M4.6 8h6.8',
  interrogacao: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z M6.4 6.3c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6c0 1.2-1.6 1.1-1.6 2.6 M8 11.2v.1',
};

/* Os marcadores {nome}/{produto} viram um exemplo concreto — senão o nó
   exibiria chave de template em vez de mensagem. No padrão, o exemplo é o
   PIOR CASO REAL da fila (maior nome, maior produto): uma amostra confortável
   faria o painel dizer "1 segmento" para SMS que saem em dois e custam o
   dobro. Com um produto escolhido, o {produto} passa a ser o NOME DELE — e no
   SMS, o `nome_sms` quando existir: "Horse Boost Gelatin" (19 car.) e
   "MindTrex" (8 car.) fazem a MESMA copy caber em 1 segmento num produto e
   estourar para 2 no outro, então medir pelo nome errado mente sobre o custo. */
const AMOSTRA_PADRAO = { nome: 'Ana', produto: 'product', uso: 'as directed' };

const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function svgGlifo(glifo) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', GLIFOS[glifo] ?? GLIFOS.interrogacao);
  svg.appendChild(path);
  return svg;
}

/** Nível de tráfego de uma conexão: quantos itens da etapa disparam em 1 h. */
function nivelFluxo(prestes) {
  if (!prestes) return 0;
  if (prestes < 10) return 1;
  if (prestes < 100) return 2;
  return 3;
}

/**
 * A linha de destaque da etapa. Mostra UMA coisa: a mais urgente. Um número em
 * cada estado dentro de cada nó viraria ruído — a leitura completa vive no
 * tooltip, na legenda e na tabela lá embaixo.
 */
function linhaAlerta(d) {
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
 * Rótulo do nó de espera: a configurada e, quando há dados, a observada.
 * A observada vem da mediana de (proximo_disparo − criado_em); a diferença
 * entre as duas é a deriva entre a régua escrita e a régua que roda.
 */
function rotuloEspera(origem, destino) {
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
  // A segunda linha ("real X") só aparece nesse caso — carimbar o observado em
  // todo nó só empilharia número onde nada está errado.
  const derivou = cfg !== null && obs !== null && cfg > 0
    && Math.abs(obs - cfg) / cfg > 0.25;

  return {
    linha1: cfg !== null ? duracaoH(cfg) : `real ${duracaoH(obs)}`,
    linha2: derivou ? `real ${duracaoH(obs)}` : null,
    cfg, obs, derivou,
  };
}

/**
 * Pegar-e-arrastar no fundo do canvas, como no n8n. O arrasto só começa depois
 * de 5px de movimento — antes disso o gesto ainda pode ser um clique num nó.
 * Depois que vira arrasto, o clique que o navegador dispara ao soltar é
 * engolido na fase de captura, senão soltar em cima de um nó abriria a
 * mensagem sem ninguém ter pedido.
 */
function ligarArrasto(alvo, aoComecar) {
  let apertado = false;
  let arrastou = false;
  let x0 = 0; let y0 = 0; let sx = 0; let sy = 0;

  alvo.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    apertado = true;
    arrastou = false;
    x0 = ev.clientX; y0 = ev.clientY;
    sx = alvo.scrollLeft; sy = alvo.scrollTop;
  });

  alvo.addEventListener('pointermove', (ev) => {
    if (!apertado) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!arrastou) {
      if (Math.hypot(dx, dy) < 5) return;
      arrastou = true;
      alvo.setPointerCapture(ev.pointerId);   // os nós param de receber o hover
      alvo.dataset.arrastando = 'sim';
      aoComecar?.();
    }
    alvo.scrollLeft = sx - dx;
    alvo.scrollTop = sy - dy;
  });

  const soltar = () => {
    apertado = false;
    delete alvo.dataset.arrastando;
  };
  alvo.addEventListener('pointerup', soltar);
  alvo.addEventListener('pointercancel', soltar);

  alvo.addEventListener('click', (ev) => {
    if (!arrastou) return;
    arrastou = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
}

export function criarRegua(container, { tooltip, aoClicarEtapa, aoAbrirMensagem, aoAbrirTempo } = {}) {
  const raiz = el('div', 'rg');
  container.appendChild(raiz);
  ligarArrasto(container, () => tooltip?.esconder());

  let amostra = { ...AMOSTRA_PADRAO };
  let canaisMeta = CANAIS_META;
  let destinos = {};
  let linhaExibindo = null;
  // De qual produto é a copy desenhada: '*' é o padrão. Com um produto
  // escolhido, cada nó resolve a cascata (produto → '*') e diz de onde veio.
  let produtoCopy = '*';
  let produtoMeta = null;

  // Ciente do canal: no SMS, {produto} usa o nome CURTO (nome_sms) quando
  // existir — é o que decide se a mesma copy cabe em 1 segmento ou estoura
  // para 2, e o nome longo do e-mail mentiria sobre esse custo.
  const preencher = (t, canal) =>
    String(t ?? '').replace(/\{(nome|produto|uso)\}/g, (_, k) => {
      if (k === 'produto' && canal === 'sms' && amostra.produto_sms) return amostra.produto_sms;
      return amostra[k] ?? `{${k}}`;
    });

  /* ── tooltip: liga o mesmo conteúdo ao hover e ao foco de teclado ── */
  function ligarTooltip(no, html) {
    if (!tooltip) return;
    no.addEventListener('pointermove', (ev) => tooltip.mostrar(html(), ev.clientX, ev.clientY));
    no.addEventListener('pointerleave', () => tooltip.esconder());
    no.addEventListener('focus', () => {
      const r = no.getBoundingClientRect();
      tooltip.mostrar(html(), r.left + r.width / 2, r.top + r.height / 2);
    });
    no.addEventListener('blur', () => tooltip.esconder());
  }

  /** As linhas de estado (em dia / atrasado / …) que todo tooltip de etapa tem. */
  function ttEstados(d) {
    return SEGMENTOS.map((k) =>
      `<span class="tt-linha"><span class="tt-chave"><i class="tt-ponto" style="background:${CORES_ESTADO[k]}"></i>${ROTULO_ESTADO[k]}</span><b>${n(d[k])}</b></span>`).join('');
  }

  function ttEtapa(d, m, meta, herdada = false) {
    // Com um produto escolhido, o tooltip diz DE ONDE veio o texto — é a
    // resposta à pergunta "se eu editar isto, mudo um produto ou todos?".
    const origem = produtoCopy === '*'
      ? ''
      : (herdada
        ? ' · <b>herdada do padrão</b>'
        : ` · <b>própria do ${esc(produtoMeta?.nome ?? produtoCopy)}</b>`);
    const cab = `<strong>Etapa ${d.etapa} · ${esc(d.nome)}</strong>`
      + `<span class="tt-sub">${esc(meta.label)}`
      + `${m ? (m.ativo === false ? ' · <b>desativada</b>' : '') : ' · <b>não cadastrada</b>'}`
      + origem
      + `${d.ativo === false ? ' · etapa <b>desativada</b>' : ''}</span>`;

    let copy = '';
    if (m) {
      const linha = preencher(m.assunto || m.texto, m.canal);
      if (linha) copy += `<span class="tt-copy"><i>${esc(meta.label)}</i>${esc(linha)}</span>`;
      if (m.canal === 'email' && m.botao) {
        copy += `<span class="tt-linha"><span class="tt-chave">Botão</span><b>${esc(preencher(m.botao, m.canal))}`
          + `${m.destino ? ` → ${esc(destinos?.[m.destino] ?? m.destino)}` : ''}</b></span>`;
      }
      if (m.canal === 'sms') {
        const med = medirSms(preencher(m.texto, m.canal));
        copy += `<span class="tt-linha"><span class="tt-chave">Tamanho</span><b>`
          + `${n(med.unidades)}/${med.limite} · ${med.segmentos === 1 ? '1 segmento' : `${med.segmentos} segmentos · custa o dobro`}`
          + `${med.unicode ? ' · fora do GSM-7' : ''}</b></span>`;
      }
    } else {
      copy = `<span class="tt-copy"><i>${esc(meta.label)}</i>Esta etapa não envia `
        + `${esc(meta.label)} na linha ${esc(linhaExibindo ?? '—')}.</span>`;
    }

    return cab + copy
      + `<span class="tt-linha tt-total"><span class="tt-chave">Nesta etapa</span><b>${n(d.na_etapa)}</b></span>`
      + `<span class="tt-sep"></span>${ttEstados(d)}<span class="tt-sep"></span>`
      + `<span class="tt-linha"><span class="tt-chave">Próximo disparo</span><b>${d.proximo_em ? relativo(d.proximo_em) : '—'}</b></span>`
      + (d.proximo_em ? `<span class="tt-linha"><span class="tt-chave"></span><b class="tt-fraco">${dataHora(d.proximo_em)}</b></span>` : '')
      + `<span class="tt-linha"><span class="tt-chave">Já finalizados aqui</span><b>${n(d.finalizado)}</b></span>`
      + `<span class="tt-dica">${produtoCopy !== '*' && herdada
        ? `Clique para criar a versão do ${esc(produtoMeta?.nome ?? produtoCopy)}`
        : m ? 'Clique para ver e editar a mensagem' : 'Clique para escrever a mensagem'}</span>`;
  }

  function ttEspera(origem, esp) {
    return `<strong>Espera entre mensagens</strong>`
      + `<span class="tt-sub">Depois da etapa ${origem.etapa} · ${esc(origem.nome)}</span>`
      + `<span class="tt-linha"><span class="tt-chave">Configurada na régua</span><b>${esp.cfg !== null ? duracaoH(esp.cfg) : '—'}</b></span>`
      + (esp.obs !== null
        ? `<span class="tt-linha"><span class="tt-chave">Observada (mediana real)</span><b>${duracaoH(esp.obs)}</b></span>`
        : '')
      + (esp.derivou
        ? `<span class="tt-dica">A fila está rodando fora do que a régua manda.</span>`
        : '');
  }

  function ttFim(totais, etapas) {
    const porEtapa = etapas.filter((e) => e.finalizado > 0)
      .map((e) => `<span class="tt-linha"><span class="tt-chave">etapa ${e.etapa}</span><b>${n(e.finalizado)}</b></span>`)
      .join('');
    return `<strong>Finalizados</strong><span class="tt-sub">Pedidos que chegaram ao fim da régua</span>`
      + `<span class="tt-linha"><span class="tt-chave">total</span><b>${n(totais.finalizado)}</b></span>`
      // Cancelado NÃO entra no total acima: quem cancelou não concluiu a
      // régua. Aparece aqui para que o número não suma sem explicação.
      + (totais.cancelado > 0
        ? `<span class="tt-linha"><span class="tt-chave"><i class="tt-ponto" style="background:${CORES_ESTADO.cancelado}"></i>Cancelados (à parte)</span><b>${n(totais.cancelado)}</b></span>`
        : '')
      + (porEtapa ? `<span class="tt-sep"></span>${porEtapa}` : '')
      + `<span class="tt-dica">Clique para filtrar a tabela</span>`;
  }

  /* ── blocos ── */

  /** O nó em si: quadrado colorido + rótulo + sub-rótulo, como no n8n. */
  function no({ tipo, glifo, rot, sub, title }) {
    const bloco = el('div', 'rg-no');
    bloco.dataset.tipo = tipo;

    const tile = el('span', 'rg-tile');
    const ico = el('span', 'rg-ico');
    ico.appendChild(svgGlifo(glifo));
    tile.appendChild(ico);
    bloco.appendChild(tile);

    bloco.appendChild(el('span', 'rg-rot', rot));
    if (sub !== undefined) bloco.appendChild(el('span', 'rg-sub', sub));
    if (title) bloco.title = title;
    return bloco;
  }

  function acionavel(bloco, acao) {
    bloco.tabIndex = 0;
    bloco.setAttribute('role', 'button');
    bloco.addEventListener('click', acao);
    bloco.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); acao(); }
    });
  }

  /** Conector entre dois nós — a linha fina do n8n, animada quando há tráfego. */
  function liga(nivel = 0, curta = false) {
    const l = el('span', `rg-liga${curta ? ' rg-liga--curta' : ''}`);
    l.dataset.nivel = String(nivel);
    l.setAttribute('aria-hidden', 'true');
    return l;
  }

  /**
   * A cascata de copy de um canal da etapa, do jeito que o robô procura:
   * primeiro a mensagem do produto escolhido, senão a do padrão '*'.
   * Uma mensagem de produto DESATIVADA volta a cair no padrão — desativar é
   * exatamente o gesto de "voltar ao padrão", sem apagar o texto.
   */
  function resolverCopy(d, canal) {
    const doCanal = (d.mensagens ?? []).filter((x) => x.canal === canal);
    const padrao = doCanal.find((x) => String(x.produto ?? '*') === '*') ?? null;
    if (produtoCopy === '*') return { efetiva: padrao, propria: null, padrao, herdada: false };
    const propria = doCanal.find((x) => String(x.produto ?? '*') === produtoCopy) ?? null;
    const ativa = propria && propria.ativo !== false ? propria : null;
    return { efetiva: ativa ?? padrao, propria, padrao, herdada: !ativa };
  }

  /** Nó de mensagem (e-mail ou SMS) de uma etapa — com a copy no sub-rótulo. */
  function noMensagem(d, canal) {
    const meta = canaisMeta[canal] ?? { label: canal, glifo: 'interrogacao' };
    const { efetiva: m, propria, padrao, herdada } = resolverCopy(d, canal);

    let sub;
    let alertaSms = false;
    if (!m) sub = 'não cadastrada';
    else if (m.ativo === false) sub = 'desativada';
    else {
      sub = truncar(preencher(m.assunto || m.texto || '', canal), 34) || '—';
      if (canal === 'sms' && m.texto) {
        const med = medirSms(preencher(m.texto, canal));
        alertaSms = med.segmentos > 1 || med.unicode;
        if (alertaSms) sub = `${med.segmentos} segmentos · ${sub}`;
      }
    }

    const bloco = no({
      tipo: canal === 'email' ? 'email' : 'sms',
      glifo: meta.glifo ?? (canal === 'email' ? 'envelope' : 'sms'),
      rot: `Enviar ${meta.label}`,
      sub,
    });
    if (!m) {
      bloco.dataset.vazio = 'sim';
      // O tile vazio ganha o "+": o lugar de uma mensagem que ainda não existe
      // é também o botão para escrevê-la.
      bloco.querySelector('.rg-ico').replaceChildren(svgGlifo('mais'));
    }
    if (m?.ativo === false) bloco.dataset.ativo = 'nao';
    if (alertaSms) bloco.dataset.alerta = 'sim';
    // Forma além de cor: herdado é tracejado, próprio é sólido — a mesma
    // regra de acessibilidade do resto do painel.
    if (produtoCopy !== '*') bloco.dataset.heranca = herdada ? 'herdada' : 'propria';

    /*
     * O indicador de herança — sem ele a tela fica ambígua de um jeito
     * perigoso: a pessoa edita um texto sem saber se mexeu na copy de UM
     * produto ou na de todos. Só aparece com um produto escolhido.
     */
    if (produtoCopy !== '*') {
      const selo = el('span', 'rg-copy-selo', herdada ? 'padrão' : 'própria');
      selo.dataset.origem = herdada ? 'padrao' : 'propria';
      selo.title = herdada
        ? `Esta etapa usa o texto padrão — clique no nó para criar a versão do ${produtoMeta?.nome ?? produtoCopy}`
        : `Texto exclusivo do ${produtoMeta?.nome ?? produtoCopy}`;
      bloco.appendChild(selo);
    }

    if (aoAbrirMensagem) {
      bloco.title = m
        ? (produtoCopy !== '*' && herdada
          ? `Abre o texto padrão como ponto de partida para a versão do ${produtoMeta?.nome ?? produtoCopy}`
          : 'Clique para ver a mensagem como o cliente recebe — e editá-la')
        : `Criar a mensagem de ${meta.label} desta etapa`;

      const alvo = alvoDoEditor(d, canal, { propria, padrao });
      acionavel(bloco, () => aoAbrirMensagem(alvo, d, amostra));
    }

    ligarTooltip(bloco, () => ttEtapa(d, m, meta, herdada));
    return bloco;
  }

  /**
   * O que o clique no nó abre no editor, respeitando o produto escolhido:
   *  - no padrão: a mensagem '*' (ou um molde vazio dela);
   *  - produto com versão própria ativa: a própria;
   *  - versão própria desativada: ela mesma, já reativada no rascunho —
   *    salvar volta a valer;
   *  - sem versão própria: um molde do produto PRÉ-PREENCHIDO com o texto do
   *    padrão — criar a versão começa do texto que o cliente recebe hoje.
   */
  function alvoDoEditor(d, canal, { propria, padrao }) {
    const molde = (produto, base) => ({
      etapa: d.etapa, canal, linha: linhaExibindo, produto,
      assunto: base?.assunto ?? null, corpo_html: base?.corpo_html ?? null,
      botao: base?.botao ?? null, destino: base?.destino ?? null,
      texto: base?.texto ?? '', ativo: true, novo: true,
    });
    if (produtoCopy === '*') return padrao ?? molde('*', null);
    if (propria && propria.ativo !== false) return propria;
    if (propria) return { ...propria, ativo: true };
    return molde(produtoCopy, padrao);
  }

  /**
   * Uma etapa: o par [e-mail]—[SMS] com o cabeçalho por cima — o número da
   * etapa (numa bolinha colorida pelo estado com MAIS pedidos ali agora),
   * o nome, quantos pedidos estão parados aqui e o alerta mais urgente.
   * O contador é um botão: é ele que filtra a tabela, como o clique no nó
   * antigo fazia.
   */
  function blocoEtapa(d) {
    const sec = el('section', 'rg-etapa');
    if (d.ativo === false) sec.dataset.inativa = 'sim';

    const cab = el('header', 'rg-etapa-cab');

    const dominante = estadoDominante(d);
    const idx = el('span', 'rg-etapa-idx', String(d.etapa));
    if (dominante) {
      idx.style.setProperty('--cor-dominante', CORES_ESTADO[dominante]);
      idx.title = `Etapa ${d.etapa} — maior volume agora: ${ROTULO_ESTADO[dominante]} (${n(d[dominante])})`;
    } else {
      idx.dataset.vazio = 'sim';
      idx.title = `Etapa ${d.etapa} — nenhum pedido aqui agora`;
    }
    cab.appendChild(idx);
    cab.appendChild(el('span', 'rg-etapa-rot', truncar(d.nome ?? '', 22)));

    const al = linhaAlerta(d);
    const qtd = el('button', 'rg-qtd');
    qtd.type = 'button';
    qtd.dataset.tom = al.tom;
    qtd.title = `${al.txt} — clique para filtrar a tabela por esta etapa`;
    qtd.append(el('i', 'rg-qtd-ponto'), el('b', null, n(d.na_etapa ?? 0)), el('span', null, 'aqui'));
    if (aoClicarEtapa) {
      qtd.addEventListener('click', (ev) => { ev.stopPropagation(); aoClicarEtapa(d); });
    }
    cab.appendChild(qtd);
    sec.appendChild(cab);

    const nos = el('div', 'rg-etapa-nos');
    nos.append(
      noMensagem(d, 'email'),
      liga(nivelFluxo(d.prestes), true),
      noMensagem(d, 'sms'),
    );
    sec.appendChild(nos);
    return sec;
  }

  /** Nó de espera — o relógio laranja com a duração escrita embaixo. */
  function blocoEspera(origem, destino) {
    const esp = rotuloEspera(origem, destino);
    const bloco = no({
      tipo: 'espera',
      glifo: 'relogio',
      rot: esp ? esp.linha1 : '—',
      sub: esp?.linha2 ?? 'espera',
    });
    if (esp?.derivou) bloco.dataset.derivou = 'sim';
    if (esp) ligarTooltip(bloco, () => ttEspera(origem, esp));
    // Clicar no relógio abre a edição do tempo desta espera — mesmo alvo do
    // botão "Tempos", só que já apontado para a etapa certa.
    if (aoAbrirTempo) acionavel(bloco, () => aoAbrirTempo(origem, destino));
    return bloco;
  }

  /* ── montagem ── */
  function atualizar({ etapas, totais, canais, destinos: dest, linha, piorCaso, copyProduto, catalogo }) {
    if (canais) canaisMeta = canais;
    destinos = dest ?? destinos;
    linhaExibindo = linha?.exibindo ?? linhaExibindo;
    produtoCopy = copyProduto ?? '*';
    produtoMeta = produtoCopy === '*'
      ? null
      : (catalogo ?? []).find((p) => p.slug === produtoCopy) ?? null;
    /*
     * A amostra dos marcadores {nome}/{produto}. No padrão continua o pior
     * caso real da fila (é ele que decide se o SMS vira dois segmentos). Com
     * um produto escolhido, o {produto} é o NOME DELE — mostrar "Memopryl"
     * na copy do NeuroMind Pro seria mentir sobre o que o cliente recebe.
     */
    amostra = {
      nome: piorCaso?.nome || AMOSTRA_PADRAO.nome,
      produto: produtoMeta?.nome || piorCaso?.produto || AMOSTRA_PADRAO.produto,
      // No SMS, o nome CURTO quando o produto tiver um — é o que decide se a
      // mesma copy cabe em 1 segmento ou estoura para 2.
      produto_sms: produtoMeta?.nome_sms || produtoMeta?.nome || piorCaso?.produto || AMOSTRA_PADRAO.produto,
      uso: AMOSTRA_PADRAO.uso,
    };

    const vivas = (etapas ?? []).filter((e) => !e.terminal);
    if (!vivas.length) {
      raiz.replaceChildren(el('p', 'vazio-suave', 'Nenhuma etapa cadastrada na régua.'));
      return;
    }

    const fita = el('div', 'rg-fita');

    // O nó verde de entrada — no n8n é o gatilho; aqui é a compra.
    const inicio = no({
      tipo: 'inicio', glifo: 'compra',
      rot: 'Compra Realizada',
      sub: `${n(totais?.na_regua ?? 0)} na régua`,
    });
    ligarTooltip(inicio, () =>
      `<strong>Compra realizada</strong>`
      + `<span class="tt-sub">Toda venda entra aqui e percorre a régua até o fim</span>`
      + `<span class="tt-linha"><span class="tt-chave">Na régua agora</span><b>${n(totais?.na_regua ?? 0)}</b></span>`
      + `<span class="tt-linha"><span class="tt-chave">Finalizados</span><b>${n(totais?.finalizado ?? 0)}</b></span>`);
    fita.appendChild(inicio);

    vivas.forEach((d, i) => {
      const nivel = nivelFluxo(d.prestes);
      // O conector de chegada carrega o tráfego de quem DESPEJA nele: a etapa
      // anterior — ou a própria primeira etapa, no coto de entrada.
      fita.appendChild(liga(i === 0 ? nivel : nivelFluxo(vivas[i - 1].prestes)));
      fita.appendChild(blocoEtapa(d));

      const prox = vivas[i + 1];
      if (prox) {
        fita.appendChild(liga(nivel));
        fita.appendChild(blocoEspera(d, prox));
      }
    });

    // Fecho: deixa explícito que a régua ACABA, em vez de o desenho parecer
    // cortado. Clicar filtra a tabela pelos finalizados, como o nó antigo.
    const ultimo = vivas[vivas.length - 1];
    fita.appendChild(liga(nivelFluxo(ultimo?.prestes)));
    const fim = no({
      tipo: 'fim', glifo: 'fim',
      rot: 'Fim da régua',
      sub: `${n(totais?.finalizado ?? 0)} finalizados`,
    });
    if (aoClicarEtapa) acionavel(fim, () => aoClicarEtapa({ terminal: true }));
    ligarTooltip(fim, () => ttFim(totais ?? {}, vivas));
    fita.appendChild(fim);

    raiz.replaceChildren(fita);
  }

  return { atualizar };
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
