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
 * ele quebra sozinho, é focável e é lido por leitor de tela. O canvas continua
 * travado — sem arrastar, sem zoom; quando não cabe, rola na horizontal.
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
   exibiria chave de template em vez de mensagem. O exemplo é o PIOR CASO REAL
   da fila (maior nome, maior produto): uma amostra confortável faria o painel
   dizer "1 segmento" para SMS que saem em dois e custam o dobro. */
const AMOSTRA_PADRAO = { nome: 'Ana', produto: 'Memopryl', uso: 'as directed' };

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

export function criarRegua(container, { tooltip, aoClicarEtapa, aoAbrirMensagem } = {}) {
  const raiz = el('div', 'rg');
  container.appendChild(raiz);

  let amostra = { ...AMOSTRA_PADRAO };
  let canaisMeta = CANAIS_META;
  let destinos = {};
  let linhaExibindo = null;

  const preencher = (t) =>
    String(t ?? '').replace(/\{(nome|produto|uso)\}/g, (_, k) => amostra[k] ?? `{${k}}`);

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
    return SEGMENTOS.map((k) => {
      const rot = { em_dia: 'Em dia', atrasado: 'Atrasado', processando: 'Processando', travado: 'Travado' }[k];
      return `<span class="tt-linha"><span class="tt-chave"><i class="tt-ponto" style="background:${CORES_ESTADO[k]}"></i>${rot}</span><b>${n(d[k])}</b></span>`;
    }).join('');
  }

  function ttEtapa(d, m, meta) {
    const cab = `<strong>Etapa ${d.etapa} · ${esc(d.nome)}</strong>`
      + `<span class="tt-sub">${esc(meta.label)}`
      + `${m ? (m.ativo === false ? ' · <b>desativada</b>' : '') : ' · <b>não cadastrada</b>'}`
      + `${d.ativo === false ? ' · etapa <b>desativada</b>' : ''}</span>`;

    let copy = '';
    if (m) {
      const linha = preencher(m.assunto || m.texto);
      if (linha) copy += `<span class="tt-copy"><i>${esc(meta.label)}</i>${esc(linha)}</span>`;
      if (m.canal === 'email' && m.botao) {
        copy += `<span class="tt-linha"><span class="tt-chave">Botão</span><b>${esc(preencher(m.botao))}`
          + `${m.destino ? ` → ${esc(destinos?.[m.destino] ?? m.destino)}` : ''}</b></span>`;
      }
      if (m.canal === 'sms') {
        const med = medirSms(preencher(m.texto));
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
      + `<span class="tt-dica">${m ? 'Clique para ver e editar a mensagem' : 'Clique para escrever a mensagem'}</span>`;
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

  /** Nó de mensagem (e-mail ou SMS) de uma etapa — com a copy no sub-rótulo. */
  function noMensagem(d, canal) {
    const meta = canaisMeta[canal] ?? { label: canal, glifo: 'interrogacao' };
    const m = (d.mensagens ?? []).find((x) => x.canal === canal) ?? null;

    let sub;
    let alertaSms = false;
    if (!m) sub = 'não cadastrada';
    else if (m.ativo === false) sub = 'desativada';
    else {
      sub = truncar(preencher(m.assunto || m.texto || ''), 34) || '—';
      if (canal === 'sms' && m.texto) {
        const med = medirSms(preencher(m.texto));
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

    if (aoAbrirMensagem) {
      bloco.title = m
        ? 'Clique para ver a mensagem como o cliente recebe — e editá-la'
        : `Criar a mensagem de ${meta.label} desta etapa`;
      // Molde vazio com a identidade certa: o editor grava por (etapa, canal,
      // linha), então basta isso para o UPSERT criar o registro.
      const alvo = m ?? {
        etapa: d.etapa, canal, linha: linhaExibindo,
        assunto: null, corpo_html: null, botao: null, destino: null,
        texto: '', ativo: true, novo: true,
      };
      acionavel(bloco, () => aoAbrirMensagem(alvo, d, amostra));
    }

    ligarTooltip(bloco, () => ttEtapa(d, m, meta));
    return bloco;
  }

  /**
   * Uma etapa: o par [e-mail]—[SMS] com o cabeçalho por cima — número, nome,
   * quantos pedidos estão parados aqui e o alerta mais urgente. O contador é
   * um botão: é ele que filtra a tabela, como o clique no nó antigo fazia.
   */
  function blocoEtapa(d) {
    const sec = el('section', 'rg-etapa');
    if (d.ativo === false) sec.dataset.inativa = 'sim';

    const cab = el('header', 'rg-etapa-cab');
    cab.appendChild(el('span', 'rg-etapa-rot', `ETAPA ${d.etapa} · ${truncar(d.nome ?? '', 22)}`));

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
    return bloco;
  }

  /* ── montagem ── */
  function atualizar({ etapas, totais, canais, destinos: dest, linha, piorCaso }) {
    if (canais) canaisMeta = canais;
    destinos = dest ?? destinos;
    linhaExibindo = linha?.exibindo ?? linhaExibindo;
    // Sem fila ainda, cai na amostra padrão: melhor um exemplo confortável que
    // um marcador cru.
    amostra = {
      nome: piorCaso?.nome || AMOSTRA_PADRAO.nome,
      produto: piorCaso?.produto || AMOSTRA_PADRAO.produto,
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
