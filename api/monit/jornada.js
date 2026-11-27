/**
 * MONIT-SPPL — "Jornada do pedido" da ficha (spec seção 9, "faixas de ritmo", e 13.5). Funções PURAS (sem banco), testáveis com `node --test`.
 *
 * A jornada tem quatro marcos — Pedido, Código gerado, Coleta (1º movimento real da transportadora) e Entrega — e três etapas entre eles:
 *   ped_cod  Pedido → código      DIAS ÚTEIS (segunda a sexta, menos `sppl_feriados`, fuso America/New_York)
 *   cod_mov  Código → coleta      DIAS ÚTEIS
 *   mov_ent  Coleta → entrega     dias CORRIDOS
 * Faixas de ritmo: até 2 dias é rápido, de 3 a 6 é médio, 7 ou mais é lento. Menos de 1 dia mostra horas ou minutos.
 * Etapa sem o marco final ainda está EM ANDAMENTO (conta até agora); sem o marco inicial é PENDENTE.
 * Os dias úteis chegam prontos do banco (`monit_dias_uteis`, a mesma função da classificação): aqui não se recalcula calendário.
 */

export const MARCOS = [
  { chave: 'pedido', rotulo: 'Pedido feito' },
  { chave: 'codigo', rotulo: 'Código de rastreio gerado' },
  { chave: 'coleta', rotulo: 'Coleta (1º movimento)' },
  { chave: 'entrega', rotulo: 'Entrega' },
];

/** [chave, marco de início, marco de fim, unidade, rótulo] */
export const ETAPAS = [
  ['ped_cod', 'pedido', 'codigo', 'uteis', 'Pedido → código'],
  ['cod_mov', 'codigo', 'coleta', 'uteis', 'Código → coleta'],
  ['mov_ent', 'coleta', 'entrega', 'corridos', 'Coleta → entrega'],
];

const DIA_MS = 86_400_000;
const t = (v) => (v ? new Date(v).getTime() : NaN);

/** Faixa de ritmo de uma duração em dias: 'rapido' (até 2), 'medio' (3 a 6), 'lento' (7 ou mais). `null` sem valor. */
export function faixaRitmo(dias) {
  if (dias === null || dias === undefined || Number.isNaN(Number(dias))) return null;
  return Number(dias) <= 2 ? 'rapido' : Number(dias) < 7 ? 'medio' : 'lento';
}

/** "5 min", "3 h", "1 dia", "4 dias" a partir de milissegundos corridos (menos de 1 dia mostra horas ou minutos). */
export function textoDuracao(ms) {
  const m = Math.max(0, ms);
  if (m < 3_600_000) return `${Math.max(1, Math.round(m / 60_000))} min`;
  if (m < DIA_MS) return `${Math.floor(m / 3_600_000)} h`;
  const d = Math.floor(m / DIA_MS);
  return `${d} dia${d === 1 ? '' : 's'}`;
}

/**
 * Monta a jornada.
 * @param {object} p
 * @param {*} p.pedido   data do pedido            @param {*} p.codigo  data de geração do código (shipped_at, só com código)
 * @param {*} p.coleta   1º movimento real          @param {*} p.entrega data da entrega
 * @param {*} p.agora    "agora" (injetável nos testes)
 * @param {{ped_cod?: number|null, cod_mov?: number|null}} p.diasUteis dias úteis de cada etapa de dias úteis (até o marco final ou até agora)
 * @returns {{ marcos: object[], etapas: object[], total: object }}
 */
export function montarJornada({ pedido, codigo, coleta, entrega, agora = new Date(), diasUteis = {} }) {
  const quando = { pedido, codigo, coleta, entrega };
  const marcos = MARCOS.map((m) => ({ ...m, quando: quando[m.chave] ?? null }));
  const now = t(agora);
  const etapas = ETAPAS.map(([chave, de, ate, unidade, rotulo]) => {
    const ini = t(quando[de]); const fim = t(quando[ate]);
    const base = { chave, rotulo, de, ate, unidade, dias: null, texto: null, faixa: null, estado: 'pendente' };
    if (Number.isNaN(ini)) return base;
    const feita = !Number.isNaN(fim);
    const ate_ms = feita ? fim : now;
    const corridoMs = Math.max(0, ate_ms - ini);
    let dias; let texto;
    if (unidade === 'uteis') {
      dias = Number(diasUteis[chave] ?? 0);
      if (!Number.isFinite(dias) || dias < 0) dias = 0;
      texto = dias >= 1 ? `${dias} ${dias === 1 ? 'dia útil' : 'dias úteis'}` : `menos de 1 dia útil (${textoDuracao(corridoMs)})`;
    } else {
      dias = corridoMs / DIA_MS;
      texto = textoDuracao(corridoMs);
    }
    return { ...base, dias, texto: feita ? texto : `${texto} até agora`, faixa: faixaRitmo(dias), estado: feita ? 'feita' : 'andamento' };
  });
  // total: pedido → entrega (ou até agora), em dias corridos
  const ini = t(pedido);
  const fimTotal = Number.isNaN(t(entrega)) ? now : t(entrega);
  const total = Number.isNaN(ini) ? { dias: null, texto: null, faixa: null, concluido: false }
    : { dias: Math.max(0, fimTotal - ini) / DIA_MS, texto: textoDuracao(fimTotal - ini), faixa: faixaRitmo(Math.max(0, fimTotal - ini) / DIA_MS), concluido: !Number.isNaN(t(entrega)) };
  return { marcos, etapas, total };
}

/**
 * Escolhe a data da coleta (1º movimento real) entre os eventos do código atual: o mais antigo cujo status não é etiqueta criada (InfoReceived) nem texto
 * "label / data received / data was sent / created" — e só vale se vier no máximo 1 dia antes do código (mesma regra da aba Prazos).
 * `eventos`: [{ ocorreu_em, status, substatus, descricao }].
 */
export function primeiroMovimento(eventos, codigo) {
  let melhor = NaN;
  for (const e of eventos ?? []) {
    const st = e.status ?? (e.substatus ? String(e.substatus).split('_')[0] : null);
    if (st === 'InfoReceived') continue;
    const d = String(e.descricao ?? '');
    if (/label|data received|data was sent/i.test(d) || d.trim().toLowerCase() === 'created') continue;
    const x = t(e.ocorreu_em); if (Number.isNaN(x)) continue;
    if (Number.isNaN(melhor) || x < melhor) melhor = x;
  }
  if (Number.isNaN(melhor)) return null;
  const cod = t(codigo);
  if (Number.isNaN(cod) || melhor < cod - DIA_MS) return null;   // sem código não há "coleta" (como na aba Prazos)
  return new Date(melhor);
}
