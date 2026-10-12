/** Cliente da API do 17TRACK (v2.4). A chave vem de SEVENTEEN_TRACK_API_KEY e NUNCA é registrada em log. */
import { emLotes } from './normalizar.js';

const BASE = 'https://api.17track.net/track/v2.4/';
export const chaveConfigurada = () => Boolean((process.env.SEVENTEEN_TRACK_API_KEY ?? '').trim());
const chave = () => (process.env.SEVENTEEN_TRACK_API_KEY ?? '').trim();

async function chamar(caminho, corpo, tentativas = 3) {
  if (!chaveConfigurada()) throw new Error('SEVENTEEN_TRACK_API_KEY não configurada');
  let ultimo;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(BASE + caminho, {
        method: 'POST',
        headers: { '17token': chave(), 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`17TRACK ${caminho}: HTTP ${r.status}`);
      const j = await r.json();
      if (j.code !== 0) throw new Error(`17TRACK ${caminho}: código ${j.code}`);
      return j.data ?? {};
    } catch (e) {
      ultimo = e;
      if (i < tentativas) await new Promise((ok) => setTimeout(ok, 1500 * i));
    }
  }
  throw ultimo;
}

/** Registra códigos (1 cota por código aceito). Devolve { aceitos: [...], recusados: [...] } somando os lotes. */
export async function registrar(numeros, { carrierPorNumero = {} } = {}) {
  const aceitos = []; const recusados = [];
  for (const lote of emLotes(numeros, 40)) {
    const d = await chamar('register', lote.map((number) => ({ number, ...(carrierPorNumero[number] ? { carrier: carrierPorNumero[number] } : {}) })));
    aceitos.push(...(d.accepted ?? [])); recusados.push(...(d.rejected ?? []));
  }
  return { aceitos, recusados };
}

/** Consulta o histórico atual (não gasta cota). */
export async function consultar(numeros) {
  const aceitos = []; const rejeitados = [];
  for (const lote of emLotes(numeros, 40)) {
    const d = await chamar('gettrackinfo', lote.map((number) => ({ number })));
    aceitos.push(...(d.accepted ?? [])); rejeitados.push(...(d.rejected ?? []));
  }
  return { aceitos, rejeitados };
}

export const cota = () => chamar('getquota', {});
