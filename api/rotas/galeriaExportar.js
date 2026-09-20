/**
 * `GET /api/galeria/exportar/pdf` — a Galeria de Imagens (emailGaleria.js),
 * só que em PDF pra baixar/arquivar/mandar pra fora do painel. Reaproveita
 * `montarFiltroGaleria` de emailIACentral.js: os MESMOS filtros da tela
 * (tipo, defeito, busca, período, produto, loja) — o que está na tela quando
 * a pessoa clica em "Exportar PDF" é exatamente o que sai no arquivo, sem
 * paginação (até `LIMITE_EXPORTACAO` anexos, os mais recentes).
 *
 * A foto de celular original chega a alguns MB — pdfkit embute o arquivo
 * CRU no PDF (só reduz o tamanho de EXIBIÇÃO, não o peso do arquivo), então
 * embutir 300 fotos originais direto gerava um PDF de mais de 100 MB (visto
 * na prática: 69 fotos = 125 MB) e a query pra trazer o binário de todas de
 * uma vez estourava o `statement_timeout` de 15s do Postgres. Por isso cada
 * imagem passa pelo `sharp` antes (redimensionada + recomprimida como JPEG
 * pequeno — sobra resolução de sobra pro box de 130×130pt no papel), e o
 * binário é buscado em lotes pequenos, nunca todos de uma vez.
 *
 * Formatos que o `sharp` não decodifica (HEIC sem libheif, DNG, um punhado
 * de casos raros vistos em anexo de e-mail de cliente) entram na exportação
 * só como texto (nome + aviso de formato), nunca quebram o PDF inteiro por
 * causa de uma imagem.
 */
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { query } from '../../server/db.js';
import { montarFiltroGaleria } from './emailIACentral.js';
import { LABEL_TIPO_CONTEUDO } from './relatorio.js';

const LIMITE_EXPORTACAO = 300;
/** px no maior lado — de sobra pro box de 130×130pt (≈173×173px a 96dpi). */
const LARGURA_MAX_EMBUTIDA = 480;

const COR = {
  TINTA: '#201f1c',
  TINTA_2: '#55534e',
  TINTA_FRACA: '#8b8983',
  SUPERFICIE_2: '#f1efe9',
  BORDA: '#e1e0d9',
  BRANCO: '#ffffff',
  AMBAR: '#fab219',
};

const PAGINA_L = 595.28;
const PAGINA_A = 841.89;
const MARGEM = 44;
const LARGURA_UTIL = PAGINA_L - MARGEM * 2;

const LARGURA_IMG = 130;
const ALTURA_IMG = 130;
const GAP_IMG_TEXTO = 14;
const LARGURA_TEXTO = LARGURA_UTIL - LARGURA_IMG - GAP_IMG_TEXTO;

/** Vira a página ANTES de desenhar um bloco que não cabe mais — nunca no meio dele. */
function garantirEspaco(doc, altura) {
  if (doc.y + altura > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

const formatarData = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
  : null);

function linhasMeta(item) {
  const linhas = [
    `Tipo: ${LABEL_TIPO_CONTEUDO[item.tipo_conteudo] ?? item.tipo_conteudo ?? 'Sem análise'}   ·   Defeito visível: ${item.defeito_visivel ? 'Sim' : 'Não'}`,
  ];
  const quem = [item.remetente_nome || item.remetente_email, formatarData(item.data_email)].filter(Boolean).join(' · ');
  if (quem) linhas.push(quem);
  if (item.assunto) linhas.push(`Assunto: ${item.assunto}`);
  return linhas;
}

/** Soma as alturas de tudo que vai ser desenhado na coluna de texto — pra
 * saber, ANTES de desenhar, se o item cabe no espaço restante da página
 * (junto com a imagem, que tem altura fixa). */
function alturaTexto(doc, item) {
  doc.font('Helvetica-Bold').fontSize(10);
  let h = doc.heightOfString(item.nome_arquivo || '(sem nome)', { width: LARGURA_TEXTO }) + 4;
  doc.font('Helvetica').fontSize(8.5);
  for (const linha of linhasMeta(item)) h += doc.heightOfString(linha, { width: LARGURA_TEXTO }) + 2;
  if (item.descricao_ia) {
    doc.font('Helvetica-Oblique').fontSize(8.5);
    h += 4 + doc.heightOfString(item.descricao_ia, { width: LARGURA_TEXTO });
  }
  if (item.tags?.length) {
    doc.font('Helvetica').fontSize(8);
    h += 4 + doc.heightOfString(item.tags.join(' · '), { width: LARGURA_TEXTO });
  }
  return h;
}

function desenharItem(doc, item) {
  const alturaTxt = alturaTexto(doc, item);
  const altura = Math.max(ALTURA_IMG, alturaTxt);
  garantirEspaco(doc, altura + 24);
  const topo = doc.y;

  // ── imagem (ou aviso de formato) ──
  doc.roundedRect(MARGEM, topo, LARGURA_IMG, ALTURA_IMG, 6).fill(COR.SUPERFICIE_2);
  // `item.conteudo` já é a versão reduzida (sharp) só de quem decodificou —
  // não precisa checar mime_type de novo aqui.
  let embutiu = false;
  if (item.conteudo) {
    try {
      doc.image(item.conteudo, MARGEM, topo, { fit: [LARGURA_IMG, ALTURA_IMG], align: 'center', valign: 'center' });
      embutiu = true;
    } catch {
      embutiu = false;
    }
  }
  if (!embutiu) {
    doc.fillColor(COR.TINTA_FRACA).font('Helvetica').fontSize(7.5)
      .text(`Sem prévia\n(${item.mime_type || 'formato desconhecido'})`, MARGEM + 8, topo + ALTURA_IMG / 2 - 12, {
        width: LARGURA_IMG - 16, align: 'center',
      });
  }

  // ── texto ──
  const xTexto = MARGEM + LARGURA_IMG + GAP_IMG_TEXTO;
  doc.fillColor(COR.TINTA).font('Helvetica-Bold').fontSize(10)
    .text(item.nome_arquivo || '(sem nome)', xTexto, topo, { width: LARGURA_TEXTO });
  let y = doc.y + 3;
  doc.font('Helvetica').fontSize(8.5).fillColor(COR.TINTA_2);
  for (const linha of linhasMeta(item)) {
    doc.text(linha, xTexto, y, { width: LARGURA_TEXTO });
    y = doc.y + 2;
  }
  if (item.descricao_ia) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COR.TINTA);
    doc.text(item.descricao_ia, xTexto, y + 2, { width: LARGURA_TEXTO });
    y = doc.y;
  }
  if (item.tags?.length) {
    doc.font('Helvetica').fontSize(8).fillColor(COR.TINTA_FRACA);
    doc.text(item.tags.join(' · '), xTexto, y + 2, { width: LARGURA_TEXTO });
    y = doc.y;
  }

  doc.x = MARGEM;
  doc.y = topo + altura + 12;
  doc.moveTo(MARGEM, doc.y - 6).lineTo(PAGINA_L - MARGEM, doc.y - 6)
    .lineWidth(0.5).strokeColor(COR.BORDA).stroke();
}

/** Linha "Filtros: ..." do cabeçalho — só lista o que a pessoa realmente
 * escolheu, pra não virar "Filtros: nenhum, nenhum, nenhum, nenhum". */
function descreverFiltros(qs) {
  const partes = [];
  if (qs.tipo) partes.push(`tipo = ${LABEL_TIPO_CONTEUDO[qs.tipo] ?? qs.tipo}`);
  if (qs.defeito) partes.push('só com defeito visível');
  if (qs.q) partes.push(`busca = "${qs.q}"`);
  if (qs.dias) partes.push(`últimos ${qs.dias} dias`);
  if (qs.data_de || qs.data_ate) partes.push(`${qs.data_de || '…'} a ${qs.data_ate || 'hoje'}`);
  if (qs.produto) partes.push(`produto = ${qs.produto}`);
  if (qs.loja) partes.push(`plataforma = ${qs.loja}`);
  return partes.length ? partes.join('  ·  ') : 'nenhum (toda a galeria)';
}

/** Quantos anexos buscam o `conteudo` (bytea) por vez — separado da lista
 * (metadado puro, rápido) de propósito: o Postgres de produção tem
 * `statement_timeout` de 15s, e uma imagem de celular passa fácil de 1-4 MB.
 * Buscar o binário de 300 anexos numa query só ESTOURA esse timeout (visto
 * na prática rodando local: 500 depois de ~17s) — em lotes pequenos, cada
 * query fica bem abaixo do limite mesmo se algum arquivo for grande. */
const TAMANHO_LOTE_BINARIO = 15;

async function buscarConteudos(ids) {
  const mapa = new Map();
  for (let i = 0; i < ids.length; i += TAMANHO_LOTE_BINARIO) {
    const lote = ids.slice(i, i + TAMANHO_LOTE_BINARIO);
    let linhas = [];
    try {
      const { rows } = await query(
        'SELECT id, conteudo FROM email_ia.anexos WHERE id = ANY($1::int[])',
        [lote],
      );
      linhas = rows;
    } catch {
      // Um lote que falhar (timeout, anexo corrompido) não derruba os
      // outros — esses itens só saem sem prévia de imagem no PDF.
      continue;
    }
    await Promise.all(linhas.map(async (r) => {
      try {
        const reduzida = await sharp(r.conteudo)
          .resize({ width: LARGURA_MAX_EMBUTIDA, height: LARGURA_MAX_EMBUTIDA, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toBuffer();
        mapa.set(r.id, reduzida);
      } catch {
        // Formato que o sharp não decodifica (HEIC sem libheif, DNG etc.) —
        // fica sem prévia no PDF, não derruba a exportação inteira.
      }
    }));
  }
  return mapa;
}

async function montarPdfGaleria(reqQuery, onde, valores) {
  const [{ rows: metadados }, { rows: totalRows }] = await Promise.all([
    query(
      `SELECT a.id, a.nome_arquivo, a.mime_type, a.tipo_conteudo, a.defeito_visivel,
              a.descricao_ia, a.tags,
              e.data_email, e.remetente_nome, e.remetente_email, e.assunto
       FROM email_ia.anexos a LEFT JOIN email_ia.emails e USING (message_id)
       WHERE ${onde}
       ORDER BY coalesce(e.data_email, a.criado_em) DESC, a.id DESC
       LIMIT ${LIMITE_EXPORTACAO}`,
      valores,
    ),
    query(
      `SELECT count(*)::int AS total FROM email_ia.anexos a LEFT JOIN email_ia.emails e USING (message_id) WHERE ${onde}`,
      valores,
    ),
  ]);
  const conteudos = await buscarConteudos(metadados.map((m) => m.id));
  const itens = metadados.map((m) => ({ ...m, conteudo: conteudos.get(m.id) ?? null }));
  const total = totalRows[0]?.total ?? itens.length;

  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });
  const pedacos = [];
  doc.on('data', (c) => pedacos.push(c));
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(pedacos))));

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const alturaFaixa = 78;
  doc.rect(0, 0, PAGINA_L, alturaFaixa).fill(COR.TINTA);
  doc.fillColor(COR.BRANCO).font('Helvetica-Bold').fontSize(9)
    .text('SENDTRACE', MARGEM, 20, { characterSpacing: 1.5, lineBreak: false });
  doc.fontSize(19).text('Galeria de Anexos — Exportação', MARGEM, 34, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#c3c2b7')
    .text(`Gerado em ${agora}  ·  ${n(itens.length)} de ${n(total)} anexo(s)`, MARGEM, 58, { lineBreak: false });
  doc.y = alturaFaixa + 14;
  doc.x = MARGEM;

  doc.font('Helvetica').fontSize(8.5).fillColor(COR.TINTA_2)
    .text(`Filtros: ${descreverFiltros(reqQuery)}`, MARGEM, doc.y, { width: LARGURA_UTIL });
  doc.moveDown(0.6);

  if (total > itens.length) {
    doc.fillColor(COR.AMBAR).font('Helvetica-Bold').fontSize(8.5)
      .text(`⚠ Mostrando só os ${n(itens.length)} mais recentes de ${n(total)} encontrados — refine o filtro (produto, período, tipo) pra exportar o restante.`, MARGEM, doc.y, { width: LARGURA_UTIL });
    doc.moveDown(0.6);
  }
  doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9.5);

  if (!itens.length) {
    doc.fillColor(COR.TINTA_FRACA).fontSize(9.5).text('Nenhum anexo encontrado com este filtro.');
  }
  for (const item of itens) desenharItem(doc, item);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(COR.TINTA_FRACA)
      .text(`SendTrace · Galeria de Anexos · página ${i + 1} de ${range.count}`,
        MARGEM, PAGINA_A - 32, { width: LARGURA_UTIL, align: 'center', lineBreak: false });
    doc.page.margins.bottom = margemInferior;
  }

  doc.end();
  return pronto;
}

const n = (v) => String(v ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export default async function rotasGaleriaExportar(app) {
  app.get('/api/galeria/exportar/pdf', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Exporta a Galeria de Anexos (com os filtros ativos) em PDF',
      description: 'Mesmos filtros de GET /api/galeria (tipo, defeito, busca, período, produto, '
        + `loja), sem paginação — traz até ${LIMITE_EXPORTACAO} anexos mais recentes que baterem `
        + 'no filtro, com a imagem embutida quando o formato permite (JPEG/PNG — HEIC e outros '
        + 'formatos raros entram só como texto, nunca quebram o PDF inteiro).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          tipo: { type: 'string' },
          defeito: { type: 'boolean' },
          q: { type: 'string' },
          dias: { type: 'integer', minimum: 1 },
          data_de: { type: 'string' },
          data_ate: { type: 'string' },
          produto: { type: 'string' },
          loja: { type: 'string' },
        },
      },
    },
  }, async (req, resposta) => {
    const { onde, valores } = await montarFiltroGaleria(req.query);
    const buffer = await montarPdfGaleria(req.query, onde, valores);
    resposta
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="galeria-sendtrace.pdf"');
    return resposta.send(buffer);
  });
}
