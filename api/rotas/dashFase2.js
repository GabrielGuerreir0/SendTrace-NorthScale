/**
 * Home · Fase 2 do Rodrigo ("Dinheiro") com o dado do dash — 25/09/2026.
 *
 *   R1  Reembolso em D30       coorte: compras de [ini−30 d, fim−30 d) que reembolsaram em até 30 dias
 *   R2  Taxa de chargeback     chargebacks (pela data do chargeback) ÷ vendas do período
 *   R3  Valor reembolsado      US$ estornados (pela data do estorno) no período
 *   C1  Curva por coorte       % acumulado reembolsado por dia desde a compra (compras de 90 a 30 dias atrás)
 *
 * Tudo lê `dash_vendas` (migração 055; o estorno já ligado à venda). Decisões de 25/09 (Lucas):
 *   · "Todas" = JVZoo + Digistore24 + BuyGoods, mas a TAXA usa só as plataformas com dado de estorno
 *     (JVZoo e Digistore24): a BuyGoods não manda reembolso/chargeback (0 de ~72 mil vendas) e derrubaria a taxa.
 *     Ela aparece em `excluidas`, com o volume, para a tela avisar.
 *   · Filtro de produto, família da régua ou fulfillment → `disponivel: false` (o dash não tem fulfillment nem o
 *     mesmo vocabulário de produto); a Home mantém a "prévia" do SendTrace nesse caso.
 *   · Conferência (critério do Rodrigo): front (etapa 1) do dash × pedidos que o SendTrace vê, mesmo período.
 *     O SendTrace só tem o front inteiro; comparar o total daria diferença falsa.
 * As metas vêm do dash (`dash_estado.metas`), não de números fixos.
 */
import { query } from '../../server/db.js';
import { dashConfigurado, lerEstado } from '../../server/dash.js';

export const PLATAFORMAS = ['jvzoo', 'digistore24', 'buygoods'];
export const COMPLETAS = ['jvzoo', 'digistore24'];                    // com dado de estorno confiável
const MOTIVO_EXCLUIDA = { buygoods: 'sem dado de reembolso/chargeback (o postback da BuyGoods não chega ao dash)' };
const AVISO_DIGISTORE = 'Digistore24: cerca de 28% dos estornos só entram por reconciliação manual, dias depois — o número dos últimos dias pode subir.';
const MIN_COORTE = 30;
const DIAS_CURVA = 30;

const pct = (a, b) => (b > 0 ? a / b : null);
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Plataforma do filtro da Home ("JVZoo", "DigiStore24"…) → slug do dash; null = sem filtro; undefined = fora do dash. */
export function slugDoFiltro(filtro) {
  if (!filtro) return null;
  const s = String(filtro).trim().toLowerCase();
  return PLATAFORMAS.includes(s) ? s : undefined;
}

/** Acumula um histograma {dia → n} em pontos D0…D30 (n reembolsados até o dia d). Pura: testável sem banco. */
export function acumularCurva(histograma, expostos, dias = DIAS_CURVA) {
  const pontos = [];
  let acum = 0;
  for (let d = 0; d <= dias; d += 1) {
    acum += histograma.get(d) ?? 0;
    pontos.push({ dia: d, reembolsadas: acum, pct: expostos > 0 ? acum / expostos : null });
  }
  return pontos;
}

export async function coletarFase2({ ini, fim, pini, filtros = {} }) {
  const indisponivel = (motivo, extra = {}) => ({ disponivel: false, motivo, ...extra });

  if (!dashConfigurado()) return indisponivel('dash_desligado');
  if (filtros.produto || filtros.linha || filtros.fulfillment) return indisponivel('filtro');
  const slug = slugDoFiltro(filtros.plataforma);
  if (slug === undefined) return indisponivel('plataforma_fora_do_dash');

  const plats = slug ? [slug] : PLATAFORMAS;
  const completas = plats.filter((p) => COMPLETAS.includes(p));
  const excluidas = plats.filter((p) => !COMPLETAS.includes(p));

  const [sync, metas, cont] = await Promise.all([
    lerEstado('ultimo_sync'), lerEstado('metas'),
    query('SELECT count(*)::int AS n FROM dash_vendas').then((r) => r.rows[0]).catch(() => ({ n: 0 })),
  ]);
  if (!cont.n) return indisponivel('sem_dados');

  const P = [ini, fim, pini, plats];
  const [periodo, coorte, curva, serie, confere] = await Promise.all([
    // R2 + R3 (+ front para a conferência): por plataforma, período atual e anterior
    query(`
      SELECT plataforma,
        count(*) FILTER (WHERE ordered_at >= $1 AND ordered_at < $2)::int                          AS vendas,
        count(*) FILTER (WHERE ordered_at >= $3 AND ordered_at < $1)::int                          AS vendas_ant,
        coalesce(sum(valor) FILTER (WHERE ordered_at >= $1 AND ordered_at < $2), 0)::float         AS vendas_usd,
        count(*) FILTER (WHERE ordered_at >= $1 AND ordered_at < $2 AND funnel_step = 1)::int      AS vendas_front,
        count(*) FILTER (WHERE chargeback AND cb_em >= $1 AND cb_em < $2)::int                     AS cb,
        count(*) FILTER (WHERE chargeback AND cb_em >= $3 AND cb_em < $1)::int                     AS cb_ant,
        coalesce(sum(cb_usd) FILTER (WHERE cb_em >= $1 AND cb_em < $2), 0)::float                  AS cb_usd,
        count(*) FILTER (WHERE reembolsada AND reemb_em >= $1 AND reemb_em < $2)::int              AS reemb,
        coalesce(sum(reemb_usd) FILTER (WHERE reemb_em >= $1 AND reemb_em < $2), 0)::float         AS reemb_usd,
        coalesce(sum(reemb_usd) FILTER (WHERE reemb_em >= $3 AND reemb_em < $1), 0)::float         AS reemb_usd_ant
      FROM dash_vendas
      WHERE plataforma = ANY($4)
        AND (ordered_at >= $3 OR reemb_em >= $3 OR cb_em >= $3)
      GROUP BY 1`, P),

    // R1 D30: coorte das compras que JÁ completaram 30 dias no fim do período (e a do período anterior)
    query(`
      SELECT plataforma,
        count(*) FILTER (WHERE ordered_at >= $1::timestamptz - interval '30 days' AND ordered_at < $2::timestamptz - interval '30 days')::int AS expostos,
        count(*) FILTER (WHERE ordered_at >= $1::timestamptz - interval '30 days' AND ordered_at < $2::timestamptz - interval '30 days'
                           AND reemb_em IS NOT NULL AND reemb_em <= ordered_at + interval '30 days')::int AS reembolsadas,
        count(*) FILTER (WHERE ordered_at >= $3::timestamptz - interval '30 days' AND ordered_at < $1::timestamptz - interval '30 days')::int AS expostos_ant,
        count(*) FILTER (WHERE ordered_at >= $3::timestamptz - interval '30 days' AND ordered_at < $1::timestamptz - interval '30 days'
                           AND reemb_em IS NOT NULL AND reemb_em <= ordered_at + interval '30 days')::int AS reembolsadas_ant
      FROM dash_vendas
      WHERE plataforma = ANY($4) AND ordered_at >= $3::timestamptz - interval '30 days' AND ordered_at < $2::timestamptz - interval '30 days'
      GROUP BY 1`, P),

    // C1: histograma "dia em que reembolsou" da coorte de 90 a 30 dias atrás (acumulado feito em JS)
    query(`
      WITH coorte AS (
        SELECT plataforma, ordered_at, reemb_em FROM dash_vendas
        WHERE plataforma = ANY($1) AND ordered_at >= now() - interval '90 days' AND ordered_at < now() - interval '30 days'
      )
      SELECT plataforma, NULL::int AS dia, count(*)::int AS n FROM coorte GROUP BY 1
      UNION ALL
      SELECT plataforma, greatest(0, ceil(extract(epoch FROM (reemb_em - ordered_at)) / 86400.0))::int AS dia, count(*)::int
      FROM coorte WHERE reemb_em IS NOT NULL AND reemb_em >= ordered_at AND reemb_em <= ordered_at + interval '30 days'
      GROUP BY 1, 2`, [plats]),

    // série diária de US$ estornados (pela data do estorno) — só nas plataformas com dado
    query(`
      SELECT to_char(date_trunc('day', reemb_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS dia,
             coalesce(sum(reemb_usd), 0)::float AS usd, count(*)::int AS n
      FROM dash_vendas
      WHERE plataforma = ANY($3) AND reembolsada AND reemb_em >= $1 AND reemb_em < $2
      GROUP BY 1 ORDER BY 1`, [ini, fim, completas.length ? completas : ['_nenhuma_']]),

    // O que o SendTrace vê no mesmo período (conferência)
    query(`
      SELECT lower(btrim(plataforma)) AS plataforma, count(*)::int AS pedidos FROM disparos_pos_venda
      WHERE criado_em >= $1 AND criado_em < $2 AND lower(btrim(plataforma)) = ANY($3) GROUP BY 1`, [ini, fim, plats]),
  ]);

  const soma = (linhas, campo, filtro = () => true) => linhas.filter(filtro).reduce((s, l) => s + num(l[campo]), 0);
  const ehCompleta = (l) => completas.includes(l.plataforma);

  const r1 = {
    expostos: soma(coorte.rows, 'expostos', ehCompleta), reembolsadas: soma(coorte.rows, 'reembolsadas', ehCompleta),
    expostos_ant: soma(coorte.rows, 'expostos_ant', ehCompleta), reembolsadas_ant: soma(coorte.rows, 'reembolsadas_ant', ehCompleta),
  };
  r1.taxa = pct(r1.reembolsadas, r1.expostos);
  r1.taxa_ant = pct(r1.reembolsadas_ant, r1.expostos_ant);

  const r2 = {
    vendas: soma(periodo.rows, 'vendas', ehCompleta), vendas_ant: soma(periodo.rows, 'vendas_ant', ehCompleta),
    chargebacks: soma(periodo.rows, 'cb', ehCompleta), chargebacks_ant: soma(periodo.rows, 'cb_ant', ehCompleta),
  };
  r2.taxa = pct(r2.chargebacks, r2.vendas);
  r2.taxa_ant = pct(r2.chargebacks_ant, r2.vendas_ant);

  const r3 = {
    valor: soma(periodo.rows, 'reemb_usd', ehCompleta), valor_ant: soma(periodo.rows, 'reemb_usd_ant', ehCompleta),
    reembolsos: soma(periodo.rows, 'reemb', ehCompleta), vendas_usd: soma(periodo.rows, 'vendas_usd', ehCompleta),
    chargeback_usd: soma(periodo.rows, 'cb_usd', ehCompleta),
  };
  r3.pct_do_valor = pct(r3.valor, r3.vendas_usd);
  r3.serie = serie.rows;

  // C1: uma linha por plataforma com dado (ou só a filtrada)
  const series = completas.map((plat) => {
    const linhas = curva.rows.filter((l) => l.plataforma === plat);
    const expostos = num(linhas.find((l) => l.dia === null)?.n);
    const hist = new Map(linhas.filter((l) => l.dia !== null).map((l) => [Number(l.dia), Number(l.n)]));
    return { plataforma: plat, expostos, pontos: acumularCurva(hist, expostos) };
  }).filter((s) => s.expostos >= MIN_COORTE);

  const dashFront = soma(periodo.rows, 'vendas_front');
  const stPedidos = soma(confere.rows, 'pedidos');
  const porPlatConf = plats.map((plat) => {
    const df = soma(periodo.rows, 'vendas_front', (l) => l.plataforma === plat);
    const st = soma(confere.rows, 'pedidos', (l) => l.plataforma === plat);
    return { plataforma: plat, dash_front: df, sendtrace: st, diferenca_pct: st > 0 ? (df - st) / st : null };
  });

  const avisos = [];
  if (plats.includes('digistore24')) avisos.push(AVISO_DIGISTORE);

  return {
    disponivel: true,
    plataformas: plats,
    completas,
    excluidas: excluidas.map((p) => ({
      plataforma: p, motivo: MOTIVO_EXCLUIDA[p] ?? 'sem dado de estorno',
      vendas: soma(periodo.rows, 'vendas', (l) => l.plataforma === p),
      vendas_usd: soma(periodo.rows, 'vendas_usd', (l) => l.plataforma === p),
    })),
    atualizado_em: sync?.valor?.fim ?? null,
    metas: metas?.valor ? {
      reembolso_meta_d30_pct: metas.valor.reembolso_meta_d30_pct ?? null,
      reembolso_limite_d30_pct: metas.valor.reembolso_limite_d30_pct ?? null,
      chargeback_atencao_pct: metas.valor.chargeback_atencao_pct ?? null,
      chargeback_limite_pct: metas.valor.chargeback_limite_pct ?? null,
    } : null,
    r1, r2, r3,
    por_plataforma: completas.map((plat) => {
      const c = coorte.rows.find((l) => l.plataforma === plat);
      const p = periodo.rows.find((l) => l.plataforma === plat);
      return {
        plataforma: plat,
        r1: c ? { expostos: c.expostos, reembolsadas: c.reembolsadas, taxa: pct(c.reembolsadas, c.expostos) } : null,
        r2: p ? { vendas: p.vendas, chargebacks: p.cb, taxa: pct(p.cb, p.vendas) } : null,
        r3: p ? { valor: p.reemb_usd, reembolsos: p.reemb } : null,
      };
    }),
    c1: { desde_dias: 90, ate_dias: 30, min_coorte: MIN_COORTE, series },
    confere: {
      dash_front: dashFront, sendtrace: stPedidos,
      diferenca_pct: stPedidos > 0 ? (dashFront - stPedidos) / stPedidos : null,
      por_plataforma: porPlatConf,
    },
    avisos,
  };
}
