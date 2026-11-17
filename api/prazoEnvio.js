/**
 * Prazo de envio em dias ÚTEIS (17/11/2026, pedido do Lucas): a mesma regra do Atlas (app/acompanhamento.js, prazoEnvio), que é a do contrato.
 *   - dias úteis em Nova York: sem sábado, domingo e feriado federal dos EUA (sábado → sexta, domingo → segunda);
 *   - corte por fulfillment (Jetpack: 14h ET): pedido em dia útil até o corte conta o próprio dia como o 1º; depois, começa no próximo dia útil;
 *   - sem corte (FullStack, Red Rock): o prazo conta a partir do dia seguinte;
 *   - atrasado = passou do fim (23:59:59 ET) do último dia do prazo.
 * Como o fim do prazo só cresce com a hora da compra, "atrasado agora" vira um corte simples na data da compra: limiteCompra() acha esse
 * instante e o SQL só compara `compra < limite` (sem precisar de calendário no banco).
 */
const FUSO = 'America/New_York';
const DIA = 86_400_000;
export const CORTE_HORA_ET = { jetstream: 14, fullstack: null, redrock: null };

const fmtET = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function partesET(ms) {
  const p = Object.fromEntries(fmtET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute), ss: Number(p.second) };
}
const ymdParse = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymdFmt = (ut) => new Date(ut).toISOString().slice(0, 10);
const somaDias = (ymd, n) => ymdFmt(ymdParse(ymd) + n * DIA);
/** Instante (ms) em que o relógio de Nova York marca ymd hh:mm:ss. */
function etParaMs(ymd, hh = 0, mm = 0, ss = 0) {
  const alvo = ymdParse(ymd) + ((hh * 60 + mm) * 60 + ss) * 1000;
  let ms = alvo;
  for (let i = 0; i < 3; i += 1) { const p = partesET(ms); ms += alvo - (ymdParse(p.ymd) + ((p.hh * 60 + p.mm) * 60 + p.ss) * 1000); }
  return ms;
}
const fimDoDiaET = (ymd) => etParaMs(somaDias(ymd, 1)) - 1;

const enesima = (ano, mes, dow, n) => { let d = Date.UTC(ano, mes, 1); while (new Date(d).getUTCDay() !== dow) d += DIA; return ymdFmt(d + (n - 1) * 7 * DIA); };
const ultima = (ano, mes, dow) => { let d = Date.UTC(ano, mes + 1, 0); while (new Date(d).getUTCDay() !== dow) d -= DIA; return ymdFmt(d); };
const cacheFeriados = new Map();
/** Feriados federais dos EUA (mesma lista do Atlas). */
export function feriadosFederais(ano) {
  if (!cacheFeriados.has(ano)) {
    const fixo = (m, d) => { const t = Date.UTC(ano, m, d), w = new Date(t).getUTCDay(); return ymdFmt(t + (w === 6 ? -DIA : w === 0 ? DIA : 0)); };
    cacheFeriados.set(ano, new Set([fixo(0, 1), enesima(ano, 0, 1, 3), enesima(ano, 1, 1, 3), ultima(ano, 4, 1), fixo(5, 19), fixo(6, 4),
      enesima(ano, 8, 1, 1), enesima(ano, 9, 1, 2), fixo(10, 11), enesima(ano, 10, 4, 4), fixo(11, 25)]));
  }
  return cacheFeriados.get(ano);
}
const ehFeriado = (ymd) => feriadosFederais(Number(ymd.slice(0, 4))).has(ymd) || feriadosFederais(Number(ymd.slice(0, 4)) + 1).has(ymd);
export const ehUtil = (ymd) => { const w = new Date(ymdParse(ymd)).getUTCDay(); return w !== 0 && w !== 6 && !ehFeriado(ymd); };
/** N-ésimo dia útil DEPOIS de ymd (ymd não conta). */
const somaUteis = (ymd, n) => { let d = ymd; for (let i = 0; i < n;) { d = somaDias(d, 1); if (ehUtil(d)) i += 1; } return d; };

/** Fim do prazo de envio (ms) de um pedido comprado em `compraMs`, com `dias` úteis e o corte da fulfillment. */
export function fimPrazoEnvio(compraMs, dias, corteHoraEt = null) {
  const p = partesET(compraMs);
  let limite;
  if (corteHoraEt != null) {
    const noCorte = ehUtil(p.ymd) && (p.hh < corteHoraEt || (p.hh === corteHoraEt && p.mm === 0 && p.ss === 0));
    limite = somaUteis(noCorte ? p.ymd : somaUteis(p.ymd, 1), Math.max(0, dias - 1));
  } else limite = somaUteis(p.ymd, dias);
  return fimDoDiaET(limite);
}

/**
 * Instante de compra a partir do qual o pedido AINDA está no prazo agora: comprado antes dele = atrasado.
 * O fim do prazo cresce com a hora da compra, então uma busca binária (precisão de 1 s) acha a virada.
 */
export function limiteCompra(dias, corteHoraEt = null, agoraMs = Date.now()) {
  let lo = agoraMs - 120 * DIA, hi = agoraMs;   // lo: atrasado com certeza (prazo ≤ 60 dias úteis); hi: comprado agora, no prazo
  while (hi - lo > 1000) {
    const meio = Math.floor((lo + hi) / 2);
    if (fimPrazoEnvio(meio, dias, corteHoraEt) < agoraMs) lo = meio; else hi = meio;
  }
  return new Date(hi);
}
