/**
 * Aba "Visão Geral" — a Home do SendTrace (v2, 21/09/2026).
 *
 * Implementa a especificação "CS NorthScale · Visão Geral do SendTrace v2"
 * juntada com o documento RETIRAR DASH. A página responde sete perguntas na
 * ordem A–G, com UM período no topo (e comparação com o anterior), e todo
 * cartão mostra período, base e referência.
 *
 * Busca tudo de UMA rota agregada (`/api/visao-geral`) e não entra no polling
 * automático: só carrega na entrada e quando o filtro muda.
 *
 * Escolhas de junção (RETIRAR DASH x PDF), deixadas explícitas pra poderem ser
 * revistas:
 *  · Motivos de reembolso e Clientes por plataforma seguem em PIZZA (pedido do
 *    RETIRAR DASH), com a legenda ordenada e no máximo 8 fatias. O PDF prefere
 *    barras para mais de 4 fatias.
 *  · O tempo por área virou o F3 (mediana e P90, IA x humano) e ficou a tabela
 *    por área dentro dele, com CS IA e CS Humano separados (RETIRAR DASH).
 *  · Reembolso e chargeback voltam ao topo, no bloco A, como PRÉVIA rotulada com
 *    os eventos das plataformas: o número oficial vem do dash (integração P4).
 */
import {
  $, api, tooltip, topMaisOutros, rotularMotivo, rotularPlataforma,
} from './emailComum.js';
import { n, dia, duracaoH, relativo } from './format.js';
import { desenharPizza, desenharLinha } from './charts.js';
import { abrirRastreioComStatus } from './rastreio.js';
import {
  el, card, bloco, pctTxt, dec1, razao, variacao, sparkline, bullet, empilhada, dumbbell,
} from './vgComponentes.js';

const CHAVE_FILTRO = 'sendtrace.vg.filtro';
const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['custom', 'Personalizado']];

/* ═══════════════════════════════  filtro  ═══════════════════════════════ */

function lerFiltro() {
  const padrao = { periodo: '30d', de: null, ate: null, comparar: true, plataforma: '', produto: '', linha: '', fulfillment: '' };
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_FILTRO) ?? 'null');
    if (bruto && PERIODOS.some(([k]) => k === bruto.periodo)) {
      const custom = bruto.periodo === 'custom' && bruto.de && bruto.ate;
      return { ...padrao, ...bruto, periodo: custom || bruto.periodo !== 'custom' ? bruto.periodo : '30d' };
    }
  } catch { /* sem storage: segue o padrão */ }
  return padrao;
}

let filtro = lerFiltro();
let opcoesCache = null;
function salvarFiltro() {
  try { localStorage.setItem(CHAVE_FILTRO, JSON.stringify(filtro)); } catch { /* sem storage */ }
}

function renderFiltros(s) {
  const c = $('vg-filtros');
  if (!c) return;
  c.replaceChildren();

  const grupo = el('div', 'vg-seg');
  grupo.setAttribute('role', 'group');
  grupo.setAttribute('aria-label', 'Período');
  grupo.append(el('span', 'vg-filtro-rotulo', 'Período'));
  for (const [chave, rotulo] of PERIODOS) {
    const b = el('button', `vg-chip${filtro.periodo === chave ? ' is-ativo' : ''}`, rotulo);
    b.type = 'button';
    b.setAttribute('aria-pressed', filtro.periodo === chave ? 'true' : 'false');
    b.addEventListener('click', () => {
      filtro.periodo = chave;
      if (chave === 'custom' && !(filtro.de && filtro.ate)) {
        const hoje = new Date();
        const ini = new Date(hoje.getTime() - 14 * 86_400_000);
        filtro.de = ini.toISOString().slice(0, 10);
        filtro.ate = hoje.toISOString().slice(0, 10);
      }
      salvarFiltro();
      carregarVisaoGeral();
    });
    grupo.append(b);
  }
  c.append(grupo);

  if (filtro.periodo === 'custom') {
    const datas = el('div', 'vg-datas');
    const mk = (chave, rotulo) => {
      const l = el('label', 'vg-data');
      l.append(el('span', '', rotulo));
      const i = el('input');
      i.type = 'date';
      i.value = filtro[chave] ?? '';
      i.max = new Date().toISOString().slice(0, 10);
      i.addEventListener('change', () => {
        filtro[chave] = i.value || null;
        if (filtro.de && filtro.ate && filtro.de <= filtro.ate) { salvarFiltro(); carregarVisaoGeral(); }
      });
      l.append(i);
      return l;
    };
    datas.append(mk('de', 'De'), mk('ate', 'Até'));
    c.append(datas);
  }

  const comp = el('button', `vg-chip vg-chip--comparar${filtro.comparar ? ' is-ativo' : ''}`,
    filtro.comparar ? 'Comparando com o período anterior' : 'Comparar com o período anterior');
  comp.type = 'button';
  comp.setAttribute('aria-pressed', filtro.comparar ? 'true' : 'false');
  comp.addEventListener('click', () => { filtro.comparar = !filtro.comparar; salvarFiltro(); carregarVisaoGeral(); });
  c.append(comp);

  const sync = el('span', 'vg-sync');
  sync.append(el('span', 'vg-sync-dot'));
  if (s) sync.dataset.geradoEm = s.gerado_em;
  sync.append(document.createTextNode(s ? `Sincronizado ${relativo(s.gerado_em)}` : 'Carregando…'));
  c.append(sync);

  // Segunda linha: plataforma, produto, família da régua e fulfillment
  const op = s?.filtros?.opcoes ?? opcoesCache;
  if (s?.filtros?.opcoes) opcoesCache = s.filtros.opcoes;
  if (op) {
    const linha2 = el('div', 'vg-filtros-2');
    const sel = (chave, rotulo, todas, itens) => {
      const l = el('label', 'vg-sel');
      l.append(el('span', 'vg-filtro-rotulo', rotulo));
      const x = el('select');
      x.append(new Option(todas, ''));
      for (const [valor, texto] of itens) x.append(new Option(texto, valor));
      x.value = filtro[chave] ?? '';
      if (x.value !== (filtro[chave] ?? '')) x.value = '';
      x.addEventListener('change', () => { filtro[chave] = x.value; salvarFiltro(); carregarVisaoGeral(); });
      l.append(x);
      return l;
    };
    const produtos = op.produtos.filter((p) => p.slug !== '*' && (!filtro.linha || String(p.linha) === String(filtro.linha)));
    linha2.append(
      sel('plataforma', 'Plataforma', 'Todas', op.plataformas.map((x) => [x, x])),
      sel('linha', 'Família da régua', 'Todas', op.linhas.filter((l) => l.linha !== null).map((l) => [String(l.linha), `Linha ${l.linha} · ${String(l.nomes).split(', ').filter((x) => x !== 'your order').slice(0, 2).join(', ')}`])),
      sel('produto', 'Produto', 'Todos', produtos.map((p) => [p.slug, p.nome])),
      sel('fulfillment', 'Fulfillment', 'Todos', [['redrock', 'Red Rock'], ['fullstack', 'FullStack']]),
    );
    if (filtro.plataforma || filtro.linha || filtro.produto || filtro.fulfillment) {
      const limpar = el('button', 'btn vg-limpar', 'Limpar filtros');
      limpar.type = 'button';
      limpar.addEventListener('click', () => { Object.assign(filtro, { plataforma: '', linha: '', produto: '', fulfillment: '' }); salvarFiltro(); carregarVisaoGeral(); });
      linha2.append(limpar);
    }
    c.append(linha2);
  }
}

/* ══════════════════════════════  utilidades  ═══════════════════════════════ */

const ROTULO_AREA = {
  entrega: 'Entrega', produto: 'Produto', codigo_rastreio: 'Código de rastreio', pagamento: 'Pagamento',
  atendimento: 'Atendimento', anuncio_informacao: 'Anúncio/informação', outro: 'Outro', sem_area: 'Sem área',
};
const rotularArea = (v) => ROTULO_AREA[v] ?? v;

/** Reúne itens de mesmo rótulo (P3: "Arrependimento (legado)" e o novo são o mesmo motivo). */
function agruparPorRotulo(itens, campo, rotular) {
  const soma = new Map();
  for (const i of itens) {
    const r = rotular(i[campo]).replace(/\s*\(legado\)/i, '');
    soma.set(r, (soma.get(r) ?? 0) + i.total);
  }
  return [...soma].map(([rotulo, total]) => ({ rotulo, total }));
}

const dDesde = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—');
const rotuloPeriodo = (s) => s.periodo.rotulo.toLowerCase();

function semBase(s, chave) {
  return el('p', 'vg-card-nota', `Sem base anterior comparável — medido desde ${dDesde(s.periodo.desde[chave])}.`);
}

/** Variação só entra se a comparação está ligada e a janela anterior é confiável. */
function comVariacao(s, chave, atual, anterior, opts) {
  if (!s.periodo.comparar) return null;
  if (chave && !s.periodo.comparavel[chave]) return semBase(s, chave);
  return variacao(atual, anterior, opts);
}

const tomFaixa = (v, ok, limite) => (v <= ok ? 'bom' : (v <= limite ? 'medio' : 'ruim'));

const usd = (v) => (v >= 1_000_000 ? `US$ ${dec1(v / 1_000_000)} mi` : `US$ ${n(Math.round(v))}`);

/** E3: participação de cada plataforma nos pedidos x nos clientes que falaram com o CS. */
function pareado(linhas) {
  const w = el('div', 'vg-par');
  for (const l of linhas) {
    const r = el('div', 'vg-par-linha');
    const gap = (l.pct_pedidos ?? 0) - (l.pct_contatos ?? 0);
    r.append(el('span', 'vg-par-rot', l.plataforma));
    const barras = el('div', 'vg-par-barras');
    for (const [chave, pct, txt] of [['ped', l.pct_pedidos, `${pctTxt(l.pct_pedidos, 0)}% dos pedidos`], ['cont', l.pct_contatos, `${pctTxt(l.pct_contatos, 0)}% dos contatos`]]) {
      const b = el('div', `vg-par-barra vg-par-barra--${chave}`);
      b.style.width = `${Math.max(1.5, (pct ?? 0) * 100)}%`;
      barras.append(b, el('span', 'vg-par-txt', txt));
    }
    r.append(barras);
    if (gap > 0.2) r.append(el('span', 'vg-tag', 'fora do alcance'));
    w.append(r);
  }
  const leg = el('p', 'vg-card-nota', '% dos pedidos (SendTrace) contra % dos clientes que falaram com o CS. Diferença acima de 20 pontos é alerta.');
  w.append(leg);
  return w;
}

/** Lista de taxas com barra (C3 e C4). itens: [{ rotulo, valor, texto, sub }] */
function listaTaxas(itens, max) {
  const ul = el('ul', 'sup-ranking');
  for (const it of itens) {
    const li = el('li', 'sup-item');
    li.append(el('span', 'sup-item-rotulo', it.rotulo), el('span', 'sup-item-num', it.texto));
    const barra = el('span', 'sup-item-barra');
    const cheio = el('span');
    cheio.style.width = `${max > 0 ? Math.max(2, (it.valor / max) * 100) : 0}%`;
    barra.append(cheio);
    li.append(barra, el('span', 'sup-item-sub', it.sub));
    ul.append(li);
  }
  return ul;
}

/* ═══════════════════════════════  alertas  ═══════════════════════════════ */

function renderAlertas(s) {
  const c = $('vg-alertas');
  if (!c) return;
  c.replaceChildren();
  const lista = [...(s.alertas ?? [])];
  // Sem 3 alertas de regra, completa com o insight mais grave das outras abas.
  const st = s.status;
  if (lista.length < 3 && st && st.nivel && st.nivel !== 'info' && st.texto) {
    lista.push({ nivel: st.nivel, titulo: st.texto, texto: st.aba ? `Vem de ${st.rotulo_aba}.` : '', aba: st.aba, rotulo_aba: st.rotulo_aba });
  }
  if (!lista.length) {
    const ok = el('div', 'vg-alerta vg-alerta--ok');
    ok.append(el('span', 'vg-alerta-dot'), el('div', 'vg-alerta-corpo'));
    ok.lastChild.append(el('b', '', 'Nenhum alerta agora.'),
      el('p', '', 'Tudo dentro da referência. Os alertas comparam com a média das 4 semanas anteriores, nunca com o dia anterior.'));
    c.append(ok);
    return;
  }
  for (const a of lista) {
    const w = el('div', `vg-alerta vg-alerta--${a.nivel === 'alerta' ? 'alerta' : 'atencao'}`);
    w.append(el('span', 'vg-alerta-dot'));
    const corpo = el('div', 'vg-alerta-corpo');
    corpo.append(el('b', '', a.titulo));
    if (a.texto) corpo.append(el('p', '', a.texto));
    w.append(corpo);
    const alvo = a.alvo ? $(`vg-bloco-${a.alvo}`) : null;
    if (alvo || a.aba) {
      const b = el('button', 'btn vg-alerta-ir', a.aba ? `Ver em ${a.rotulo_aba} →` : 'Ver bloco →');
      b.type = 'button';
      b.addEventListener('click', () => (a.aba ? $(`aba-btn-${a.aba}`)?.click() : alvo.scrollIntoView({ behavior: 'smooth', block: 'start' })));
      w.append(b);
    }
    c.append(w);
  }
}

/* ═════════════════════════  A · Resultado (prévia)  ═════════════════════════ */

function blocoA(s) {
  const a = s.a;
  const taxa = razao(a.reembolsos, a.pedidos);
  const taxaAnt = razao(a.reembolsos_ant, a.pedidos_ant);
  const cb = razao(a.chargebacks, a.pedidos);
  const cbAnt = razao(a.chargebacks_ant, a.pedidos_ant);
  const serie = a.serie.map((r) => r.reemb);
  const cm = a.curva_maduro;
  const coorte = cm
    ? `Por coorte (pedidos desde ${dDesde(s.periodo.desde.reembolso)}): ${pctTxt(razao(cm.reemb, cm.expostos))}% reembolsaram até o D${cm.dia} (${n(cm.reemb)} de ${n(cm.expostos)} pedidos com pelo menos ${cm.dia} dias).`
    : null;

  const c1 = card({
    codigo: 'R1', span: 4, titulo: 'Reembolso no período', tag: 'prévia',
    valor: pctTxt(taxa), unidade: '% dos pedidos',
    tom: taxa === null ? 'neutro' : tomFaixa(taxa * 100, 10, 18),
    sub: `${n(a.reembolsos)} reembolsos ÷ ${n(a.pedidos)} pedidos recebidos · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'reembolso', taxa, taxaAnt, { pp: true, menorMelhor: true }),
    viz: serie.length > 1 ? sparkline(serie, { cor: 'var(--st-travado)' }) : null,
    ref: 'Meta do CS: até 10% em D30 · limite 18%.',
    nota: `${coorte ? `${coorte} ` : ''}O D30 oficial só fecha quando a 1ª coorte completar 30 dias (${dDesde(new Date(new Date(s.periodo.desde.reembolso).getTime() + 30 * 86_400_000))}).`,
  });
  const c2 = card({
    codigo: 'R2', span: 4, titulo: 'Chargeback no período', tag: 'prévia',
    valor: pctTxt(cb), unidade: '% dos pedidos',
    tom: cb === null ? 'neutro' : (cb * 100 < 0.5 ? 'bom' : (cb * 100 <= 0.9 ? 'medio' : 'ruim')),
    sub: `${n(a.chargebacks)} chargebacks ÷ ${n(a.pedidos)} pedidos recebidos · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'reembolso', cb, cbAnt, { pp: true, menorMelhor: true }),
    viz: bullet({ valor: (cb ?? 0) * 100, max: 1.2, atencao: 0.5, limite: 0.9, tom: cb === null ? 'neutro' : (cb * 100 < 0.5 ? 'bom' : (cb * 100 <= 0.9 ? 'medio' : 'ruim')) }),
    ref: 'Atenção 0,5% · limite 0,9%.',
  });
  const v = a.valor;
  const c3 = card({
    codigo: 'R3', span: 4, titulo: 'Valor reembolsado', tag: 'prévia',
    valor: usd(v.valor_reemb), unidade: 'em reembolsos',
    tom: 'neutro',
    sub: `${n(v.reemb_com_valor)} de ${n(v.reemb)} reembolsos com valor conhecido · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'reembolso', v.valor_reemb, v.valor_reemb_ant, { menorMelhor: true }),
    viz: el('p', 'vg-card-sub', `${pctTxt(razao(v.valor_reemb, v.valor_pedidos), 1)}% do valor dos pedidos do período (${n(v.pedidos_com_valor)} pedidos com valor). Ticket médio ${usd(v.ticket_medio)}.`),
    ref: 'Referência: vs período anterior.',
    nota: 'É um piso: o valor vem do rastreio e só existe para pedidos da Red Rock e da FullStack. O valor exato de cada venda passa a ser guardado quando o registro dos eventos das plataformas for ligado no n8n.',
  });
  return bloco({
    id: 'vg-bloco-a', letra: 'A', titulo: 'Resultado', pergunta: 'Estamos perdendo dinheiro?',
    fonte: 'Prévia com os eventos das plataformas no SendTrace — o dash não está ligado',
    pendencias: 'R4 (receita preservada pelo CS) precisa do registro da oferta feita e do valor concedido (P10). O chat já marca “reembolso evitado”, mas ainda sem casos no período.',
  }, [c1, c2, c3]);
}

/* ═════════════════════════  B · Eficácia do CS  ═════════════════════════════ */

function blocoB(s) {
  const e = s.b.e4;
  const taxa = razao(e.ia, e.resolvidos);
  const taxaAnt = razao(e.ia_ant, e.resolvidos_ant);
  const c4 = card({
    codigo: 'E4', span: 4, titulo: 'Resolvido só pela IA', tag: 'aprox.',
    valor: pctTxt(taxa, 0), unidade: '% dos tickets resolvidos',
    tom: taxa === null ? 'neutro' : (taxa >= 0.7 ? 'bom' : (taxa >= 0.4 ? 'medio' : 'ruim')),
    sub: `${n(e.ia)} de ${n(e.resolvidos)} tickets resolvidos foram concluídos pela IA · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'ia', taxa, taxaAnt, { pp: true, menorMelhor: false }),
    viz: bullet({ valor: (taxa ?? 0) * 100, max: 100, meta: 70, tom: taxa !== null && taxa >= 0.7 ? 'bom' : 'medio', rotulos: true }),
    ref: 'Meta sugerida: 70%.',
    nota: 'O registro de quem fechou cada ticket (IA ou humano) começa quando for ligado. Até lá vale a assinatura do fluxo da IA.',
  });

  const e1 = s.b.e1;
  const semC = razao(e1.sem_contato, e1.total);
  const semCAnt = razao(e1.sem_contato_ant, e1.total_ant);
  const c1 = card({
    codigo: 'E1', span: 4, titulo: 'Reembolsos sem contato prévio', tag: 'prévia',
    valor: pctTxt(semC, 0), unidade: '% dos reembolsos',
    tom: semC === null ? 'neutro' : (semC <= 0.5 ? 'bom' : (semC <= 0.7 ? 'medio' : 'ruim')),
    sub: `${n(e1.sem_contato)} de ${n(e1.total)} clientes reembolsaram sem nunca falar com o CS antes · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'reembolso', semC, semCAnt, { pp: true, menorMelhor: true }),
    viz: empilhada([
      { rotulo: 'Sem contato', valor: e1.sem_contato, tom: 5 },
      { rotulo: 'Com contato', valor: e1.total - e1.sem_contato, tom: 1 },
    ]),
    ref: 'Referência: tendência de queda.',
    nota: 'Contato = e-mail ou chat do cliente antes da data do estorno.',
  });

  const e2 = s.b.e2;
  const ret = razao(e2.retidos, e2.com_pedido);
  const c2 = card({
    codigo: 'E2', span: 4, titulo: 'Taxa de retenção', tag: 'prévia',
    valor: pctTxt(ret, 0), unidade: '% de quem pediu',
    tom: ret === null ? 'neutro' : (ret >= 0.4 ? 'bom' : 'medio'),
    sub: `${n(e2.retidos)} de ${n(e2.com_pedido)} clientes que pediram reembolso por e-mail não foram reembolsados até agora · desde ${dDesde(s.periodo.desde.reembolso)}`,
    viz: bullet({ valor: (ret ?? 0) * 100, max: 100, meta: 40, tom: ret !== null && ret >= 0.4 ? 'bom' : 'medio' }),
    ref: 'Meta sugerida: 40%.',
    nota: 'Não prova que o CS reteve: é quem pediu e ainda não foi reembolsado (pode ainda estar a caminho). Falta registrar a oferta feita (P10).',
  });

  const pizza = el('div', 'vg-pizza');
  const plat = topMaisOutros(s.b.plataformas, 'plataforma_origem', rotularPlataforma);
  const c5 = card({
    codigo: null, titulo: 'Clientes por plataforma', span: 6,
    sub: 'Central de e-mail da IA · todos os períodos.',
    viz: pizza,
  });
  queueMicrotask(() => desenharPizza(pizza, plat, { tooltip, unidade: 'clientes' }));

  const c3 = card({
    codigo: 'E3', span: 6, titulo: 'Cobertura por plataforma', tag: 'prévia',
    sub: `Quem compra em cada plataforma contra quem fala com o CS · ${rotuloPeriodo(s)}`,
    viz: pareado(s.b.e3),
  });
  return bloco({
    id: 'vg-bloco-b', letra: 'B', titulo: 'Eficácia do CS', pergunta: 'O CS teve chance de agir antes do reembolso?',
    fonte: 'Fonte: SendTrace (e-mails, chat e eventos das plataformas)',
  }, [c4, c1, c2, c5, c3]);
}

/* ═════════════════════════  C · Fila e operação  ════════════════════════════ */

const FAIXAS_IDADE = ['0–2 dias', '3–7 dias', '8–14 dias', '15+ dias'];

function blocoC(s) {
  const c = s.c;
  const f1 = c.f1;
  const nun = f1.nao_iniciado.reduce((a, b) => a + b, 0);
  const abe = f1.em_aberto.reduce((a, b) => a + b, 0);
  const velhos = f1.nao_iniciado[3] + f1.em_aberto[3];
  const cartaoF1 = card({
    codigo: 'F1', span: 6, titulo: 'Backlog por idade',
    valor: n(f1.total), unidade: 'tickets sem resolução', tom: velhos > 0 ? 'ruim' : 'bom',
    sub: `${n(nun)} nunca abertos (${pctTxt(razao(nun, f1.total), 0)}%) · ${n(abe)} em aberto · agora`,
    viz: (() => {
      const w = el('div', 'vg-emp-duplo');
      const seg = (arr) => arr.map((v, i) => ({ rotulo: FAIXAS_IDADE[i], valor: v, tom: i + 1 }));
      w.append(empilhada(seg(f1.nao_iniciado), { titulo: 'Nunca abertos', legenda: false }),
        empilhada(seg(f1.em_aberto), { titulo: 'Em aberto', legenda: true }));
      return w;
    })(),
    ref: 'Referência: zero tickets com mais de 7 dias — depois disso o pico de reembolso já passou.',
  });

  // F2 — entradas x resolvidos por dia
  const serie = c.f2.serie;
  const tot = serie.reduce((a, r) => ({ e: a.e + r.entradas, r: a.r + r.resolvidos }), { e: 0, r: 0 });
  const dias = Math.max(1, s.periodo.dias);
  const saldo = (tot.e - tot.r) / dias;
  const grafico = el('div', 'vg-linha');
  const cartaoF2 = card({
    codigo: 'F2', span: 6, titulo: 'Entradas vs resolvidos por dia',
    valor: s.periodo.serie ? `${saldo >= 0 ? '+' : '−'}${n(Math.abs(Math.round(saldo)))}` : n(tot.e),
    unidade: s.periodo.serie ? '/dia de saldo' : 'tickets novos',
    tom: s.periodo.serie ? (saldo <= 0 ? 'bom' : 'ruim') : 'neutro',
    sub: s.periodo.serie
      ? `${n(tot.e)} entradas · ${n(tot.r)} resolvidos em ${rotuloPeriodo(s)}. O backlog cresce quando a linha de entrada fica acima.`
      : 'A série diária aparece nos períodos de 2 a 120 dias. Resolução em lote de script fica de fora.',
    viz: s.periodo.serie ? grafico : null,
    ref: 'Referência: saldo menor ou igual a zero.',
  });
  if (s.periodo.serie) {
    queueMicrotask(() => desenharLinha(
      grafico, serie.map((r) => r.dia),
      [{ chave: 'entradas', rotulo: 'Entradas', cor: 7, pontos: serie.map((r) => r.entradas) },
        { chave: 'resolvidos', rotulo: 'Resolvidos', cor: 0, pontos: serie.map((r) => r.resolvidos) }],
      { altura: 190, rotuloEixoX: (d) => dia(`${d}T12:00:00`), tooltip, unidade: 'tickets' },
    ));
  }

  // F3 — tempo até resolver: IA x humano (mediana ● e P90 ○) + por área (RETIRAR DASH)
  const at = c.f3.atual;
  const an = c.f3.anterior;
  const linha = (rotulo, chave, grupo, chaveCob) => {
    const x = at[chave];
    const y = an[chave];
    return {
      rotulo, grupo, mediana: x?.mediana_h ?? null, p90: x?.p90_h ?? null, casos: x?.casos ?? 0,
      variacao: x && y && s.periodo.comparar && (!chaveCob || s.periodo.comparavel[chaveCob])
        ? variacao(x.mediana_h, y.mediana_h, { menorMelhor: true }) : null,
    };
  };
  const cartaoF3 = card({
    codigo: 'F3', span: 12, titulo: 'Tempo até resolver: IA vs humano', tom: 'neutro',
    sub: `Mediana e P90, em ${rotuloPeriodo(s)}. IA = fluxo automático de e-mail; humano = Suporte Escalado. Casos criados ou fechados em lote por script ficam de fora.`,
    viz: (() => {
      const w = el('div');
      w.append(dumbbell([
        linha('CS IA · 1ª resposta', 'ia_primeira', 'ia'),
        linha('CS IA · até escalar pro humano', 'ia_escala', 'ia'),
        linha('CS IA · até concluir sozinha', 'ia_conclui', 'ia', 'ia'),
        linha('CS Humano · até pegar o caso', 'humano_pega', 'humano'),
        linha('CS Humano · até resolver', 'humano_resolve', 'humano'),
      ]));
      w.append(tabelaPorArea(c.f3.por_area));
      return w;
    })(),
    ref: 'Referência: 1ª resposta humana em menos de 24 h.',
    nota: '“Até pegar o caso” é o momento da 1ª ação de uma pessoa no caso (mover no kanban, nota, data de entrega); movimentos feitos por automação não contam. Antes de 21/09 só entram casos com nota humana ou movidos para Iniciado/Em análise — por isso a base é menor no passado.',
  });

  // F4 — escalados pendentes
  const f4 = c.f4;
  const parados = f4.d3_7 + f4.mais_7d;
  const cartaoF4 = card({
    codigo: 'F4', span: 6, titulo: 'Escalados pendentes', valor: n(f4.total), unidade: 'casos em aberto',
    tom: parados > 0 ? 'ruim' : 'bom',
    sub: `${n(parados)} há mais de 3 dias · agora`,
    viz: empilhada([
      { rotulo: 'até 1 dia', valor: f4.ate_1d, tom: 1 }, { rotulo: '1–3 dias', valor: f4.d1_3, tom: 2 },
      { rotulo: '3–7 dias', valor: f4.d3_7, tom: 4 }, { rotulo: '7+ dias', valor: f4.mais_7d, tom: 5 },
    ]),
    ref: 'Referência: zero casos com mais de 3 dias.',
  });

  // F5 — reabertura
  const f5 = c.f5;
  const taxaReab = razao(f5.reabertos, f5.resolvidos);
  const cartaoF5 = card({
    codigo: 'F5', span: 6, titulo: 'Taxa de reabertura', valor: pctTxt(taxaReab), unidade: '%',
    tom: taxaReab === null ? 'neutro' : (taxaReab < 0.05 ? 'bom' : (taxaReab < 0.1 ? 'medio' : 'ruim')),
    sub: `${n(f5.reabertos)} de ${n(f5.resolvidos)} tickets resolvidos voltaram · acumulado`,
    viz: bullet({ valor: (taxaReab ?? 0) * 100, max: 15, meta: 5, tom: taxaReab !== null && taxaReab < 0.05 ? 'bom' : 'medio' }),
    ref: 'Referência: abaixo de 5%.',
    nota: 'Acumulado: a data da reabertura não é gravada, então não há comparação por período.',
  });

  return bloco({
    id: 'vg-bloco-c', letra: 'C', titulo: 'Fila e operação', pergunta: 'A fila está sob controle?',
    fonte: 'Fonte: SendTrace · estado atual + fluxo no período',
  }, [cartaoF1, cartaoF2, cartaoF3, cartaoF4, cartaoF5]);
}

function tabelaPorArea(linhas) {
  const d = el('details', 'vg-porarea');
  d.append(el('summary', '', 'Ver por área do problema'));
  const porArea = new Map();
  for (const l of linhas) {
    if (!porArea.has(l.area)) porArea.set(l.area, {});
    porArea.get(l.area)[l.medida] = l;
  }
  const areas = [...porArea.keys()].sort((a, b) => (porArea.get(b).humano_resolve?.mediana_h ?? -1) - (porArea.get(a).humano_resolve?.mediana_h ?? -1));
  const env = el('div', 'tabela-envolve');
  const t = el('table', 'tabela tabela--compacta');
  const cab = el('tr');
  for (const [txt, num] of [['Área', false], ['CS IA · até escalar', true], ['CS IA · até concluir', true], ['CS Humano · até resolver', true]]) {
    const th = el('th', num ? 'num' : '', txt);
    cab.append(th);
  }
  const thead = el('thead'); thead.append(cab);
  const tb = el('tbody');
  for (const a of areas) {
    const tr = el('tr');
    tr.append(el('td', '', rotularArea(a)));
    for (const m of ['ia_escala', 'ia_conclui', 'humano_resolve']) {
      const x = porArea.get(a)[m];
      const td = el('td', 'num');
      if (x) {
        td.append(el('b', '', duracaoH(x.mediana_h)));
        td.append(el('span', 'sup-item-sub', `P90 ${duracaoH(x.p90_h)} · ${n(x.casos)} caso${x.casos === 1 ? '' : 's'}`));
        td.lastChild.style.display = 'block';
      } else td.textContent = '—';
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(thead, tb);
  env.append(t);
  d.append(env);
  return d;
}

/* ═════════════════════════════  D · Causa  ═════════════════════════════════ */

function blocoD(s) {
  const d = s.d;
  const motivos = agruparPorRotulo(d.c2.motivos.map((m) => ({ motivo_devolucao: m.motivo_devolucao, total: m.total })), 'motivo_devolucao', rotularMotivo)
    .filter((m) => m.total > 0);
  const totalMot = motivos.reduce((a, m) => a + m.total, 0);
  const pizza = el('div', 'vg-pizza');
  const cMot = card({
    codigo: 'C2', span: 8, titulo: 'Motivos de reembolso',
    sub: `${n(totalMot)} e-mails de devolução ou troca com motivo · ${rotuloPeriodo(s)} · “Arrependimento (legado)” já reunido com “Arrependimento”.`,
    viz: pizza,
    nota: s.periodo.comparar && !s.periodo.comparavel.motivos
      ? `Sem comparação com o período anterior: a lista atual de motivos só existe desde ${dDesde(s.periodo.desde.motivos)}.` : null,
  });
  queueMicrotask(() => desenharPizza(
    pizza, topMaisOutros(motivos.map((m) => ({ ...m, k: m.rotulo })), 'k', (x) => x),
    { tooltip, unidade: 'e-mails', textoVazio: 'Sem e-mails de devolução no período.' },
  ));

  const c5 = d.c5;
  const taxa = razao(c5.neg, c5.tot);
  const taxaAnt = razao(c5.neg_ant, c5.tot_ant);
  const serie = d.c5.serie.map((r) => (r.tot > 0 ? r.neg / r.tot : null));
  const cSent = card({
    codigo: 'C5', span: 4, titulo: 'Sentimento negativo na base', valor: pctTxt(taxa, 0), unidade: '% dos e-mails',
    tom: taxa === null ? 'neutro' : (taxa < 0.3 ? 'bom' : (taxa < 0.45 ? 'medio' : 'ruim')),
    sub: `${n(c5.neg)} de ${n(c5.tot)} e-mails classificados · negativo ${n(c5.neg - c5.muito_neg)} + muito negativo ${n(c5.muito_neg)} · ${n(c5.sem_class)} sem classificação`,
    extra: comVariacao(s, null, taxa, taxaAnt, { pp: true, menorMelhor: true }),
    viz: serie.filter((x) => x !== null).length > 1 ? sparkline(serie, { cor: 'var(--st-atrasado)' }) : null,
    ref: 'Referência: tendência de queda.',
  });

  // C1 — curva de reembolso por coorte, com as etapas da régua
  const c1 = d.c1;
  const pontos = c1.curva.filter((c) => c.expostos >= c1.min_coorte);
  const grafico = el('div', 'vg-linha');
  const etapas = c1.marcadores.map((m) => `${m.nome} · D${Math.round(m.offset_h / 24)}`).join('  ·  ');
  const cCurva = card({
    codigo: 'C1', span: 8, titulo: 'Curva de reembolso por coorte, com a régua', tag: 'prévia',
    sub: pontos.length > 1
      ? `% acumulado dos pedidos reembolsados por dia desde a compra · pedidos desde ${dDesde(c1.desde)} (só entra o dia em que há ao menos ${c1.min_coorte} pedidos com essa idade).`
      : 'Ainda não há pedidos suficientes com idade para desenhar a curva.',
    viz: pontos.length > 1 ? grafico : null,
    ref: etapas ? `Etapas da régua: ${etapas}` : null,
    nota: 'O SendTrace só registra reembolso completo desde 09/09, então a curva cresce um dia por dia até fechar os 30. Meta do CS: abaixo de 10% em D30.',
  });
  if (pontos.length > 1) {
    queueMicrotask(() => desenharLinha(
      grafico, pontos.map((c) => `D${c.dia}`),
      [{ chave: 'reemb', rotulo: 'Reembolsado (% acumulado)', cor: 7, pontos: pontos.map((c) => (c.expostos ? (c.reemb / c.expostos) * 100 : null)) }],
      { altura: 190, tooltip, unidade: '%', formatarValor: (v) => `${dec1(v)}%` },
    ));
  }

  // C4 — reembolso por etapa do funil
  const rotEtapa = { front: 'Front-end', upsell: 'Upsell', downsell: 'Downsell' };
  const et = ['front', 'upsell', 'downsell'].map((k) => d.c4.etapas.find((x) => x.etapa === k)).filter(Boolean)
    .map((x) => ({ rotulo: rotEtapa[x.etapa], valor: razao(x.reembolsadas, x.compras) ?? 0, texto: `${pctTxt(razao(x.reembolsadas, x.compras), 1)}%`, sub: `${n(x.reembolsadas)} de ${n(x.compras)} compras já reembolsadas` }));
  const cFunil = card({
    codigo: 'C4', span: 4, titulo: 'Reembolso por etapa do funil', tag: 'prévia',
    sub: `Compras de ${rotuloPeriodo(s)} já reembolsadas até agora, por etapa.`,
    viz: et.length ? listaTaxas(et, Math.max(...et.map((x) => x.valor), 0.01)) : el('p', 'vazio-suave', 'Sem compras no período.'),
    ref: 'Base: o front-end.',
    nota: d.c4.parcial ? 'O filtro de produto e de família não vale para upsell e downsell (esses registros não guardam o produto do funil).' : null,
  });

  // C3 — reclamações a cada 100 pedidos, por produto
  const prod = d.c3.map((x) => ({
    rotulo: x.produto, valor: razao(x.reclamantes, x.pedidos) ?? 0,
    texto: `${dec1((razao(x.reclamantes, x.pedidos) ?? 0) * 100)} a cada 100`,
    sub: `${n(x.reclamantes)} clientes reclamaram · ${n(x.pedidos)} pedidos no período`,
  }));
  const cProd = card({
    codigo: 'C3', span: 12, titulo: 'Reclamações a cada 100 pedidos, por produto', tag: 'prévia',
    sub: `Clientes que abriram devolução, troca ou reclamação ÷ pedidos do produto · ${rotuloPeriodo(s)}. O produto é o do pedido do cliente, não o texto do e-mail. Produtos com menos de 30 pedidos ficam de fora.`,
    viz: prod.length ? listaTaxas(prod, Math.max(...prod.map((x) => x.valor), 0.01)) : el('p', 'vazio-suave', 'Sem produtos com volume suficiente no período.'),
    ref: 'Referência: média da operação.',
  });

  return bloco({
    id: 'vg-bloco-d', letra: 'D', titulo: 'Causa', pergunta: 'Por que o cliente pede reembolso?',
    fonte: 'Fonte: SendTrace (e-mails classificados pela IA, pedidos e funil)',
  }, [cMot, cSent, cCurva, cFunil, cProd]);
}

/* ══════════════════════════  E · Saúde técnica  ═══════════════════════════ */

function blocoE(s) {
  const { s1, s2, s3 } = s.e;
  const taxaS1 = razao(s1.regua_erro, s1.regua_total);
  const c1 = card({
    codigo: 'S1', span: 4, titulo: 'Falha de envio', valor: pctTxt(taxaS1), unidade: '%',
    tom: taxaS1 === null ? 'neutro' : (taxaS1 < 0.01 ? 'bom' : 'ruim'),
    sub: `${n(s1.regua_erro)} de ${n(s1.regua_total)} disparos ativos da régua · ${n(s1.smtp_erro)} erros de envio nas respostas da IA (${rotuloPeriodo(s)})`,
    ref: 'Limite: 1%.',
  });
  const taxaS2 = razao(s2.com_ficha, s2.ativos);
  const c2 = card({
    codigo: 'S2', span: 4, titulo: 'Ficha de produto para a IA', valor: `${n(s2.com_ficha)}/${n(s2.ativos)}`, unidade: 'produtos',
    tom: taxaS2 === null ? 'neutro' : (taxaS2 >= 1 ? 'bom' : (taxaS2 >= 0.6 ? 'medio' : 'ruim')),
    sub: 'produtos ativos com ficha preenchida (rótulo, ingredientes, garantia) · agora',
    viz: bullet({ valor: (taxaS2 ?? 0) * 100, max: 100, meta: 100, tom: taxaS2 >= 1 ? 'bom' : 'medio', rotulos: false }),
    ref: 'Meta: 100%.',
  });
  const taxaS3 = razao(s3.com_defeito, s3.total);
  const c3 = card({
    codigo: 'S3', span: 4, titulo: 'Anexos com defeito', valor: pctTxt(taxaS3), unidade: '%', tom: 'neutro',
    sub: `${n(s3.com_defeito)} de ${n(s3.total)} imagens analisadas · acumulado (os anexos não têm data própria)`,
    ref: 'Sem meta definida.',
  });
  return bloco({
    id: 'vg-bloco-e', letra: 'E', titulo: 'Saúde técnica', pergunta: 'Algo técnico está quebrado?',
    fonte: 'Faixa compacta · só fica vermelha quando passa do limite',
  }, [c1, c2, c3]);
}

/* ═══════════════════════  F · Rastreio de encomendas  ══════════════════════ */

function blocoF(s) {
  const f = s.f;
  const st = f.status;
  const seg = (rotulo, chave, tom) => ({
    rotulo, valor: st[chave] ?? 0, tom, ao: () => abrirRastreioComStatus(chave),
  });
  const abrirAba = (status) => { $('aba-btn-rastreio')?.click(); abrirRastreioComStatus(status); };
  const c1 = card({
    codigo: 'T1', span: 12, titulo: 'Onde estão os pedidos agora',
    valor: n(f.total), unidade: 'pedidos consultados',
    sub: 'Fulfillment Red Rock e FullStack · atualização por script, não em tempo real. Clique num segmento para abrir a lista.',
    viz: empilhada([
      { ...seg('Aguardando envio', 'pending', 3), ao: () => abrirAba('pending') },
      { ...seg('Em trânsito', 'shipped', 2), ao: () => abrirAba('shipped') },
      { ...seg('Entregue', 'delivered', 1), ao: () => abrirAba('delivered') },
      { ...seg('Sem rastreio', 'nao_encontrado', 5), ao: () => abrirAba('nao_encontrado') },
      { ...seg('Cancelado', 'cancelled', 4), ao: () => abrirAba('cancelled') },
    ]),
  });
  const p = f.aguardando_faixas;
  const pend = st.pending ?? 0;
  const c2 = card({
    codigo: 'T2', span: 4, titulo: 'Aguardando envio', valor: n(pend), unidade: 'pedidos', tom: p[2] > 0 ? 'ruim' : 'bom',
    sub: `${pctTxt(razao(pend, f.total), 1)}% dos pedidos · recebidos, ainda sem código de rastreio · agora`,
    viz: empilhada([
      { rotulo: '0–2 dias', valor: p[0], tom: 1 }, { rotulo: '3–5 dias', valor: p[1], tom: 3 }, { rotulo: '6+ dias', valor: p[2], tom: 5 },
    ]),
    ref: 'Referência: zero pedidos com 6+ dias.',
  });
  const t3 = f.t3;
  const medH = t3.mediana_h;
  const c3 = card({
    codigo: 'T3', span: 4, titulo: 'Prazo da compra até a entrega', valor: medH === null ? '—' : duracaoH(medH), unidade: 'mediana',
    tom: medH === null ? 'neutro' : (medH <= 168 ? 'bom' : (medH <= 240 ? 'medio' : 'ruim')),
    sub: `P90 ${t3.p90_h === null ? '—' : duracaoH(t3.p90_h)} · ${n(t3.entregues)} entregas em ${rotuloPeriodo(s)}` +
      (t3.por_plataforma.length ? ` · ${t3.por_plataforma.filter((x) => x.n >= 20).map((x) => `${x.plataforma} ${duracaoH(x.mediana_h)}`).join(' · ')}` : ''),
    extra: s.periodo.comparar ? variacao(t3.mediana_h, t3.mediana_h_ant, { menorMelhor: true }) : null,
    viz: empilhada([
      { rotulo: 'até 3 dias', valor: t3.faixas[0], tom: 1 }, { rotulo: '3–7 dias', valor: t3.faixas[1], tom: 2 },
      { rotulo: '7–15 dias', valor: t3.faixas[2], tom: 4 }, { rotulo: '15+ dias', valor: t3.faixas[3], tom: 5 },
    ]),
    ref: 'Referência: mediana de até 7 dias.',
  });
  const t4 = f.t4;
  const taxaEnt = razao(t4.entregues, t4.enviados);
  const c4 = card({
    codigo: 'T4', span: 4, titulo: 'Taxa de entrega', valor: pctTxt(taxaEnt, 1), unidade: '%', tom: 'neutro',
    sub: `${n(t4.entregues)} entregues ÷ ${n(t4.enviados)} enviados (em trânsito + entregues) · ${pctTxt(razao(t4.entregues, f.total), 0)}% sobre o total · agora`,
    viz: bullet({ valor: (taxaEnt ?? 0) * 100, max: 100, tom: 'neutro', rotulos: false }),
  });
  const t5 = f.t5;
  const atrasoPct = razao(t5.atrasadas, t5.entregues);
  const c5 = card({
    codigo: 'T5', span: 6, titulo: 'Entregas com mais de 15 dias', valor: pctTxt(atrasoPct, 1), unidade: '%',
    tom: atrasoPct === null ? 'neutro' : (atrasoPct < 0.02 ? 'bom' : 'ruim'),
    sub: `${n(t5.atrasadas)} de ${n(t5.entregues)} entregues em ${rotuloPeriodo(s)} · ${n(t5.transito_15d)} ainda em trânsito há mais de 15 dias`,
    viz: bullet({ valor: (atrasoPct ?? 0) * 100, max: 6, meta: 2, tom: atrasoPct !== null && atrasoPct < 0.02 ? 'bom' : 'ruim' }),
    ref: 'Meta: abaixo de 2%.',
  });
  const t6 = f.t6;
  const nao = razao(t6.nao_encontrado, t6.total);
  const c6 = card({
    codigo: 'T6', span: 6, titulo: 'Cobertura do rastreio', valor: pctTxt(nao, 1), unidade: '% sem rastreio',
    tom: nao === null ? 'neutro' : (nao < 0.02 ? 'bom' : 'ruim'),
    sub: `${n(t6.nao_encontrado)} pedidos não encontrados na Red Rock nem na FullStack ÷ ${n(t6.total)} consultados · agora`,
    viz: bullet({ valor: (nao ?? 0) * 100, max: 8, meta: 2, tom: nao !== null && nao < 0.02 ? 'bom' : 'ruim' }),
    ref: 'Meta: abaixo de 2%.',
  });
  return bloco({
    id: 'vg-bloco-f', letra: 'F', titulo: 'Rastreio de encomendas', pergunta: 'O produto chega antes do reembolso?',
    fonte: 'Fonte: SendTrace (rastreio)',
  }, [c1, c2, c3, c4, c5, c6, cT7(s)]);
}


/** T7 — o cliente pede reembolso antes de receber? Duas curvas no mesmo eixo de dias. */
function cT7(s) {
  const t7 = s.f.t7;
  const antes = razao(t7.antes, t7.reembolsos);
  const antesAnt = razao(t7.antes_ant, t7.reembolsos_ant);
  const pontos = t7.curva.filter((c) => c.expostos_rastreio >= s.d.c1.min_coorte);
  const grafico = el('div', 'vg-linha');
  const c = card({
    codigo: 'T7', span: 12, titulo: 'O cliente pede reembolso antes de receber?', tag: 'prévia',
    valor: pctTxt(antes, 0), unidade: '% dos reembolsos antes da entrega',
    tom: antes === null ? 'neutro' : (antes >= 0.5 ? 'ruim' : 'medio'),
    sub: `${n(t7.antes)} de ${n(t7.reembolsos)} reembolsos foram pedidos antes de o cliente receber o produto (ou sem entrega registrada) · ${rotuloPeriodo(s)}`,
    extra: comVariacao(s, 'reembolso', antes, antesAnt, { pp: true, menorMelhor: true }),
    viz: pontos.length > 1 ? grafico : null,
    ref: 'Referência: tendência de queda. A curva compara, por dia desde a compra, o que já foi reembolsado com o que já foi entregue (pedidos com rastreio).',
  });
  if (pontos.length > 1) {
    queueMicrotask(() => desenharLinha(
      grafico, pontos.map((p) => `D${p.dia}`),
      [{ chave: 'reemb', rotulo: 'Reembolsos já pedidos (%)', cor: 7, pontos: pontos.map((p) => (p.expostos_rastreio ? (p.reemb_rastreio / p.expostos_rastreio) * 100 : null)) },
        { chave: 'ent', rotulo: 'Pedidos entregues (%)', cor: 0, pontos: pontos.map((p) => (p.expostos_rastreio ? (p.entregues_rastreio / p.expostos_rastreio) * 100 : null)) }],
      { altura: 200, tooltip, unidade: '%', formatarValor: (v) => `${dec1(v)}%` },
    ));
  }
  return c;
}

/* ═════════════════════════  G · Risco e save-desk  ═════════════════════════ */

const ROTULO_NIVEL = { critico: 'Crítico', alto: 'Alto', medio: 'Médio', baixo: 'Baixo' };

function blocoG(s) {
  const g = s.g;
  const c1 = card({
    codigo: 'G1', span: 4, titulo: 'Críticos em aberto', valor: n(g.g1.abertos), unidade: 'casos',
    tom: g.g1.abertos > 0 ? 'ruim' : 'bom', tag: 'aprox.',
    sub: `${n(g.g1.abertos)} de ${n(g.g1.criticos)} clientes críticos dos últimos 30 dias estão com ticket aberto · humano pegou o caso em até 2 h em ${n(g.g1.humano_2h)} (${pctTxt(razao(g.g1.humano_2h, g.g1.criticos), 0)}%)`,
    ref: 'Regra: crítico é atendido por humano em até 2 h (meta: 100%).',
    nota: 'O prazo de 2 h usa o 1º toque humano no caso (mover no kanban, nota, data de entrega); automação não conta. Antes de 21/09 a base é menor: só casos com nota humana ou movidos para Iniciado/Em análise. Crítico vem de palavras-chave nos e-mails.',
  });
  const c6 = card({
    codigo: 'G6', span: 4, titulo: 'Relatos de reação adversa', valor: n(g.g6.relatos), unidade: 'clientes',
    tom: g.g6.sem_escalar_abertos > 0 ? 'ruim' : 'bom', tag: 'aprox.',
    sub: `${n(g.g6.escalados_24h)} escalados para humano em até 24 h · ${n(g.g6.escalados)} escalados no total · ${n(g.g6.sem_escalar_abertos)} com ticket aberto e sem escalar · últimos 30 dias`,
    ref: 'Meta: 100% escalados em até 24 h.',
    nota: 'Detecção por palavras-chave (reação alérgica, náusea, tontura, dor no peito…).',
  });
  const c5 = card({
    codigo: 'G5', span: 4, titulo: 'Reincidentes', valor: n(g.g5.clientes), unidade: 'clientes com 2+ devoluções',
    tom: 'neutro',
    sub: `${pctTxt(razao(g.g5.reembolsos_deles, g.g5.reembolsos), 1)}% dos reembolsos de ${rotuloPeriodo(s)} vieram deles (${n(g.g5.reembolsos_deles)} de ${n(g.g5.reembolsos)})`,
    ref: 'Referência: tendência de queda.',
  });
  const nivel = el('div', 'vg-niveis');
  for (const k of ['critico', 'alto', 'medio', 'baixo']) {
    const b = el('span', `vg-nivel vg-nivel--${k}`);
    b.append(el('b', '', n(g.por_nivel[k] ?? 0)), document.createTextNode(` ${ROTULO_NIVEL[k]}`));
    nivel.append(b);
  }
  const fila = card({
    codigo: 'G7', span: 12, titulo: 'Fila de risco do dia', tag: 'aprox.',
    sub: 'Clientes com ticket aberto, ordenados pelo score de risco (0 a 100). Últimos 30 dias de contato.',
    extra: nivel,
    viz: tabelaFila(g.g7),
    nota: 'Score pelos pesos da especificação (disputa +35, reação +30, pede reembolso +20, sentimento +15, reincidente +10, pedido parado +10, sem resposta +5). Depois de 30 dias, comparar com o reembolso real e ajustar os pesos.',
  });
  return bloco({
    id: 'vg-bloco-g', letra: 'G', titulo: 'Risco e save-desk', pergunta: 'Quem precisa de atenção agora?',
    fonte: 'Fonte: SendTrace · risco guardado no ticket, recalculado a cada e-mail novo e a cada 10 min',
    pendencias: 'G2 (salvamento por tipo de oferta), G3 (custo da retenção) e G4 (reembolsos de proteção) dependem do registro da oferta feita e do valor concedido (P10) e do teto de custo da controladoria.',
  }, [c1, c6, c5, fila]);
}

function tabelaFila(fila) {
  if (!fila.length) return el('p', 'vazio-suave', 'Nenhum cliente com ticket aberto e sinal de risco.');
  const env = el('div', 'tabela-envolve');
  const t = el('table', 'tabela tabela--compacta vg-fila');
  const th = el('tr');
  for (const [txt, cls] of [['Score', 'num'], ['Cliente', ''], ['Sinais', ''], ['Pedido', ''], ['Espera', 'num']]) th.append(el('th', cls, txt));
  const thead = el('thead'); thead.append(th);
  const tb = el('tbody');
  for (const r of fila) {
    const tr = el('tr');
    const sc = el('td', 'num');
    sc.append(el('span', `vg-score vg-score--${r.nivel}`, String(r.score)));
    tr.append(sc);
    const cli = el('td');
    cli.append(el('b', '', r.cliente), el('span', 'sup-item-sub', r.email));
    cli.lastChild.style.display = 'block';
    tr.append(cli);
    tr.append(el('td', '', r.sinais.join(' · ')));
    tr.append(el('td', '', r.pedido ?? '—'));
    tr.append(el('td', 'num', r.espera_h >= 48 ? duracaoH(r.espera_h) : `${n(r.espera_h)} h`));
    tb.append(tr);
  }
  t.append(thead, tb);
  env.append(t);
  return env;
}

/* ═══════════════════════════  carregamento  ═════════════════════════════════ */

let carregando = false;
let pendente = false;

export async function carregarVisaoGeral() {
  if (carregando) { pendente = true; return; }
  carregando = true;
  renderFiltros(null);
  const q = new URLSearchParams({ periodo: filtro.periodo, comparar: filtro.comparar ? '1' : '0' });
  if (filtro.periodo === 'custom') { q.set('de', filtro.de); q.set('ate', filtro.ate); }
  for (const k of ['plataforma', 'produto', 'linha', 'fulfillment']) if (filtro[k]) q.set(k, filtro[k]);
  const corpo = $('vg-blocos');
  corpo?.setAttribute('aria-busy', 'true');

  const { ok, dados: s } = await api(`/api/visao-geral?${q}`);
  carregando = false;
  corpo?.removeAttribute('aria-busy');
  if (pendente) { pendente = false; carregarVisaoGeral(); return; }

  if (!ok) {
    const al = $('vg-alertas');
    if (al) {
      al.replaceChildren();
      const w = el('div', 'vg-alerta vg-alerta--alerta');
      w.append(el('span', 'vg-alerta-dot'), el('div', 'vg-alerta-corpo'));
      w.lastChild.append(el('b', '', 'Não consegui carregar a Visão Geral agora.'), el('p', '', 'Tente novamente em instantes.'));
      al.append(w);
    }
    return;
  }

  const sub = $('vg-heroi-sub');
  if (sub) {
    const ativos = Object.entries(s.filtros.aplicados).filter(([, v]) => v).map(([, v]) => v);
    sub.textContent = `${s.periodo.rotulo}${s.periodo.comparar ? ', comparado com o período anterior' : ''}`
      + `${ativos.length ? ` · filtrado por ${ativos.join(', ')}` : ''} · `
      + 'régua, atendimento por IA, tickets, rastreio e risco num só lugar.';
  }
  renderFiltros(s);
  renderAlertas(s);
  corpo?.replaceChildren(blocoA(s), blocoB(s), blocoC(s), blocoD(s), blocoE(s), blocoF(s), blocoG(s));
}

// Atualiza o "Sincronizado há…" sem refazer a consulta.
setInterval(() => {
  const sync = document.querySelector('.vg-sync');
  if (sync && sync.dataset.geradoEm) sync.lastChild.textContent = `Sincronizado ${relativo(sync.dataset.geradoEm)}`;
}, 60_000);

// Primeira carga — mesma mecânica das outras abas: todas ficam no DOM, só
// escondidas, e como Visão Geral é a aba PADRÃO ela precisa de dado já na
// entrada, sem esperar um clique.
carregarVisaoGeral();
