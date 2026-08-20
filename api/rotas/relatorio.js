/**
 * Relatório de métricas — Parte 2 do plano em
 * PLANO-tracking-abertura-e-relatorio-metricas.md, sem NPS nem taxa de
 * devolução física (decisão do usuário 20/08/2026: deixar as duas de lado
 * por enquanto — nenhuma das duas tem fonte de dado pronta hoje).
 *
 * Uma função só (`coletarMetricas`) alimenta as duas rotas: a tela lê o
 * JSON, o PDF é o MESMO dado renderizado em papel. Sem isso, JSON e PDF
 * divergiriam a cada mudança de query.
 *
 * `GET /api/relatorio/pdf/` também dispara o e-mail para quem está logado —
 * "baixar o PDF" e "receber por e-mail" são o mesmo clique, a pedido do
 * usuário. O envio nunca derruba o download: se o SMTP falhar, quem clicou
 * ainda recebe o arquivo, só sem a cópia por e-mail.
 */
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';

import { query } from '../../server/db.js';

/* ═══════════════════════════════  SQL  ══════════════════════════════════ */

/** Bucket de dias desde a compra: 0, 1, 2–5, 6–10 … 26–30, >30 (pedido do usuário). */
function bucketDias(expr) {
  return `CASE
    WHEN ${expr} IS NULL OR ${expr} < 0 THEN NULL
    WHEN ${expr} = 0  THEN '0'
    WHEN ${expr} = 1  THEN '1'
    WHEN ${expr} <= 5  THEN '2–5'
    WHEN ${expr} <= 10 THEN '6–10'
    WHEN ${expr} <= 15 THEN '11–15'
    WHEN ${expr} <= 20 THEN '16–20'
    WHEN ${expr} <= 25 THEN '21–25'
    WHEN ${expr} <= 30 THEN '26–30'
    ELSE '>30'
  END`;
}
const ORDEM_BUCKETS = ['0', '1', '2–5', '6–10', '11–15', '16–20', '21–25', '26–30', '>30'];

function ordenarBuckets(linhas) {
  const porBucket = new Map(linhas.map((l) => [l.bucket, l.total]));
  return ORDEM_BUCKETS.map((bucket) => ({ bucket, total: porBucket.get(bucket) ?? 0 }));
}

async function coletarMetricas(dias) {
  const p = [dias];

  const [
    contatosSerie, motivosChat, jornada,
    aberturaRegua, aberturaResposta,
    reembolsoEmail, reembolsoChat,
    motivosCategoria, motivosArea, motivosReembolso,
    fotosPorTipo, fotosResumo,
  ] = await Promise.all([
    query(`
      SELECT coalesce(iniciado_em, criado_em)::date AS dia, count(*)::int AS total
      FROM chat_atendimentos
      WHERE coalesce(iniciado_em, criado_em) >= now() - ($1::int || ' days')::interval
      GROUP BY 1 ORDER BY 1`, p),

    query(`
      SELECT t.slug AS motivo, t.nome AS label, count(*)::int AS total
      FROM chat_atendimentos a
      JOIN chat_topicos t ON t.id = a.topico_id
      WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - ($1::int || ' days')::interval
      GROUP BY t.slug, t.nome ORDER BY total DESC`, p),

    query(`
      SELECT coalesce(e.nome, 'Fora da régua') AS nome, count(*)::int AS total
      FROM chat_atendimentos a
      LEFT JOIN etapas_regua e ON e.etapa::text = a.etapa_regua::text
      WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - ($1::int || ' days')::interval
      GROUP BY coalesce(e.nome, 'Fora da régua') ORDER BY total DESC`, p),

    // Acumulado (não filtrado pelo período): etapa_atual é um PONTEIRO de
    // estado, não um evento com data — "enviados_aprox" conta quem já
    // passou daquela etapa em qualquer momento. abertos idem, sem filtro de
    // período, para os dois lados da fração ficarem comparáveis.
    query(`
      SELECT e.etapa, e.nome,
        (SELECT count(*)::int FROM disparos_pos_venda d WHERE d.etapa_atual > e.etapa) AS enviados_aprox,
        (SELECT count(DISTINCT ab.disparo_id)::int FROM aberturas_disparo ab WHERE ab.etapa = e.etapa) AS abertos
      FROM etapas_regua e
      WHERE e.etapa BETWEEN 0 AND 5
      ORDER BY e.etapa`),

    query(`
      SELECT
        (SELECT count(*)::int FROM email_ia.emails
           WHERE resposta_enviada_em IS NOT NULL
             AND resposta_enviada_em >= now() - ($1::int || ' days')::interval) AS enviados,
        (SELECT count(DISTINCT ab.email_id)::int FROM email_ia.aberturas_email ab
           JOIN email_ia.emails e2 ON e2.id = ab.email_id
           WHERE e2.resposta_enviada_em IS NOT NULL
             AND e2.resposta_enviada_em >= now() - ($1::int || ' days')::interval) AS abertos`, p),

    query(`
      SELECT bucket, count(*)::int AS total FROM (
        SELECT ${bucketDias('(data_email::date - pedido_em::date)')} AS bucket
        FROM email_ia.mv_emails_x_pedidos
        WHERE pedido_em IS NOT NULL
          AND data_email >= now() - ($1::int || ' days')::interval
          AND (categoria IN ('devolucao', 'troca') OR motivo_devolucao IS NOT NULL)
      ) t WHERE bucket IS NOT NULL GROUP BY bucket`, p),

    query(`
      SELECT bucket, count(*)::int AS total FROM (
        SELECT ${bucketDias('(a.criado_em::date - d.criado_em::date)')} AS bucket
        FROM chat_atendimentos a
        JOIN disparos_pos_venda d ON d.transacao_id = a.transacao_id
        WHERE a.reembolso_pedido = true
          AND a.criado_em >= now() - ($1::int || ' days')::interval
      ) t WHERE bucket IS NOT NULL GROUP BY bucket`, p),

    query(`
      SELECT categoria, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - ($1::int || ' days')::interval
        AND plataforma_origem IS NULL AND categoria IS NOT NULL
      GROUP BY categoria ORDER BY total DESC LIMIT 15`, p),

    query(`
      SELECT area_problema, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - ($1::int || ' days')::interval
        AND plataforma_origem IS NULL AND area_problema IS NOT NULL
      GROUP BY area_problema ORDER BY total DESC LIMIT 10`, p),

    query(`
      SELECT problema_pagamento, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - ($1::int || ' days')::interval
        AND plataforma_origem IS NULL AND problema_pagamento IS NOT NULL
        AND problema_pagamento <> 'sem_problema_pagamento'
      GROUP BY problema_pagamento ORDER BY total DESC`, p),

    // Sem filtro de período: email_ia.anexos não tem data própria, e juntar
    // com emails.data_email só para isto não valia a complexidade agora.
    query(`
      SELECT tipo_conteudo, count(*)::int AS total
      FROM email_ia.anexos
      WHERE tipo_conteudo IS NOT NULL
      GROUP BY tipo_conteudo ORDER BY total DESC`),

    query(`
      SELECT count(*) FILTER (WHERE defeito_visivel = true)::int AS com_defeito,
             count(*)::int AS total_analisadas
      FROM email_ia.anexos WHERE tipo_conteudo IS NOT NULL`),
  ]);

  const taxa = (abertos, enviados) => (enviados > 0 ? abertos / enviados : null);

  return {
    periodo_dias: dias,
    chat: {
      contatos_serie: contatosSerie.rows,
      contatos_total: contatosSerie.rows.reduce((a, r) => a + r.total, 0),
      motivos: motivosChat.rows,
      jornada: jornada.rows,
    },
    abertura: {
      regua_por_etapa: aberturaRegua.rows.map((r) => ({
        ...r, taxa: taxa(r.abertos, r.enviados_aprox),
      })),
      resposta_automatica: {
        enviados: aberturaResposta.rows[0].enviados,
        abertos: aberturaResposta.rows[0].abertos,
        taxa: taxa(aberturaResposta.rows[0].abertos, aberturaResposta.rows[0].enviados),
      },
    },
    reembolsos_por_dia: {
      email: ordenarBuckets(reembolsoEmail.rows),
      chat: ordenarBuckets(reembolsoChat.rows),
    },
    email: {
      motivos_categoria: motivosCategoria.rows,
      motivos_area: motivosArea.rows,
      motivos_reembolso: motivosReembolso.rows,
    },
    fotos: {
      por_tipo: fotosPorTipo.rows,
      com_defeito: fotosResumo.rows[0].com_defeito,
      total_analisadas: fotosResumo.rows[0].total_analisadas,
    },
  };
}

/* ═══════════════════════════════  PDF  ═══════════════════════════════════ */

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);

function secao(doc, titulo) {
  doc.moveDown(1.1);
  doc.fontSize(14).fillColor('#111827').font('Helvetica-Bold').text(titulo);
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#374151');
}

/**
 * Rótulo à esquerda, valor à direita, na mesma linha. `doc.x`/`doc.y` mudam
 * DEPOIS do primeiro `.text()` (o pdfkit os move ao terminar um bloco) — por
 * isso `x0`/`y0` são capturados ANTES dos dois desenhos, nunca lidos de novo
 * no meio. `lineBreak: false` evita que um rótulo comprido quebre linha e
 * empurre o valor para baixo dele.
 */
function linhaLista(doc, rotulo, valor) {
  const altura = doc.currentLineHeight(true) + 3;
  // Sem isto, uma linha bem na borda quebra ao meio: o rótulo sai numa
  // página e o valor, desalinhado, na página seguinte (aconteceu no teste
  // manual contra o banco real). Força a virada ANTES de desenhar a linha
  // inteira, nunca no meio dela.
  if (doc.y + altura > doc.page.height - doc.page.margins.bottom) doc.addPage();

  const x0 = doc.x;
  const y0 = doc.y;
  doc.text(rotulo, x0, y0, { width: 380, lineBreak: false, ellipsis: true });
  doc.text(valor, x0 + 380, y0, { width: 120, align: 'right', lineBreak: false });
  doc.x = x0;
  doc.y = y0 + altura;
}

function listaVazia(doc) {
  doc.fillColor('#9ca3af').text('Sem dados no período.');
  doc.fillColor('#374151');
}

function montarPdf(m) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const pedacos = [];
  doc.on('data', (c) => pedacos.push(c));
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(pedacos))));

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  doc.fontSize(20).font('Helvetica-Bold').fillColor('#111827')
    .text('Relatório de métricas — SendTrace');
  doc.fontSize(10).font('Helvetica').fillColor('#6b7280')
    .text(`Período: últimos ${m.periodo_dias} dias · Gerado em ${agora}`);

  secao(doc, 'Chat com IA — contatos');
  linhaLista(doc, 'Total de conversas iniciadas no período', String(m.chat.contatos_total));
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('Principais motivos de contato');
  doc.font('Helvetica');
  if (!m.chat.motivos.length) listaVazia(doc);
  for (const r of m.chat.motivos) linhaLista(doc, r.label, String(r.total));
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('Onde a jornada gera contato');
  doc.font('Helvetica');
  if (!m.chat.jornada.length) listaVazia(doc);
  for (const r of m.chat.jornada) linhaLista(doc, r.nome, String(r.total));

  secao(doc, 'Taxa de abertura de e-mail');
  doc.font('Helvetica-Bold').text('Régua de pós-venda, por etapa (acumulado)');
  doc.font('Helvetica');
  for (const r of m.abertura.regua_por_etapa) {
    linhaLista(doc, `Etapa ${r.etapa} — ${r.nome}`, `${pct(r.taxa)} (${r.abertos}/${r.enviados_aprox})`);
  }
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('Resposta automática (período)');
  doc.font('Helvetica');
  linhaLista(
    doc, 'Taxa de abertura',
    `${pct(m.abertura.resposta_automatica.taxa)} (${m.abertura.resposta_automatica.abertos}/${m.abertura.resposta_automatica.enviados})`,
  );

  secao(doc, 'Reembolsos por dias após a compra');
  doc.font('Helvetica-Bold').text('Sinalizados por e-mail');
  doc.font('Helvetica');
  for (const r of m.reembolsos_por_dia.email) linhaLista(doc, `${r.bucket} dia(s)`, String(r.total));
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('Pedidos no chat de suporte');
  doc.font('Helvetica');
  for (const r of m.reembolsos_por_dia.chat) linhaLista(doc, `${r.bucket} dia(s)`, String(r.total));

  secao(doc, 'E-mail — motivos de contato');
  doc.font('Helvetica-Bold').text('Por categoria');
  doc.font('Helvetica');
  if (!m.email.motivos_categoria.length) listaVazia(doc);
  for (const r of m.email.motivos_categoria) linhaLista(doc, r.categoria, String(r.total));
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('Por área do problema');
  doc.font('Helvetica');
  if (!m.email.motivos_area.length) listaVazia(doc);
  for (const r of m.email.motivos_area) linhaLista(doc, r.area_problema, String(r.total));

  secao(doc, 'E-mail — motivos de reembolso');
  if (!m.email.motivos_reembolso.length) listaVazia(doc);
  for (const r of m.email.motivos_reembolso) linhaLista(doc, r.problema_pagamento, String(r.total));

  secao(doc, 'Fotos analisadas nos anexos (acumulado)');
  linhaLista(doc, 'Total de anexos analisados', String(m.fotos.total_analisadas));
  linhaLista(doc, 'Com defeito visível identificado', String(m.fotos.com_defeito));
  doc.moveDown(0.3);
  if (!m.fotos.por_tipo.length) listaVazia(doc);
  for (const r of m.fotos.por_tipo) linhaLista(doc, r.tipo_conteudo, String(r.total));

  doc.end();
  return pronto;
}

/* ═══════════════════════════════  e-mail  ═════════════════════════════════ */

const { SMTP_HOST, SMTP_PORT, SMTP_USUARIO, SMTP_SENHA, SMTP_DE, SMTP_SEGURO } = process.env;
const smtpConfigurado = Boolean(SMTP_HOST && SMTP_DE);

let transporte = null;
function obterTransporte() {
  if (!smtpConfigurado) return null;
  if (transporte) return transporte;
  const porta = Number(SMTP_PORT) || 587;
  transporte = nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: SMTP_SEGURO ? SMTP_SEGURO === 'true' : porta === 465,
    auth: SMTP_USUARIO ? { user: SMTP_USUARIO, pass: SMTP_SENHA } : undefined,
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
  return transporte;
}

/** Nunca estoura: quem baixou o PDF recebe o arquivo mesmo se isto falhar. */
async function enviarRelatorioPorEmail({ para, buffer, dias, log }) {
  if (!smtpConfigurado) return;
  try {
    await obterTransporte().sendMail({
      from: SMTP_DE,
      to: para,
      subject: `Relatório de métricas — últimos ${dias} dias`,
      text: `Segue em anexo o relatório de métricas dos últimos ${dias} dias, gerado agora pelo painel SendTrace.`,
      attachments: [{
        filename: `relatorio-metricas-${dias}d.pdf`, content: buffer, contentType: 'application/pdf',
      }],
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  } catch (err) {
    log.warn({ err }, 'falha ao enviar relatório por e-mail');
  }
}

/* ═══════════════════════════════  rotas  ══════════════════════════════════ */

function diasDaQuery(req) {
  const bruto = Number(req.query.dias);
  if (!Number.isFinite(bruto)) return 30;
  return Math.min(365, Math.max(1, Math.round(bruto)));
}

export default async function rotasRelatorio(app) {
  app.get('/api/relatorio/metricas/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Métricas agregadas do relatório (Chat, e-mail, abertura, reembolsos, fotos)',
      description: 'NPS e taxa de devolução física ficam de fora de propósito — nenhuma das '
        + 'duas tem fonte de dado pronta hoje (ver PLANO-tracking-abertura-e-relatorio-metricas.md).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { dias: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      },
    },
  }, async (req) => coletarMetricas(diasDaQuery(req)));

  app.get('/api/relatorio/pdf/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'O mesmo relatório em PDF — e envia uma cópia para quem pediu',
      description: 'O download e o e-mail são o MESMO clique: o PDF sai como resposta HTTP e, '
        + 'em paralelo, uma cópia é mandada para o e-mail de quem está logado (best-effort — '
        + 'falha de SMTP não impede o download).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { dias: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      },
    },
  }, async (req, resposta) => {
    const dias = diasDaQuery(req);
    const metricas = await coletarMetricas(dias);
    const buffer = await montarPdf(metricas);

    if (!req.usuario.servico && req.usuario.email) {
      // Não usa `await`: o download não deve esperar a ida ao servidor SMTP.
      enviarRelatorioPorEmail({ para: req.usuario.email, buffer, dias, log: req.log });
    }

    resposta
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="relatorio-metricas-${dias}d.pdf"`);
    return resposta.send(buffer);
  });
}
