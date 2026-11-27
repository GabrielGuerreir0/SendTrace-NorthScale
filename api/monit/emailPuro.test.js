// node --test api/monit/emailPuro.test.js — escolha do modelo pela classe, produto principal, campos entre chaves (PT/EN) e a tradução por IA (parte pura).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELO_POR_CLASSE, MODELOS_ORDEM, MODELO_PADRAO, modeloDaSelecao, produtoPrincipal, renderizar, camposIguais, camposDoTexto } from './emailPuro.js';
import { CLASSE_POR_CHAVE } from './classes.js';
import { listaParaEnvio, inglesDesatualizado } from '../../public/monitEmailTexto.js';

// traduzir.js importa api/comum.js → server/db.js, que exige DATABASE_URL só para existir (o Pool não conecta sem consulta)
process.env.DATABASE_URL ??= 'postgres://teste:teste@127.0.0.1:1/teste';
const { montarPedido, lerResposta, conferirTraducao, traduzir, INSTRUCAO } = await import('./traduzir.js');

test('MODELO_POR_CLASSE: só classes que existem e só modelos de fábrica', () => {
  for (const [classe, modelo] of Object.entries(MODELO_POR_CLASSE)) {
    assert.ok(CLASSE_POR_CHAVE[classe], `classe desconhecida: ${classe}`);
    assert.ok(MODELOS_ORDEM.includes(modelo), `modelo desconhecido: ${modelo}`);
  }
  assert.equal(MODELO_POR_CLASSE.devolucao_endereco, 'devolucao');
  assert.equal(MODELO_POR_CLASSE.devolucao_cliente, 'recusado');
  assert.equal(MODELO_POR_CLASSE.retido_cliente, 'retirada');
  assert.equal(MODELO_POR_CLASSE.aguardando_coleta_ok, 'atraso');
  assert.equal(MODELO_POR_CLASSE.transito_normal, undefined);
});

test('modeloDaSelecao: o mais frequente vence; sem classe conhecida cai em endereco', () => {
  assert.equal(modeloDaSelecao(['atraso_transportadora', 'parado_sem_aviso', 'endereco']).modelo, 'atraso');
  assert.equal(modeloDaSelecao(['transito_normal', 'entregue_nao_baixado']).modelo, MODELO_PADRAO);
  assert.equal(modeloDaSelecao([]).modelo, 'endereco');
  assert.equal(modeloDaSelecao(['recusado', 'devolucao_cliente', 'ausente']).modelo, 'recusado');
  assert.deepEqual(modeloDaSelecao(['recusado', 'devolvido']).por_modelo, { recusado: 1, devolucao: 1 });
  // empate: vale a ordem fixa dos modelos (endereco antes de atraso)
  assert.equal(modeloDaSelecao(['atraso_transportadora', 'endereco']).modelo, 'endereco');
});

test('produtoPrincipal tira quantidade de frascos e upsells', () => {
  assert.equal(produtoPrincipal('6 Bottles ProstaVive + 2 Bottles Outro'), 'ProstaVive');
  assert.equal(produtoPrincipal('ProstaVive - 6 Bottles'), 'ProstaVive');
  assert.equal(produtoPrincipal('3 Bottles of GlucoSafe'), 'GlucoSafe');
  assert.equal(produtoPrincipal('GlucoSafe'), 'GlucoSafe');
  assert.equal(produtoPrincipal(''), '');
  assert.equal(produtoPrincipal(null), '');
});

test('renderizar: campos do cliente em inglês e em português, com os "sem dado" de cada idioma', () => {
  const cheio = { nome: 'JOHN smith', numero_pedido: 'A1', produto: 'ProstaVive', rastreio_original: 'T123', link_rastreio: 'https://t.17track.net/pt#nums=T123', transportadora: 'USPS', endereco_entrega: '1 Main St', assinatura: 'Customer Care Team' };
  const modelo = 'Hi {nome}, order {pedido} ({produto}) via {transportadora} to {endereco}: {rastreio} {link_rastreio} — {assinatura}';
  assert.equal(renderizar(modelo, cheio), 'Hi John, order A1 (ProstaVive) via USPS to 1 Main St: T123 https://t.17track.net/pt#nums=T123 — Customer Care Team');
  const vazio = { nome: '', numero_pedido: 'A2' };
  assert.equal(renderizar('Hi {nome} {transportadora} {endereco} {produto}', vazio, 'en'), 'Hi there the carrier (address on file) your order');
  assert.equal(renderizar('Olá {nome} {transportadora} {endereco} {produto}', vazio, 'pt'), 'Olá cliente a transportadora (endereço cadastrado) seu produto');
  assert.equal(renderizar('{naoexiste}', cheio), '{naoexiste}');
});

test('camposIguais compara os campos entre chaves (nomes e quantidade)', () => {
  assert.deepEqual(camposDoTexto('{pedido} e {nome} e {pedido}'), ['nome', 'pedido', 'pedido']);
  assert.ok(camposIguais('Oi {nome}, pedido {pedido}', 'Hi {nome}, order {pedido}'));
  assert.ok(!camposIguais('Oi {nome}', 'Hi {first_name}'));
  assert.ok(!camposIguais('Oi {nome} {pedido}', 'Hi {nome}'));
});

test('tradução por IA: pedido com a instrução da spec, leitura da resposta e conferência dos campos', () => {
  const p = montarPedido('Assunto {pedido}', 'Olá {nome}\nlinha 2');
  assert.ok(p.startsWith(INSTRUCAO)); assert.match(p, /SUBJECT:\nAssunto \{pedido\}\n\nBODY:\nOlá \{nome\}\nlinha 2$/);
  assert.match(INSTRUCAO, /Brazilian Portuguese to natural, friendly American English/);
  assert.deepEqual(lerResposta('```json\n{"assunto":"Hi {pedido}","corpo":"Hello {nome}\\nline 2"}\n```'), { assunto: 'Hi {pedido}', corpo: 'Hello {nome}\nline 2' });
  assert.equal(lerResposta('sem json'), null); assert.equal(lerResposta('{"assunto":"x"}'), null);
  const orig = { assunto: 'A {pedido}', corpo: 'B {nome}' };
  assert.equal(conferirTraducao(orig, { assunto: 'A {pedido}', corpo: 'B {nome}' }), null);
  assert.match(conferirTraducao(orig, { assunto: 'A {order}', corpo: 'B {nome}' }), /assunto/);
  assert.match(conferirTraducao(orig, { assunto: 'A {pedido}', corpo: 'B' }), /texto/);
});

test('traduzir sem ANTHROPIC_API_KEY: 503 com mensagem amigável (nada inventado)', async () => {
  const antes = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(() => traduzir({ assunto: 'Oi', corpo: 'Olá {nome}' }), (e) => e.statusCode === 503 && /ANTHROPIC_API_KEY/.test(e.message));
    await assert.rejects(() => traduzir({ assunto: '', corpo: 'x' }), (e) => e.statusCode === 400);
  } finally { if (antes !== undefined) process.env.ANTHROPIC_API_KEY = antes; }
});

test('listaParaEnvio: tabulação, texto entre aspas (aspas dobradas) e sem e-mail fica de fora', () => {
  const t = listaParaEnvio([
    { email: 'a@x.com', nome: 'Ana', pedido: 'P1', rastreio: 'T1', classe_nome: 'Endereço insuficiente', assunto: 'Action\tneeded', texto: 'Hi "Ana"\nBye' },
    { email: null, nome: 'Sem', pedido: 'P2', texto: 'x' },
  ]).split('\n');
  assert.equal(t[0], 'E-mail\tNome\tPedido\tRastreio\tClassificação\tAssunto\tTexto');
  assert.equal(t[1], 'a@x.com\tAna\tP1\tT1\tEndereço insuficiente\tAction needed\t"Hi ""Ana""');
  assert.equal(t[2], 'Bye"'); assert.equal(t.length, 3);
});

test('inglesDesatualizado: português mudou desde a base e o inglês não foi refeito nem revisado', () => {
  assert.equal(inglesDesatualizado({ ptAtual: 'a', ptBase: 'a', enRevisadoDepois: false }), false);
  assert.equal(inglesDesatualizado({ ptAtual: 'b', ptBase: 'a', enRevisadoDepois: false }), true);
  assert.equal(inglesDesatualizado({ ptAtual: 'b', ptBase: 'a', enRevisadoDepois: true }), false);
});
