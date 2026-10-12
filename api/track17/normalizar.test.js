import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizarItem, classificarRecusa, assinaturaValida, emLotes, chaveEvento } from './normalizar.js';

const fx = JSON.parse(readFileSync(new URL('./__fixtures__/gettrackinfo.json', import.meta.url), 'utf8'));

test('normaliza o histórico real: status e substatus originais, mais novo primeiro', () => {
  const n = normalizarItem(fx.accepted[0]);
  assert.equal(n.ultimoStatus, 'Delivered');
  assert.equal(n.ultimoSubstatus, 'Delivered_Other');
  assert.equal(n.eventos.length, 10);
  assert.equal(n.eventos[0].status, 'Delivered');
  for (let i = 1; i < n.eventos.length; i++) assert.ok(n.eventos[i - 1].ocorreuEm >= n.eventos[i].ocorreuEm);
  assert.equal(n.ultimoEventoEm, n.eventos[0].ocorreuEm);
});

test('local do evento: só cidade, estado e país (nunca CEP, rua ou coordenadas)', () => {
  for (const e of normalizarItem(fx.accepted[0]).eventos) {
    assert.deepEqual(Object.keys(e).filter((k) => /cep|postal|rua|street|coord/i.test(k)), []);
  }
});

test('mesmo evento gera a mesma chave (idempotência); evento diferente, outra', () => {
  const a = normalizarItem(fx.accepted[0]); const b = normalizarItem(fx.accepted[0]);
  assert.deepEqual(a.eventos.map((e) => e.chave), b.eventos.map((e) => e.chave));
  assert.equal(new Set(a.eventos.map((e) => e.chave)).size, a.eventos.length);
  assert.notEqual(chaveEvento('X', { ocorreuEm: '1', status: 'a' }), chaveEvento('Y', { ocorreuEm: '1', status: 'a' }));
});

test('item sem rastreio não quebra', () => {
  const n = normalizarItem({ number: 'ABC', track_info: {} });
  assert.equal(n.numero, 'ABC'); assert.deepEqual(n.eventos, []); assert.equal(n.ultimoStatus, null);
});

test('classifica as recusas vistas no teste de 12/10', () => {
  assert.equal(classificarRecusa({ code: -18019823, message: "policy restrictions of the carrier 'USPS'" }).situacao, 'recusado');
  assert.equal(classificarRecusa({ code: -18019823, message: 'x' }).codigo, -18019823);
  assert.equal(classificarRecusa({ code: -18019909, message: 'No tracking information at this time.' }).situacao, 'sem_dado');
});

test('assinatura do webhook: sha256(corpo + "/" + chave)', () => {
  const corpo = Buffer.from('{"event":"TRACKING_UPDATED","data":{"number":"X"}}');
  const sign = crypto.createHash('sha256').update(Buffer.concat([corpo, Buffer.from('/segredo')])).digest('hex');
  assert.ok(assinaturaValida(corpo, sign, 'segredo'));
  assert.ok(assinaturaValida(corpo, sign.toUpperCase(), 'segredo'));
  assert.ok(!assinaturaValida(corpo, sign, 'outra'));
  assert.ok(!assinaturaValida(Buffer.from('adulterado'), sign, 'segredo'));
  assert.ok(!assinaturaValida(corpo, '', 'segredo'));
  assert.ok(!assinaturaValida(corpo, 'zz', 'segredo'));
  assert.ok(!assinaturaValida(corpo, sign, ''));
});

test('lotes de 40', () => {
  assert.deepEqual(emLotes(Array.from({ length: 85 }, (_, i) => i)).map((l) => l.length), [40, 40, 5]);
  assert.deepEqual(emLotes([]), []);
});
