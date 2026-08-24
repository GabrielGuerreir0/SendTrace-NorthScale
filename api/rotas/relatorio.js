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

/**
 * Quando o pixel de abertura entrou no ar (20/08/2026 ~08h30, 10 min antes
 * da primeira abertura real registrada nas duas tabelas). Sem isto, a taxa
 * de abertura por etapa comparava aberturas de HOJE com "enviados" que
 * incluíam anos de disparos antigos — e-mails que nunca tiveram pixel
 * nenhum, porque foram mandados antes de o código existir. O denominador
 * ficava artificialmente enorme e a taxa, artificialmente (e
 * permanentemente) pequena. Achado pelo usuário 20/08/2026: "os dados devem
 * ser comparados a partir do momento que iniciou as novas implementações".
 */
const PIXEL_ABERTURA_DESDE = '2026-08-20 08:30:00-03';

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

    // "enviados_aprox" só conta disparos CRIADOS depois do pixel entrar no
    // ar — etapa_atual é um ponteiro de estado sem data própria, então não
    // dá pra saber quando cada etapa foi mandada de verdade; usar criado_em
    // do pedido é a aproximação mais simples que não mistura pedido velho
    // (nunca teve pixel) com pedido novo. "abertos" segue o mesmo recorte
    // (join com disparos_pos_venda) pra numerador e denominador falarem da
    // MESMA população — sem isso um disparo antigo que abrisse por acaso
    // contaria no numerador sem nunca poder contar no denominador.
    query(`
      SELECT e.etapa, e.nome,
        (SELECT count(*)::int FROM disparos_pos_venda d
           WHERE d.etapa_atual > e.etapa AND d.criado_em >= $1::timestamptz) AS enviados_aprox,
        (SELECT count(DISTINCT ab.disparo_id)::int FROM aberturas_disparo ab
           JOIN disparos_pos_venda d2 ON d2.id = ab.disparo_id
           WHERE ab.etapa = e.etapa AND d2.criado_em >= $1::timestamptz) AS abertos
      FROM etapas_regua e
      WHERE e.etapa BETWEEN 0 AND 5
      ORDER BY e.etapa`, [PIXEL_ABERTURA_DESDE]),

    // Aqui não precisa aproximar: resposta_enviada_em É o instante do envio
    // de verdade (não um ponteiro de estado), então o corte pelo cutover é
    // exato — GREATEST com o início do período escolhido, o que for mais
    // recente.
    query(`
      SELECT
        (SELECT count(*)::int FROM email_ia.emails
           WHERE resposta_enviada_em IS NOT NULL
             AND resposta_enviada_em >= GREATEST(now() - ($1::int || ' days')::interval, $2::timestamptz)) AS enviados,
        (SELECT count(DISTINCT ab.email_id)::int FROM email_ia.aberturas_email ab
           JOIN email_ia.emails e2 ON e2.id = ab.email_id
           WHERE e2.resposta_enviada_em IS NOT NULL
             AND e2.resposta_enviada_em >= GREATEST(now() - ($1::int || ' days')::interval, $2::timestamptz)) AS abertos`,
    [dias, PIXEL_ABERTURA_DESDE]),

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
      SELECT motivo_devolucao, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - ($1::int || ' days')::interval
        AND plataforma_origem IS NULL AND motivo_devolucao IS NOT NULL
      GROUP BY motivo_devolucao ORDER BY total DESC`, p),

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

/* ═══════════════════════════════  PDF  ═══════════════════════════════════
 * Cores tiradas direto de public/styles.css (:root, tema claro) — o PDF é
 * sempre "modo claro" (papel), então usa a mesma paleta que o painel mostra
 * fora do modo escuro. AZUL é o `--azul` usado nos e-mails transacionais
 * (server/email.js) — é a cor que o cliente já vê nos botões de e-mail.
 * ═══════════════════════════════════════════════════════════════════════ */

const COR = {
  TINTA: '#201f1c',
  TINTA_2: '#55534e',
  TINTA_FRACA: '#8b8983',
  SUPERFICIE_2: '#f1efe9',
  BORDA: '#e1e0d9',
  BRANCO: '#ffffff',
  AZUL: '#415fe5',
  VERDE: '#0ca30c',
  TEAL: '#1baf7a',
  AMBAR: '#fab219',
  VERMELHO: '#d03b3b',
};

// Só o suficiente pra não mostrar slug cru (devolucao, pede_cancelamento_reembolso)
// no relatório — mesma fonte de LABEL_* de public/emailComum.js, mas esse
// arquivo é do navegador (mexe em `document`) e não dá pra importar aqui.
const LABEL_CATEGORIA = {
  devolucao: 'Devolução', reclamacao: 'Reclamação', duvida_produto: 'Dúvida sobre produto',
  duvida_pedido: 'Dúvida sobre pedido', orcamento: 'Orçamento', elogio: 'Elogio',
  troca: 'Troca', garantia: 'Garantia', cancelamento: 'Cancelamento', outro: 'Outro',
};
const LABEL_AREA_PROBLEMA = {
  entrega: 'Entrega', produto: 'Produto', codigo_rastreio: 'Código de rastreio',
  pagamento: 'Pagamento', atendimento: 'Atendimento', anuncio_informacao: 'Anúncio/informação', outro: 'Outro',
};
const LABEL_MOTIVO_DEVOLUCAO = {
  produto_com_defeito: 'Produto com defeito', produto_errado: 'Produto errado',
  dano_no_transporte: 'Dano no transporte', atraso_na_entrega: 'Atraso na entrega',
  arrependimento: 'Arrependimento', tamanho_ou_medida_errada: 'Tamanho/medida errada',
  diferente_do_anuncio: 'Diferente do anúncio', compra_duplicada: 'Compra duplicada', outro: 'Outro',
};
const LABEL_TIPO_CONTEUDO = {
  foto_produto: 'Foto de produto', defeito: 'Defeito', nota_fiscal: 'Nota fiscal',
  comprovante: 'Comprovante', print_tela: 'Print de tela', documento: 'Documento', outro: 'Outro',
  sem_analise: 'Sem análise',
};
const rotular = (mapa, v) => (v ? (mapa[v] ?? v) : '—');

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
const n = (v) => String(v ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const PAGINA_L = 595.28;
const PAGINA_A = 841.89;
const MARGEM = 44;
const LARGURA_UTIL = PAGINA_L - MARGEM * 2;

/** Vira a página ANTES de desenhar um bloco que não cabe mais — nunca no meio dele. */
function garantirEspaco(doc, altura) {
  if (doc.y + altura > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Título de seção: pílula colorida, mesma linguagem visual dos chips do painel (.gal-chip/.selo-estado). */
function secaoTitulo(doc, titulo, cor = COR.AZUL) {
  garantirEspaco(doc, 46);
  doc.moveDown(1.1);
  doc.font('Helvetica-Bold').fontSize(11);
  const y = doc.y;
  const largura = doc.widthOfString(titulo) + 22;
  doc.roundedRect(MARGEM, y, largura, 20, 10).fill(cor);
  doc.fillColor(COR.BRANCO).text(titulo, MARGEM + 11, y + 5.5, { lineBreak: false });
  doc.x = MARGEM;
  doc.y = y + 28;
  doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9.5);
}

function subtitulo(doc, texto) {
  garantirEspaco(doc, 20);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COR.TINTA_2).text(texto);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9.5).fillColor(COR.TINTA);
}

function vazio(doc, texto = 'Sem dados no período.') {
  garantirEspaco(doc, 16);
  doc.fillColor(COR.TINTA_FRACA).fontSize(9).text(texto);
  doc.fillColor(COR.TINTA).fontSize(9.5);
  doc.moveDown(0.2);
}

/** 4 cartões coloridos lado a lado — mesma hierarquia visual do .kpi do painel. */
function desenharKpis(doc, kpis) {
  const altura = 68;
  garantirEspaco(doc, altura + 16);
  const gap = 10;
  const larguraCard = (LARGURA_UTIL - gap * (kpis.length - 1)) / kpis.length;
  const y = doc.y;
  kpis.forEach((k, i) => {
    const x = MARGEM + i * (larguraCard + gap);
    doc.roundedRect(x, y, larguraCard, altura, 8).fill(COR.SUPERFICIE_2);
    doc.rect(x, y, 3.5, altura).fill(k.cor);
    doc.fillColor(COR.TINTA_FRACA).font('Helvetica-Bold').fontSize(7)
      .text(k.rotulo.toUpperCase(), x + 12, y + 12, { width: larguraCard - 22, lineBreak: false });
    doc.fillColor(COR.TINTA).font('Helvetica-Bold').fontSize(18)
      .text(k.valor, x + 12, y + 24, { width: larguraCard - 22, lineBreak: false });
    doc.fillColor(COR.TINTA_FRACA).font('Helvetica').fontSize(7)
      .text(k.nota, x + 12, y + 47, { width: larguraCard - 22 });
  });
  doc.x = MARGEM;
  doc.y = y + altura + 18;
  doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9.5);
}

/**
 * Barra horizontal rótulo→número, mesma forma do `.sup-item`/`barraHorizontal`
 * do painel (public/emailComum.js) — só que desenhada, não HTML.
 */
function barrasHorizontais(doc, itens, {
  campoRotulo, campoValor = 'total', cor = COR.AZUL, rotular: fnRotular = (v) => v,
} = {}) {
  if (!itens.length) return vazio(doc);
  const max = Math.max(...itens.map((i) => i[campoValor]));
  const larguraRotulo = 200;
  const larguraNum = 46;
  const larguraBarra = LARGURA_UTIL - larguraRotulo - larguraNum - 10;

  for (const item of itens) {
    const altura = 15;
    garantirEspaco(doc, altura + 3);
    const y = doc.y;
    doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9)
      .text(fnRotular(item[campoRotulo]), MARGEM, y + 2, { width: larguraRotulo, lineBreak: false, ellipsis: true });
    doc.roundedRect(MARGEM + larguraRotulo, y + 3, larguraBarra, 7, 2).fill(COR.SUPERFICIE_2);
    const w = max > 0 ? Math.max(3, (item[campoValor] / max) * larguraBarra) : 0;
    if (w > 0) doc.roundedRect(MARGEM + larguraRotulo, y + 3, w, 7, 2).fill(cor);
    doc.fillColor(COR.TINTA).font('Helvetica-Bold').fontSize(9)
      .text(n(item[campoValor]), MARGEM + larguraRotulo + larguraBarra + 8, y + 2, { width: larguraNum, align: 'right', lineBreak: false });
    doc.x = MARGEM;
    doc.y = y + altura;
  }
  doc.moveDown(0.3);
}

/** Barra horizontal de PORCENTAGEM (taxa de abertura) — enche relativo a 100%, não ao maior item. */
function barrasPercentual(doc, itens, { campoRotulo, campoTaxa, campoDetalhe, cor = COR.VERDE }) {
  if (!itens.length) return vazio(doc);
  const larguraRotulo = 230;
  const larguraNum = 110;
  const larguraBarra = LARGURA_UTIL - larguraRotulo - larguraNum - 10;

  for (const item of itens) {
    const altura = 15;
    garantirEspaco(doc, altura + 3);
    const y = doc.y;
    doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9)
      .text(item[campoRotulo], MARGEM, y + 2, { width: larguraRotulo, lineBreak: false, ellipsis: true });
    doc.roundedRect(MARGEM + larguraRotulo, y + 3, larguraBarra, 7, 2).fill(COR.SUPERFICIE_2);
    const taxa = item[campoTaxa] ?? 0;
    const w = Math.max(taxa > 0 ? 3 : 0, taxa * larguraBarra);
    if (w > 0) doc.roundedRect(MARGEM + larguraRotulo, y + 3, w, 7, 2).fill(cor);
    doc.fillColor(COR.TINTA).font('Helvetica-Bold').fontSize(9)
      .text(`${pct(item[campoTaxa])} (${item[campoDetalhe]})`, MARGEM + larguraRotulo + larguraBarra + 8, y + 2,
        { width: larguraNum, align: 'right', lineBreak: false });
    doc.x = MARGEM;
    doc.y = y + altura;
  }
  doc.moveDown(0.3);
}

/** Gráfico de colunas verticais — mesma ideia do desenharColunas() do painel (public/charts.js). */
function graficoColunas(doc, dados, { campoRotulo, campoValor = 'total', cor = COR.AZUL, altura = 100 } = {}) {
  garantirEspaco(doc, altura + 34);
  if (!dados.length) return vazio(doc);
  const max = Math.max(...dados.map((d) => d[campoValor]), 1);
  const y0 = doc.y;
  const slot = LARGURA_UTIL / dados.length;
  const largBarra = Math.max(2, Math.min(slot - 4, 30));

  doc.moveTo(MARGEM, y0 + altura).lineTo(MARGEM + LARGURA_UTIL, y0 + altura).lineWidth(0.5).stroke(COR.BORDA);
  dados.forEach((d, i) => {
    const val = d[campoValor];
    if (!val) return;
    const h = (val / max) * (altura - 8);
    const x = MARGEM + i * slot + (slot - largBarra) / 2;
    doc.roundedRect(x, y0 + altura - h, largBarra, h, largBarra > 6 ? 2 : 0).fill(cor);
  });
  doc.font('Helvetica').fontSize(6.5).fillColor(COR.TINTA_FRACA);
  const passo = Math.max(1, Math.ceil(dados.length / 14));
  dados.forEach((d, i) => {
    if (i % passo !== 0 && i !== dados.length - 1) return;
    doc.text(String(d[campoRotulo]), MARGEM + i * slot, y0 + altura + 4, { width: slot, align: 'center', lineBreak: false });
  });
  doc.x = MARGEM;
  doc.y = y0 + altura + 18;
  doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9.5);
}

function rodapePaginas(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = range.start; i < range.start + total; i += 1) {
    doc.switchToPage(i);
    // O texto vai ABAIXO da margem inferior de propósito (é o rodapé) — mas
    // sem zerar a margem antes, o pdfkit interpreta isso como conteúdo que
    // não coube e cria uma página nova em branco pra cada página existente
    // (foi exatamente o que aconteceu no teste: 3 páginas de conteúdo
    // viraram 6, e o rodapé ainda saía com o total ERRADO, "de 3").
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(COR.TINTA_FRACA)
      .text(`SendTrace · Relatório de métricas · página ${i + 1} de ${total}`,
        MARGEM, PAGINA_A - 32, { width: LARGURA_UTIL, align: 'center', lineBreak: false });
    doc.page.margins.bottom = margemInferior;
  }
}

function montarPdf(m) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });
  const pedacos = [];
  doc.on('data', (c) => pedacos.push(c));
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(pedacos))));

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // ── faixa do cabeçalho, cor de marca ──
  const alturaFaixa = 78;
  doc.rect(0, 0, PAGINA_L, alturaFaixa).fill(COR.TINTA);
  doc.fillColor(COR.BRANCO).font('Helvetica-Bold').fontSize(9)
    .text('SENDTRACE', MARGEM, 20, { characterSpacing: 1.5, lineBreak: false });
  doc.fontSize(19).text('Relatório de Métricas', MARGEM, 34, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#c3c2b7')
    .text(`Período: últimos ${m.periodo_dias} dias  ·  Gerado em ${agora}`, MARGEM, 58, { lineBreak: false });
  doc.y = alturaFaixa + 20;
  doc.x = MARGEM;
  doc.fillColor(COR.TINTA).font('Helvetica').fontSize(9.5);

  // ── KPIs ──
  const totalReembolsoEmail = m.email.motivos_reembolso.reduce((a, r) => a + r.total, 0);
  desenharKpis(doc, [
    {
      rotulo: 'Contatos no chat', valor: n(m.chat.contatos_total),
      nota: `iniciados em ${m.periodo_dias} dias`, cor: COR.AZUL,
    },
    {
      rotulo: 'Abertura automática', valor: pct(m.abertura.resposta_automatica.taxa),
      nota: `${n(m.abertura.resposta_automatica.abertos)} de ${n(m.abertura.resposta_automatica.enviados)}`, cor: COR.VERDE,
    },
    {
      rotulo: 'Problema de pagamento', valor: n(totalReembolsoEmail),
      nota: 'no período, excluindo "sem problema"', cor: COR.VERMELHO,
    },
    {
      rotulo: 'Fotos com defeito', valor: n(m.fotos.com_defeito),
      nota: `de ${n(m.fotos.total_analisadas)} anexos (acumulado)`, cor: COR.AMBAR,
    },
  ]);

  secaoTitulo(doc, 'Chat com IA — contatos', COR.AZUL);
  subtitulo(doc, `Contatos por dia (total: ${n(m.chat.contatos_total)})`);
  graficoColunas(doc, m.chat.contatos_serie.map((r) => ({
    dia: new Date(r.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), total: r.total,
  })), { campoRotulo: 'dia', cor: COR.AZUL });
  subtitulo(doc, 'Principais motivos de contato');
  barrasHorizontais(doc, m.chat.motivos, { campoRotulo: 'label', cor: COR.AZUL });
  subtitulo(doc, 'Onde a jornada gera contato');
  barrasHorizontais(doc, m.chat.jornada, { campoRotulo: 'nome', cor: COR.TEAL });

  secaoTitulo(doc, 'Taxa de abertura de e-mail', COR.VERDE);
  subtitulo(doc, 'Régua de pós-venda, por etapa (só pedidos criados depois que o pixel entrou no ar)');
  barrasPercentual(
    doc,
    m.abertura.regua_por_etapa.map((r) => ({
      rotulo: `Etapa ${r.etapa} — ${r.nome}`, taxa: r.taxa, detalhe: `${n(r.abertos)}/${n(r.enviados_aprox)}`,
    })),
    { campoRotulo: 'rotulo', campoTaxa: 'taxa', campoDetalhe: 'detalhe', cor: COR.VERDE },
  );
  subtitulo(doc, 'Resposta automática (período)');
  barrasPercentual(
    doc,
    [{
      rotulo: 'Taxa de abertura', taxa: m.abertura.resposta_automatica.taxa,
      detalhe: `${n(m.abertura.resposta_automatica.abertos)}/${n(m.abertura.resposta_automatica.enviados)}`,
    }],
    { campoRotulo: 'rotulo', campoTaxa: 'taxa', campoDetalhe: 'detalhe', cor: COR.VERDE },
  );

  secaoTitulo(doc, 'Reembolsos por dias após a compra', COR.AMBAR);
  subtitulo(doc, 'Sinalizados por e-mail');
  graficoColunas(doc, m.reembolsos_por_dia.email, { campoRotulo: 'bucket', cor: COR.AMBAR });
  subtitulo(doc, 'Pedidos no chat de suporte');
  graficoColunas(doc, m.reembolsos_por_dia.chat, { campoRotulo: 'bucket', cor: COR.AMBAR });

  secaoTitulo(doc, 'E-mail — motivos de contato', COR.AZUL);
  subtitulo(doc, 'Por categoria');
  barrasHorizontais(doc, m.email.motivos_categoria, { campoRotulo: 'categoria', cor: COR.AZUL, rotular: (v) => rotular(LABEL_CATEGORIA, v) });
  subtitulo(doc, 'Por área do problema');
  barrasHorizontais(doc, m.email.motivos_area, { campoRotulo: 'area_problema', cor: COR.AZUL, rotular: (v) => rotular(LABEL_AREA_PROBLEMA, v) });

  secaoTitulo(doc, 'E-mail — motivos de reembolso', COR.VERMELHO);
  barrasHorizontais(doc, m.email.motivos_reembolso, { campoRotulo: 'motivo_devolucao', cor: COR.VERMELHO, rotular: (v) => rotular(LABEL_MOTIVO_DEVOLUCAO, v) });

  secaoTitulo(doc, 'Fotos analisadas nos anexos (acumulado)', COR.TEAL);
  desenharKpis(doc, [
    { rotulo: 'Total de anexos analisados', valor: n(m.fotos.total_analisadas), nota: 'acumulado', cor: COR.TEAL },
    { rotulo: 'Com defeito visível', valor: n(m.fotos.com_defeito), nota: 'identificado pela IA', cor: COR.AMBAR },
  ]);
  barrasHorizontais(doc, m.fotos.por_tipo, { campoRotulo: 'tipo_conteudo', cor: COR.TEAL, rotular: (v) => rotular(LABEL_TIPO_CONTEUDO, v) });

  rodapePaginas(doc);
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
