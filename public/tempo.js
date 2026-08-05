/**
 * Conversão entre a unidade que a pessoa escolhe no painel (minutos, horas,
 * dias) e o que o banco — e o n8n — entendem: `espera_h`, sempre em horas
 * decimais. Um arquivo só, importado pelo servidor E pela tela, como
 * `copy.js`: a mesma regra nos dois lados, em vez de um par que diverge.
 */

/** Teto de segurança: 30 dias. Acima disso é quase certo erro de digitação. */
export const TETO_HORAS_ESPERA = 24 * 30;

/** UI → banco. Lança se a unidade ou o valor não fizerem sentido. */
export function paraEsperaH(valor, unidade) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('O tempo precisa ser um número maior ou igual a zero.');
  }
  let horas;
  if (unidade === 'minutos') horas = n / 60;
  else if (unidade === 'horas') horas = n;
  else if (unidade === 'dias') horas = n * 24;
  else throw new Error("Unidade inválida — use 'minutos', 'horas' ou 'dias'.");

  if (horas > TETO_HORAS_ESPERA) {
    throw new Error(`O tempo máximo entre etapas é ${TETO_HORAS_ESPERA / 24} dias.`);
  }
  return horas;
}

/**
 * Banco → UI, para abrir o formulário já preenchido na unidade mais legível.
 * `null` (etapa sem próxima) devolve `valor: null` — a tela mostra texto fixo.
 */
export function deEsperaH(esperaH) {
  if (esperaH === null || esperaH === undefined) return { valor: null, unidade: 'horas' };
  if (esperaH >= 24 && esperaH % 24 === 0) return { valor: esperaH / 24, unidade: 'dias' };
  if (esperaH >= 1) return { valor: esperaH, unidade: 'horas' };
  return { valor: Math.round(esperaH * 60), unidade: 'minutos' };
}
