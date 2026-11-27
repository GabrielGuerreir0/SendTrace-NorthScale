/**
 * MONIT-SPPL — Fase 2, blocos da aba Classificação: quadros Q1–Q5 e KPIs (seção 7), rastreios gerados (hoje, ontem, semana), Sem rastreio por plataforma e
 * por fulfillment (clicáveis), "Reembolsos e chargebacks × logística" (recolhido) e a BUSCA em toda a base com o cartão "Fora da lista de pedidos em aberto".
 * Tudo carrega depois do resumo, em paralelo; um bloco que falha não derruba os outros. Todo texto da API entra por textContent.
 */
import { el, fmtData } from './spplComum.js';

const BASE = '/api/rastreio/monit';
let ctx = null; let raiz = null; let tokenBusca = 0;
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const SITUACOES = {
  sem_registro: 'Sem registro no rastreio', cancelado: 'Cancelado', devolvido: 'Devolvido', entregue: 'Entregue', nao_encontrado: 'Não encontrado na fulfillment', sem_codigo: 'Sem código de rastreio',
  codigo_nao_lido: 'Código que o 17Track não lê', aguardando_coleta: 'Aguardando coleta', problema_entrega: 'Problema na entrega', em_transito: 'Em trânsito',
};
const celula = (conteudo, classe) => { const td = document.createElement('td'); if (classe) td.className = classe; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? '—'; return td; };
const rotFul = (f) => ctx.estado.cfg.rotulo_fulfillment[String(f || '').toLowerCase()] ?? f ?? '—';

const carregadores = {};   // id do bloco → função que carrega
const velhos = new Set();   // blocos fechados cujos dados mudaram (carregam ao abrir)
function bloco(id, titulo, carregar, aberto = true) {
  const d = el('details', undefined, 'mon-todo'); d.id = id; d.open = aberto; d.append(el('summary', titulo)); const c = el('div'); c.className = 'mon-corpo-bloco'; d.append(c); raiz.append(d);
  carregadores[id] = carregar; velhos.add(id);
  d.addEventListener('toggle', () => { if (d.open && velhos.has(id)) { velhos.delete(id); carregar(); } });
  return { d, c };
}
function tabela(cabecalho, linhas) {
  const env = el('div', undefined, 'tabela-envolve'); const t = el('table', undefined, 'tabela tabela--larga'); const th = el('thead'); const trh = el('tr');
  for (const h of cabecalho) trh.append(el('th', h)); th.append(trh); const tb = el('tbody'); for (const l of linhas) tb.append(l); t.append(th, tb); env.append(t); return env;
}

export function iniciar(c) {
  ctx = c; raiz = c.raiz; raiz.replaceChildren();
  const busca = el('div'); busca.id = 'mon-busca-card'; raiz.append(busca);
  bloco('mi-quadros', 'Quadros de tempo parado (Q1 a Q5) e totais', quadros, false); bloco('mi-gerados', 'Rastreios gerados (hoje, ontem e nesta semana)', gerados, false);
  bloco('mi-sem', 'Sem rastreio por plataforma e por fulfillment', semRastreio, true); bloco('mi-reemb', 'Reembolsos e chargebacks × logística (clique para abrir)', reembolso, false);
  recarregar();
}

/** Recarrega os blocos ABERTOS; os fechados só carregam quando abertos (os quadros são a consulta mais cara). */
export function recarregar() {
  if (!ctx) return;
  for (const [id, fn] of Object.entries(carregadores)) { if (raiz.querySelector(`#${id}`)?.open) { velhos.delete(id); fn(); } else velhos.add(id); }
}

async function carga(id, caminho, desenhar) {
  const c = raiz.querySelector(`#${id} .mon-corpo-bloco`); c.replaceChildren(el('p', 'carregando…', 'mon-vazio'));
  const r = await ctx.api(`${BASE}/${caminho}`);
  c.replaceChildren(); if (!r.ok) { c.append(el('p', r.dados?.detail ?? 'Não foi possível carregar.', 'mon-vazio')); return; }
  desenhar(c, r.dados);
}

function quadros() {
  carga('mi-quadros', `quadros?${ctx.parametros({ lista: false })}`, (c, d) => {
    const k = d.kpis; const g = el('div', undefined, 'sppl-kpis');
    for (const q of d.quadros) { const b = el('div', undefined, 'sppl-kpi'); b.title = q.regra; if (q.n >= 4 && k[`q${q.n}`] > 0) b.dataset.tom = 'alto'; b.append(el('b', n(k[`q${q.n}`])), el('span', `Q${q.n} · ${q.nome}`), el('small', q.regra, 'sppl-kpi-criterio')); g.append(b); }
    c.append(g);
    const t = el('div', undefined, 'sppl-kpis');
    for (const [v, rot, dica] of [[k.abertos, 'Pedidos em aberto', 'Não cancelados, sem reembolso/chargeback na régua e não entregues.'], [k.fora_monitoramento, 'Fora da régua pós-venda', 'Em aberto sem registro em disparos_pos_venda.'],
      [k.nao_encontrados, 'Não encontrados', 'Em aberto com status não encontrado.'], [k.em_quadro, 'Em algum quadro', 'Pedidos que caíram em Q1 a Q5.'], [k.graves_sem_quadro, 'Graves sem quadro', 'Sem quadro, mas com último status de prioridade P0/P1 em sppl_regras.'],
      [k.corrigidos, 'Quadro diferente da view', 'Aqui contam também eventos do 17Track que chegam só com o status detalhado.'], [k.ocorr_abertas, 'Ocorrências abertas', 'Em sppl_ocorrencias, de pedidos criados desde a data.'], [k.ocorr_vencidas, 'Ocorrências vencidas', 'Abertas com prazo anterior a agora.']]) {
      const b = el('div', undefined, 'sppl-kpi'); b.title = dica; b.append(el('b', n(v)), el('span', rot)); t.append(b);
    }
    c.append(t);
  });
}

function gerados() {
  carga('mi-gerados', 'rastreios-gerados', (c, d) => {
    const linhas = d.itens.map((x) => { const tr = el('tr'); tr.append(celula(rotFul(x.fulfillment)), celula(n(x.hoje)), celula(n(x.ontem)), celula(n(x.semana))); return tr; });
    const tot = el('tr'); tot.style.fontWeight = '600'; tot.append(celula('Total'), celula(n(d.total.hoje)), celula(n(d.total.ontem)), celula(n(d.total.semana))); linhas.push(tot);
    c.append(tabela(['Fulfillment', 'Hoje', 'Ontem', 'Nesta semana (seg a dom)'], linhas), el('p', 'Códigos de rastreio gerados, no horário de Brasília.', 'cartao-sub'));
  });
}

function semRastreio() {
  carga('mi-sem', `sem-rastreio?${ctx.parametros({ lista: false })}`, (c, d) => {
    const classes = ctx.estado.cfg.classes.filter((x) => x.grupo === 'semrastreio');
    const montar = (titulo, mapa, rot, filtro) => {
      const linhas = Object.entries(mapa).sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0)).map(([k, vs]) => {
        const tr = el('tr'); tr.append(celula(rot(k)));
        for (const cl of classes) {
          const v = vs[cl.chave] ?? 0; const b = el('button', n(v), 'btn'); b.type = 'button'; b.disabled = !v;
          b.addEventListener('click', () => { ctx.filtrarPor({ grupo: 'semrastreio', classe: cl.chave }, filtro(k)); }); tr.append(celula(b));
        }
        return tr;
      });
      const w = el('div'); w.append(el('b', titulo), tabela([titulo.split(' ').pop(), ...classes.map((x) => x.nome)], linhas)); return w;
    };
    const g = el('div', undefined, 'mon-grupos'); g.style.gridTemplateColumns = 'repeat(auto-fit, minmax(380px, 1fr))';
    g.append(montar('Por plataforma', d.por_plataforma, (k) => (k ? ({ jvzoo: 'JVZoo', vupim: 'Vupim', buygoods: 'BuyGoods', digistore24: 'DigiStore24' }[k.toLowerCase()] ?? k) : 'Não identificada'), (k) => ({ plataforma: k ? k.toLowerCase() : '__sem' })),
      montar('Por fulfillment', d.por_fulfillment, rotFul, (k) => ({ fulfillment: k })));
    c.append(g);
  });
}

function reembolso() {
  carga('mi-reemb', `reembolso-logistica?${ctx.parametros({ lista: false })}`, (c, d) => {
    const total = d.itens.reduce((s, x) => s + x.pedidos, 0); const max = Math.max(1, ...d.itens.map((x) => x.pedidos));
    c.append(el('p', 'Pedidos com reembolso ou chargeback, por situação logística. "Dias até reembolsar" é a média entre a compra e o reembolso.', 'cartao-sub'));
    const linhas = d.itens.filter((x) => x.pedidos).map((x) => {
      const tr = el('tr'); const barra = el('span', undefined, 'mon-trilho'); const i = el('i'); i.style.width = `${100 * x.pedidos / max}%`; i.style.background = '#8FA3F2'; barra.append(i);
      tr.append(celula(SITUACOES[x.situacao] ?? x.situacao), celula(barra), celula(n(x.reembolsos)), celula(n(x.chargebacks)), celula(total ? `${(100 * x.pedidos / total).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '0%'), celula(x.dias_ate_reembolsar === null ? '—' : n(x.dias_ate_reembolsar)));
      return tr;
    });
    c.append(tabela(['Situação', '', 'Reembolsos', 'Chargebacks', '% do total', 'Dias até reembolsar'], linhas));
  });
}

/** Busca em toda a base (≥ 4 caracteres, espera 600 ms): mostra os pedidos que NÃO estão na lista de pedidos em aberto. Com menos de 4 caracteres o cartão some. */
export async function buscar(q) {
  const caixa = raiz?.querySelector('#mon-busca-card'); if (!caixa) return;
  const meu = ++tokenBusca; const termo = String(q ?? '').trim();
  if (termo.length < 4) { caixa.replaceChildren(); return; }
  await new Promise((r) => setTimeout(r, 150)); if (meu !== tokenBusca) return;
  const r = await ctx.api(`${BASE}/busca?q=${encodeURIComponent(termo)}`); if (meu !== tokenBusca) return;
  caixa.replaceChildren(); if (!r.ok) return;
  const fora = r.dados.itens.filter((x) => x.fora_da_lista);
  const d = el('details', undefined, 'mon-todo'); d.open = true; d.append(el('summary', `Fora da lista de pedidos em aberto · ${n(fora.length)}`));
  d.append(el('p', 'Estes pedidos aparecem na busca, mas não estão na lista porque já foram entregues (pela fulfillment ou pelo 17Track), cancelados ou reembolsados.', 'cartao-sub'));
  if (!fora.length) d.append(el('p', 'Nenhum pedido fora da lista com esse termo.', 'mon-vazio'));
  else {
    const linhas = fora.map((x) => {
      const tr = el('tr'); tr.className = 'sup-linha-clique';
      const rast = x.rastreio ? (() => { const a = el('a', x.rastreio); a.href = `https://t.17track.net/pt#nums=${encodeURIComponent(x.rastreio)}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.addEventListener('click', (e) => e.stopPropagation()); return a; })() : '—';
      tr.append(celula(x.pedido), celula(x.nome_cliente), celula(x.email_cliente), celula(x.situacao), celula(x.entregue_em ? fmtData(x.entregue_em) : '—'), celula(rotFul(x.fulfillment)), celula(rast),
        celula(x.plataforma ?? 'Não identificada'), celula(fmtData(x.data_pedido)));
      tr.addEventListener('click', () => ctx.abrirFicha(x.pedido_id)); return tr;
    });
    d.append(tabela(['Pedido', 'Cliente', 'E-mail', 'Situação', 'Entregue em', 'Fulfillment', 'Rastreio', 'Plataforma', 'Pedido em'], linhas));
  }
  caixa.append(d);
}
