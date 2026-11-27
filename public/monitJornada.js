/**
 * MONIT-SPPL — gráfico "Jornada do pedido" da ficha (spec seção 9, "faixas de ritmo"): os quatro marcos (pedido, código gerado, coleta, entrega) ligados por
 * três etapas coloridas pelo ritmo — até 2 dias rápido (verde), 3 a 6 médio (azul), 7 ou mais lento (laranja). Etapa sem o marco final fica tracejada
 * ("em andamento", conta até agora); sem o marco inicial, cinza ("pendente"). HTML/CSS inline, sem biblioteca; as cores vêm das variáveis de tema do painel
 * (claro e escuro). Os dados vêm prontos da API (`jornada` da ficha, api/monit/jornada.js). Todo texto da API entra por textContent.
 */
import { el, fmtDataHora } from './spplComum.js';

const CSS = `
.mj { margin: 0 0 14px; }
.mj-trilha { display: grid; grid-template-columns: auto minmax(70px, 1fr) auto minmax(70px, 1fr) auto minmax(70px, 1fr) auto; align-items: start; gap: 0 6px; padding: 10px 4px 4px; }
.mj-no, .mj-etapa { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 3px; min-width: 0; }
.mj-no { width: 112px; }
.mj-bola { width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--borda); background: var(--superficie); box-sizing: border-box; }
.mj-no[data-ok="1"] .mj-bola { border-color: var(--st-em-dia); background: var(--st-em-dia); }
.mj-no b { font-size: 12px; font-weight: 600; color: var(--tinta); }
.mj-no small, .mj-etapa small { font-size: 11.5px; color: var(--tinta-fraca); overflow-wrap: anywhere; }
.mj-barra { align-self: stretch; margin-top: 7px; height: 4px; border-radius: 4px; background: var(--borda); }
.mj-etapa[data-faixa="rapido"] .mj-barra { background: var(--st-processando); }
.mj-etapa[data-faixa="medio"] .mj-barra { background: var(--st-em-dia); }
.mj-etapa[data-faixa="lento"] .mj-barra { background: var(--st-atrasado); }
.mj-etapa[data-estado="andamento"] .mj-barra { background: repeating-linear-gradient(90deg, currentColor 0 7px, transparent 7px 12px); color: var(--borda); height: 4px; }
.mj-etapa[data-estado="andamento"][data-faixa="rapido"] .mj-barra { color: var(--st-processando); }
.mj-etapa[data-estado="andamento"][data-faixa="medio"] .mj-barra { color: var(--st-em-dia); }
.mj-etapa[data-estado="andamento"][data-faixa="lento"] .mj-barra { color: var(--st-atrasado); }
.mj-etapa b { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--tinta); }
.mj-etapa[data-estado="pendente"] b { color: var(--tinta-fraca); font-weight: 400; }
.mj-legenda { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; font-size: 12px; color: var(--tinta-fraca); }
.mj-legenda span::before { content: ''; display: inline-block; width: 18px; height: 4px; border-radius: 4px; margin-right: 6px; vertical-align: middle; background: var(--borda); }
.mj-legenda .mj-l-rapido::before { background: var(--st-processando); }
.mj-legenda .mj-l-medio::before { background: var(--st-em-dia); }
.mj-legenda .mj-l-lento::before { background: var(--st-atrasado); }
@media (max-width: 640px) {
  .mj-trilha { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
  .mj-no { flex-direction: row; width: auto; justify-content: flex-start; gap: 10px; text-align: left; }
  .mj-no > div, .mj-etapa > div { align-items: flex-start !important; }
  .mj-etapa { flex-direction: row; justify-content: flex-start; gap: 10px; text-align: left; margin-left: 7px; padding: 4px 0; border-left: 4px solid var(--borda); padding-left: 16px; }
  .mj-etapa[data-faixa="rapido"] { border-left-color: var(--st-processando); }
  .mj-etapa[data-faixa="medio"] { border-left-color: var(--st-em-dia); }
  .mj-etapa[data-faixa="lento"] { border-left-color: var(--st-atrasado); }
  .mj-etapa[data-estado="andamento"] { border-left-style: dashed; }
  .mj-barra { display: none; }
}
`;

const FAIXA = { rapido: 'rápido', medio: 'médio', lento: 'lento' };

/** Monta o bloco "Jornada do pedido". `j` = `jornada` da ficha ({ marcos, etapas, total }); devolve null se não houver nada para mostrar. */
export function desenharJornada(j) {
  if (!j?.marcos?.some((m) => m.quando)) return null;
  if (!document.getElementById('monit-jornada-css')) { const s = document.createElement('style'); s.id = 'monit-jornada-css'; s.textContent = CSS; document.head.append(s); }
  const raiz = el('section', undefined, 'mj'); raiz.append(el('h3', 'Jornada do pedido'));
  const trilha = el('div', undefined, 'mj-trilha'); trilha.setAttribute('role', 'list'); trilha.setAttribute('aria-label', 'Etapas do pedido, da compra à entrega');
  j.marcos.forEach((m, i) => {
    const no = el('div', undefined, 'mj-no'); no.dataset.ok = m.quando ? '1' : '0'; no.setAttribute('role', 'listitem');
    no.title = m.quando ? `${m.rotulo}: ${fmtDataHora(m.quando)}` : `${m.rotulo}: ainda não aconteceu`;
    no.append(el('span', undefined, 'mj-bola'));
    const txt = el('div'); txt.style.cssText = 'display:flex;flex-direction:column;align-items:inherit;gap:3px';
    txt.append(el('b', m.rotulo), el('small', m.quando ? fmtDataHora(m.quando) : 'ainda não'));
    no.append(txt); trilha.append(no);
    const e = j.etapas[i]; if (!e) return;
    const et = el('div', undefined, 'mj-etapa'); et.dataset.estado = e.estado; et.setAttribute('role', 'listitem'); if (e.faixa) et.dataset.faixa = e.faixa;
    et.title = `${e.rotulo} — ${e.texto ?? 'sem dados'}${e.faixa ? ` (ritmo ${FAIXA[e.faixa]})` : ''} · ${e.unidade === 'uteis' ? 'dias úteis' : 'dias corridos'}`;
    et.append(el('span', undefined, 'mj-barra'));
    const t2 = el('div'); t2.style.cssText = 'display:flex;flex-direction:column;align-items:inherit;gap:3px';
    t2.append(el('b', e.texto ?? '—'), el('small', `${e.rotulo} · ${e.unidade === 'uteis' ? 'dias úteis' : 'dias corridos'}`));
    et.append(t2); trilha.append(et);
  });
  raiz.append(trilha);
  if (j.total?.texto) raiz.append(el('p', `Pedido → entrega: ${j.total.texto}${j.total.concluido ? '' : ' até agora (ainda não entregue)'}.`, 'cartao-sub'));
  const lg = el('div', undefined, 'mj-legenda');
  lg.append(el('span', 'rápido: até 2 dias', 'mj-l-rapido'), el('span', 'médio: 3 a 6 dias', 'mj-l-medio'), el('span', 'lento: 7 dias ou mais', 'mj-l-lento'), el('span', 'tracejado: em andamento'));
  raiz.append(lg);
  return raiz;
}
