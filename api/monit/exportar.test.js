/**
 * MONIT-SPPL — testes da planilha: 32 colunas na ordem da seção 13.2, número só nas 7 colunas numéricas, o resto texto, cabeçalho/filtro/congelamento,
 * nome do arquivo. Não toca no banco (usa linhas de exemplo). Rodar: DATABASE_URL=postgres://x@127.0.0.1:1/x node --test api/monit/exportar.test.js
 */
process.env.DATABASE_URL ??= 'postgres://teste@127.0.0.1:1/teste';
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
const { COLUNAS_XLSX, montarXlsx, nomeArquivo, outrosLegivel, tituloDaLista } = await import('./exportar.js');
const { enriquecer } = await import('./consultas.js');

const LINHA = enriquecer({
  pedido_id: 'T1', pedido: '0012345', email_cliente: 'a@b.co', nome_cliente: 'Fulana', classe: 'devolucao_endereco', grupo: 'cliente', causa: 'endereco', texto_transportadora: 'Returned to Sender',
  evento_em: '2026-11-20T15:00:00Z', dias_desde_evento: 6, fulfillment: 'jetstream', transportadora: 'USPS', rastreio: '9400111899223344556677', qtd_rastreios: 2, outros_rastreios: 'ZZ1 · ups · Delivered',
  transferido: true, link_rastreio: null, endereco: 'Rua X, 1', produtos: 'Prod A + Prod B', quantidade: 3, valor: '197.00', moeda: 'USD', data_pedido: '2026-11-01T12:00:00Z', idade_dias: 25,
  ultima_movimentacao: '2026-11-20T15:00:00Z', dias_sem_movimentacao: 6, plataforma: 'jvzoo', reembolso_cb: 'Não', emails_enviados: 1, emails_tipos: 'Endereço incompleto', email_ultimo: '2026-11-21T10:00:00Z',
});

test('a planilha tem as 32 colunas na ordem da especificação', () => {
  assert.equal(COLUNAS_XLSX.length, 32);
  assert.equal(COLUNAS_XLSX[0][0], 'Classificação'); assert.equal(COLUNAS_XLSX[2][0], 'Número do pedido'); assert.equal(COLUNAS_XLSX[16][0], 'Código de rastreio'); assert.equal(COLUNAS_XLSX[31][0], 'Transferido RedRock → FullStack');
});

test('números só nas 7 colunas numéricas; código e pedido ficam como texto (zeros e notação científica)', async () => {
  const buf = await montarXlsx([LINHA]);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const ws = wb.getWorksheet('Pedidos');
  assert.equal(ws.columnCount, 32);
  const nums = COLUNAS_XLSX.map(([cab, , n], i) => [cab, n, ws.getRow(2).getCell(i + 1).value]).filter(([, n]) => n);
  assert.deepEqual(nums.map(([c]) => c), ['Dias desde o evento', 'E-mails enviados', 'Quantidade', 'Valor (vírgula decimal)', 'Idade (dias)', 'Dias sem movimentação', 'Qtd. de rastreios']);
  for (const [c, , v] of nums) assert.equal(typeof v, 'number', c);
  assert.equal(ws.getRow(2).getCell(3).value, '0012345');                          // zero à esquerda preservado
  assert.equal(ws.getRow(2).getCell(17).value, '9400111899223344556677');          // sem notação científica
  assert.equal(ws.getRow(2).getCell(22).value, 197);                                // valor decimal vira número
  assert.equal(ws.getRow(2).getCell(32).value, 'Sim');
  assert.equal(ws.getRow(2).getCell(31).value, 'ZZ1 (ups, entregue)');
});

test('cabeçalho em negrito com fundo ECEEF2, 1ª linha congelada, filtro automático', async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await montarXlsx([LINHA])); const ws = wb.getWorksheet('Pedidos');
  const c = ws.getRow(1).getCell(1);
  assert.equal(c.font.bold, true); assert.equal(c.fill.fgColor.argb, 'FFECEEF2');
  assert.equal(ws.views[0].state, 'frozen'); assert.equal(ws.views[0].ySplit, 1);
  assert.ok(ws.autoFilter);
});

test('nome do arquivo: <título> - dd-mm-aaaa.xlsx, sem caracteres proibidos, máximo 120', () => {
  const n = nomeArquivo('Aguardando: coleta / "ok" <2d>', new Date('2026-11-26T15:00:00Z'));
  assert.equal(n, 'Aguardando coleta ok 2d - 26-11-2026.xlsx'.replace('coleta ok 2d', 'coleta ok 2d'));
  assert.ok(nomeArquivo('x'.repeat(300)).length <= 120);
  assert.equal(tituloDaLista({ classe: 'avaria' }), 'Pacote danificado'); assert.equal(tituloDaLista({}), 'Pedidos em aberto');
  assert.equal(outrosLegivel(null), '');
});
