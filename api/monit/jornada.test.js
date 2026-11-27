// node --test api/monit/jornada.test.js — "Jornada do pedido": faixas de ritmo, unidades (dias úteis x corridos), etapa em andamento e 1º movimento.
import test from 'node:test';
import assert from 'node:assert/strict';
import { faixaRitmo, textoDuracao, montarJornada, primeiroMovimento } from './jornada.js';

test('faixaRitmo: até 2 rápido, 3 a 6 médio, 7 ou mais lento', () => {
  assert.equal(faixaRitmo(0), 'rapido'); assert.equal(faixaRitmo(2), 'rapido');
  assert.equal(faixaRitmo(3), 'medio'); assert.equal(faixaRitmo(6.9), 'medio');
  assert.equal(faixaRitmo(7), 'lento'); assert.equal(faixaRitmo(30), 'lento');
  assert.equal(faixaRitmo(null), null);
});

test('textoDuracao: minutos, horas e dias', () => {
  assert.equal(textoDuracao(10 * 60_000), '10 min'); assert.equal(textoDuracao(5 * 3_600_000), '5 h');
  assert.equal(textoDuracao(86_400_000), '1 dia'); assert.equal(textoDuracao(4 * 86_400_000 + 3_600_000), '4 dias');
  assert.equal(textoDuracao(0), '1 min');
});

test('montarJornada: pedido entregue — etapas feitas, dias úteis vindos do banco e coleta → entrega em dias corridos', () => {
  const j = montarJornada({ pedido: '2026-11-16T15:00:00Z', codigo: '2026-11-18T15:00:00Z', coleta: '2026-11-20T15:00:00Z', entrega: '2026-11-30T15:00:00Z', agora: '2026-12-02T00:00:00Z', diasUteis: { ped_cod: 2, cod_mov: 2 } });
  assert.deepEqual(j.etapas.map((e) => [e.chave, e.estado, e.unidade, e.faixa]), [['ped_cod', 'feita', 'uteis', 'rapido'], ['cod_mov', 'feita', 'uteis', 'rapido'], ['mov_ent', 'feita', 'corridos', 'lento']]);
  assert.equal(j.etapas[0].texto, '2 dias úteis'); assert.equal(j.etapas[2].dias, 10); assert.equal(j.etapas[2].texto, '10 dias');
  assert.equal(j.total.concluido, true); assert.equal(Math.round(j.total.dias), 14); assert.equal(j.total.faixa, 'lento');
  assert.equal(j.marcos.length, 4); assert.ok(j.marcos.every((m) => m.quando));
});

test('montarJornada: ainda sem coleta — a etapa em andamento conta até agora; as seguintes ficam pendentes', () => {
  const j = montarJornada({ pedido: '2026-11-10T12:00:00Z', codigo: '2026-11-11T12:00:00Z', coleta: null, entrega: null, agora: '2026-11-24T12:00:00Z', diasUteis: { ped_cod: 1, cod_mov: 9 } });
  assert.equal(j.etapas[0].estado, 'feita'); assert.equal(j.etapas[0].texto, '1 dia útil');
  assert.equal(j.etapas[1].estado, 'andamento'); assert.equal(j.etapas[1].dias, 9); assert.equal(j.etapas[1].faixa, 'lento'); assert.match(j.etapas[1].texto, /até agora/);
  assert.equal(j.etapas[2].estado, 'pendente'); assert.equal(j.etapas[2].dias, null); assert.equal(j.total.concluido, false);
});

test('montarJornada: pedido sem código; menos de 1 dia útil mostra horas; dias úteis ausentes viram 0', () => {
  const sem = montarJornada({ pedido: '2026-11-10T12:00:00Z', agora: '2026-11-10T14:00:00Z' });
  assert.equal(sem.etapas[0].estado, 'andamento'); assert.equal(sem.etapas[1].estado, 'pendente');
  assert.equal(sem.etapas[0].texto, 'menos de 1 dia útil (2 h) até agora'); assert.equal(sem.etapas[0].faixa, 'rapido');
  const nada = montarJornada({ agora: '2026-11-10T14:00:00Z' });
  assert.ok(nada.etapas.every((e) => e.estado === 'pendente')); assert.equal(nada.total.dias, null);
});

test('primeiroMovimento: ignora etiqueta criada e textos de etiqueta; só vale até 1 dia antes do código', () => {
  const ev = [
    { ocorreu_em: '2026-11-11T10:00:00Z', status: 'InfoReceived', descricao: 'Shipping label created' },
    { ocorreu_em: '2026-11-12T10:00:00Z', status: 'InTransit', descricao: 'Label printed' },
    { ocorreu_em: '2026-11-13T10:00:00Z', status: 'InTransit', descricao: 'Departed facility' },
    { ocorreu_em: '2026-11-15T10:00:00Z', status: 'InTransit', descricao: 'Arrived' },
  ];
  assert.equal(primeiroMovimento(ev, '2026-11-11T12:00:00Z').toISOString(), '2026-11-13T10:00:00.000Z');
  assert.equal(primeiroMovimento(ev, '2026-11-20T00:00:00Z'), null);                // movimento mais de 1 dia ANTES do código: não vale
  assert.equal(primeiroMovimento(ev, null), null);                                   // sem código não há coleta
  assert.equal(primeiroMovimento([{ ocorreu_em: '2026-11-11T10:00:00Z', substatus: 'InfoReceived_Ok', descricao: 'x' }], '2026-11-11T00:00:00Z'), null);
});
