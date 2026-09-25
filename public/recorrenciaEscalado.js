/**
 * Suporte Escalado → sub-aba "Relatório de métricas" (recorrência) — pedido da Vitória, 25/09/2026.
 *
 * Só mostra o que /api/recorrencia/relatorio devolve: uma linha por mês, acumulada até o fim dele — quantos
 * clientes com recorrência já entraram em contato, sobre o total acumulado, e a média de dias entre a
 * renovação e o primeiro contato. Sem dado pessoal: só contagens. Todo texto entra por `textContent`.
 */
import { $, api, kpiCard } from './emailComum.js';
import { n, dataHora } from './format.js';

const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined && texto !== null) e.textContent = texto;
  return e;
};

const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (aaaamm) => {
  const [a, m] = aaaamm.split('-');
  return `${NOMES_MES[Number(m) - 1]}/${a}`;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1).replace('.', ',')}%`);
const dias = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1).replace('.', ',')} dias`);

let carregando = false;

function renderKpis(dados) {
  const a = dados.atual;
  const prev = dados.previsao ?? {};
  $('rc-kpis').replaceChildren(
    kpiCard({
      icone: '↻', tom: 'neutro', rotulo: 'Com recorrência',
      valor: a ? n(a.com_recorrencia) : '0',
      nota: a ? `já cobrados na renovação${dados.manuais ? ` + ${n(dados.manuais)} movido${dados.manuais === 1 ? '' : 's'} na mão` : ''}` : 'ninguém cobrado ainda',
    }),
    kpiCard({
      icone: '✉', tom: 'neutro', rotulo: 'Entraram em contato',
      valor: a ? `${n(a.entraram_em_contato)} de ${n(a.com_recorrencia)}` : '—',
      nota: a ? `${pct(a.pct_contato)} — cada cliente conta uma vez` : '',
    }),
    kpiCard({
      icone: '◔', tom: 'neutro', rotulo: 'Média até o contato',
      valor: a ? dias(a.media_dias) : '—',
      nota: a && a.amostra_dias ? `desde a renovação mais recente antes do contato · ${n(a.amostra_dias)} cliente${a.amostra_dias === 1 ? '' : 's'}` : 'sem contato medido ainda',
    }),
    kpiCard({
      icone: '⏳', tom: 'neutro', rotulo: 'Aguardando 1ª cobrança',
      valor: n(prev.aguardando_total ?? 0),
      nota: `${n(prev.proximos_7_dias ?? 0)} previstos nos próximos 7 dias · ${n(a?.cancelaram ?? 0)} já cancelaram`,
    }),
  );
  $('rc-status').textContent = prev.ultima_cobranca
    ? `Última renovação registrada: ${dataHora(prev.ultima_cobranca)}.`
    : 'Nenhuma renovação registrada ainda.';
}

function renderTabela(meses) {
  if (!meses.length) {
    $('rc-tabela').replaceChildren(el('p', 'vazio-suave', 'Ainda não há clientes com recorrência registrados.'));
    return;
  }
  const envolve = el('div', 'sup-tabela-envolve');
  const tabela = el('table', 'sup-tabela');
  const cabeca = el('thead');
  const trc = el('tr');
  for (const t of ['Mês (acumulado até o fim)', 'Compraram US$ 39', 'Com recorrência', 'Entraram em contato', '% que entrou', 'Média de dias', 'Média dos contatos do mês', 'Aguardando 1ª cobrança', 'Cancelaram']) {
    trc.append(el('th', '', t));
  }
  cabeca.append(trc);
  const corpo = el('tbody');
  for (const m of [...meses].reverse()) {
    const tr = el('tr');
    const td = (texto, classe) => tr.append(el('td', classe, texto));
    td(rotuloMes(m.mes), 'cel-forte');
    td(n(m.compraram));
    td(`${n(m.com_recorrencia)}${m.novos_na_base ? ` (+${n(m.novos_na_base)})` : ''}`);
    td(`${n(m.entraram_em_contato)} de ${n(m.com_recorrencia)}`);
    td(pct(m.pct_contato));
    td(dias(m.media_dias));
    td(dias(m.media_dias_no_mes));
    td(n(m.aguardando_1a_cobranca));
    td(n(m.cancelaram));
    corpo.append(tr);
  }
  tabela.append(cabeca, corpo);
  envolve.append(tabela);
  $('rc-tabela').replaceChildren(envolve);
}

export async function carregarRecorrencia() {
  if (carregando) return;
  carregando = true;
  const { ok, dados } = await api('/api/recorrencia/relatorio');
  carregando = false;
  if (!ok) {
    $('rc-tabela').replaceChildren(el('p', 'vazio-suave', 'Não consegui carregar o relatório de recorrência agora.'));
    return;
  }
  renderKpis(dados);
  renderTabela(dados.meses);
}

$('rc-atualizar')?.addEventListener('click', carregarRecorrencia);
