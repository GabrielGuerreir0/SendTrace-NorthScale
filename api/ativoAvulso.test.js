import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { separarEntradas, classificarEntrada, resolverEntradas, contatosAnteriores, chaveAvulso, ehAvulso, rotuloChave } from './sppl/ativoAvulso.js';
import { personalizar, marcadorInvalido, validarModelo, validarAssinatura, slugModelo, modeloEditado } from './sppl/ativoModelos.js';
import { MARCADORES } from './sppl/ativoConstantes.js';

test('separarEntradas: quebra por linha/vírgula/ponto e vírgula, tira duplicata e <>', () => {
  assert.deepEqual(separarEntradas('A@x.com, b@y.com;\n#123 <A@X.com>\t456'), ['A@x.com', 'b@y.com', '123', '456']);
  assert.deepEqual(separarEntradas(''), []);
});

test('classificarEntrada: e-mail, pedido e inválidos', () => {
  assert.deepEqual(classificarEntrada('Ana@Ex.COM'), { tipo: 'email', valor: 'ana@ex.com' });
  assert.equal(classificarEntrada('ana@@ex').tipo, 'invalido');
  assert.equal(classificarEntrada('JVZ-123_4').tipo, 'pedido');
  assert.equal(classificarEntrada('a b$').tipo, 'invalido');
});

const linhas = [
  { transacao_id: 'T1', numero_pedido: '1001', nome: 'ana souza', email: 'ana@ex.com', produto: 'P', plataforma: 'jvzoo', fulfillment: 'redrock', carrier_code: 'usps', tracking_number: 'Z1', tracking_url: null, data: '2026-10-01' },
  { transacao_id: 'T2', numero_pedido: '1002', nome: 'ana souza', email: 'ana@ex.com', produto: 'Q', plataforma: 'jvzoo', fulfillment: 'redrock', carrier_code: null, tracking_number: null, tracking_url: null, data: '2026-11-01' },
  { transacao_id: 'T3', numero_pedido: 'T3', nome: 'sem mail', email: null, produto: 'P', plataforma: 'jvzoo', fulfillment: null, carrier_code: null, tracking_number: null, tracking_url: null, data: '2026-11-02' },
];

test('resolverEntradas: e-mail com pedidos usa o mais recente; pedido por número; sem pedido vira avulso:<email>', () => {
  const r = resolverEntradas(['ana@ex.com', '1001', 'zzz', 'novo@cli.com', 'x@@y', 'T3'], linhas, []);
  assert.equal(r[0].situacao, 'novo'); assert.equal(r[0].pedido_transacao_id, 'T2'); assert.equal(r[0].chave, 'avulso:T2'); assert.equal(r[0].pedidos_encontrados, 2);
  assert.equal(r[1].situacao, 'novo'); assert.equal(r[1].chave, 'avulso:T1'); assert.equal(r[1].email, 'ana@ex.com'); assert.equal(r[1].transportadora, 'usps');
  assert.equal(r[2].situacao, 'nao_encontrado');
  assert.equal(r[3].situacao, 'novo'); assert.equal(r[3].chave, 'avulso:novo@cli.com'); assert.equal(r[3].pedido_transacao_id, null);
  assert.equal(r[4].situacao, 'invalido');
  assert.equal(r[5].situacao, 'sem_email');
});

test('resolverEntradas: idempotência (ticket aberto do pedido/cliente) e repetido na lista', () => {
  const abertos = [{ id: 9, transacao_id: 'T1', pedido_transacao_id: null, email: 'ana@ex.com', origem: 'logistica' }, { id: 10, transacao_id: 'avulso:novo@cli.com', pedido_transacao_id: null, email: 'novo@cli.com', origem: 'equipe' }];
  const r = resolverEntradas(['1001', 'novo@cli.com', 'NOVO@cli.com', 'ana@ex.com'], linhas, abertos);
  assert.deepEqual([r[0].situacao, r[0].ticket_id], ['ja_existe', 9]);
  assert.deepEqual([r[1].situacao, r[1].ticket_id], ['ja_existe', 10]);
  assert.equal(r[2].situacao, 'repetido');       // a lista já vem deduplicada por separarEntradas; a função protege mesmo assim
  assert.equal(r[3].situacao, 'novo');           // e-mail → pedido mais recente T2, sem ticket aberto
});

test('contatosAnteriores: casa por e-mail ou pedido, mais recentes primeiro, ignora o próprio ticket', () => {
  const c = [
    { email: 'ana@ex.com', transacao_id: 'T1', tipo: 'envio', quando: '2026-11-01', por: 'Kessia', modelo_nome: 'Atraso', ticket_id: 1 },
    { email: 'outra@ex.com', transacao_id: 'T9', tipo: 'envio', quando: '2026-11-02', por: 'X', ticket_id: 2 },
    { email: 'ana@ex.com', transacao_id: 'avulso:T2', pedido_transacao_id: 'T2', tipo: 'ticket', quando: '2026-11-05', por: 'Y', ticket_id: 3 },
    { email: 'z@ex.com', transacao_id: 'T2', tipo: 'envio', quando: '2026-11-03', por: 'W', ticket_id: 4 },
  ];
  const r = contatosAnteriores({ email: 'ANA@ex.com', transacoes: ['T2'] }, c, 5);
  assert.deepEqual(r.map((x) => x.ticket_id), [3, 4, 1]);
  assert.deepEqual(contatosAnteriores({ email: 'ana@ex.com', transacoes: [] }, c, 5, 3).map((x) => x.ticket_id), [1]);
});

test('chave avulso é legível e identificável', () => {
  assert.equal(chaveAvulso('T1', 'a@b.com'), 'avulso:T1'); assert.equal(chaveAvulso(null, 'A@B.com'), 'avulso:a@b.com');
  assert.ok(ehAvulso('avulso:x')); assert.ok(!ehAvulso('T1')); assert.equal(rotuloChave('avulso:T1'), 'T1');
});

test('personalizar: marcadores novos, padrões em inglês e nunca vaza a chave sintética', () => {
  const t = { nome: 'JOÃO silva', numero_pedido: '1001', transacao_id: 'avulso:T1', produto: null, transportadora: null, endereco_entrega: null, assinatura: '', rastreio_original: 'Z1', link_rastreio: 'http://t' };
  assert.equal(personalizar('Hi {nome}, {pedido} {produto} {transportadora} {endereco} {rastreio} {link_rastreio}\n{assinatura}', t),
    'Hi João, 1001 your order the carrier (address on file) Z1 http://t\nCustomer Care Team');
  assert.equal(personalizar('[{pedido}]', { transacao_id: 'avulso:a@b.com' }), '[]');
  assert.equal(personalizar('{nome}', {}), 'there');
});

test('marcadorInvalido e validarModelo exigem inglês e marcadores conhecidos', () => {
  assert.equal(marcadorInvalido('{nome} {assinatura}'), null);
  assert.match(marcadorInvalido('oi {xyz}'), /xyz/);
  assert.match(validarModelo({ nome: 'A', assunto_en: '', corpo_en: 'texto longo' }).erro, /assunto em inglês/);
  assert.match(validarModelo({ nome: 'A', assunto_en: 'S', corpo_en: '' }).erro, /texto em inglês/);
  assert.match(validarModelo({ nome: 'A', assunto_en: 'S {first_name}', corpo_en: 'texto longo' }).erro, /first_name/);
  assert.match(validarModelo({ nome: 'A', assunto_en: 'S', corpo_en: 'texto longo', corpo_pt: 'oi {foo}' }).erro, /foo/);
  assert.equal(validarModelo({ nome: ' A ', assunto_en: 'S', corpo_en: 'texto longo' }).valor.nome, 'A');
  assert.ok(validarAssinatura('{x}').erro); assert.equal(validarAssinatura(' Team ').valor, 'Team');
  assert.equal(slugModelo('Pacote retido — aviso!'), 'pacote_retido_aviso');
  assert.equal(modeloEditado({ fabrica: { nome: 'a', corpo_en: 'x' }, nome: 'a', corpo_en: 'y' }), true);
  assert.equal(modeloEditado({ fabrica: null, nome: 'a' }), false);
});

test('migração 141: todo marcador dos modelos de fábrica existe em MARCADORES (nunca sai {xyz})', () => {
  const sql = readFileSync(new URL('../server/migrations/141_sppl_ativo_modelos_email.sql', import.meta.url), 'utf8');
  const corpo = sql.slice(sql.indexOf('FROM (VALUES'));
  const usados = new Set([...corpo.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  assert.ok(usados.size >= 7);
  assert.deepEqual([...usados].filter((m) => !MARCADORES.includes(m)), []);
  assert.equal([...corpo.matchAll(/^\(\$m\$(\w+)\$m\$,/gm)].length, 9);
});
