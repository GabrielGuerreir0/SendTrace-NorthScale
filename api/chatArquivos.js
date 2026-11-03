/**
 * Arquivos gerados pelo Chat com IA (CSV, Excel, PDF) — e os que o código da IA cria no ambiente isolado da Anthropic.
 *
 * O arquivo NÃO passa pelo texto da conversa: a IA pede (`gerar_arquivo`), o servidor roda a consulta inteira (até
 * LIMITE_LINHAS), monta o arquivo e guarda em memória por pouco tempo. A tela mostra um botão de download. Assim um relatório de
 * 100 mil linhas sai completo, sem estourar o limite de caracteres da resposta.
 *
 * Guardado em memória (não em disco/banco): são arquivos descartáveis, de quem acabou de pedir. Some em 2 h ou quando o
 * servidor reinicia — pedir de novo resolve. O total em memória é limitado (LIMITE_TOTAL) e o mais antigo cai primeiro.
 */
import { randomBytes } from 'node:crypto';

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const LIMITE_LINHAS = 100_000;
const LIMITE_LINHAS_PDF = 3_000;
const LIMITE_COLUNAS = 60;
const LIMITE_TOTAL = 200 * 1024 * 1024;
const TTL_MS = 2 * 60 * 60 * 1000;

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/** Extensões de arquivo que o chat pode entregar para download (o resto é recusado). */
export function mimeDe(nome) {
  const ext = String(nome).split('.').pop().toLowerCase();
  return MIME[ext] ?? null;
}

const arquivos = new Map();

function tamanhoTotal() {
  let t = 0;
  for (const a of arquivos.values()) t += a.buffer.length;
  return t;
}

function limpar() {
  const agora = Date.now();
  for (const [id, a] of arquivos) if (agora - a.criadoEm > TTL_MS) arquivos.delete(id);
  while (tamanhoTotal() > LIMITE_TOTAL && arquivos.size > 1) arquivos.delete(arquivos.keys().next().value);
}

/** Nome seguro: sem pasta, sem caractere estranho, com a extensão certa. */
export function nomeSeguro(nome, extensao) {
  let base = String(nome ?? '').split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,5}$/, '');
  base = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ()]/g, '_').trim().slice(0, 80);
  return `${base || 'relatorio'}.${extensao}`;
}

/** Guarda o arquivo e devolve o descritor que a tela usa para o botão de download. */
export function guardar(buffer, nome) {
  limpar();
  const id = randomBytes(16).toString('hex');
  const mime = mimeDe(nome) ?? 'application/octet-stream';
  arquivos.set(id, { buffer, nome, mime, criadoEm: Date.now() });
  return { id, nome, bytes: buffer.length, mime };
}

export function obter(id) {
  limpar();
  return arquivos.get(String(id)) ?? null;
}

/* ═══════════════════════════════  montagem  ═══════════════════════════════ */

function valorCelula(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function escaparCsv(v) {
  const s = String(valorCelula(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function montarCsv(campos, linhas) {
  const cab = campos.map(escaparCsv).join(',');
  const corpo = linhas.map((l) => campos.map((c) => escaparCsv(l[c])).join(','));
  // BOM: o Excel abre em UTF-8 (acentos certos) sem passar pelo assistente de importação.
  return Buffer.from(`﻿${[cab, ...corpo].join('\r\n')}\r\n`, 'utf8');
}

export async function montarXlsx(campos, linhas, titulo) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SendTrace';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(titulo || 'Dados').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Dados', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = campos.map((c) => ({ header: c, key: c, width: Math.min(45, Math.max(10, c.length + 2)) }));
  const cab = ws.getRow(1);
  cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
  for (const l of linhas) {
    ws.addRow(campos.map((c) => {
      const v = l[c];
      // Número que o banco devolveu como texto (bigint/numeric) volta a ser número na planilha — mas ID longo fica texto.
      if (typeof v === 'string' && /^-?\d{1,15}(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
      return valorCelula(v);
    }));
  }
  if (linhas.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: campos.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * PDF simples e limpo: título, texto em markdown básico (# títulos, - listas, **negrito** vira texto normal) e,
 * se houver dados, uma tabela. Pensado para relatório que a pessoa vai ler/enviar, não para diagramação.
 */
export function montarPdf({ titulo, texto, campos = [], linhas = [] }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const pedacos = [];
  doc.on('data', (c) => pedacos.push(c));
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(pedacos))));
  const L = doc.page.width - 80;

  doc.fillColor('#1F2A44').font('Helvetica-Bold').fontSize(18).text(String(titulo || 'Relatório'), { width: L });
  doc.moveDown(0.2).fillColor('#667085').font('Helvetica').fontSize(8)
    .text(`SendTrace · ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  doc.moveDown(0.8).fillColor('#111827');

  for (const bruto of String(texto ?? '').split(/\r?\n/)) {
    const linha = bruto.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`/g, '');
    const h = /^(#{1,3})\s+(.*)$/.exec(linha);
    if (h) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(h[1].length === 1 ? 14 : 12).fillColor('#1F2A44').text(h[2], { width: L });
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
    } else if (/^\s*[-*]\s+/.test(linha)) {
      doc.font('Helvetica').fontSize(10).text(`•  ${linha.replace(/^\s*[-*]\s+/, '')}`, { width: L, indent: 8 });
    } else if (linha.trim()) {
      doc.font('Helvetica').fontSize(10).text(linha, { width: L });
    } else {
      doc.moveDown(0.4);
    }
  }

  if (campos.length) {
    const colunas = campos.slice(0, 12);
    const largura = L / colunas.length;
    const desenharLinha = (valores, negrito, fundo) => {
      const y = doc.y;
      if (y > doc.page.height - 70) { doc.addPage(); }
      const topo = doc.y;
      if (fundo) doc.rect(40, topo - 2, L, 14).fill(fundo);
      doc.fillColor(negrito ? '#FFFFFF' : '#111827').font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
      valores.forEach((v, i) => {
        doc.text(String(valorCelula(v)).replace(/\s+/g, ' ').slice(0, 40), 40 + i * largura + 2, topo, { width: largura - 4, height: 10, ellipsis: true, lineBreak: false });
      });
      doc.y = topo + 14;
    };
    doc.moveDown(0.8);
    desenharLinha(colunas, true, '#1F2A44');
    linhas.slice(0, LIMITE_LINHAS_PDF).forEach((l, i) => desenharLinha(colunas.map((c) => l[c]), false, i % 2 ? '#F3F4F6' : null));
    if (linhas.length > LIMITE_LINHAS_PDF || campos.length > colunas.length) {
      doc.moveDown(0.5).fillColor('#667085').font('Helvetica-Oblique').fontSize(8)
        .text(`Tabela limitada a ${LIMITE_LINHAS_PDF} linhas e ${colunas.length} colunas no PDF — use Excel/CSV para tudo.`);
    }
  }

  const n = doc.bufferedPageRange().count;
  for (let i = 0; i < n; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // sem isso o rodapé, escrito abaixo da margem, cria uma página em branco
    doc.fillColor('#9CA3AF').font('Helvetica').fontSize(7).text(`${i + 1} / ${n}`, 40, doc.page.height - 28, { width: L, align: 'right', lineBreak: false });
  }
  doc.end();
  return pronto;
}

/** Monta o arquivo pedido. Devolve { buffer, extensao }. */
export async function montar({ formato, titulo, texto, campos, linhas }) {
  if (campos.length > LIMITE_COLUNAS) throw new Error(`consulta com ${campos.length} colunas; o máximo é ${LIMITE_COLUNAS}`);
  if (formato === 'csv') return { buffer: montarCsv(campos, linhas), extensao: 'csv' };
  if (formato === 'xlsx') return { buffer: await montarXlsx(campos, linhas, titulo), extensao: 'xlsx' };
  if (formato === 'pdf') return { buffer: await montarPdf({ titulo, texto, campos, linhas }), extensao: 'pdf' };
  throw new Error(`formato "${formato}" não suportado (use csv, xlsx ou pdf)`);
}
