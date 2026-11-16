import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perguntasVisiveis, proximaPergunta, validarResposta, validarPergunta, grupoDoEstorno } from './pesquisaEstorno.js';

const P = [
  { chave: 'reconhece', grupo: 'banco', ordem: 10, tipo: 'unica', opcoes: [{ valor: 'sim' }, { valor: 'nao' }], obrigatoria: true },
  { chave: 'motivo', grupo: 'todos', ordem: 20, tipo: 'unica', opcoes: [{ valor: 'sem_resultado' }, { valor: 'nao_chegou' }, { valor: 'outro' }],
    mostrar_se: { pergunta: 'reconhece', valores: ['sim'] }, obrigatoria: true },
  { chave: 'tempo_uso', grupo: 'todos', ordem: 30, tipo: 'unica', opcoes: [{ valor: 'a' }, { valor: 'b' }], mostrar_se: { pergunta: 'motivo', valores: ['sem_resultado'] }, obrigatoria: true },
  { chave: 'contatou_suporte', grupo: 'todos', ordem: 40, tipo: 'unica', opcoes: [{ valor: 'nao' }, { valor: 'sim' }], mostrar_se: { pergunta: 'reconhece', valores: ['sim'] }, obrigatoria: true },
  { chave: 'nota', grupo: 'todos', ordem: 50, tipo: 'nota', obrigatoria: false, mostrar_se: { pergunta: 'reconhece', valores: ['sim'] } },
  { chave: 'comentario', grupo: 'todos', ordem: 60, tipo: 'texto', obrigatoria: false },
  { chave: 'velha', grupo: 'todos', ordem: 70, tipo: 'texto', obrigatoria: false, ativa: false },
];
const chaves = (l) => l.map((p) => p.chave);

test('grupo do estorno', () => {
  assert.equal(grupoDoEstorno('REFUND'), 'reembolso');
  assert.equal(grupoDoEstorno('ALERT'), 'banco');
  assert.equal(grupoDoEstorno('dispute'), 'banco');
  assert.equal(grupoDoEstorno(null), 'reembolso');
});

test('reembolso: sem a pergunta do banco, motivo aparece direto (condição citando pergunta ausente vale)', () => {
  assert.deepEqual(chaves(perguntasVisiveis(P, 'reembolso', {})), ['motivo', 'contatou_suporte', 'nota', 'comentario']);
  assert.equal(proximaPergunta(P, 'reembolso', {}).chave, 'motivo');
  assert.equal(proximaPergunta(P, 'reembolso', { motivo: 'sem_resultado' }).chave, 'tempo_uso');
  assert.equal(proximaPergunta(P, 'reembolso', { motivo: 'nao_chegou' }).chave, 'contatou_suporte');
});

test('banco: começa por reconhece; quem não reconhece termina ali (e o comentário opcional fica)', () => {
  assert.equal(proximaPergunta(P, 'banco', {}).chave, 'reconhece');
  assert.deepEqual(chaves(perguntasVisiveis(P, 'banco', { reconhece: 'nao' })), ['reconhece', 'comentario']);
  assert.equal(proximaPergunta(P, 'banco', { reconhece: 'nao', comentario: null }), null);
  assert.equal(proximaPergunta(P, 'banco', { reconhece: 'sim' }).chave, 'motivo');
});

test('pergunta desativada nunca aparece; pulada conta como respondida', () => {
  const r = { motivo: 'outro', contatou_suporte: 'nao', nota: null, comentario: null };
  assert.equal(proximaPergunta(P, 'reembolso', r), null);
  assert.ok(!chaves(perguntasVisiveis(P, 'reembolso', r)).includes('velha'));
});

test('validarResposta', () => {
  assert.deepEqual(validarResposta(P[1], 'outro'), { ok: true, valor: 'outro' });
  assert.equal(validarResposta(P[1], 'x').ok, false);
  assert.equal(validarResposta(P[1], '').ok, false);
  assert.deepEqual(validarResposta(P[4], ''), { ok: true, valor: null });
  assert.deepEqual(validarResposta(P[4], '10'), { ok: true, valor: '10' });
  assert.equal(validarResposta(P[4], '11').ok, false);
  assert.equal(validarResposta(P[5], 'a'.repeat(2000)).valor.length, 1000);
});

test('validarPergunta: opções, condição e ordem', () => {
  const base = { chave: 'nova', grupo: 'todos', tipo: 'unica', ordem: 35, texto: 'Was it easy?', opcoes: [{ valor: 'sim', rotulo: 'Yes' }, { valor: 'nao', rotulo: 'No' }] };
  assert.equal(validarPergunta(base, P).ok, true);
  assert.equal(validarPergunta({ ...base, opcoes: [{ valor: 'sim', rotulo: 'Yes' }] }, P).ok, false);
  assert.equal(validarPergunta({ ...base, opcoes: [{ valor: 'Sim!', rotulo: 'Yes' }, { valor: 'nao', rotulo: 'No' }] }, P).ok, false);
  assert.equal(validarPergunta({ ...base, mostrar_se: { pergunta: 'motivo', valores: ['outro'] } }, P).ok, true);
  assert.equal(validarPergunta({ ...base, mostrar_se: { pergunta: 'motivo', valores: ['inexistente'] } }, P).ok, false);
  assert.equal(validarPergunta({ ...base, ordem: 5, mostrar_se: { pergunta: 'motivo', valores: ['outro'] } }, P).ok, false);
  assert.equal(validarPergunta({ ...base, tipo: 'texto', opcoes: [] }, P).pergunta.obrigatoria, false);
});
