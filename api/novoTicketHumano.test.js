import test from 'node:test';
import assert from 'node:assert/strict';
import { separarEntradas, prepararAlvos, resumirAlvos, alvosEnviaveis, montarMensagem, dadosFaltando, validarConteudo, escolherBoard } from './novoTicketHumano.js';

const linhas = [
  { transacao_id: 'T1', numero_pedido: '1001', nome: 'ana souza', email: 'ana@ex.com', produto: 'Prod A', plataforma: 'jvzoo', fulfillment: 'redrock', carrier_code: 'usps', tracking_number: 'Z1', tracking_url: null, data: '2026-10-01' },
  { transacao_id: 'T2', numero_pedido: '1002', nome: 'ana souza', email: 'ana@ex.com', produto: 'Prod B', plataforma: 'jvzoo', fulfillment: 'redrock', carrier_code: null, tracking_number: null, tracking_url: null, data: '2026-11-01' },
  { transacao_id: 'T3', numero_pedido: '1003', nome: 'bruno lima', email: 'bruno@ex.com', produto: 'Prod C', plataforma: 'jvzoo', fulfillment: null, carrier_code: null, tracking_number: null, tracking_url: null, data: '2026-11-02' },
  { transacao_id: 'T4', numero_pedido: '1004', nome: 'carla', email: 'carla@ex.com', produto: 'Prod D', plataforma: 'buygoods', fulfillment: null, carrier_code: null, tracking_number: null, tracking_url: null, data: '2026-11-03' },
];

test('parser da lista: vírgula, linha, espaço e < >, sem repetir', () => {
  assert.deepEqual(separarEntradas('Ana@Ex.com, 1001\n<bruno@ex.com>;1001  #1002'), ['Ana@Ex.com', '1001', 'bruno@ex.com', '1002']);
});

test('um ticket por cliente: dois pedidos do mesmo e-mail na lista viram um só', () => {
  const r = prepararAlvos(['ana@ex.com', '1001', '1002'], linhas);
  assert.equal(r.filter((i) => i.situacao === 'novo').length, 1);
  assert.equal(r.filter((i) => i.situacao === 'repetido').length, 2);
  assert.equal(r[0].pedido_transacao_id, 'T2');   // por e-mail: o pedido mais recente
});

test('e-mail que já tem ticket não abre outro e mostra o ticket existente', () => {
  const r = prepararAlvos(['bruno@ex.com', '1004'], linhas, [{ id: 77, remetente_email: 'BRUNO@ex.com', status: 'esperando_resposta', origem: null, agente: 'Ana' }]);
  assert.equal(r[0].situacao, 'ticket_existente'); assert.equal(r[0].ticket_id, 77); assert.equal(r[0].ticket_agente, 'Ana');
  assert.equal(r[1].situacao, 'novo');
  assert.deepEqual(alvosEnviaveis(r).map((i) => i.email), ['carla@ex.com']);
});

test('cliente em contato pelo Suporte Ativo é bloqueado (a resposta ficaria isolada lá)', () => {
  const r = prepararAlvos(['carla@ex.com'], linhas, [], ['carla@ex.com']);
  assert.equal(r[0].situacao, 'isolado_no_ativo');
  assert.equal(alvosEnviaveis(r).length, 0);
});

test('alerta de contato duplicado: por e-mail OU por pedido; não bloqueia', () => {
  const contatos = [
    { email: 'ana@ex.com', transacao_id: null, pedido_transacao_id: null, tipo: 'resposta_agente', por: 'Zé', quando: '2026-11-20T10:00:00Z', ticket_id: 5 },
    { email: 'outro@ex.com', transacao_id: 'T3', pedido_transacao_id: 'T3', tipo: 'email_equipe', por: 'Lia', quando: '2026-11-25T10:00:00Z', ticket_id: 9 },
    { email: 'zzz@ex.com', transacao_id: 'T9', pedido_transacao_id: 'T9', tipo: 'envio', por: 'X', quando: '2026-11-25T10:00:00Z', ticket_id: 1 },
  ];
  const r = prepararAlvos(['ana@ex.com', 'bruno@ex.com', 'carla@ex.com'], linhas, [], [], contatos);
  assert.equal(r[0].situacao, 'novo'); assert.equal(r[0].contatos_anteriores.length, 1);
  assert.equal(r[1].contatos_anteriores.length, 1);   // mesmo pedido T3 (e-mail diferente)
  assert.equal(r[2].contatos_anteriores.length, 0);
  const res = resumirAlvos(r);
  assert.equal(res.novos, 3); assert.equal(res.com_contato_anterior, 2); assert.equal(res.sem_pedido, 0);
});

test('entradas sem pedido, inválidas e não encontradas', () => {
  const r = prepararAlvos(['novo@cli.com', 'x@@y', '99999'], linhas);
  assert.equal(r[0].situacao, 'novo'); assert.equal(r[0].pedido_transacao_id, null);
  assert.equal(r[1].situacao, 'invalido'); assert.equal(r[2].situacao, 'nao_encontrado');
  assert.equal(resumirAlvos(r).sem_pedido, 1);
});

test('montarMensagem: cada cliente recebe só os dados dele', () => {
  const r = prepararAlvos(['ana@ex.com', 'bruno@ex.com'], linhas);
  const modelo = 'Hi {nome}, order {pedido} ({produto}). Tracking: {rastreio}.\n{assinatura}';
  const a = montarMensagem('Order {pedido}', modelo, r[0], 'Care Team');
  const b = montarMensagem('Order {pedido}', modelo, r[1], 'Care Team');
  assert.equal(a.assunto, 'Order 1002'); assert.match(a.texto, /^Hi Ana, order 1002 \(Prod B\)/);
  assert.equal(b.assunto, 'Order 1003'); assert.match(b.texto, /^Hi Bruno/);
  assert.ok(!b.texto.includes('Ana') && !b.texto.includes('1002'));
  assert.match(a.texto, /Care Team$/);
});

test('montarMensagem: cliente sem pedido não recebe chave interna', () => {
  const r = prepararAlvos(['novo@cli.com'], linhas);
  const m = montarMensagem('Order {pedido}', 'Hi {nome}, order {pedido}.', r[0], 'Team');
  assert.equal(m.assunto, 'Order'); assert.match(m.texto, /^Hi there, order \./);
  assert.ok(!/avulso|T\d/.test(m.texto));
});

test('dadosFaltando avisa quando o marcador usado não tem dado', () => {
  const r = prepararAlvos(['novo@cli.com', 'ana@ex.com'], linhas);
  assert.deepEqual(dadosFaltando('x', 'Order {pedido} tracking {rastreio}', r[0]), ['pedido', 'rastreio']);
  assert.deepEqual(dadosFaltando('x', 'Order {pedido}', r[1]), []);
  assert.deepEqual(dadosFaltando('x', 'no markers', r[0]), []);
});

test('validarConteudo: modelo preenche, idioma pt usa o texto em português, marcador inválido é recusado', () => {
  const modelo = { assunto_en: 'Hello', corpo_en: 'Hi {nome}, welcome.', assunto_pt: 'Olá', corpo_pt: 'Oi {nome}, bem-vindo.' };
  assert.deepEqual(validarConteudo({}, modelo).valor, { assunto: 'Hello', texto: 'Hi {nome}, welcome.', idioma: 'en' });
  assert.deepEqual(validarConteudo({ idioma: 'pt' }, modelo).valor, { assunto: 'Olá', texto: 'Oi {nome}, bem-vindo.', idioma: 'pt' });
  assert.deepEqual(validarConteudo({ assunto: 'Meu', texto: 'Texto livre ok' }).valor, { assunto: 'Meu', texto: 'Texto livre ok', idioma: 'en' });
  assert.match(validarConteudo({ assunto: 'a', texto: 'Hi {xyz}' }).erro, /Marcador desconhecido/);
  assert.ok(validarConteudo({ assunto: '', texto: 'Texto livre ok' }).erro);
  assert.ok(validarConteudo({ assunto: 'a', texto: 'abc' }).erro);
  assert.ok(validarConteudo({ assunto: 'a', texto: 'Texto livre ok', idioma: 'fr' }).erro);
});

test('escolherBoard: agente só no próprio; gestor em qualquer um; gestor sem escolha precisa escolher', () => {
  const boards = [{ id: 1 }, { id: 2 }];
  assert.equal(escolherBoard({ pedido: undefined, meuBoardId: 1, gestor: false, boards }).valor, 1);
  assert.match(escolherBoard({ pedido: 2, meuBoardId: 1, gestor: false, boards }).erro, /não é seu/);
  assert.equal(escolherBoard({ pedido: '2', meuBoardId: 1, gestor: true, boards }).valor, 2);
  assert.ok(escolherBoard({ pedido: null, meuBoardId: null, gestor: true, boards }).erro);
  assert.ok(escolherBoard({ pedido: null, meuBoardId: null, gestor: false, boards }).erro);
  assert.match(escolherBoard({ pedido: 9, meuBoardId: 1, gestor: true, boards }).erro, /não encontrado/);
});
