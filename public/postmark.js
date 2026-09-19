/**
 * Aba "Postmark" — saúde do envio de e-mail (18/09/2026).
 *
 * Uma chamada só (GET /api/postmark?dias=N) traz tudo: alertas já calculados no servidor, cota do
 * ciclo, série por dia, eventos do webhook, fila da régua e bounces/spam recentes. Só desenha.
 * Atualiza sozinha a cada minuto enquanto a aba estiver visível (aba escondida não consulta).
 * Todo texto que vem de fora (destinatário, assunto, detalhe do bounce) entra por `textContent`.
 */
import { $, api, kpiCard, renderTabela, tooltip } from './emailComum.js';
import { n, dataHora, relativo } from './format.js';
import { desenharColunas } from './charts.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined && texto !== null) e.textContent = texto;
  return e;
};

let carregando = false;

/* ── alertas ── */
const ICONE = { critico: '⛔', atencao: '⚠', info: 'ℹ', ok: '✓' };

function renderAlertas(alertas) {
  $('pm-alertas').replaceChildren(...alertas.map((a) => {
    const card = el('div', 'pm-alerta');
    card.dataset.nivel = a.nivel;
    card.append(el('span', 'pm-alerta-ico', ICONE[a.nivel] ?? '•'));
    const corpo = el('div', 'pm-alerta-corpo');
    corpo.append(el('strong', '', a.titulo));
    if (a.detalhe) corpo.append(el('span', '', a.detalhe));
    card.append(corpo);
    return card;
  }));
}

/* ── KPIs ── */
function renderKpis(d) {
  const e = d.eventos; const c = d.cota; const f = d.fila;
  const tomSpam = e.taxa_spam !== null && e.taxa_spam >= 0.1 ? 'ruim' : (e.spam > 0 ? 'medio' : 'bom');
  const tomBounce = e.taxa_bounce !== null && e.taxa_bounce >= 5 ? 'ruim' : (e.taxa_bounce >= 2 ? 'medio' : 'bom');
  const tomCota = c.pct !== null && c.pct >= 90 ? 'ruim' : (c.pct >= 75 ? 'medio' : 'bom');
  const tomFila = f.vencidos >= 1000 || f.maior_atraso_h >= 12 ? 'ruim' : (f.vencidos >= 200 || f.maior_atraso_h >= 3 ? 'medio' : 'bom');
  $('pm-kpis').replaceChildren(
    kpiCard({ icone: '✉', tom: 'neutro', rotulo: 'E-mails enviados', valor: n(e.enviados), nota: 'régua + IA + boas-vindas no período' }),
    kpiCard({ icone: '◔', tom: tomCota, rotulo: 'Cota do ciclo', valor: pct(c.pct), nota: `${n(c.usado_total)} de ${n(c.limite)} e-mails` }),
    kpiCard({ icone: '⚑', tom: tomSpam, rotulo: 'Reclamações de spam', valor: n(e.spam), nota: `taxa ${pct(e.taxa_spam)} — limite do Postmark: 0,1%` }),
    kpiCard({ icone: '↩', tom: tomBounce, rotulo: 'Bounces', valor: n(e.bounces), nota: `taxa ${pct(e.taxa_bounce)} dos enviados` }),
    kpiCard({ icone: '◉', tom: 'neutro', rotulo: 'Abertura', valor: pct(e.taxa_abertura), nota: `${n(e.aberturas)} aberturas / ${n(e.entregues)} entregues (webhook)` }),
    kpiCard({ icone: '⏱', tom: tomFila, rotulo: 'Fila da régua', valor: n(f.vencidos), nota: f.vencidos ? `vencidos — maior atraso ${String(f.maior_atraso_h).replace('.', ',')} h` : 'nenhum pedido esperando' }),
  );
}

/* ── cota ── */
function linha(rotulo, valor, tom) {
  const li = el('div', 'pm-linha');
  li.append(el('span', 'pm-linha-rot', rotulo));
  const v = el('span', 'pm-linha-val', valor);
  if (tom) v.dataset.tom = tom;
  li.append(v);
  return li;
}

function renderCota(d) {
  const c = d.cota;
  const cheio = Math.min(100, c.pct ?? 0);
  const barra = el('div', 'pm-barra');
  barra.dataset.tom = c.pct >= 90 ? 'ruim' : (c.pct >= 75 ? 'medio' : 'bom');
  const preench = el('span'); preench.style.width = `${cheio}%`;
  barra.append(preench);
  $('pm-cota-sub').textContent = c.ciclo_fim
    ? `Ciclo renova em ${dataHora(c.ciclo_fim).split(',')[0]} — faltam ${c.dias_restantes} dia(s). Teto de ${n(c.limite)} e-mails, com ${c.margem_pct}% de folga na régua.`
    : `Teto de ${n(c.limite)} e-mails.`;
  $('pm-cota').replaceChildren(
    barra,
    linha('Usado no ciclo', `${n(c.usado_total)} (${pct(c.pct)})`),
    linha('  régua de pós-venda', n(c.usado.regua)),
    linha('  respostas da IA', n(c.usado.ia)),
    linha('  boas-vindas', n(c.usado.boas_vindas)),
    linha('  já usado antes do log começar', n(c.usado.inicial)),
    linha('Enviados hoje pela régua', n(c.enviados_hoje ?? 0)),
    linha('Saldo da régua para hoje', c.saldo_hoje === null ? '—' : n(c.saldo_hoje), c.saldo_hoje === 0 ? 'ruim' : null),
    linha('Média diária (dias completos)', c.media_diaria === null ? 'sem histórico ainda' : n(c.media_diaria)),
    linha('Projeção no fim do ciclo', c.projecao_fim_ciclo === null ? 'sem histórico ainda' : n(Math.round(c.projecao_fim_ciclo)),
      c.projecao_fim_ciclo !== null && c.projecao_fim_ciclo > c.limite ? 'medio' : null),
    linha('Chave mestra dos e-mails da venda', c.emails_automaticos_ativo ? 'ligada' : 'DESLIGADA', c.emails_automaticos_ativo ? null : 'ruim'),
  );
}

/* ── gráfico ── */
function renderGrafico(d) {
  const dados = d.serie.map((r) => ({
    valor: r.total, rotulo: r.dia.slice(8) + '/' + r.dia.slice(5, 7),
    sub: `régua ${n(r.regua)} · IA ${n(r.ia)} · boas-vindas ${n(r.boas_vindas)}`,
  }));
  desenharColunas($('pm-graf'), dados, {
    altura: 190, unidade: 'e-mails', barraMax: 30, tooltip,
    textoVazio: 'Nenhum envio no período.',
    rotuloEixoX: (item, i) => (i % Math.ceil(dados.length / 10 || 1) === 0 ? item.rotulo : ''),
  });
}

/* ── fila, IA, webhook ── */
function renderFila(d) {
  const f = d.fila; const ia = d.ia;
  const nodes = [
    linha('Pedidos ativos na régua', n(f.ativos)),
    linha('Vencidos agora (esperando envio)', n(f.vencidos), f.vencidos >= 200 ? 'medio' : null),
    linha('Maior atraso', `${String(f.maior_atraso_h).replace('.', ',')} h`, f.maior_atraso_h >= 3 ? 'medio' : null),
    linha('Falhas de envio na régua (últimas 6 h)', n(f.falhas_6h), f.falhas_6h > 0 ? 'ruim' : null),
  ];
  for (const m of f.falhas_motivos ?? []) nodes.push(linha('  ' + m.erro, n(m.n), 'ruim'));
  nodes.push(
    linha('Respostas da IA com erro de envio (48 h)', n(ia.erros_48h), ia.erros_48h > 0 ? 'medio' : null),
    linha('E-mails aguardando resposta da IA (24 h)', n(ia.pendentes_24h)),
  );
  $('pm-fila').replaceChildren(...nodes);
}

function renderWebhook(d) {
  const w = d.webhook;
  let estado; let tom;
  if (!w.tabela_existe) { estado = 'tabela ainda não criada'; tom = 'medio'; }
  else if (!w.ultimo_evento_em) { estado = 'nenhum evento real recebido'; tom = 'medio'; }
  else {
    const idade = Date.now() - new Date(w.ultimo_evento_em).getTime();
    estado = idade > 3 * 3600 * 1000 ? 'sem eventos há mais de 3 h' : 'recebendo eventos';
    tom = idade > 3 * 3600 * 1000 ? 'medio' : 'bom';
  }
  $('pm-webhook').replaceChildren(
    linha('Situação', estado, tom),
    linha('Último evento', w.ultimo_evento_em ? `${dataHora(w.ultimo_evento_em)} (${relativo(w.ultimo_evento_em)})` : '—'),
    linha('Eventos nas últimas 24 h', n(w.eventos_24h)),
    linha('Entregues / abertos / cliques (período)', `${n(d.eventos.entregues)} / ${n(d.eventos.aberturas)} / ${n(d.eventos.cliques)}`),
  );
}

/* ── tabela de problemas ── */
const ROTULO_EVENTO = { Bounce: 'Bounce', SpamComplaint: 'Spam', SubscriptionChange: 'Supressão' };

function renderProblemas(d) {
  const colunas = [
    { render: (r) => dataHora(r.quando) },
    {
      render: (r) => {
        const chip = el('span', 'pm-chip', ROTULO_EVENTO[r.tipo] ?? r.tipo);
        chip.dataset.tipo = r.tipo;
        return chip;
      },
    },
    { render: (r) => r.email ?? '—' },
    { render: (r) => r.assunto ?? '—' },
    { render: (r) => [r.subtipo, r.detalhes].filter(Boolean).join(' — ').slice(0, 90) || '—' },
  ];
  renderTabela($('pm-problemas'), d.problemas, colunas, { vazio: 'Nenhum bounce, spam ou supressão registrado pelo webhook ainda.' });
}

async function carregar() {
  if (carregando) return;
  carregando = true;
  const dias = $('pm-dias').value || '7';
  const { ok, dados } = await api(`/api/postmark?dias=${encodeURIComponent(dias)}`);
  carregando = false;
  if (!ok) {
    $('pm-alertas').replaceChildren(el('div', 'pm-alerta', 'Não consegui carregar os dados do Postmark agora.'));
    return;
  }
  renderAlertas(dados.alertas);
  renderKpis(dados);
  renderCota(dados);
  renderGrafico(dados);
  renderFila(dados);
  renderWebhook(dados);
  renderProblemas(dados);
  $('pm-atualizado').textContent = `atualizado às ${new Date(dados.gerado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

$('aba-btn-postmark').addEventListener('click', () => setTimeout(carregar, 0));
$('pm-dias').addEventListener('change', carregar);
setInterval(() => {
  if (!$('aba-postmark').hidden && !document.hidden) carregar();
}, 60 * 1000);
