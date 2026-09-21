/**
 * Visão Geral — a Home do SendTrace (v2, 21/09/2026).
 *
 * Segue a especificação "CS NorthScale · Visão Geral do SendTrace v2" (pasta
 * Projetos/SendTrace/Correções) juntada com o documento RETIRAR DASH: a página
 * responde sete perguntas na ordem A–G, um período único no topo com comparação
 * ao período anterior, e todo número sai daqui com a base e a referência.
 *
 * Regras da especificação que esta rota cumpre:
 *  · Mediana e P90 nos tempos — a média só aparece ao lado, nunca sozinha.
 *  · Todo indicador devolve a base (numerador e denominador), não só a taxa.
 *  · Lote de script fica de fora dos tempos de atendimento: mais de 25 casos
 *    criados/finalizados/resolvidos no MESMO minuto não é gente (ex.: a limpeza
 *    de 20/09, 489 casos às 10:04) e desmancharia a mediana.
 *
 * SEM o dash (decisão do Lucas: por enquanto não dá para ligar): tudo o que a
 * especificação pedia do dash é calculado aqui, com o que o SendTrace já tem e
 * rotulado como PRÉVIA. O SendTrace recebe os eventos de venda, reembolso e
 * chargeback das plataformas por webhook; guarda o valor do pedido no rastreio;
 * e tem o funil (front, upsell, downsell). Onde o dado é incompleto (reembolso só
 * é confiável desde 09/09/2026), a tela diz desde quando e esconde a comparação.
 *
 * O risco (bloco G) vem guardado no ticket (`risco_*`, migração 043): o banco
 * calcula por palavras-chave nos e-mails + os pesos da seção 06 da especificação
 * (`email_ia.recalcular_risco`), a cada e-mail novo e a cada poucos minutos.
 * Continua uma aproximação por palavras-chave — a tela diz isso.
 *
 * Filtros (plataforma, produto, família da régua, fulfillment): valem para tudo
 * que tem pedido por trás. Tickets e e-mails são filtrados pelo cliente (o
 * e-mail dele precisa ter um pedido que passa no filtro).
 */
import { query } from '../../server/db.js';

const TZ = 'America/Sao_Paulo';

const LIMITE_LOTE = 25;

/* Desde quando cada medição é confiável. Antes disso comparar com o "período
   anterior" daria um número falso, então a tela esconde a variação:
   · reembolso: os eventos das plataformas só entram completos no SendTrace desde
     09/09/2026 (a semana de 03/08 tem 25 eventos, a de 14/09 tem 1.185);
   · resolvido pela IA e motivos: calculados abaixo a partir do primeiro registro. */
const REEMBOLSO_CONFIAVEL_DESDE = '2026-09-09T00:00:00-03:00';

const PLATAFORMAS = ['JVZoo', 'DigiStore24', 'BuyGoods'];
const FULFILLMENT = ['redrock', 'fullstack', 'nenhum'];

/* ═══════════════════════════  janela de período  ═══════════════════════════ */

function periodoDaQuery(q) {
  const periodo = ['hoje', '7d', '30d', 'custom'].includes(q.periodo) ? q.periodo : null;
  const dias = Number.isFinite(Number(q.dias)) ? Math.min(365, Math.max(1, Math.round(Number(q.dias)))) : null;
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (periodo === 'custom' && ok(q.de) && ok(q.ate) && q.de <= q.ate) {
    return { periodo: 'custom', de: q.de, ate: q.ate };
  }
  if (periodo === 'hoje') return { periodo: 'hoje' };
  if (periodo === '7d') return { periodo: '7d', dias: 7 };
  return { periodo: dias ? 'dias' : '30d', dias: dias ?? 30 };
}

async function resolverJanela(p) {
  let sql;
  let args = [];
  if (p.periodo === 'hoje') {
    sql = `SELECT (date_trunc('day', now() AT TIME ZONE '${TZ}')) AT TIME ZONE '${TZ}' AS ini, now() AS fim`;
  } else if (p.periodo === 'custom') {
    sql = `SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS ini,
                  LEAST((($2::date + 1)::timestamp AT TIME ZONE '${TZ}'), now()) AS fim`;
    args = [p.de, p.ate];
  } else {
    sql = 'SELECT now() - make_interval(days => $1::int) AS ini, now() AS fim';
    args = [p.dias];
  }
  const { rows } = await query(
    `SELECT ini, fim, ini - (fim - ini) AS pini,
            round((extract(epoch FROM (fim - ini)) / 86400.0)::numeric, 2)::float AS dias FROM (${sql}) j`,
    args,
  );
  return rows[0];
}

function rotuloPeriodo(p, j) {
  if (p.periodo === 'hoje') return 'Hoje';
  if (p.periodo === '7d') return 'Últimos 7 dias';
  if (p.periodo === 'custom') return `${p.de.split('-').reverse().slice(0, 2).join('/')} a ${p.ate.split('-').reverse().slice(0, 2).join('/')}`;
  return `Últimos ${Math.round(j.dias)} dias`;
}

/* ═════════════════════════════════  filtros  ═══════════════════════════════ */

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Só aceita valores de formato conhecido; qualquer outra coisa é ignorada. */
function filtrosDaQuery(q) {
  const slug = (v) => (typeof v === 'string' && /^[A-Za-z0-9*_-]{1,60}$/.test(v) ? v : null);
  return {
    plataforma: PLATAFORMAS.includes(q.plataforma) ? q.plataforma : null,
    produto: slug(q.produto),
    linha: typeof q.linha === 'string' && /^\d{1,3}$/.test(q.linha) ? q.linha : null,
    fulfillment: FULFILLMENT.includes(q.fulfillment) ? q.fulfillment : null,
  };
}

/**
 * Fragmentos de SQL para os filtros. Valores entram como literais já validados.
 *  FO(alias)  — pedido: `disparos_pos_venda` (plataforma, produto, família);
 *  FC(coluna) — cliente: o e-mail precisa ter um pedido que passa em FO;
 *  FR(alias)  — fulfillment: provedor do rastreio (Red Rock / FullStack).
 */
function montarFiltros(f) {
  const partes = [];
  if (f.plataforma) partes.push((a) => `btrim(${a}.plataforma) = ${lit(f.plataforma)}`);
  if (f.produto) partes.push((a) => `${a}.produto_slug = ${lit(f.produto)}`);
  if (f.linha) partes.push((a) => `${a}.produto_slug IN (SELECT slug FROM produtos WHERE linha = ${lit(f.linha)})`);
  const temPedido = partes.length > 0;
  const FO = (a = 'd') => (temPedido ? ` AND ${partes.map((fn) => fn(a)).join(' AND ')}` : '');
  const FC = (col) => (temPedido
    ? ` AND lower(${col}) IN (SELECT lower(fx.email) FROM disparos_pos_venda fx WHERE fx.email IS NOT NULL${FO('fx')})`
    : '');
  const FR = (a = 'r') => (f.fulfillment ? ` AND coalesce(${a}.provedor, 'nenhum') = ${lit(f.fulfillment)}` : '');
  return { FO, FC, FR, temPedido, ativo: temPedido || Boolean(f.fulfillment) };
}

/* ═════════════════════════════  utilitários  ═══════════════════════════════ */

const num = (v) => (v === null || v === undefined ? null : Number(v));
const razao = (a, b) => (b > 0 ? a / b : null);

/** Contagem em lote: mesmo padrão nas colunas de data que scripts atualizam em massa. */
const LOTE = (col) => `(SELECT date_trunc('minute', ${col}) FROM email_ia.suporte_escalado
                       WHERE ${col} IS NOT NULL GROUP BY 1 HAVING count(*) > ${LIMITE_LOTE})`;

/** Sem contato prévio: nenhum e-mail do cliente e nenhum chat ANTES do estorno. */
const SEM_CONTATO = `NOT EXISTS (SELECT 1 FROM email_ia.emails e WHERE lower(e.remetente_email) = lower(d.email)
                                    AND e.plataforma_origem IS NULL AND e.data_email < d.reembolsado_em)
                     AND NOT EXISTS (SELECT 1 FROM chat_atendimentos c WHERE lower(c.email) = lower(d.email)
                                      AND coalesce(c.iniciado_em, c.criado_em) < d.reembolsado_em)`;

/* ═══════════════════  tempo de atendimento: IA x humano  ═══════════════════ */

/**
 * Cinco medidas, em horas, numa janela [$1, $2):
 *  ia_primeira  — e-mail do cliente até a 1ª resposta automática da IA;
 *  ia_escala    — e-mail do cliente até a IA jogar o caso pro Suporte Escalado;
 *  ia_conclui   — 1º e-mail até a IA concluir sozinha (só é IA quando
 *                 `resolvido_em = ultima_resposta_ia_em`: o UPDATE do fluxo n8n
 *                 grava os dois no mesmo now(); a migração 042 passa a gravar
 *                 `resolvido_por` e o resultado é o mesmo);
 *  humano_pega  — caso chegar no Suporte Escalado até alguém iniciar;
 *  humano_resolve — caso chegar no Suporte Escalado até ser finalizado.
 */
const sqlMedidasCs = (F) => `
  WITH area_cliente AS (
    SELECT DISTINCT ON (lower(remetente_email)) lower(remetente_email) AS email, area_problema
    FROM email_ia.emails
    WHERE area_problema IS NOT NULL AND plataforma_origem IS NULL
    ORDER BY lower(remetente_email), data_email DESC
  ),
  lote_criado AS ${LOTE('criado_em')},
  lote_inicio AS ${LOTE('iniciado_em')},
  lote_final  AS ${LOTE('finalizado_em')},
  lote_resolv AS (
    SELECT date_trunc('minute', resolvido_em) FROM email_ia.tickets
    WHERE resolvido_em IS NOT NULL GROUP BY 1 HAVING count(*) > ${LIMITE_LOTE}
  ),
  m AS (
    SELECT coalesce(ac.area_problema, 'sem_area') AS area, 'ia_primeira' AS medida,
           extract(epoch FROM (e.resposta_enviada_em - e.data_email)) / 3600.0 AS h
    FROM email_ia.emails e
    LEFT JOIN area_cliente ac ON ac.email = lower(e.remetente_email)
    WHERE e.plataforma_origem IS NULL AND e.resposta_enviada_em >= $1 AND e.resposta_enviada_em < $2
      AND e.resposta_enviada_em >= e.data_email${F.FC('e.remetente_email')}
    UNION ALL
    SELECT coalesce(ac.area_problema, 'sem_area'), 'ia_escala',
           extract(epoch FROM (s.criado_em - e.data_email)) / 3600.0
    FROM email_ia.suporte_escalado s
    JOIN email_ia.emails e ON e.id = s.email_id
    LEFT JOIN area_cliente ac ON ac.email = lower(s.remetente_email)
    WHERE s.criado_em >= $1 AND s.criado_em < $2 AND s.criado_em >= e.data_email
      AND date_trunc('minute', s.criado_em) NOT IN (SELECT * FROM lote_criado)${F.FC('s.remetente_email')}
    UNION ALL
    SELECT coalesce(ac.area_problema, 'sem_area'), 'ia_conclui',
           extract(epoch FROM (t.resolvido_em - t.primeiro_email_em)) / 3600.0
    FROM email_ia.tickets t
    LEFT JOIN area_cliente ac ON ac.email = lower(t.remetente_email)
    WHERE t.resolvido_em = t.ultima_resposta_ia_em AND t.primeiro_email_em IS NOT NULL
      AND t.resolvido_em >= $1 AND t.resolvido_em < $2
      AND date_trunc('minute', t.resolvido_em) NOT IN (SELECT * FROM lote_resolv)${F.FC('t.remetente_email')}
    UNION ALL
    SELECT coalesce(ac.area_problema, 'sem_area'), 'humano_pega',
           extract(epoch FROM (s.iniciado_em - s.criado_em)) / 3600.0
    FROM email_ia.suporte_escalado s
    LEFT JOIN area_cliente ac ON ac.email = lower(s.remetente_email)
    WHERE s.iniciado_em >= $1 AND s.iniciado_em < $2 AND s.iniciado_em >= s.criado_em
      AND date_trunc('minute', s.iniciado_em) NOT IN (SELECT * FROM lote_inicio)${F.FC('s.remetente_email')}
    UNION ALL
    SELECT coalesce(ac.area_problema, 'sem_area'), 'humano_resolve',
           extract(epoch FROM (s.finalizado_em - s.criado_em)) / 3600.0
    FROM email_ia.suporte_escalado s
    LEFT JOIN area_cliente ac ON ac.email = lower(s.remetente_email)
    WHERE s.finalizado_em >= $1 AND s.finalizado_em < $2 AND s.finalizado_em >= s.criado_em
      AND date_trunc('minute', s.finalizado_em) NOT IN (SELECT * FROM lote_final)${F.FC('s.remetente_email')}
  )
  SELECT medida, area, count(*)::int AS casos,
         round(avg(h)::numeric, 2)::float AS media_h,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY h))::numeric, 2)::float AS mediana_h,
         round((percentile_cont(0.9) WITHIN GROUP (ORDER BY h))::numeric, 2)::float AS p90_h
  FROM m GROUP BY GROUPING SETS ((medida, area), (medida))
  ORDER BY medida, area NULLS FIRST`;

/* ═══════════════════════════════  risco (bloco G)  ═════════════════════════ */

const sqlRisco = (F) => `
  WITH pedido AS (
    SELECT DISTINCT ON (lower(d.email)) lower(d.email) AS em, r.status_interno,
           floor(extract(epoch FROM (now() - d.criado_em)) / 86400)::int AS dias_compra
    FROM disparos_pos_venda d JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
    WHERE d.email IS NOT NULL ORDER BY lower(d.email), d.criado_em DESC
  ),
  escalado AS (
    SELECT lower(remetente_email) AS em, min(criado_em) AS esc_criado, min(iniciado_em) AS esc_iniciado
    FROM email_ia.suporte_escalado GROUP BY 1
  )
  SELECT lower(t.remetente_email) AS em,
         coalesce(nullif(t.nome, ''), split_part(t.remetente_email, '@', 1)) AS nome,
         t.risco_score AS score, t.risco_nivel AS nivel, t.risco_sinais AS sinais,
         (t.risco_flags->>'disputa')::boolean AS disputa,
         (t.risco_flags->>'reacao')::boolean AS reacao,
         (t.risco_flags->>'fraude')::boolean AS fraude,
         (t.risco_flags->>'pede_reembolso')::boolean AS pede_reembolso,
         t.risco_primeiro_critico_em AS primeiro_critico, t.risco_primeira_reacao_em AS primeira_reacao,
         (SELECT left(coalesce(e.resumo, e.assunto, ''), 140) FROM email_ia.emails e
           WHERE lower(e.remetente_email) = lower(t.remetente_email) AND e.plataforma_origem IS NULL
           ORDER BY e.data_email DESC LIMIT 1) AS resumo,
         p.status_interno AS pedido_status, p.dias_compra,
         (t.status <> 'resolvido') AS ticket_aberto,
         round(extract(epoch FROM (now() - t.ultimo_email_em)) / 3600.0)::int AS espera_h,
         (e.em IS NOT NULL) AS escalado, e.esc_criado, e.esc_iniciado
  FROM email_ia.tickets t
  LEFT JOIN pedido p ON p.em = lower(t.remetente_email)
  LEFT JOIN escalado e ON e.em = lower(t.remetente_email)
  WHERE t.risco_no_radar${F.FC('t.remetente_email')}`;

const ROTULO_PEDIDO = {
  pending: 'Recebido', shipped: 'Em trânsito', delivered: 'Entregue',
  cancelled: 'Cancelado', nao_encontrado: 'Sem rastreio',
};

/* ═════════════════════════  rastreio: entregas na janela  ══════════════════ */

/** Entregas na janela [$1, $2): prazo compra → entrega (h), P90, faixas e por plataforma. */
const sqlEntregas = (F) => `
  WITH e AS (
    SELECT extract(epoch FROM (r.delivered_at - coalesce(d.criado_em, r.order_created_at))) / 3600.0 AS h,
           coalesce(nullif(btrim(d.plataforma), ''), 'sem plataforma') AS plataforma
    FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
    WHERE r.status_interno = 'delivered' AND r.delivered_at >= $1 AND r.delivered_at < $2
      AND coalesce(d.criado_em, r.order_created_at) IS NOT NULL
      AND r.delivered_at >= coalesce(d.criado_em, r.order_created_at)${F.FO('d')}${F.FR('r')})
  SELECT count(*)::int AS entregues,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY h))::numeric, 1)::float AS mediana_h,
         round((percentile_cont(0.9) WITHIN GROUP (ORDER BY h))::numeric, 1)::float AS p90_h,
         count(*) FILTER (WHERE h <= 72)::int AS ate3,
         count(*) FILTER (WHERE h > 72 AND h <= 168)::int AS d3_7,
         count(*) FILTER (WHERE h > 168 AND h <= 360)::int AS d7_15,
         count(*) FILTER (WHERE h > 360)::int AS mais15,
         (SELECT coalesce(json_agg(x ORDER BY x.n DESC), '[]'::json) FROM (
            SELECT plataforma, count(*)::int AS n,
                   round((percentile_cont(0.5) WITHIN GROUP (ORDER BY h))::numeric, 1)::float AS mediana_h
            FROM e GROUP BY 1) x) AS por_plataforma
  FROM e`;

/* ═════════════════════════════  coleta principal  ═════════════════════════ */

async function coletarVisaoGeral(p, comparar, filtros = {}) {
  const j = await resolverJanela(p);
  const { ini, fim, pini } = j;
  const J = [ini, fim, pini];
  const dias = j.dias;
  const serieOk = dias > 1 && dias <= 120;
  const F = montarFiltros(filtros);
  const { FO, FC, FR } = F;
  const CONF = lit(REEMBOLSO_CONFIAVEL_DESDE);
  const parcialFunil = Boolean(filtros.produto || filtros.linha);
  const FOu = filtros.plataforma ? ` AND btrim(u.plataforma) = ${lit(filtros.plataforma)}` : '';
  const linhaMarcadores = `coalesce(${filtros.linha ? lit(filtros.linha) : 'NULL'}, ${filtros.produto ? `(SELECT linha FROM produtos WHERE slug = ${lit(filtros.produto)})` : 'NULL'}, '4')`;

  const Q = {
    // A · prévia: eventos que as plataformas mandam ao SendTrace
    fin: query(`
      SELECT count(*) FILTER (WHERE d.criado_em >= $1 AND d.criado_em < $2)::int AS pedidos,
             count(*) FILTER (WHERE d.criado_em >= $3 AND d.criado_em < $1)::int AS pedidos_ant,
             count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL)::int AS reemb,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1 AND d.chargeback_em IS NULL)::int AS reemb_ant,
             count(*) FILTER (WHERE d.chargeback_em >= $1 AND d.chargeback_em < $2)::int AS cb,
             count(*) FILTER (WHERE d.chargeback_em >= $3 AND d.chargeback_em < $1)::int AS cb_ant
      FROM disparos_pos_venda d
      WHERE (d.criado_em >= $3 OR d.reembolsado_em >= $3 OR d.chargeback_em >= $3)${FO('d')}`, J),

    // R3 · valor reembolsado em $ (prévia): o valor do pedido vem do rastreio (Red Rock/FullStack)
    valor: query(`
      SELECT count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL)::int AS reemb,
             count(r.total) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL)::int AS reemb_com_valor,
             coalesce(sum(r.total) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL), 0)::float AS valor_reemb,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1 AND d.chargeback_em IS NULL)::int AS reemb_ant,
             count(r.total) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1 AND d.chargeback_em IS NULL)::int AS reemb_ant_com_valor,
             coalesce(sum(r.total) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1 AND d.chargeback_em IS NULL), 0)::float AS valor_reemb_ant,
             count(r.total) FILTER (WHERE d.criado_em >= $1 AND d.criado_em < $2)::int AS pedidos_com_valor,
             coalesce(sum(r.total) FILTER (WHERE d.criado_em >= $1 AND d.criado_em < $2), 0)::float AS valor_pedidos,
             coalesce(avg(r.total), 0)::float AS ticket_medio
      FROM disparos_pos_venda d LEFT JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
      WHERE (d.criado_em >= $3 OR d.reembolsado_em >= $3)${FO('d')}${FR('r')}`, J),

    // R1 / C1 · curva de reembolso por coorte (só pedidos criados depois de 09/09, quando o registro é completo).
    // Estimador "de quem já tem idade": no dia D só entram os pedidos com pelo menos D dias.
    curva: query(`
      WITH base AS (
        SELECT floor(extract(epoch FROM (now() - d.criado_em)) / 86400)::int AS idade,
               CASE WHEN d.reembolsado_em >= d.criado_em THEN floor(extract(epoch FROM (d.reembolsado_em - d.criado_em)) / 86400)::int END AS dia_reemb,
               CASE WHEN r.delivered_at >= d.criado_em THEN floor(extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400)::int END AS dia_entrega,
               (r.transacao_id IS NOT NULL) AS com_rastreio
        FROM disparos_pos_venda d LEFT JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
        WHERE d.criado_em >= ${CONF}::timestamptz${FO('d')}${FR('r')})
      SELECT g.dia,
             count(*) FILTER (WHERE b.idade >= g.dia)::int AS expostos,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.dia_reemb <= g.dia)::int AS reemb,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.com_rastreio)::int AS expostos_rastreio,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.com_rastreio AND b.dia_reemb <= g.dia)::int AS reemb_rastreio,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.com_rastreio AND b.dia_entrega <= g.dia)::int AS entregues_rastreio
      FROM generate_series(0, 30) g(dia) CROSS JOIN base b GROUP BY 1 ORDER BY 1`),
    marcadores: query(`SELECT nome, offset_h::float AS offset_h FROM etapas_regua
                       WHERE ativo AND linha = ${linhaMarcadores} ORDER BY offset_h`),

    // Séries diárias (fuso de São Paulo): reembolso, pedidos, entradas, resolvidos, sentimento
    serie: serieOk ? query(`
      WITH dias AS (
        SELECT generate_series(($1::timestamptz AT TIME ZONE '${TZ}')::date,
                               (($2::timestamptz - interval '1 second') AT TIME ZONE '${TZ}')::date,
                               interval '1 day')::date AS d),
      lote_resolv AS (SELECT date_trunc('minute', resolvido_em) FROM email_ia.tickets
                      WHERE resolvido_em IS NOT NULL GROUP BY 1 HAVING count(*) > ${LIMITE_LOTE}),
      reemb AS (SELECT (d.reembolsado_em AT TIME ZONE '${TZ}')::date d, count(*) n FROM disparos_pos_venda d
                WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL${FO('d')} GROUP BY 1),
      cb AS (SELECT (d.chargeback_em AT TIME ZONE '${TZ}')::date d, count(*) n FROM disparos_pos_venda d
             WHERE d.chargeback_em >= $1 AND d.chargeback_em < $2${FO('d')} GROUP BY 1),
      ped AS (SELECT (d.criado_em AT TIME ZONE '${TZ}')::date d, count(*) n FROM disparos_pos_venda d
              WHERE d.criado_em >= $1 AND d.criado_em < $2${FO('d')} GROUP BY 1),
      ent AS (SELECT (primeiro_email_em AT TIME ZONE '${TZ}')::date d, count(*) n FROM email_ia.tickets
              WHERE primeiro_email_em >= $1 AND primeiro_email_em < $2${FC('remetente_email')} GROUP BY 1),
      res AS (SELECT (resolvido_em AT TIME ZONE '${TZ}')::date d, count(*) n FROM email_ia.tickets
              WHERE resolvido_em >= $1 AND resolvido_em < $2${FC('remetente_email')}
                AND date_trunc('minute', resolvido_em) NOT IN (SELECT * FROM lote_resolv) GROUP BY 1),
      sent AS (SELECT (data_email AT TIME ZONE '${TZ}')::date d,
                      count(*) FILTER (WHERE sentimento IN ('negativo', 'muito_negativo')) neg,
                      count(*) FILTER (WHERE sentimento IS NOT NULL) tot
               FROM email_ia.emails WHERE plataforma_origem IS NULL AND data_email >= $1 AND data_email < $2${FC('remetente_email')} GROUP BY 1)
      SELECT dias.d AS dia, coalesce(reemb.n, 0)::int AS reemb, coalesce(cb.n, 0)::int AS cb,
             coalesce(ped.n, 0)::int AS pedidos, coalesce(ent.n, 0)::int AS entradas,
             coalesce(res.n, 0)::int AS resolvidos, coalesce(sent.neg, 0)::int AS neg, coalesce(sent.tot, 0)::int AS tot
      FROM dias LEFT JOIN reemb USING (d) LEFT JOIN cb USING (d) LEFT JOIN ped USING (d)
                LEFT JOIN ent USING (d) LEFT JOIN res USING (d) LEFT JOIN sent USING (d)
      ORDER BY 1`, [ini, fim]) : Promise.resolve({ rows: [] }),

    // Base de 4 semanas (28 dias antes do início): referência dos alertas — nunca o dia anterior
    base28: query(`
      SELECT (SELECT count(*) FROM disparos_pos_venda d WHERE d.reembolsado_em >= $1::timestamptz - interval '28 days' AND d.reembolsado_em < $1::timestamptz AND d.chargeback_em IS NULL${FO('d')})::float / 28 AS reemb_dia,
             (SELECT count(*) FROM email_ia.tickets WHERE primeiro_email_em >= $1::timestamptz - interval '28 days' AND primeiro_email_em < $1::timestamptz${FC('remetente_email')})::float / 28 AS entradas_dia,
             (SELECT count(*) FROM email_ia.emails WHERE plataforma_origem IS NULL AND sentimento IN ('negativo','muito_negativo') AND data_email >= $1::timestamptz - interval '28 days' AND data_email < $1::timestamptz${FC('remetente_email')})::float AS neg,
             (SELECT count(*) FROM email_ia.emails WHERE plataforma_origem IS NULL AND sentimento IS NOT NULL AND data_email >= $1::timestamptz - interval '28 days' AND data_email < $1::timestamptz${FC('remetente_email')})::float AS tot`, [ini]),

    // B · E1 reembolsos sem contato prévio (nem e-mail nem chat antes do estorno)
    e1: query(`
      SELECT count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2)::int AS total,
             count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2 AND ${SEM_CONTATO})::int AS sem_contato,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1)::int AS total_ant,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1 AND ${SEM_CONTATO})::int AS sem_contato_ant
      FROM disparos_pos_venda d
      WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL AND d.email IS NOT NULL${FO('d')}`, J),

    // B · E2 retenção (prévia): quem pediu reembolso por e-mail e NÃO foi reembolsado até agora
    e2: query(`
      WITH pediram AS (
        SELECT lower(e.remetente_email) AS em, min(e.data_email) AS primeira
        FROM email_ia.emails e
        WHERE e.categoria IN ('devolucao', 'cancelamento') AND e.plataforma_origem IS NULL
          AND e.data_email >= GREATEST($1::timestamptz, ${CONF}::timestamptz) AND e.data_email < $2${FC('e.remetente_email')}
        GROUP BY 1)
      SELECT count(*)::int AS pediram,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE lower(d.email) = p.em))::int AS com_pedido,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE lower(d.email) = p.em)
                                AND NOT EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE lower(d.email) = p.em
                                                  AND d.reembolsado_em IS NOT NULL AND d.reembolsado_em >= p.primeira - interval '1 day'))::int AS retidos
      FROM pediram p`, [ini, fim]),

    // B · E4 resolvido só pela IA ÷ resolvidos no período (lote de script fora)
    e4: query(`
      WITH lote AS (SELECT date_trunc('minute', resolvido_em) FROM email_ia.tickets
                    WHERE resolvido_em IS NOT NULL GROUP BY 1 HAVING count(*) > ${LIMITE_LOTE})
      SELECT count(*) FILTER (WHERE resolvido_em >= $1 AND resolvido_em < $2)::int AS resolvidos,
             count(*) FILTER (WHERE resolvido_em >= $1 AND resolvido_em < $2 AND resolvido_em = ultima_resposta_ia_em)::int AS ia,
             count(*) FILTER (WHERE resolvido_em >= $3 AND resolvido_em < $1)::int AS resolvidos_ant,
             count(*) FILTER (WHERE resolvido_em >= $3 AND resolvido_em < $1 AND resolvido_em = ultima_resposta_ia_em)::int AS ia_ant
      FROM email_ia.tickets
      WHERE resolvido_em IS NOT NULL AND date_trunc('minute', resolvido_em) NOT IN (SELECT * FROM lote)${FC('remetente_email')}`, J),

    // B · E3 cobertura por plataforma: % dos pedidos x % dos clientes que falaram com o CS
    e3: query(`
      WITH ped AS (SELECT btrim(d.plataforma) AS p, count(*)::int AS n FROM disparos_pos_venda d
                   WHERE d.criado_em >= $1 AND d.criado_em < $2 AND btrim(d.plataforma) NOT IN ('', 'teste')${FO('d')} GROUP BY 1),
           cont AS (SELECT btrim(d.plataforma) AS p, count(DISTINCT lower(e.remetente_email))::int AS n
                    FROM email_ia.emails e JOIN disparos_pos_venda d ON lower(d.email) = lower(e.remetente_email)
                    WHERE e.plataforma_origem IS NULL AND e.data_email >= $1 AND e.data_email < $2
                      AND btrim(d.plataforma) NOT IN ('', 'teste')${FO('d')} GROUP BY 1)
      SELECT ped.p AS plataforma, ped.n AS pedidos, coalesce(cont.n, 0) AS contatos
      FROM ped LEFT JOIN cont ON cont.p = ped.p ORDER BY ped.n DESC`, [ini, fim]),

    plataformas: query(`SELECT plataforma_origem, count(*)::int AS total FROM email_ia.emails
                        WHERE plataforma_origem IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),

    // C · F1 backlog por idade (estado atual)
    f1: query(`
      SELECT status, faixa, count(*)::int AS n FROM (
        SELECT status, CASE WHEN a < 3 THEN 0 WHEN a < 8 THEN 1 WHEN a < 15 THEN 2 ELSE 3 END AS faixa
        FROM (SELECT status, extract(epoch FROM (now() - coalesce(primeiro_email_em, ultimo_email_em))) / 86400.0 AS a
              FROM email_ia.tickets WHERE status <> 'resolvido'${FC('remetente_email')}) t WHERE a IS NOT NULL) x
      GROUP BY 1, 2`),

    cs: query(sqlMedidasCs(F), [ini, fim]),
    csAnt: comparar ? query(sqlMedidasCs(F), [pini, ini]) : Promise.resolve({ rows: [] }),

    f4: query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE now() - criado_em <= interval '1 day')::int AS ate_1d,
             count(*) FILTER (WHERE now() - criado_em > interval '1 day' AND now() - criado_em <= interval '3 days')::int AS d1_3,
             count(*) FILTER (WHERE now() - criado_em > interval '3 days' AND now() - criado_em <= interval '7 days')::int AS d3_7,
             count(*) FILTER (WHERE now() - criado_em > interval '7 days')::int AS mais_7d
      FROM email_ia.suporte_escalado
      WHERE status IN ('pendente', 'iniciado', 'em_analise', 'esperando_resposta')${FC('remetente_email')}`),

    f5: query(`SELECT count(*) FILTER (WHERE reaberturas > 0)::int AS reabertos,
                      count(*) FILTER (WHERE status = 'resolvido' OR reaberturas > 0)::int AS resolvidos
               FROM email_ia.tickets WHERE true${FC('remetente_email')}`),

    // D · C2 motivos, C3 reclamações por 100 pedidos, C4 reembolso por etapa do funil, C5 sentimento
    c2: query(`
      SELECT motivo_devolucao,
             count(*) FILTER (WHERE data_email >= $1 AND data_email < $2)::int AS total,
             count(*) FILTER (WHERE data_email >= $3 AND data_email < $1)::int AS total_ant
      FROM email_ia.emails
      WHERE categoria IN ('devolucao', 'troca') AND motivo_devolucao IS NOT NULL AND plataforma_origem IS NULL
        AND data_email >= $3 AND data_email < $2${FC('remetente_email')}
      GROUP BY 1`, J),

    // C3: o produto da reclamação é o do PEDIDO do cliente (o mais recente antes do e-mail), não o texto do
    // e-mail — assim o "your order" (P1) some do problema em vez de precisar ser normalizado.
    c3: query(`
      WITH ped AS (SELECT d.produto_slug AS s, count(*)::int AS n FROM disparos_pos_venda d
                   WHERE d.criado_em >= $1 AND d.criado_em < $2 AND d.produto_slug IS NOT NULL${FO('d')} GROUP BY 1),
           rec AS (
             SELECT o.produto_slug AS s, count(DISTINCT lower(e.remetente_email))::int AS n
             FROM email_ia.emails e
             JOIN LATERAL (SELECT d.produto_slug FROM disparos_pos_venda d
                           WHERE lower(d.email) = lower(e.remetente_email) AND d.criado_em <= e.data_email${FO('d')}
                           ORDER BY d.criado_em DESC LIMIT 1) o ON true
             WHERE e.categoria IN ('devolucao', 'reclamacao', 'troca') AND e.plataforma_origem IS NULL
               AND e.data_email >= $1 AND e.data_email < $2 GROUP BY 1)
      SELECT CASE WHEN ped.s = '*' THEN 'Não identificado' ELSE coalesce(pr.nome, ped.s) END AS produto, ped.s AS slug, ped.n AS pedidos, coalesce(rec.n, 0) AS reclamantes
      FROM ped LEFT JOIN rec ON rec.s = ped.s LEFT JOIN produtos pr ON pr.slug = ped.s
      WHERE ped.n >= 30 ORDER BY coalesce(rec.n, 0)::float / ped.n DESC LIMIT 8`, [ini, fim]),

    c4: query(`
      WITH t AS (
        SELECT 'front' AS etapa, d.reembolsado_em FROM disparos_pos_venda d
         WHERE d.criado_em >= $1 AND d.criado_em < $2${FO('d')}
        UNION ALL
        SELECT u.etapa_funil, u.reembolsado_em FROM compras_upsell_downsell u
         WHERE u.criado_em >= $1 AND u.criado_em < $2 AND u.etapa_funil IN ('upsell', 'downsell')${FOu})
      SELECT etapa, count(*)::int AS compras, count(reembolsado_em)::int AS reembolsadas FROM t GROUP BY 1`, [ini, fim]),

    c5: query(`
      SELECT count(*) FILTER (WHERE data_email >= $1 AND data_email < $2 AND sentimento IN ('negativo', 'muito_negativo'))::int AS neg,
             count(*) FILTER (WHERE data_email >= $1 AND data_email < $2 AND sentimento = 'muito_negativo')::int AS muito_neg,
             count(*) FILTER (WHERE data_email >= $1 AND data_email < $2 AND sentimento IS NOT NULL)::int AS tot,
             count(*) FILTER (WHERE data_email >= $1 AND data_email < $2 AND sentimento IS NULL)::int AS sem_class,
             count(*) FILTER (WHERE data_email >= $3 AND data_email < $1 AND sentimento IN ('negativo', 'muito_negativo'))::int AS neg_ant,
             count(*) FILTER (WHERE data_email >= $3 AND data_email < $1 AND sentimento IS NOT NULL)::int AS tot_ant
      FROM email_ia.emails WHERE plataforma_origem IS NULL AND data_email >= $3 AND data_email < $2${FC('remetente_email')}`, J),

    // E · saúde técnica
    s1: query(`
      SELECT (SELECT count(*) FROM disparos_pos_venda d WHERE d.status IN ('ativo', 'processando') AND d.ultimo_erro IS NOT NULL${FO('d')})::int AS regua_erro,
             (SELECT count(*) FROM disparos_pos_venda d WHERE d.status IN ('ativo', 'processando')${FO('d')})::int AS regua_total,
             (SELECT count(*) FROM email_ia.emails WHERE erro_resposta_automatica IS NOT NULL AND plataforma_origem IS NULL AND data_email >= $1 AND data_email < $2${FC('remetente_email')})::int AS smtp_erro,
             (SELECT count(*) FROM email_ia.emails WHERE resposta_automatica IS NOT NULL AND plataforma_origem IS NULL AND data_email >= $1 AND data_email < $2${FC('remetente_email')})::int AS smtp_total`, [ini, fim]),
    s2: query(`
      SELECT count(*)::int AS ativos,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM produto_readmes r WHERE r.produto = p.nome AND r.ativo = true))::int AS com_ficha
      FROM produtos p WHERE p.ativo = true AND p.slug <> '*'${filtros.produto ? ` AND p.slug = ${lit(filtros.produto)}` : ''}${filtros.linha ? ` AND p.linha = ${lit(filtros.linha)}` : ''}`),
    s3: query(`SELECT count(*) FILTER (WHERE defeito_visivel = true)::int AS com_defeito, count(*)::int AS total
               FROM email_ia.anexos WHERE tipo_conteudo IS NOT NULL`),

    // F · rastreio de encomendas (Red Rock / FullStack)
    tStatus: query(`
      SELECT r.status_interno, count(*)::int AS n
      FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
      WHERE true${FO('d')}${FR('r')} GROUP BY 1`),
    tPendente: query(`
      SELECT CASE WHEN a < 3 THEN 0 WHEN a < 6 THEN 1 ELSE 2 END AS faixa, count(*)::int AS n FROM (
        SELECT extract(epoch FROM (now() - coalesce(d.criado_em, r.order_created_at, r.criado_em))) / 86400.0 AS a
        FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.status_interno = 'pending'${FO('d')}${FR('r')}) x GROUP BY 1`),
    tEntregues: query(sqlEntregas(F), [ini, fim]),
    tEntreguesAnt: comparar ? query(sqlEntregas(F), [pini, ini]) : Promise.resolve({ rows: [{}] }),
    tTransito: query(`
      SELECT count(*) FILTER (WHERE r.shipped_at <= now() - interval '15 days')::int AS mais_15d, count(*)::int AS total
      FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
      WHERE r.status_interno = 'shipped'${FO('d')}${FR('r')}`),

    // T7 · reembolso antes da entrega (só pedidos com rastreio)
    t7: query(`
      SELECT count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2)::int AS reembolsos,
             count(*) FILTER (WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2
                                AND (r.delivered_at IS NULL OR d.reembolsado_em < r.delivered_at))::int AS antes,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1)::int AS reembolsos_ant,
             count(*) FILTER (WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $1
                                AND (r.delivered_at IS NULL OR d.reembolsado_em < r.delivered_at))::int AS antes_ant
      FROM disparos_pos_venda d JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
      WHERE d.reembolsado_em >= $3 AND d.reembolsado_em < $2 AND d.chargeback_em IS NULL${FO('d')}${FR('r')}`, J),

    // R4 (parte): o chat registra quando o reembolso foi evitado
    chat: query(`
      SELECT count(*) FILTER (WHERE reembolso_pedido)::int AS pedidos,
             count(*) FILTER (WHERE reembolso_evitado)::int AS evitados
      FROM chat_atendimentos
      WHERE coalesce(iniciado_em, criado_em) >= $1 AND coalesce(iniciado_em, criado_em) < $2${FC('email')}`, [ini, fim]),

    // G · risco (últimos 30 dias de contato, estado atual)
    risco: query(sqlRisco(F)),
    reincid: query(`
      WITH reincid AS (SELECT lower(remetente_email) em FROM email_ia.emails
                       WHERE categoria IN ('devolucao', 'troca') GROUP BY 1 HAVING count(*) >= 2)
      SELECT count(*) FILTER (WHERE lower(d.email) IN (SELECT em FROM reincid))::int AS de_reincidentes,
             count(*)::int AS total,
             (SELECT count(*)::int FROM reincid) AS clientes
      FROM disparos_pos_venda d WHERE d.reembolsado_em >= $1 AND d.reembolsado_em < $2${FO('d')}`, [ini, fim]),

    cobertura: query(`
      SELECT (SELECT min(resolvido_em) FROM email_ia.tickets WHERE resolvido_em = ultima_resposta_ia_em) AS ia_desde,
             (SELECT min(data_email) FROM email_ia.emails WHERE motivo_devolucao = 'comprou_por_engano') AS motivos_desde`),

    // opções dos filtros do topo
    opcoes: query(`
      SELECT (SELECT coalesce(json_agg(p ORDER BY p), '[]'::json) FROM
                (SELECT DISTINCT btrim(plataforma) AS p FROM disparos_pos_venda WHERE btrim(plataforma) NOT IN ('', 'teste')) x) AS plataformas,
             (SELECT coalesce(json_agg(json_build_object('slug', slug, 'nome', nome, 'linha', linha) ORDER BY nome), '[]'::json)
                FROM produtos WHERE ativo AND slug <> '*') AS produtos,
             (SELECT coalesce(json_agg(x ORDER BY length(x.linha), x.linha), '[]'::json) FROM
                (SELECT linha, string_agg(nome, ', ' ORDER BY nome) AS nomes FROM produtos
                  WHERE ativo AND slug <> '*' AND linha IS NOT NULL GROUP BY linha) x) AS linhas`),
  };

  const chaves = Object.keys(Q);
  const resultados = await Promise.all(Object.values(Q));
  const R = Object.fromEntries(chaves.map((k, i) => [k, resultados[i]]));

  /* ─────────────── montagem ─────────────── */
  const A = R.fin.rows[0];
  const S = R.serie.rows.map((r) => ({ ...r, dia: r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10) }));

  const f1Faixas = { nao_iniciado: [0, 0, 0, 0], em_aberto: [0, 0, 0, 0] };
  for (const r of R.f1.rows) if (f1Faixas[r.status]) f1Faixas[r.status][r.faixa] = r.n;

  const csTotal = (rows) => Object.fromEntries(
    ['ia_primeira', 'ia_escala', 'ia_conclui', 'humano_pega', 'humano_resolve'].map((k) => [k, rows.find((r) => r.medida === k && r.area === null) ?? null]),
  );

  const c5r = R.c5.rows[0];
  const b28 = R.base28.rows[0];

  const tSt = Object.fromEntries(R.tStatus.rows.map((r) => [r.status_interno, r.n]));
  const tTotal = Object.values(tSt).reduce((a, b) => a + b, 0);
  const tPend = [0, 0, 0];
  for (const r of R.tPendente.rows) tPend[r.faixa] = r.n;
  const tE = R.tEntregues.rows[0];
  const tEa = R.tEntreguesAnt.rows[0];
  const tTr = R.tTransito.rows[0];

  // Curva por coorte (C1/R1) e as duas curvas do T7
  const curva = R.curva.rows.map((r) => ({
    dia: r.dia, expostos: r.expostos, reemb: r.reemb,
    expostos_rastreio: r.expostos_rastreio, reemb_rastreio: r.reemb_rastreio, entregues_rastreio: r.entregues_rastreio,
  }));
  const MIN_COORTE = 300;
  const maduro = [...curva].reverse().find((c) => c.expostos >= MIN_COORTE) ?? null;

  // Risco: classifica, ordena (crítico primeiro, depois score) e devolve a fila do dia
  const clientes = R.risco.rows;
  const abertos = clientes.filter((c) => c.ticket_aberto);
  const criticos = clientes.filter((c) => c.nivel === 'critico');
  const criticosAbertos = criticos.filter((c) => c.ticket_aberto);
  const reacao = clientes.filter((c) => c.reacao);
  const ms = (d) => (d ? new Date(d).getTime() : null);
  const humano2h = criticos.filter((c) => c.esc_iniciado && c.primeiro_critico
    && ms(c.esc_iniciado) - ms(c.primeiro_critico) <= 2 * 3_600_000).length;
  const humanoQualquer = criticos.filter((c) => c.esc_iniciado).length;
  const esc24h = reacao.filter((c) => c.esc_criado && c.primeira_reacao
    && ms(c.esc_criado) - ms(c.primeira_reacao) <= 24 * 3_600_000).length;
  const ordem = { critico: 0, alto: 1, medio: 2, baixo: 3 };
  const fila = [...abertos]
    .sort((a, b) => ordem[a.nivel] - ordem[b.nivel] || b.score - a.score || b.espera_h - a.espera_h)
    .slice(0, 10)
    .map((c) => ({
      cliente: c.nome, email: c.em, score: c.score, nivel: c.nivel, sinais: c.sinais,
      pedido: c.pedido_status ? `${ROTULO_PEDIDO[c.pedido_status] ?? c.pedido_status} D${c.dias_compra}` : null,
      espera_h: c.espera_h, resumo: c.resumo,
    }));

  const g = {
    g1: {
      criticos: criticos.length, abertos: criticosAbertos.length,
      humano_2h: humano2h, com_humano: humanoQualquer,
    },
    g5: {
      clientes: R.reincid.rows[0].clientes, reembolsos_deles: R.reincid.rows[0].de_reincidentes,
      reembolsos: R.reincid.rows[0].total,
    },
    g6: {
      relatos: reacao.length,
      escalados: reacao.filter((c) => c.escalado).length,
      escalados_24h: esc24h,
      sem_escalar_abertos: reacao.filter((c) => c.ticket_aberto && !c.escalado).length,
    },
    g7: fila,
    por_nivel: Object.fromEntries(['critico', 'alto', 'medio', 'baixo'].map((n) => [n, abertos.filter((c) => c.nivel === n).length])),
  };

  // E3: participação de cada plataforma nos pedidos x nos clientes que falaram com o CS
  const totPed = R.e3.rows.reduce((a, r) => a + r.pedidos, 0);
  const totCont = R.e3.rows.reduce((a, r) => a + r.contatos, 0);
  const e3 = R.e3.rows.map((r) => ({
    plataforma: r.plataforma, pedidos: r.pedidos, contatos: r.contatos,
    pct_pedidos: razao(r.pedidos, totPed), pct_contatos: razao(r.contatos, totCont),
  }));

  const bloco = {
    a: {
      pedidos: A.pedidos, pedidos_ant: A.pedidos_ant,
      reembolsos: A.reemb, reembolsos_ant: A.reemb_ant,
      chargebacks: A.cb, chargebacks_ant: A.cb_ant,
      serie: S.map((r) => ({ dia: r.dia, reemb: r.reemb, cb: r.cb, pedidos: r.pedidos })),
      valor: R.valor.rows[0],
      curva_maduro: maduro,
      chat: R.chat.rows[0],
    },
    b: {
      e1: R.e1.rows[0],
      e2: R.e2.rows[0],
      e3,
      e4: { ia: R.e4.rows[0].ia, resolvidos: R.e4.rows[0].resolvidos, ia_ant: R.e4.rows[0].ia_ant, resolvidos_ant: R.e4.rows[0].resolvidos_ant },
      plataformas: R.plataformas.rows,
    },
    c: {
      f1: { ...f1Faixas, total: R.f1.rows.reduce((a, r) => a + r.n, 0) },
      f2: { serie: S.map((r) => ({ dia: r.dia, entradas: r.entradas, resolvidos: r.resolvidos })) },
      f3: { atual: csTotal(R.cs.rows), anterior: csTotal(R.csAnt.rows), por_area: R.cs.rows.filter((r) => r.area !== null) },
      f4: R.f4.rows[0],
      f5: R.f5.rows[0],
    },
    d: {
      c1: { curva, marcadores: R.marcadores.rows, min_coorte: MIN_COORTE, desde: REEMBOLSO_CONFIAVEL_DESDE },
      c2: { motivos: R.c2.rows },
      c3: R.c3.rows,
      c4: { etapas: R.c4.rows, parcial: parcialFunil },
      c5: { ...c5r, serie: S.map((r) => ({ dia: r.dia, neg: r.neg, tot: r.tot })) },
    },
    e: { s1: R.s1.rows[0], s2: R.s2.rows[0], s3: R.s3.rows[0] },
    f: {
      total: tTotal, status: tSt, aguardando_faixas: tPend,
      t3: {
        entregues: tE.entregues ?? 0, mediana_h: num(tE.mediana_h), p90_h: num(tE.p90_h),
        faixas: [tE.ate3 ?? 0, tE.d3_7 ?? 0, tE.d7_15 ?? 0, tE.mais15 ?? 0],
        mediana_h_ant: num(tEa.mediana_h), p90_h_ant: num(tEa.p90_h), entregues_ant: tEa.entregues ?? 0,
        por_plataforma: tE.por_plataforma ?? [],
      },
      t4: { entregues: tSt.delivered ?? 0, enviados: (tSt.shipped ?? 0) + (tSt.delivered ?? 0) },
      t5: { atrasadas: tE.mais15 ?? 0, entregues: tE.entregues ?? 0, transito_15d: tTr.mais_15d, em_transito: tTr.total },
      t6: { nao_encontrado: tSt.nao_encontrado ?? 0, total: tTotal },
      t7: { ...R.t7.rows[0], curva },
    },
    g,
  };

  const cob = R.cobertura.rows[0];
  const desde = { reembolso: new Date(REEMBOLSO_CONFIAVEL_DESDE), ia: cob.ia_desde, motivos: cob.motivos_desde };
  // A base anterior só serve se a janela anterior INTEIRA está dentro da medição confiável.
  const comparavel = Object.fromEntries(Object.entries(desde).map(([k, v]) => [k, Boolean(v) && new Date(pini) >= new Date(v)]));
  // Alertas com base de 4 semanas exigem as 4 semanas dentro da medição.
  const base4sem = {
    reembolso: new Date(new Date(ini).getTime() - 28 * 86_400_000) >= desde.reembolso,
  };
  const alertas = montarAlertas({ bloco, b28, dias, base4sem });

  return {
    versao: 2,
    gerado_em: new Date().toISOString(),
    periodo: {
      chave: p.periodo, rotulo: rotuloPeriodo(p, j), dias, comparar,
      de: ini, ate: fim, anterior: { de: pini, ate: ini },
      serie: serieOk,
      // `comparavel.X` = a janela anterior tem medição confiável; `desde.X` diz desde quando.
      comparavel, desde,
    },
    filtros: { aplicados: filtros, opcoes: R.opcoes.rows[0] },
    alertas,
    ...bloco,
  };
}

/* ═══════════════════════  alertas (base de 4 semanas)  ═════════════════════ */

/**
 * Até 3 alertas, do mais grave pro menos. A comparação é com a MÉDIA das 4
 * semanas anteriores (nunca com o dia anterior, que oscila). Sem valor em
 * dólar no SendTrace, o "impacto" que ordena é o desvio relativo/absoluto.
 */
function montarAlertas({ bloco, b28, dias, base4sem }) {
  const lista = [];
  const add = (nivel, peso, titulo, texto, alvo) => lista.push({ nivel, peso, titulo, texto, alvo });
  const pt = (v, c = 1) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: c }).format(v);

  const { a, b, c, d, e, f, g } = bloco;
  const diasN = Math.max(dias, 1 / 24);

  // Reembolsos por dia acima da média das 4 semanas anteriores
  const reembDia = a.reembolsos / diasN;
  if (base4sem.reembolso && b28.reemb_dia > 5 && reembDia > b28.reemb_dia * 1.2) {
    add('alerta', 100 * (reembDia / b28.reemb_dia), 'Reembolsos acima do normal',
      `${pt(reembDia, 0)} por dia neste período, contra ${pt(b28.reemb_dia, 0)} por dia na média das 4 semanas anteriores (+${pt((reembDia / b28.reemb_dia - 1) * 100, 0)}%).`, 'a');
  }
  // Sentimento negativo: pontos percentuais acima da base
  const negPct = razao(d.c5.neg, d.c5.tot);
  const negBase = razao(b28.neg, b28.tot);
  if (negPct !== null && negBase !== null && negPct - negBase > 0.05 && d.c5.tot >= 50) {
    add('atencao', 60 + (negPct - negBase) * 100, 'Sentimento negativo em alta',
      `${pt(negPct * 100)}% dos e-mails classificados são negativos, contra ${pt(negBase * 100)}% na média das 4 semanas anteriores.`, 'd');
  }
  const entDia = c.f2.serie.length ? c.f2.serie.reduce((s, r) => s + r.entradas, 0) / diasN : null;
  if (entDia !== null && b28.entradas_dia > 20 && entDia > b28.entradas_dia * 1.3) {
    add('atencao', 55, 'Entrada de tickets acima do normal',
      `${pt(entDia, 0)} tickets novos por dia, contra ${pt(b28.entradas_dia, 0)} por dia na média das 4 semanas anteriores.`, 'c');
  }
  // Referências absolutas do catálogo
  if (g.g1.abertos > 0) {
    add('alerta', 95, `${pt(g.g1.abertos, 0)} casos críticos com ticket em aberto`,
      'Menção a chargeback, disputa, banco, advogado, fraude ou relato de reação física. A regra é humano em até 2 h.', 'g');
  }
  if (g.g6.sem_escalar_abertos > 0) {
    add('alerta', 90, `${pt(g.g6.sem_escalar_abertos, 0)} relatos de reação física sem escalar para humano`,
      'A meta é 100% escalado em até 24 h.', 'g');
  }
  const velhos = c.f1.nao_iniciado[3] + c.f1.em_aberto[3] + c.f1.nao_iniciado[2] + c.f1.em_aberto[2];
  if (velhos > 0) {
    add('atencao', 50, `${pt(velhos, 0)} tickets sem resolução há mais de 7 dias`,
      'A referência é zero. Depois de 7 dias o pico de reembolso já passou.', 'c');
  }
  if (c.f4.total > 0 && (c.f4.d3_7 + c.f4.mais_7d) > 0) {
    add('atencao', 52, `${pt(c.f4.d3_7 + c.f4.mais_7d, 0)} casos escalados parados há mais de 3 dias`,
      `São ${pt(c.f4.total, 0)} escalados em aberto no total. A referência é zero acima de 3 dias.`, 'c');
  }
  // E3: plataforma com diferença de mais de 20 pontos entre % dos pedidos e % dos contatos
  const fora = (b.e3 ?? []).filter((x) => x.pct_pedidos !== null && x.pct_contatos !== null && x.pct_pedidos - x.pct_contatos > 0.2);
  if (fora.length) {
    const x = fora[0];
    add('atencao', 48, `${x.plataforma} fora do alcance do CS`,
      `${pt(x.pct_pedidos * 100, 0)}% dos pedidos e só ${pt(x.pct_contatos * 100, 0)}% dos clientes que falaram com o CS. Diferença acima de 20 pontos é alerta.`, 'b');
  }
  const ped6 = f.aguardando_faixas[2];
  if (ped6 > 0) {
    add('atencao', 45, `${pt(ped6, 0)} pedidos aguardando envio há 6 dias ou mais`,
      'Pedidos que chegaram na Red Rock e ainda não têm código de rastreio. A referência é zero com 6+ dias.', 'f');
  }
  const t6 = razao(f.t6.nao_encontrado, f.t6.total);
  if (t6 !== null && t6 > 0.02) {
    add('atencao', 40, 'Rastreio não encontra parte dos pedidos',
      `${pt(t6 * 100)}% dos pedidos não foram encontrados na Red Rock nem na FullStack. A meta é abaixo de 2%.`, 'f');
  }
  const s1 = razao(e.s1.regua_erro, e.s1.regua_total);
  if (s1 !== null && s1 > 0.01) {
    add('atencao', 42, 'Falha de envio da régua acima do limite',
      `${pt(s1 * 100)}% dos disparos ativos com erro. O limite é 1%.`, 'e');
  }

  return lista.sort((x, y) => y.peso - x.peso).slice(0, 3).map(({ peso, ...r }) => r);
}

/* ═══════════════════════════════════  rota  ════════════════════════════════ */

export { coletarVisaoGeral, periodoDaQuery, filtrosDaQuery };

export default async function rotasVisaoGeral(app) {
  app.get('/api/visao-geral/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Visão Geral v2 — blocos A a G com período único, comparação e filtros',
      description: 'Página inicial do painel. Período: `periodo` (hoje, 7d, 30d, custom com `de`/`ate` '
        + 'no formato AAAA-MM-DD) ou `dias` (1 a 365). `comparar=1` calcula também o período anterior de '
        + 'mesma duração. Filtros: `plataforma`, `produto` (slug), `linha` (família da régua) e '
        + '`fulfillment` (redrock, fullstack). Não inclui a faixa de insights das outras abas: o painel junta (server/dados.js).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hoje', '7d', '30d', 'custom'] },
          de: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          ate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dias: { type: 'integer', minimum: 1, maximum: 365 },
          comparar: { type: 'integer', enum: [0, 1], default: 1 },
          plataforma: { type: 'string' },
          produto: { type: 'string' },
          linha: { type: 'string' },
          fulfillment: { type: 'string' },
        },
      },
    },
  }, async (req) => coletarVisaoGeral(periodoDaQuery(req.query), req.query.comparar !== 0, filtrosDaQuery(req.query)));
}
