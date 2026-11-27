/**
 * MONIT-SPPL — Fase 3: planilha .xlsx da lista (seção 13.2: 32 colunas) no SERVIDOR, com os mesmos filtros da tela. Regras de tipo (seção 11): só
 * "Dias desde o evento", "E-mails enviados", "Quantidade", "Valor", "Idade (dias)", "Dias sem movimentação" e "Qtd. de rastreios" são NÚMERO; o resto
 * (pedido, rastreio, datas...) é TEXTO, para não perder zeros nem virar notação científica. Cabeçalho em negrito com fundo ECEEF2, 1ª linha congelada,
 * filtro automático, largura 22. Nome do arquivo: `<título> - dd-mm-aaaa.xlsx` (máx. 120, sem caracteres proibidos).
 */
import ExcelJS from 'exceljs';
import { listar } from './consultas.js';
import { rotuloSt17, ROTULO_FULFILLMENT, GRUPOS, CLASSE_POR_CHAVE } from './classes.js';

const dh = (v) => (v ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
/** Número vindo do banco (texto com vírgula ou ponto) → Number; vazio → null. */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace(',', '.')));
const PLAT = { jvzoo: 'JVZoo', vupim: 'Vupim', buygoods: 'BuyGoods', digistore24: 'DigiStore24', paggins: 'Paggins', tauk: 'Tauk', logicall: 'Logicall' };

/** "cod · carrier · status17, cod2 · ..." → "cod (carrier, estado), cod2 (...)" */
export function outrosLegivel(s) {
  if (!s) return '';
  return String(s).split(', ').map((x) => { const [cod, car, st] = x.split(' · '); return `${cod} (${[car, rotuloSt17(st === 'sem 17Track' ? null : st)].filter(Boolean).join(', ')})`; }).join(', ');
}

/** [cabeçalho, função da linha, é número?, formato] — a ORDEM é a da seção 13.2. */
export const COLUNAS_XLSX = [
  ['Classificação', (p) => p.classe_nome], ['Causa', (p) => (p.causa ? (CLASSE_POR_CHAVE[p.causa]?.nome ?? p.causa) : '')], ['Número do pedido', (p) => p.pedido],
  ['E-mail do cliente', (p) => p.email_cliente ?? ''], ['Nome do cliente', (p) => p.nome_cliente ?? ''], ['O que a transportadora informou (traduzido)', (p) => p.texto_pt ?? ''],
  ['Texto original da transportadora (inglês)', (p) => p.texto_transportadora ?? ''], ['Data do evento', (p) => dh(p.evento_em)], ['Dias desde o evento', (p) => num(p.dias_desde_evento), true, '0'],
  ['Pagamento', (p) => (p.plataforma ? (PLAT[String(p.plataforma).toLowerCase()] ?? p.plataforma) : 'Não identificada')], ['Reembolso / chargeback', (p) => p.reembolso_cb],
  ['E-mails enviados', (p) => num(p.emails_enviados), true, '0'], ['Tipos de e-mail enviados', (p) => p.emails_tipos ?? ''], ['Último e-mail', (p) => dh(p.email_ultimo)],
  ['Fulfillment', (p) => ROTULO_FULFILLMENT[String(p.fulfillment ?? '').toLowerCase()] ?? p.fulfillment ?? ''], ['Transportadora', (p) => p.transportadora ?? ''],
  ['Código de rastreio', (p) => p.rastreio ?? ''], ['Link de rastreio', (p) => p.link_rastreio ?? ''], ['Endereço do cliente', (p) => p.endereco ?? ''], ['Produtos', (p) => p.produtos ?? ''],
  ['Quantidade', (p) => num(p.quantidade), true, '0'], ['Valor (vírgula decimal)', (p) => num(p.valor), true, '#,##0.00'], ['Moeda', (p) => p.moeda ?? 'USD'], ['Data do pedido', (p) => dh(p.data_pedido)],
  ['Idade (dias)', (p) => num(p.idade_dias), true, '0'], ['Última movimentação relevante', (p) => dh(p.ultima_movimentacao)], ['Dias sem movimentação', (p) => num(p.dias_sem_movimentacao), true, '0'],
  ['Como tratar', (p) => p.como_tratar ?? ''], ['Motivo no Suporte Ativo', (p) => p.motivo_suporte_ativo ?? ''], ['Qtd. de rastreios', (p) => num(p.qtd_rastreios), true, '0'],
  ['Outros rastreios', (p) => outrosLegivel(p.outros_rastreios)], ['Transferido RedRock → FullStack', (p) => (p.transferido ? 'Sim' : 'Não')],
];

/** Título da lista para o nome do arquivo. */
export function tituloDaLista(f) {
  if (f.classe) return CLASSE_POR_CHAVE[f.classe]?.nome ?? f.classe;
  if (f.grupo) return GRUPOS.find((g) => g.id === f.grupo)?.nome ?? f.grupo;
  return 'Pedidos em aberto';
}
export function nomeArquivo(titulo, data = new Date()) {
  const d = data.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
  const limpo = String(titulo).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${limpo.slice(0, 120 - d.length - 8)} - ${d}.xlsx`;
}

/** Monta o .xlsx (Buffer) de uma lista de linhas já enriquecidas (`enriquecer` de consultas.js). */
export async function montarXlsx(itens) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Pedidos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUNAS_XLSX.map(([cab]) => ({ header: cab, width: 22 }));
  const cab = ws.getRow(1); cab.font = { bold: true }; cab.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEEF2' } }; });
  for (const p of itens) {
    const linha = ws.addRow(COLUNAS_XLSX.map(([, fn, numero]) => { const v = fn(p); return numero ? v : (v === null || v === undefined ? '' : String(v)); }));
    COLUNAS_XLSX.forEach(([, , numero, fmt], i) => { const c = linha.getCell(i + 1); c.numFmt = numero ? fmt : '@'; });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUNAS_XLSX.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Gera o .xlsx com TODAS as linhas do filtro (até 50 mil) e devolve também o nome do arquivo. */
export async function gerarXlsx(f, ordenacao = {}) {
  const { itens, total } = await listar(f, { ...ordenacao, limite: 50_000, offset: 0 });
  return { buffer: await montarXlsx(itens), nome: nomeArquivo(tituloDaLista(f)), linhas: itens.length, total };
}
