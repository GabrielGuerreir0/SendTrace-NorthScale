/**
 * Aba Rastreio — prazo de envio por fulfillment (migração 131; pedido do Lucas, 16/11/2026).
 *
 * Dias úteis desde a compra, com o corte de 14h ET na Jetpack (17/11: a regra do contrato, igual ao Atlas). O card "Pendente de envio" separa "no prazo" × "atrasado" por esse prazo
 * (antes era um corte fixo de 7 dias). Todo mundo com a página vê; só administrador grava (a API também confere). Prazo vazio = sem prazo.
 * Depois de salvar, dispara `rastreio:prazos` para a aba recalcular os cards.
 */
import { $, api, usuarioAtual } from './emailComum.js';
import { dataHora } from './format.js';

const FUL = [['fullstack', 'FullStack'], ['jetstream', 'JetStream'], ['redrock', 'Red Rock']];
let atual = null;

export async function lerPrazosEnvio() {
  const r = await api('/api/rastreio/prazos-envio/');
  if (r.ok) atual = r.dados;
  return atual?.prazos ?? {};
}

function aviso(texto, tom = 'ok') {
  const p = $('rst-prazos-msg');
  p.hidden = !texto; p.textContent = texto || ''; p.dataset.tom = tom;
}

function render() {
  const admin = Boolean(usuarioAtual()?.admin);
  const caixa = $('rst-prazos-campos');
  caixa.replaceChildren(...FUL.map(([k, nome]) => {
    const l = document.createElement('label');
    l.className = 'campo';
    const s = document.createElement('span'); s.textContent = `${nome} (dias úteis${atual?.cortes_hora_et?.[k] != null ? `, corte ${atual.cortes_hora_et[k]}h ET` : ''})`;
    const i = document.createElement('input');
    i.type = 'number'; i.min = '0'; i.max = '60'; i.step = '1'; i.style.width = '110px'; i.dataset.ful = k;
    i.value = atual?.prazos?.[k] ?? ''; i.placeholder = 'sem prazo'; i.disabled = !admin;
    l.append(s, i);
    return l;
  }));
  $('rst-prazos-salvar').hidden = !admin;
  const hist = atual?.historico ?? [];
  const lista = $('rst-prazos-hist');
  const nome = Object.fromEntries(FUL);
  lista.replaceChildren(...(hist.length ? hist.map((h) => {
    const mud = FUL.map(([k]) => k).filter((k) => (h.de?.[k] ?? null) !== (h.para?.[k] ?? null))
      .map((k) => `${nome[k]}: ${h.de?.[k] ?? 'sem prazo'} → ${h.para?.[k] ?? 'sem prazo'} dia(s) útil(eis)`).join(' · ');
    const li = document.createElement('li');
    li.textContent = `${dataHora(h.em)} · ${h.por || '—'} · ${mud}`;
    return li;
  }) : [Object.assign(document.createElement('li'), { textContent: 'Nenhuma alteração ainda (valores iniciais iguais aos do Atlas).' })]));
}

async function carregar() { await lerPrazosEnvio(); if (atual) render(); }

async function salvar() {
  const corpo = {};
  for (const i of $('rst-prazos-campos').querySelectorAll('input')) {
    const v = i.value.trim();
    if (v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 60)) { aviso('O prazo vai de 0 a 60 dias (ou vazio, sem prazo).', 'erro'); return; }
    corpo[i.dataset.ful] = v === '' ? null : Number(v);
  }
  $('rst-prazos-salvar').disabled = true;
  const r = await api('/api/rastreio/prazos-envio/', { metodo: 'PUT', corpo }).finally(() => { $('rst-prazos-salvar').disabled = false; });
  if (!r.ok) { aviso(r.dados?.erro || r.dados?.message || 'Não foi possível salvar.', 'erro'); return; }
  aviso(r.dados.mudou ? 'Prazos salvos. Os cards já usam o prazo novo.' : 'Nada mudou.');
  await carregar();
  document.dispatchEvent(new CustomEvent('rastreio:prazos'));
}

$('rst-prazos-salvar').addEventListener('click', salvar);
$('aba-btn-rastreio')?.addEventListener('click', () => setTimeout(carregar, 0));
if (!$('aba-rastreio').hidden) carregar();
