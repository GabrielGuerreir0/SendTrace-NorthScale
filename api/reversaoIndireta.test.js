import test from 'node:test';
import assert from 'node:assert/strict';
import { tipoPorDias, planejar, perguntarIA, TIPO_ANALISAR, TIPOS_ELEGIVEIS } from './reversaoIndireta.js';

test('faixas de dias da Késsia', () => {
  for (const [d, t] of [[0, null], [9, null], [10, '10D'], [19, '10D'], [20, '30D'], [30, '30D'], [31, '60D'], [60, '60D'], [61, 'concluída - superior a 60D'], [400, 'concluída - superior a 60D']]) {
    const r = tipoPorDias(d); assert.equal(r === null ? null : r.replace('Reversão indireta - ', '').replace('Reversão indireta ', ''), t, `dias=${d}`);
  }
  assert.equal(tipoPorDias(NaN), null);
});
test('os tipos de reversão indireta são elegíveis (o ticket avança de faixa)', () => {
  assert.ok(TIPOS_ELEGIVEIS.includes('Reversão indireta - 10D')); assert.ok(TIPOS_ELEGIVEIS.includes('Reversão total do reembolso')); assert.ok(!TIPOS_ELEGIVEIS.includes('Reembolso parcial'));
});
const tk = (o) => ({ caso_id: 1, tipo_resolucao: 'Verificando - Ag. Cliente', detalhamento_motivo: 'Verificando - Ag. Cliente', dias: 15, ...o });
test('planejar: espera resposta troca tipo e o detalhamento "Verificando - Ag. Cliente"', () => {
  assert.deepEqual(planejar(tk(), { decisao: 'espera_resposta' }), { acao: 'classificar', tipo: 'Reversão indireta - 10D', detalhe: 'Cliente não retornou' });
});
test('planejar: outro detalhamento não muda', () => {
  const p = planejar(tk({ detalhamento_motivo: 'Insatisfação após uso do produto' }), { decisao: 'espera_resposta' });
  assert.equal(p.detalhe, 'Insatisfação após uso do produto'); assert.equal(p.tipo, 'Reversão indireta - 10D');
});
test('planejar: avança de 10D para 30D e não repete a faixa certa', () => {
  assert.equal(planejar(tk({ tipo_resolucao: 'Reversão indireta - 10D', detalhamento_motivo: 'Cliente não retornou', dias: 22 }), { decisao: 'espera_resposta' }).tipo, 'Reversão indireta - 30D');
  assert.equal(planejar(tk({ tipo_resolucao: 'Reversão indireta - 30D', detalhamento_motivo: 'Cliente não retornou', dias: 22 }), { decisao: 'espera_resposta' }).acao, 'nenhuma');
});
test('planejar: menos de 10 dias, mensagem sem pergunta e dúvida', () => {
  assert.equal(planejar(tk({ dias: 9 }), { decisao: 'espera_resposta' }).acao, 'nenhuma');
  assert.equal(planejar(tk(), { decisao: 'nao_espera' }).acao, 'nenhuma');
  assert.deepEqual(planejar(tk(), { decisao: 'duvida' }), { acao: 'analisar', tipo: TIPO_ANALISAR });
  assert.equal(planejar(tk({ tipo_resolucao: TIPO_ANALISAR }), { decisao: 'duvida' }).acao, 'nenhuma');
});
test('IA: resposta válida, JSON ruim e erro viram dúvida (nunca chute)', async () => {
  const api = (txt) => ({ messages: { create: async () => ({ content: [{ text: txt }] }) } });
  assert.equal((await perguntarIA({ assunto: 'a', corpo: 'b' }, { api: api('{"decisao":"espera_resposta","motivo":"pede foto"}') })).decisao, 'espera_resposta');
  assert.equal((await perguntarIA({ assunto: 'a', corpo: 'b' }, { api: api('lixo') })).decisao, 'duvida');
  assert.equal((await perguntarIA({ assunto: 'a', corpo: 'b' }, { api: api('{"decisao":"talvez"}') })).decisao, 'duvida');
  const r = await perguntarIA({ assunto: 'a', corpo: 'b' }, { api: { messages: { create: async () => { throw new Error('boom'); } } } });
  assert.equal(r.decisao, 'duvida'); assert.ok(r.falhou);
  assert.equal((await perguntarIA({ assunto: 'a', corpo: 'b' }, { api: null })).falhou, true);
});
