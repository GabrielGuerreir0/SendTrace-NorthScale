/**
 * Aba "Visão Geral" — a Home do SendTrace, 9ª aba e a primeira que abre.
 *
 * Mesmo padrão de relatorioMetricas.js: busca tudo de UMA rota agregada
 * (`/api/visao-geral`), sem entrar no polling automático do painel (não faz
 * sentido recarregar a Home a cada poucos segundos) — só na primeira carga.
 *
 * Todo número na tela vem de `s` (a resposta da rota). Nenhum dado de
 * exemplo: a seção "fila operacional do dia" do rascunho original ficou de
 * fora de propósito — a consulta que cruzaria "escalado há mais tempo" +
 * "urgência sem resposta" + "reaberto recentemente" numa lista só ainda não
 * existe, e mostrar linhas fictícias fingindo ser cliente real não é opção.
 */
import {
  $, api, kpiCard, barraHorizontal, tooltip, rotularMotivo, rotularPlataforma,
} from './emailComum.js';
import { n, duracaoH } from './format.js';
import { desenharColunas } from './charts.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
const pct0 = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

/* ══════════════════════════  status band (topo)  ══════════════════════════ */

function renderStatus(s) {
  const el = $('vg-status');
  if (!el) return;
  const st = s.status ?? { nivel: 'info', texto: 'Sem dados.' };
  el.dataset.nivel = st.nivel;
  el.replaceChildren();

  const glifo = document.createElement('span');
  glifo.className = 'vg-status-glifo';
  glifo.setAttribute('aria-hidden', 'true');

  const corpo = document.createElement('div');
  const texto = document.createElement('p');
  texto.textContent = st.texto;
  corpo.append(texto);

  if (st.aba) {
    const fonte = document.createElement('div');
    fonte.className = 'vg-status-fonte';
    fonte.textContent = 'Insight de maior severidade entre régua, Suporte IA, Tickets e Suporte '
      + `Escalado — este veio de ${st.rotulo_aba}.`;
    corpo.append(fonte);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn vg-status-link';
    btn.textContent = `Ver em ${st.rotulo_aba} →`;
    btn.addEventListener('click', () => $(`aba-btn-${st.aba}`)?.click());
    corpo.append(btn);
  }

  el.append(glifo, corpo);
}

function renderPontoPositivo(s) {
  const el = $('vg-positivo');
  if (!el) return;
  el.replaceChildren();
  const glifo = document.createElement('span');
  glifo.className = 'vg-status-glifo';
  glifo.setAttribute('aria-hidden', 'true');
  const corpo = document.createElement('div');
  const total = s.ponto_positivo?.perguntas_sem_resposta ?? 0;
  const texto = document.createElement('p');
  texto.innerHTML = `<b>${n(total)} pergunta${total === 1 ? '' : 's'} sem resposta pela IA</b> `
    + `nos últimos ${s.periodo_dias} dias — a Home não é só alarme, isto também é um ponto real.`;
  const fonte = document.createElement('div');
  fonte.className = 'vg-status-fonte';
  fonte.textContent = 'Fonte: chat_perguntas_sem_resposta — a mesma tabela que já alimenta o card de Suporte IA.';
  corpo.append(texto, fonte);
  el.append(glifo, corpo);
}

/* ══════════════════════════  números críticos / saúde  ════════════════════ */

function renderCriticos(s) {
  const c = s.criticos;
  const semResolucao = c.tickets_sem_resolucao.nao_iniciado + c.tickets_sem_resolucao.em_aberto;
  $('vg-criticos').replaceChildren(
    kpiCard({
      icone: '✕', tom: 'ruim', rotulo: 'Tickets sem resolução',
      valor: n(semResolucao),
      nota: `${n(c.tickets_sem_resolucao.nao_iniciado)} nunca abertos + `
        + `${n(c.tickets_sem_resolucao.em_aberto)} em aberto, de ${n(c.tickets_sem_resolucao.total)} no total`,
    }),
    kpiCard({
      icone: '⚑', tom: 'medio', rotulo: 'Casos escalados pendentes',
      valor: n(c.casos_escalados_pendentes),
      nota: 'esperando alguém do time olhar, somando todos os boards',
    }),
    kpiCard({
      icone: '↩', tom: c.reembolsos_24h.atual > c.reembolsos_24h.anterior ? 'ruim' : 'medio',
      rotulo: 'Reembolsos consumados (24h)',
      valor: n(c.reembolsos_24h.atual),
      nota: `${n(c.reembolsos_24h.anterior)} no período anterior de 24h`,
    }),
    kpiCard({
      icone: '●', tom: 'neutro', rotulo: `E-mails de plataforma (${s.periodo_dias}d)`,
      valor: n(c.emails_plataforma_periodo),
      nota: 'DigiStore24/JVZoo/BuyGoods/interno — fora da fila de ticket',
    }),
  );
}

function renderSaude(s) {
  const sa = s.saude;
  $('vg-saude').replaceChildren(
    kpiCard({
      icone: '⚠', tom: 'medio', rotulo: 'Erro no envio automático',
      valor: n(sa.erro_envio_automatico),
      nota: `e-mails onde a IA tentou responder e o SMTP falhou · ${s.periodo_dias} dias`,
    }),
    kpiCard({
      icone: '↻', tom: 'medio', rotulo: 'Tickets reabertos',
      valor: n(sa.tickets_reabertos.tickets),
      nota: `${n(sa.tickets_reabertos.total_reaberturas)} reaberturas no total — "resolvido" que não resolveu de vez`,
    }),
    kpiCard({
      icone: '⚐', tom: 'neutro', rotulo: 'Anexos com defeito visível',
      valor: `${n(sa.anexos_defeito.com_defeito)} / ${n(sa.anexos_defeito.total_analisadas)}`,
      nota: 'fotos/prints analisados pela IA, acumulado — controle de lote',
    }),
    kpiCard({
      icone: '⚠', tom: 'medio', rotulo: 'Disparos da régua com erro',
      valor: `${n(sa.regua_com_erro.com_erro)} / ${n(sa.regua_com_erro.total)}`,
      nota: `${pct0(sa.regua_com_erro.total > 0 ? sa.regua_com_erro.com_erro / sa.regua_com_erro.total : 0)} `
        + 'dos disparos ativos — e-mail/SMS falhando',
    }),
  );
}

function renderRisco(s) {
  $('vg-risco').replaceChildren(
    kpiCard({
      icone: '⟲', tom: 'medio', rotulo: 'Reincidentes (2+ devoluções)',
      valor: n(s.risco.reincidentes),
      nota: 'clientes que já voltaram a pedir devolução/troca mais de uma vez',
    }),
    kpiCard({
      icone: '☹', tom: 'medio', rotulo: `Sentimento negativo (${s.periodo_dias}d)`,
      valor: n(s.risco.sentimento_negativo_periodo),
      nota: 'clientes distintos com pelo menos 1 e-mail negativo/muito negativo no período',
    }),
  );
}

/* ══════════════════════════  metas do time (termômetros)  ═════════════════ */

function corMeta(taxa, meta) {
  if (taxa === null) return 'var(--tinta-fraca)';
  if (taxa >= meta) return 'var(--st-finalizado)';
  if (taxa >= meta * 0.7) return 'var(--st-atrasado)';
  return 'var(--st-travado)';
}

function metaCard({
  titulo, formula, taxa, meta, of, nota,
}) {
  const wrap = document.createElement('div');
  wrap.className = 'cartao vg-meta-card';
  const cor = corMeta(taxa, meta);
  const larguraFill = Math.max(0, Math.min(100, (taxa ?? 0) * 100));

  wrap.innerHTML = `
    <div class="vg-therm-wrap">
      <div class="vg-therm-track">
        <div class="vg-therm-fill" style="width:${larguraFill}%; background:${cor};"></div>
        <div class="vg-therm-mark" data-label="meta ${pct0(meta)}" style="left:${meta * 100}%;"></div>
      </div>
    </div>
    <div class="vg-meta-body">
      <h3>${titulo}</h3>
      <div class="vg-meta-formula">${formula}</div>
      <div class="vg-meta-readout">
        <span class="vg-big" style="color:${cor}">${pct(taxa)}</span>
        <span class="vg-of">${of}</span>
      </div>
      <div class="vg-meta-nota">${nota}</div>
    </div>`;
  return wrap;
}

function renderMetas(s) {
  const { chat, tickets } = s.metas;
  $('vg-metas').replaceChildren(
    metaCard({
      titulo: 'Taxa de resolução — chat IA',
      formula: `conversas resolvidas ÷ conversas classificadas · ${s.periodo_dias} dias`,
      taxa: chat.taxa, meta: chat.meta,
      of: `de ${n(chat.classificadas)} conversas · meta sugerida ${pct0(chat.meta)}`,
      nota: chat.taxa !== null && chat.taxa >= chat.meta
        ? 'Na meta ou acima dela.'
        : 'Ainda abaixo da meta sugerida.',
    }),
    metaCard({
      titulo: 'Taxa de resolução — tickets de e-mail',
      formula: 'tickets resolvidos ÷ total de tickets na fila · instantâneo',
      taxa: tickets.taxa, meta: tickets.meta,
      of: `${n(tickets.resolvidos)} de ${n(tickets.total)} tickets · meta sugerida ${pct0(tickets.meta)}`,
      nota: 'Reflete a fila real — a ideia é ver subir toda semana.',
    }),
  );
}

/* ══════════════════════════  diagnóstico da base  ══════════════════════════ */

const ROTULO_AREA = {
  entrega: 'Entrega', produto: 'Produto', codigo_rastreio: 'Código de rastreio',
  pagamento: 'Pagamento', atendimento: 'Atendimento', anuncio_informacao: 'Anúncio/informação', outro: 'Outro',
};
const rotularArea = (v) => ROTULO_AREA[v] ?? v;

const ROTULO_SENTIMENTO = {
  positivo: 'Positivo', neutro: 'Neutro', negativo: 'Negativo',
  muito_negativo: 'Muito negativo', sem_classificacao: 'Sem classificação',
};
const COR_SENTIMENTO = {
  positivo: 'var(--st-finalizado)', neutro: 'var(--tinta-fraca)', negativo: 'var(--st-atrasado)',
  muito_negativo: 'var(--st-travado)', sem_classificacao: 'var(--eixo)',
};
// Ordem fixa de leitura — da melhor pra pior, com "sem classificação" por último.
const ORDEM_SENTIMENTO = ['positivo', 'neutro', 'negativo', 'muito_negativo', 'sem_classificacao'];

function renderSentimento(s) {
  const container = $('vg-sentimento');
  if (!container) return;
  const itens = s.diagnostico.sentimento;
  const total = itens.reduce((a, i) => a + i.total, 0);
  container.replaceChildren();
  if (!total) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Sem e-mails classificados no período.';
    container.append(p);
    return;
  }
  const porChave = new Map(itens.map((i) => [i.sentimento, i.total]));

  const track = document.createElement('div');
  track.className = 'vg-stack';
  const legenda = document.createElement('ul');
  legenda.className = 'vg-stack-legend';

  for (const chave of ORDEM_SENTIMENTO) {
    const total_ = porChave.get(chave) ?? 0;
    if (!total_) continue;
    const p = Math.round((total_ / total) * 1000) / 10;
    const seg = document.createElement('div');
    seg.className = 'vg-stack-seg';
    seg.style.width = `${p}%`;
    seg.style.background = COR_SENTIMENTO[chave];
    if (p >= 6) seg.textContent = `${Math.round(p)}%`;
    track.append(seg);

    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'vg-dot';
    dot.style.background = COR_SENTIMENTO[chave];
    li.append(dot, document.createTextNode(`${ROTULO_SENTIMENTO[chave]} — ${Math.round(p)}%`));
    legenda.append(li);
  }
  container.append(track, legenda);

  const negativos = (porChave.get('negativo') ?? 0) + (porChave.get('muito_negativo') ?? 0);
  const callout = $('vg-sentimento-callout');
  if (callout) {
    const pNeg = Math.round((negativos / total) * 1000) / 10;
    callout.textContent = `${pNeg}% dos e-mails do período carregam sentimento negativo ou muito `
      + 'negativo — termômetro de humor da base inteira, não só de quem já abriu reclamação formal.';
  }
}

/* ══════════════════════  tempo de resolução por área  ══════════════════════ */

function renderResolucaoArea(s) {
  const container = $('vg-resolucao-area');
  if (!container) return;
  container.replaceChildren();
  const itens = s.resolucao_por_area;
  if (!itens.length) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Sem tickets resolvidos com área classificada no período.';
    container.append(p);
    return;
  }
  const max = Math.max(...itens.map((i) => i.media_h));
  const ul = document.createElement('ul');
  ul.className = 'sup-ranking';
  for (const item of itens) {
    const li = document.createElement('li');
    li.className = 'sup-item';
    const rot = document.createElement('span');
    rot.className = 'sup-item-rotulo';
    rot.textContent = rotularArea(item.area_problema);
    const num = document.createElement('span');
    num.className = 'sup-item-num';
    num.textContent = duracaoH(item.media_h);
    const barra = document.createElement('span');
    barra.className = 'sup-item-barra';
    const cheio = document.createElement('span');
    cheio.style.width = `${max > 0 ? Math.max(2, (item.media_h / max) * 100) : 0}%`;
    if (item === itens[0]) cheio.style.background = 'var(--st-travado)';
    barra.append(cheio);
    const sub = document.createElement('span');
    sub.className = 'sup-item-sub';
    sub.textContent = `${n(item.tickets)} ticket${item.tickets === 1 ? '' : 's'} resolvido${item.tickets === 1 ? '' : 's'}`;
    li.append(rot, num, barra, sub);
    ul.append(li);
  }
  container.append(ul);
}

function renderVolumeSemana(s) {
  const container = $('vg-graf-semana');
  if (!container) return;
  const dados = s.volume_dia_semana.map((r) => ({ valor: r.total, rotulo: r.nome, sub: null }));
  desenharColunas(container, dados, {
    altura: 170, unidade: 'e-mails', barraMax: 40, tooltip,
    textoVazio: 'Sem e-mails no período.',
    rotuloEixoX: (d) => d.rotulo,
  });
}

/* ══════════════════════════  reembolso: por quê e onde  ════════════════════ */

function renderReembolso(s) {
  barraHorizontal($('vg-motivos-reembolso'), s.reembolso.motivos, 'motivo_devolucao', { rotular: rotularMotivo });
  barraHorizontal($('vg-plataformas'), s.reembolso.plataformas, 'plataforma_origem', { rotular: rotularPlataforma });
}

function renderProdutos(s) {
  barraHorizontal($('vg-produtos'), s.produtos_problema, 'produto');
}

/* ══════════════════════════  jornada do cliente  ════════════════════════════ */

function renderAberturaRegua(s) {
  const container = $('vg-abertura-regua');
  if (!container) return;
  container.replaceChildren();
  const itens = s.jornada.abertura_regua;
  const ul = document.createElement('ul');
  ul.className = 'sup-ranking';
  for (const r of itens) {
    const li = document.createElement('li');
    li.className = 'sup-item';
    const rot = document.createElement('span');
    rot.className = 'sup-item-rotulo';
    rot.textContent = `Etapa ${r.etapa} — ${r.nome}`;
    const num = document.createElement('span');
    num.className = 'sup-item-num';
    num.textContent = `${pct(r.taxa)} (${n(r.abertos)}/${n(r.enviados_aprox)})`;
    const barra = document.createElement('span');
    barra.className = 'sup-item-barra';
    const cheio = document.createElement('span');
    cheio.style.width = `${r.taxa ? Math.max(2, r.taxa * 100) : 0}%`;
    barra.append(cheio);
    li.append(rot, num, barra);
    ul.append(li);
  }
  container.append(ul);
}

function renderJornadaContato(s) {
  barraHorizontal($('vg-jornada-contato'), s.jornada.onde_gera_contato, 'nome');
}

/* ══════════════════════════  cobertura de ficha de produto  ═══════════════ */

function renderCobertura(s) {
  const { ativos, com_ficha: comFicha } = s.cobertura_produto;
  const frac = ativos > 0 ? comFicha / ativos : 0;
  const raio = 32;
  const circ = 2 * Math.PI * raio;
  const cheio = circ * frac;

  const ring = $('vg-ring');
  if (ring) {
    ring.innerHTML = `
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="${raio}" fill="none" stroke="var(--trilho)" stroke-width="7"/>
        <circle cx="36" cy="36" r="${raio}" fill="none" stroke="var(--st-atrasado)" stroke-width="7"
                stroke-linecap="round" stroke-dasharray="${cheio.toFixed(2)} ${circ.toFixed(2)}"/>
      </svg>
      <div class="vg-ring-num">${comFicha}/${ativos}</div>`;
  }
  const texto = $('vg-cobertura-texto');
  if (texto) {
    texto.textContent = `${comFicha} de ${ativos} produtos ativos têm produto_readmes preenchido — `
      + 'a IA nunca inventa esse dado quando falta.';
  }
}

/* ══════════════════════════  navegação pras outras abas  ═══════════════════ */

// Estático de propósito: não depende de nenhum dado da rota, só troca de aba
// (reaproveita o mesmo botão do menu lateral, via .click()).
const OUTRAS_ABAS = [
  { aba: 'suporte', titulo: 'Suporte IA', desc: 'Chat com o cliente: resolução, reembolsos evitados e o que a IA ainda não sabe responder.' },
  { aba: 'regua', titulo: 'Régua de pós-venda', desc: 'Onde cada pedido está na sequência de e-mails/SMS automáticos, etapa por etapa.' },
  { aba: 'ticketsia', titulo: 'Tickets de Atendimento', desc: 'Um ticket por cliente: não iniciado, em aberto ou resolvido — a fila de e-mail.' },
  { aba: 'detalhesia', titulo: 'Mais Detalhes', desc: 'Todos os filtros e rankings da Central de E-mail IA: categoria, área, motivo, produto.' },
  { aba: 'chatia', titulo: 'Chat com IA', desc: 'Testa e acompanha o assistente de chat que atende o cliente em tempo real.' },
  { aba: 'galeriaia', titulo: 'Galeria de Imagens', desc: 'Anexos analisados pela IA: fotos de produto, defeito, nota fiscal, comprovante.' },
  { aba: 'suporteescalado', titulo: 'Suporte Escalado', desc: 'O kanban dos casos que a IA passou pra um humano — por board/responsável.' },
  { aba: 'relatorioia', titulo: 'Relatório de Métricas', desc: 'KPIs e gráficos consolidados, com PDF que também sai por e-mail.' },
];

function renderNav() {
  const container = $('vg-nav');
  if (!container || container.childElementCount) return; // estático — monta uma vez só
  container.replaceChildren(...OUTRAS_ABAS.map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vg-nav-card';
    btn.addEventListener('click', () => $(`aba-btn-${item.aba}`)?.click());
    const h3 = document.createElement('h3');
    h3.textContent = item.titulo;
    const p = document.createElement('p');
    p.textContent = item.desc;
    btn.append(h3, p);
    return btn;
  }));
}

/* ══════════════════════════════  carregamento  ═════════════════════════════ */

let carregando = false;

export async function carregarVisaoGeral() {
  if (carregando) return;
  carregando = true;
  renderNav(); // não depende da API — monta imediatamente

  const { ok, dados: s } = await api('/api/visao-geral?dias=30');
  carregando = false;
  if (!ok) {
    const el = $('vg-status');
    if (el) {
      el.dataset.nivel = 'alerta';
      el.textContent = 'Não consegui carregar a Visão Geral agora. Tente novamente em instantes.';
    }
    return;
  }

  renderStatus(s);
  renderCriticos(s);
  renderSaude(s);
  renderPontoPositivo(s);
  renderMetas(s);
  barraHorizontal($('vg-area-problema'), s.diagnostico.area_problema, 'area_problema', { rotular: rotularArea });
  renderSentimento(s);
  renderResolucaoArea(s);
  renderVolumeSemana(s);
  renderReembolso(s);
  renderProdutos(s);
  renderAberturaRegua(s);
  renderJornadaContato(s);
  renderRisco(s);
  renderCobertura(s);
}

// Primeira carga — mesma mecânica das outras abas: todas ficam no DOM, só
// escondidas, e como Visão Geral é a aba PADRÃO ela precisa de dado já na
// entrada, sem esperar um clique.
carregarVisaoGeral();
