import test from 'node:test';
import assert from 'node:assert/strict';
import { fimPrazoEnvio, limiteCompra, ehUtil } from './prazoEnvio.js';

// horários em Nova York (EST, UTC-5, em novembro)
const et = (s) => Date.parse(`${s}-05:00`);
const fim = (s) => new Date(et(`${s}T23:59:59.999`)).toISOString();

test('Jetpack, 2 dias úteis com corte às 14h ET', () => {
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-16T13:59:00'), 2, 14)).toISOString(), fim('2026-11-17'));   // segunda antes do corte: seg conta
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-16T14:00:00'), 2, 14)).toISOString(), fim('2026-11-17'));   // 14:00:00 em ponto ainda conta
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-16T14:00:01'), 2, 14)).toISOString(), fim('2026-11-18'));   // depois do corte: começa terça
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-13T16:00:00'), 2, 14)).toISOString(), fim('2026-11-17'));   // sexta à tarde: seg + ter
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-14T10:00:00'), 2, 14)).toISOString(), fim('2026-11-17'));   // sábado: seg + ter
});

test('FullStack, 3 dias úteis sem corte, pulando feriado (Thanksgiving 26/11/2026)', () => {
  assert.equal(new Date(fimPrazoEnvio(et('2026-11-24T09:00:00'), 3, null)).toISOString(), fim('2026-11-30'));   // qua, (qui feriado), sex, seg
  assert.equal(ehUtil('2026-11-26'), false);
  assert.equal(ehUtil('2026-11-27'), true);
});

test('limiteCompra: comprado antes do limite está atrasado, no limite ainda não', () => {
  const agora = et('2026-11-17T10:00:00');
  for (const [dias, corte] of [[2, 14], [3, null], [0, 14]]) {
    const L = limiteCompra(dias, corte, agora).getTime();
    assert.ok(fimPrazoEnvio(L - 1000, dias, corte) < agora, `dias=${dias}`);
    assert.ok(fimPrazoEnvio(L, dias, corte) >= agora, `dias=${dias}`);
  }
  assert.equal(limiteCompra(2, 14, agora).toISOString().slice(0, 16), new Date(et('2026-11-13T14:00:01')).toISOString().slice(0, 16));   // sexta 14h ET
});
