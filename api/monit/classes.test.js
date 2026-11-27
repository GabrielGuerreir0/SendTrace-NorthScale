/**
 * MONIT-SPPL — testes das regras de classificação (seção 5 da especificação): cada uma das 14 classes de evento com textos de exemplo (reais, do 17Track),
 * a PRECEDÊNCIA (a primeira regra que casar vence), a tradução (12.5) e as tabelas de configuração.
 * Rodar: node --test api/monit/classes.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classificarTexto, textoDoEvento, traduzirTexto, limparTextoTransportadora, REGRAS, CLASSES, GRUPOS, CLASSE_POR_CHAVE, grupoDaClasse, termoParaRegex, REGEX_DA_REGRA,
  QTD_TRADUCOES, rotuloSt17,
} from './classes.js';
import { casoDeTexto } from './sqlClassificacao.js';

/** [texto do evento (já cortado em " -> "), classe esperada] */
const EXEMPLOS = [
  // 1 devolvido
  ['Delivered, To Original Sender', 'devolvido'], ['Returned to Sender', 'devolvido'], ['Returned to Sender Facility', 'devolvido'], ['Package returned to the seller', 'devolvido'],
  ['Your item was returned and is enroute to the Sender', 'devolvido'],
  // 2 em_devolucao
  ['Return to Sender Processed', 'em_devolucao'], ['Return Initiated', 'em_devolucao'], ['In Transit, Return in Progress', 'em_devolucao'], ['Unclaimed/Being Returned to Sender', 'em_devolucao'],
  ['This is a reminder to arrange for redelivery of your item or your item will be returned to sender.', 'em_devolucao'], ['returnedToVeho', 'em_devolucao'], ['pendingReturnToClient', 'em_devolucao'],
  // 3 recusado
  ['Refused', 'recusado'], ['Refused by the Recipient', 'recusado'], ['UNDELIVERABLE – CUSTOMER REFUSED SHIPMENT', 'recusado'], ['Delivery rejected by consignee', 'recusado'],
  // 4 taxa
  ['Payment of charges - Item being held, addressee being notified', 'taxa'], ['Customs duties unpaid', 'taxa'], ['Import tax due', 'taxa'],
  // 5 mudou
  ['Moved, Left no Address', 'mudou'], ['Vacant', 'mudou'], ['Forward Time Expired', 'mudou'],
  // 6 endereco
  ['Insufficient Address', 'endereco'], ['Incorrect Address', 'endereco'], ['Incorrect/Insufficient Address, Additional Details Required', 'endereco'], ['No Such Number', 'endereco'], ['Addressee Unknown', 'endereco'],
  ['Undeliverable as addressed', 'endereco'], ['Delivery attempt failed. This may be due to incorrect address details. Reach out to the UniUni support bot to resolve.', 'endereco'],
  // 7 acesso
  ['No Access to Delivery Location', 'acesso'], ['Unable to gain access to the building', 'acesso'], ['Restricted Address', 'acesso'], ['Recipient business closed today. Delivery scheduled for next business day', 'acesso'],
  // 8 retido_cliente
  ['Held at Post Office, At Customer Request', 'retido_cliente'],
  // 9 retirada
  ['Final Notice', 'retirada'], ['Reminder to Schedule Redelivery of your item', 'retirada'], ['Collect for Pick Up', 'retirada'], ['Available for Pickup', 'retirada'], ['Notice Left (No Authorized Recipient Available)', 'retirada'],
  ['Ready for Collection', 'retirada'], ['Item being held', 'retirada'],
  // 10 ausente
  ['ATTEMPTED DELIVERY', 'ausente'], ['Delivery attempt delayed, timed out or failed.', 'ausente'], ['No one in attendance', 'ausente'], ['Recipient not available', 'ausente'], ['Contact Attempt Failed', 'ausente'],
  // 11 avaria
  ['Package Damaged', 'avaria'], ['Your package has been damaged. Please contact the seller directly for further information', 'avaria'], ['Package lost in transit', 'avaria'], ['Item Missing', 'avaria'],
  // 12 etiqueta_cancelada
  ['Label Cancelled', 'etiqueta_cancelada'],
  // 13 atraso_transportadora
  ['Delay in transit', 'atraso_transportadora'], ['Customs Clearance Delay', 'atraso_transportadora'], ['Package routed incorrectly', 'atraso_transportadora'], ['Missent', 'atraso_transportadora'],
  ['Delayed due to weather', 'atraso_transportadora'], ['Force Majeure', 'atraso_transportadora'],
  // 14 entregue
  ['Delivered, Individual Picked Up at Post Office', 'entregue'], ['DELIVERED', 'entregue'], ['Your package has been delivered', 'entregue'], ['Parcel Delivered', 'entregue'],
  ['Recipient Collected', 'entregue'], ['Picked Up, Smart Parcel Locker', 'entregue'], ['Package successfully delivered', 'entregue'], ['Delivered to Front Door', 'entregue'],
  // sem classe
  ['Arrived at Facility', null], ['Departed Post Office', null], ['In Transit', null], ['Label created, not yet in system', null], ['', null],
];

test('as 14 regras: cada classe de evento casa com os textos de exemplo', () => {
  for (const [texto, esperada] of EXEMPLOS) assert.equal(classificarTexto(texto), esperada, `"${texto}" deveria ser ${esperada}`);
});

test('as 14 regras existem, na ordem da especificação, e cobrem as 14 classes', () => {
  assert.equal(REGRAS.length, 14);
  assert.deepEqual(REGRAS.map((r) => r.classe), ['devolvido', 'em_devolucao', 'recusado', 'taxa', 'mudou', 'endereco', 'acesso', 'retido_cliente', 'retirada', 'ausente', 'avaria', 'etiqueta_cancelada', 'atraso_transportadora', 'entregue']);
});

test('precedência: a primeira regra que casar vence', () => {
  assert.equal(classificarTexto('Delivered, To Original Sender'), 'devolvido');                // não "entregue" (regra 14)
  assert.equal(classificarTexto('Returned to Sender - Item not collected'), 'devolvido');      // não "em_devolucao" (regra 2)
  assert.equal(classificarTexto('Attempted Delivery: Refused by Recipient. The package is undeliverable'), 'recusado');   // não "endereco"/"ausente"
  assert.equal(classificarTexto('Attempted Delivery: No access. The package is undeliverable and return to facility'), 'endereco');  // "Undeliverable" (6) vem antes de "No Access" (7)
  assert.equal(classificarTexto('Delivery Delay: Under review at Service Center. Redelivery is Scheduled'), 'atraso_transportadora');
  assert.equal(classificarTexto('Held at Post Office, At Customer Request'), 'retido_cliente');   // não "retirada"
  assert.equal(classificarTexto('Attempted Delivery - Item being held'), 'retirada');          // "Item being held" (retirada, 9) vem antes de "Attempted Delivery" (ausente, 10)
});

test('"^" ancora no início do texto; sem "^" casa em qualquer ponto; ignora maiúsculas', () => {
  assert.equal(classificarTexto('Your item Vacant'), null);                  // ^Vacant só no começo
  assert.equal(classificarTexto('vacant'), 'mudou');
  assert.equal(classificarTexto('Item returned to sender'), null);            // "^Returned to Sender" não casa no meio e "Return to Sender" não é "returned to sender"
  assert.equal(classificarTexto('Parcel was RETURNED TO THE SELLER'), 'devolvido');
});

test('o texto avaliado é a parte da descrição antes de " -> "', () => {
  assert.equal(textoDoEvento('Delivered, To Original Sender -> Your item has been delivered to the original sender'), 'Delivered, To Original Sender');
  assert.equal(classificarTexto(textoDoEvento('Refused -> Delivered')), 'recusado');
  assert.equal(textoDoEvento(null), '');
});

test('cada termo vira regex literal: caracteres especiais não quebram nem casam por engano', () => {
  assert.equal(termoParaRegex('^Vacant'), '^Vacant');
  assert.equal(termoParaRegex('Incorrect/Insufficient'), 'Incorrect/Insufficient');
  assert.equal(termoParaRegex('Moved, Left'), 'Moved, Left');
  for (const r of REGEX_DA_REGRA) assert.doesNotThrow(() => new RegExp(r.fonte, 'i'));
});

test('o SQL gerado usa as mesmas 14 regras, na mesma ordem', () => {
  const sql = casoDeTexto('t');
  const ordem = [...sql.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ordem, REGRAS.map((r) => r.classe));
  assert.ok(sql.includes('|^Vacant|'));
});

test('24 classes, 5 grupos, cada classe num grupo existente, sem chave repetida', () => {
  assert.equal(CLASSES.length, 24);
  assert.equal(new Set(CLASSES.map((c) => c.chave)).size, 24);
  const grupos = new Set(GRUPOS.map((g) => g.id)); assert.equal(grupos.size, 5);
  for (const c of CLASSES) { assert.ok(grupos.has(c.grupo), c.chave); assert.ok(c.nome && c.comoTratar, c.chave); }
  assert.equal(grupoDaClasse('transito_normal'), 'ok'); assert.equal(grupoDaClasse('parado_sem_aviso'), 'logistica'); assert.equal(grupoDaClasse('devolucao_cliente'), 'cliente');
  assert.equal(grupoDaClasse('qualquer_coisa'), 'ok');   // classe fora do mapa cai em ok, como no painel
  assert.equal(CLASSE_POR_CHAVE.nao_encontrado.urgencia, 'Confirmar com o dev');
});

test('tradução: primeira regra que casar vence; sem regra, o texto original', () => {
  assert.equal(QTD_TRADUCOES, 113);
  assert.equal(traduzirTexto('Delivered, To Original Sender -> algo'), 'Entregue de volta ao remetente');
  assert.equal(traduzirTexto('Returned to Sender - Item not collected'), 'Devolvido ao remetente: o cliente não retirou');
  assert.equal(traduzirTexto('Returned to Sender'), 'Devolvido ao remetente');
  assert.equal(traduzirTexto('Incorrect/Insufficient Address, Additional Details Required'), 'Endereço incorreto ou incompleto: precisa de mais detalhes para entregar');
  assert.equal(traduzirTexto('Undeliverable - Incorrect Address'), 'Não entregável: endereço incorreto');
  assert.equal(traduzirTexto('Label Cancelled'), 'Etiqueta cancelada');
  assert.equal(traduzirTexto('Delivered, PO Box'), 'Entregue na caixa postal');
  assert.equal(traduzirTexto('Delivered'), 'Entregue');
  assert.equal(traduzirTexto('Out for Delivery'), 'Saiu para entrega');
  assert.equal(traduzirTexto('Departed Facility'), 'Saiu de uma unidade');
  assert.equal(traduzirTexto('Something nobody translated'), 'Something nobody translated');
  assert.equal(traduzirTexto(''), '');
});

test('limpeza do texto: corta " -> " e o sufixo "For Delivery Issues..."', () => {
  assert.equal(limparTextoTransportadora('Arrived at Facility. For Delivery Issues call 1-800-000 -> mais'), 'Arrived at Facility');
});

test('status do 17Track em português', () => {
  assert.equal(rotuloSt17('InfoReceived'), 'etiqueta criada'); assert.equal(rotuloSt17('Delivered'), 'entregue'); assert.equal(rotuloSt17(null), 'sem dados no 17Track');
});
