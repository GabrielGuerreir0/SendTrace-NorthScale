import test from 'node:test';
import assert from 'node:assert/strict';
import { camada1, precisaAvaliar, assinatura, limparTexto, perguntarIA, BASE, SEM, EVA, OUT, TIPOS } from './reembolsoPlataforma.js';

test('camada 1: sem resposta, ou primeira resposta no dia/depois do reembolso = Sem atendimento; senão vai para a IA', () => {
  assert.equal(camada1({ pResp: null, dr: null }).status, SEM);
  assert.equal(camada1({ pResp: null, dr: '2026-10-01' }).motivo, 'agente nunca respondeu');
  assert.equal(camada1({ pResp: '2026-10-05T15:00:00Z', dr: '2026-10-05' }).status, SEM);        // no dia
  assert.equal(camada1({ pResp: '2026-10-06T15:00:00Z', dr: '2026-10-05' }).status, SEM);        // depois
  assert.equal(camada1({ pResp: '2026-10-04T15:00:00Z', dr: '2026-10-05' }), null);              // antes → IA
  assert.equal(camada1({ pResp: '2026-10-04T15:00:00Z', dr: null }), null);                      // sem data de reembolso → IA
  assert.equal(camada1({ pResp: '2026-10-06T01:00:00Z', dr: '2026-10-05' }).status, SEM, '01:00 UTC de 06/10 ainda é 05/10 em Brasília (22h) → no dia do reembolso');
  assert.equal(camada1({ pResp: '2026-10-05T01:00:00Z', dr: '2026-10-05' }), null, '01:00 UTC de 05/10 é 04/10 em Brasília → antes do reembolso → IA');
});
const T = (o) => ({ caso_id: 1, tipo_resolucao: BASE, propriedades_atualizado_por: 'Sistema', reembolso_plat_origem: null, reembolso_plat_assinatura: null, n_emails: 2, n_resp: 1, dr: null, dcb: null, ...o });
test('gatilho: resolução nova sempre avalia; classificado por pessoa nunca mexe', () => {
  assert.equal(precisaAvaliar(T()), true);
  assert.equal(precisaAvaliar(T({ tipo_resolucao: 'Reversão total do reembolso' })), false);
  assert.equal(precisaAvaliar(T({ tipo_resolucao: EVA, reembolso_plat_origem: 'IA', propriedades_atualizado_por: 'Késsia', reembolso_plat_assinatura: '2|1||' })), false);   // pessoa mudou à mão
  assert.equal(precisaAvaliar(T({ tipo_resolucao: EVA, reembolso_plat_origem: null })), false);                                                                              // escolhido por pessoa, sem marca do sistema
});
test('gatilho: marcação de pessoa vencida pelo reembolso da plataforma (reaberto) reavalia; sem a marca continua intocada', () => {
  const r = { tipo_resolucao: 'Reversão total do reembolso', propriedades_atualizado_por: 'Thalison', dr: '2026-10-17', reaberto: true };
  assert.equal(precisaAvaliar(T(r)), true);
  assert.equal(precisaAvaliar(T({ ...r, reaberto: false })), false);
  assert.equal(precisaAvaliar(T({ ...r, reembolso_plat_assinatura: assinatura(T(r)) })), false, 'já avaliado com a mesma assinatura');
});
test('gatilho: ticket classificado pela IA só reavalia com e-mail novo ou resposta nova; pela camada 1, com qualquer mudança', () => {
  const ia = T({ tipo_resolucao: EVA, reembolso_plat_origem: 'IA', propriedades_atualizado_por: 'Sistema (IA)', reembolso_plat_assinatura: '2|1||' });
  assert.equal(precisaAvaliar(ia), false);
  assert.equal(precisaAvaliar({ ...ia, dr: '2026-10-05' }), false, 'data do reembolso mudou, mas é IA: não reprocessa');
  assert.equal(precisaAvaliar({ ...ia, n_emails: 3 }), true);
  assert.equal(precisaAvaliar({ ...ia, n_resp: 2 }), true);
  const sql = T({ tipo_resolucao: SEM, reembolso_plat_origem: 'SQL', reembolso_plat_assinatura: '2|1||' });
  assert.equal(precisaAvaliar(sql), false);
  assert.equal(precisaAvaliar({ ...sql, dr: '2026-10-05' }), true);
  assert.equal(precisaAvaliar({ ...sql, dcb: '2026-10-06' }), true);
  assert.equal(precisaAvaliar({ ...sql, n_resp: 2 }), true);
  assert.equal(assinatura(T({ dr: '2026-10-05T00:00:00.000Z', dcb: null })), '2|1|2026-10-05|');
});
test('limpeza: tira citação e assinatura e mantém o resto inteiro', () => {
  const t = 'Hello, I want my money back.\nPlease.\n\n> old quoted line\n> another\nOn Mon, Oct 5, 2026 at 3:00 PM Support <s@x.com> wrote:\n> bla\n\n-- \nJohn\n555-1234';
  assert.equal(limparTexto(t), 'Hello, I want my money back.\nPlease.');
  assert.equal(limparTexto('Sem nada a cortar.\nSegunda linha.'), 'Sem nada a cortar.\nSegunda linha.');
  assert.equal(limparTexto('Oi\n-----Original Message-----\nFrom: x\nTo: y'), 'Oi');
  assert.equal(limparTexto(null), '');
});
test('IA: categoria válida, JSON ruim, categoria desconhecida e erro NUNCA viram classificação (falhou)', async () => {
  const api = (txt) => ({ messages: { create: async () => ({ content: [{ text: txt }] }) } });
  const ok = await perguntarIA('conversa', { api: api('{"categoria":"EVASAO_PROVAVEL","confianca":"alta","motivo":"cliente citou o banco"}') });
  assert.deepEqual([ok.categoria, ok.confianca, ok.falhou], ['EVASAO_PROVAVEL', 'alta', undefined]);
  assert.equal((await perguntarIA('c', { api: api('{"categoria":"OUTROS","confianca":"talvez","motivo":"x"}') })).confianca, 'baixa', 'confiança inválida vira baixa (vai para revisão)');
  assert.equal((await perguntarIA('c', { api: api('lixo') })).falhou, true);
  assert.equal((await perguntarIA('c', { api: api('{"categoria":"TALVEZ"}') })).falhou, true);
  assert.equal((await perguntarIA('c', { api: { messages: { create: async () => { throw new Error('boom'); } } } })).falhou, true);
  assert.equal((await perguntarIA('c', { api: null })).falhou, true);
});
test('os três nomes e a família', () => { assert.deepEqual(TIPOS, [BASE, SEM, EVA, OUT]); assert.equal(SEM, 'Reembolsado pela plataforma - Sem atendimento'); assert.equal(EVA, 'Reembolsado pela plataforma - Evasão provável'); assert.equal(OUT, 'Reembolsado pela plataforma - Outros'); });
