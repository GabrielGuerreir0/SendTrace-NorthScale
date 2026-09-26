/**
 * Home · Fase 3 do Rodrigo ("Impacto do CS") com o dado do dash — 26/09/2026.
 *
 *   E1  Reembolsos sem contato prévio   clientes que reembolsaram (dash) sem e-mail/chat antes do estorno (SendTrace)
 *   E2  Taxa de retenção                quem pediu reembolso por e-mail e NÃO foi estornado em até 30 dias (dash confirma)
 *   E3  Cobertura por plataforma        pedidos do dash × clientes que falaram com o CS, por plataforma
 *   C3  Reclamações por 100 pedidos     volume de pedidos por produto vem do dash (front); reclamações, do SendTrace
 *   C4  Reembolso por etapa do funil    front / upsell / downsell direto do dash (funnel_step + product_type)
 *   T7  Reembolso antes da entrega      data de reembolso do dash × entrega do rastreio (SendTrace)
 *
 * R4, G2, G3 e G4 continuam fora: dependem do registro da oferta de retenção (P10) e do teto da controladoria.
 *
 * Mesmas regras da Fase 2 (decisões de 25/09):
 *   · BuyGoods fica de fora de tudo que depende de estorno (0 de ~72 mil vendas com reembolso no dash).
 *   · Filtro de produto, família ou fulfillment → `disponivel: false`; a Home volta pra "prévia" do SendTrace.
 *   · O formato de cada bloco é o MESMO da prévia (campo a campo), para a tela só trocar a fonte.
 *
 * Como o dash se liga ao SendTrace (medido em produção, 60 dias): JVZoo por external_id = transacao_id (99,9%);
 * Digistore24 por session_id (o ID do pedido) = transacao_id (99,98%); e-mail do comprador em customer_email.
 */
import { query } from '../../server/db.js';
import { dashConfigurado } from '../../server/dash.js';
import { PLATAFORMAS, COMPLETAS, slugDoFiltro } from './dashFase2.js';

const MIN_PEDIDOS_PRODUTO = 30;
const JANELA_RETENCAO_DIAS = 30;

/** "NeuroRecall" → neurorecallpro, "Honeyflush" → honeyflush, "Opti Core Pro" → opticorepro… (família do dash → slug do SendTrace). */
export function slugDaFamilia(familia, slugs) {
  const chave = String(familia ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!chave) return null;
  const set = new Set(slugs);
  if (set.has(chave)) return chave;
  if (set.has(`${chave}pro`)) return `${chave}pro`;
  if (chave.endsWith('pro') && set.has(chave.slice(0, -3))) return chave.slice(0, -3);
  return null;
}

/** Junta as linhas (etapa/compras/reembolsadas) de upsell e downsell de cada passo. Pura: testável sem banco. */
export function rotuloPasso(tipo, passo) {
  const nome = { UPSELL: 'Upsell', DOWNSELL: 'Downsell' }[tipo] ?? tipo;
  return passo ? `${nome} ${Math.max(passo - 1, 1)}` : nome;
}

export async function coletarFase3({ ini, fim, pini, filtros = {} }) {
  const indisponivel = (motivo) => ({ disponivel: false, motivo });
  if (!dashConfigurado()) return indisponivel('dash_desligado');
  if (filtros.produto || filtros.linha || filtros.fulfillment) return indisponivel('filtro');
  const slug = slugDoFiltro(filtros.plataforma);
  if (slug === undefined) return indisponivel('plataforma_fora_do_dash');
  const cont = await query('SELECT count(*)::int AS n FROM dash_vendas').then((r) => r.rows[0].n).catch(() => 0);
  if (!cont) return indisponivel('sem_dados');

  const plats = slug ? [slug] : PLATAFORMAS;
  const completas = plats.filter((p) => COMPLETAS.includes(p));
  const excluidas = plats.filter((p) => !COMPLETAS.includes(p));
  const J = [ini, fim, pini, completas.length ? completas : ['_nenhuma_']];
  const dFim = new Date(fim);
  const fimCoorte = new Date(dFim.getTime() - JANELA_RETENCAO_DIAS * 86_400_000).toISOString();
  const iniCoorte = new Date(new Date(ini).getTime() - JANELA_RETENCAO_DIAS * 86_400_000).toISOString();
  // chave que liga a venda do dash ao pedido do SendTrace (transacao_id)
  const CHAVE = "CASE WHEN v.plataforma = 'digistore24' THEN p.session_id ELSE v.external_id END";

  const [slugsProd, e1, e2, e3, c4, c3ped, c3rec, t7, curva] = await Promise.all([
    query('SELECT slug FROM produtos WHERE slug <> \'*\'').then((r) => r.rows.map((x) => x.slug)),

    // E1 — um cliente por período (o 1º estorno dele na janela) × contato ANTES desse estorno
    query(`
      WITH ref AS (
        SELECT lower(p.customer_email) AS em, (v.reemb_em >= $1) AS atual, min(v.reemb_em) AS reemb_em
        FROM dash_vendas v JOIN dash_pedidos p ON p.plataforma = v.plataforma AND p.external_id = v.external_id
        WHERE v.plataforma = ANY($4) AND v.reembolsada AND NOT v.chargeback
          AND v.reemb_em >= $3 AND v.reemb_em < $2 AND p.customer_email IS NOT NULL
        GROUP BY 1, 2),
      c AS (
        SELECT ref.*,
               (EXISTS (SELECT 1 FROM email_ia.emails e WHERE lower(e.remetente_email) = ref.em
                          AND e.plataforma_origem IS NULL AND e.data_email < ref.reemb_em)
                OR EXISTS (SELECT 1 FROM chat_atendimentos ch WHERE lower(ch.email) = ref.em
                             AND coalesce(ch.iniciado_em, ch.criado_em) < ref.reemb_em)) AS contato
        FROM ref)
      SELECT count(*) FILTER (WHERE atual)::int                       AS total,
             count(*) FILTER (WHERE atual AND NOT contato)::int       AS sem_contato,
             count(*) FILTER (WHERE NOT atual)::int                   AS total_ant,
             count(*) FILTER (WHERE NOT atual AND NOT contato)::int   AS sem_contato_ant
      FROM c`, J),

    // E2 — coorte de 30 dias atrás: quem pediu reembolso por e-mail e o dash NÃO mostra estorno em até 30 dias
    query(`
      WITH pediram AS (
        SELECT lower(e.remetente_email) AS em, min(e.data_email) AS primeira,
               (min(e.data_email) >= $2::timestamptz) AS atual
        FROM email_ia.emails e
        WHERE e.categoria IN ('devolucao', 'cancelamento') AND e.plataforma_origem IS NULL
          AND e.data_email >= $1::timestamptz AND e.data_email < $3::timestamptz
        GROUP BY 1),
      c AS (
        SELECT p.em, p.primeira, p.atual,
               EXISTS (SELECT 1 FROM dash_vendas v JOIN dash_pedidos d ON d.plataforma = v.plataforma AND d.external_id = v.external_id
                        WHERE v.plataforma = ANY($4) AND lower(d.customer_email) = p.em AND v.ordered_at <= p.primeira) AS com_pedido,
               EXISTS (SELECT 1 FROM dash_vendas v JOIN dash_pedidos d ON d.plataforma = v.plataforma AND d.external_id = v.external_id
                        WHERE v.plataforma = ANY($4) AND lower(d.customer_email) = p.em AND v.reembolsada
                          AND v.reemb_em >= p.primeira - interval '1 day'
                          AND v.reemb_em <= p.primeira + interval '${JANELA_RETENCAO_DIAS} days') AS reembolsou
        FROM pediram p)
      SELECT count(*) FILTER (WHERE atual)::int                                      AS pediram,
             count(*) FILTER (WHERE atual AND com_pedido)::int                       AS com_pedido,
             count(*) FILTER (WHERE atual AND com_pedido AND NOT reembolsou)::int    AS retidos,
             count(*) FILTER (WHERE NOT atual)::int                                  AS pediram_ant,
             count(*) FILTER (WHERE NOT atual AND com_pedido)::int                   AS com_pedido_ant,
             count(*) FILTER (WHERE NOT atual AND com_pedido AND NOT reembolsou)::int AS retidos_ant
      FROM c`, [new Date(new Date(iniCoorte).getTime() - (new Date(fim) - new Date(ini))).toISOString(), iniCoorte, fimCoorte, J[3]]),

    // E3 — pedidos (front) do dash × clientes que falaram com o CS, por plataforma (todas, com ou sem estorno)
    query(`
      WITH ped AS (SELECT plataforma AS p, count(*)::int AS n FROM dash_vendas
                   WHERE plataforma = ANY($3) AND funnel_step = 1 AND ordered_at >= $1 AND ordered_at < $2 GROUP BY 1),
           cont AS (SELECT lower(btrim(d.plataforma)) AS p, count(DISTINCT lower(e.remetente_email))::int AS n
                    FROM email_ia.emails e JOIN disparos_pos_venda d ON lower(d.email) = lower(e.remetente_email)
                    WHERE e.plataforma_origem IS NULL AND e.data_email >= $1 AND e.data_email < $2
                      AND lower(btrim(d.plataforma)) = ANY($3) GROUP BY 1),
           st AS (SELECT lower(btrim(plataforma)) AS p, count(*)::int AS n FROM disparos_pos_venda
                  WHERE criado_em >= $1 AND criado_em < $2 AND lower(btrim(plataforma)) = ANY($3) GROUP BY 1)
      SELECT ped.p AS plataforma, ped.n AS pedidos, coalesce(cont.n, 0) AS contatos, coalesce(st.n, 0) AS pedidos_sendtrace
      FROM ped LEFT JOIN cont ON cont.p = ped.p LEFT JOIN st ON st.p = ped.p ORDER BY ped.n DESC`, [ini, fim, plats]),

    // C4 — compras do período, por etapa (e por passo), já reembolsadas até agora
    query(`
      SELECT CASE WHEN product_type = 'FRONTEND' AND funnel_step = 1 THEN 'front'
                  WHEN product_type = 'UPSELL' AND funnel_step >= 2 THEN 'upsell'
                  WHEN product_type = 'DOWNSELL' AND funnel_step >= 2 THEN 'downsell' END AS etapa,
             product_type, funnel_step,
             count(*)::int AS compras, count(*) FILTER (WHERE reembolsada)::int AS reembolsadas
      FROM dash_vendas
      WHERE plataforma = ANY($3) AND ordered_at >= $1 AND ordered_at < $2
      GROUP BY 1, 2, 3`, [ini, fim, J[3]]),

    // C3 (volume) — pedidos do front por família, todas as plataformas do filtro
    query(`
      SELECT family, count(*)::int AS pedidos FROM dash_vendas
      WHERE plataforma = ANY($3) AND funnel_step = 1 AND product_type = 'FRONTEND' AND ordered_at >= $1 AND ordered_at < $2
      GROUP BY 1`, [ini, fim, plats]),
    // C3 (reclamações) — igual à prévia: o produto é o do pedido mais recente do cliente antes do e-mail
    query(`
      SELECT o.produto_slug AS s, count(DISTINCT lower(e.remetente_email))::int AS n
      FROM email_ia.emails e
      JOIN LATERAL (SELECT d.produto_slug FROM disparos_pos_venda d
                    WHERE lower(d.email) = lower(e.remetente_email) AND d.criado_em <= e.data_email
                      AND lower(btrim(d.plataforma)) = ANY($3)
                    ORDER BY d.criado_em DESC LIMIT 1) o ON true
      WHERE e.categoria IN ('devolucao', 'reclamacao', 'troca') AND e.plataforma_origem IS NULL
        AND e.data_email >= $1 AND e.data_email < $2 GROUP BY 1`, [ini, fim, plats]),

    // T7 — reembolso (data do dash) antes da entrega (rastreio), só pedidos com rastreio
    query(`
      SELECT count(*) FILTER (WHERE v.reemb_em >= $1 AND v.reemb_em < $2)::int AS reembolsos,
             count(*) FILTER (WHERE v.reemb_em >= $1 AND v.reemb_em < $2
                                AND (r.delivered_at IS NULL OR v.reemb_em < r.delivered_at))::int AS antes,
             count(*) FILTER (WHERE v.reemb_em >= $3 AND v.reemb_em < $1)::int AS reembolsos_ant,
             count(*) FILTER (WHERE v.reemb_em >= $3 AND v.reemb_em < $1
                                AND (r.delivered_at IS NULL OR v.reemb_em < r.delivered_at))::int AS antes_ant
      FROM dash_vendas v
      JOIN dash_pedidos p ON p.plataforma = v.plataforma AND p.external_id = v.external_id
      JOIN rastreio_pedidos r ON r.transacao_id = ${CHAVE}
      WHERE v.plataforma = ANY($4) AND v.reembolsada AND NOT v.chargeback AND v.reemb_em >= $3 AND v.reemb_em < $2`, J),

    // T7 (curva) — por dia desde a compra: % reembolsado (dash) × % entregue (rastreio), coorte com rastreio
    query(`
      WITH base AS (
        SELECT floor(extract(epoch FROM (now() - v.ordered_at)) / 86400)::int AS idade,
               CASE WHEN v.reemb_em >= v.ordered_at THEN floor(extract(epoch FROM (v.reemb_em - v.ordered_at)) / 86400)::int END AS dia_reemb,
               CASE WHEN r.delivered_at >= v.ordered_at THEN floor(extract(epoch FROM (r.delivered_at - v.ordered_at)) / 86400)::int END AS dia_entrega
        FROM rastreio_pedidos r
        JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        JOIN dash_pedidos p ON p.plataforma = lower(btrim(d.plataforma))
                           AND ((p.plataforma = 'digistore24' AND p.session_id = d.transacao_id) OR (p.plataforma <> 'digistore24' AND p.external_id = d.transacao_id))
        JOIN dash_vendas v ON v.plataforma = p.plataforma AND v.external_id = p.external_id
        WHERE v.plataforma = ANY($1) AND v.ordered_at >= now() - interval '120 days')
      SELECT g.dia,
             count(*) FILTER (WHERE b.idade >= g.dia)::int AS expostos_rastreio,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.dia_reemb <= g.dia)::int AS reemb_rastreio,
             count(*) FILTER (WHERE b.idade >= g.dia AND b.dia_entrega <= g.dia)::int AS entregues_rastreio
      FROM generate_series(0, 30) g(dia) CROSS JOIN base b GROUP BY 1 ORDER BY 1`, [J[3]]),
  ]);

  // C4 — resumo por etapa (mesmo formato da prévia) + detalhe por passo do funil
  const etapas = ['front', 'upsell', 'downsell'].map((k) => {
    const linhas = c4.rows.filter((x) => x.etapa === k);
    return { etapa: k, compras: linhas.reduce((s, x) => s + x.compras, 0), reembolsadas: linhas.reduce((s, x) => s + x.reembolsadas, 0) };
  }).filter((x) => x.compras > 0);
  const passos = c4.rows.filter((x) => x.etapa && x.etapa !== 'front')
    .map((x) => ({ rotulo: rotuloPasso(x.product_type, x.funnel_step), etapa: x.etapa, passo: x.funnel_step, compras: x.compras, reembolsadas: x.reembolsadas }))
    .sort((a, b) => a.etapa.localeCompare(b.etapa) || a.passo - b.passo);

  // C3 — pedidos por slug (famílias do dash somadas) × clientes que reclamaram (SendTrace)
  const pedidosPorSlug = new Map();
  let semSlug = 0;
  for (const l of c3ped.rows) {
    const s = slugDaFamilia(l.family, slugsProd);
    if (!s) { semSlug += l.pedidos; continue; }
    pedidosPorSlug.set(s, (pedidosPorSlug.get(s) ?? 0) + l.pedidos);
  }
  const nomes = new Map((await query('SELECT slug, nome FROM produtos')).rows.map((r) => [r.slug, r.nome]));
  const reclam = new Map(c3rec.rows.map((r) => [r.s, r.n]));
  const c3 = [...pedidosPorSlug.entries()]
    .filter(([, pedidos]) => pedidos >= MIN_PEDIDOS_PRODUTO)
    .map(([s, pedidos]) => ({ produto: nomes.get(s) ?? s, slug: s, pedidos, reclamantes: reclam.get(s) ?? 0 }))
    .sort((a, b) => b.reclamantes / b.pedidos - a.reclamantes / a.pedidos)
    .slice(0, 8);

  // T7
  const t7Linha = t7.rows[0] ?? {};

  return {
    disponivel: true,
    plataformas: plats,
    completas,
    excluidas,
    janela_retencao_dias: JANELA_RETENCAO_DIAS,
    coorte_e2: { de: iniCoorte, ate: fimCoorte },
    e1: e1.rows[0],
    e2: e2.rows[0],
    e3: (() => {
      const totPed = e3.rows.reduce((a, r) => a + r.pedidos, 0);
      const totCont = e3.rows.reduce((a, r) => a + r.contatos, 0);
      return e3.rows.map((r) => ({
        plataforma: r.plataforma, pedidos: r.pedidos, contatos: r.contatos,
        pct_pedidos: totPed > 0 ? r.pedidos / totPed : null, pct_contatos: totCont > 0 ? r.contatos / totCont : null,
        pedidos_sendtrace: r.pedidos_sendtrace,
      }));
    })(),
    c4: { etapas, passos, parcial: false },
    c3,
    c3_sem_produto: semSlug,
    t7: { ...t7Linha, curva: curva.rows },
  };
}

/**
 * R4, G2, G3, G4 — a retenção registrada pelo CS (P10). Nasce vazia: enquanto ninguém registrar oferta, devolve
 * `vazio: true` e a Home mostra o convite ("registre a oferta no caso"), sem número inventado.
 *   R4  receita preservada   soma do valor preservado das ofertas ACEITAS em que o dash NÃO mostra estorno depois
 *   G2  salvamento por degrau ofertas aceitas sem estorno ÷ ofertas feitas, por degrau
 *   G3  custo da retenção    valor concedido (reembolso parcial, reenvio, bônus) ÷ receita preservada (teto: sugestão 30%)
 *   G4  reembolsos de proteção  reembolsos imediatos em casos críticos; ao lado, chargebacks de quem já falou com o CS
 * A ligação com o dash é por `transacao_id` = external_id do dash (é o contrato do /api/retencao).
 */
export async function coletarRetencao({ ini, fim, pini, filtros = {} }) {
  const slug = slugDoFiltro(filtros.plataforma);
  if (slug === undefined) return { disponivel: false, motivo: 'plataforma_fora_do_dash' };
  const [ofertas, cbs, total] = await Promise.all([
    query(`
      SELECT o.degrau_oferecido, o.degrau_aceito, o.status, o.valor_preservado_usd::float AS preservado,
             o.valor_concedido_usd::float AS concedido, o.protecao, o.ocorrido_em, (o.ocorrido_em >= $1) AS atual,
             EXISTS (SELECT 1 FROM dash_vendas v WHERE v.plataforma = o.plataforma AND v.external_id = o.transacao_id
                       AND v.reembolsada AND v.reemb_em >= o.ocorrido_em) AS reembolsou
      FROM retencao_ofertas o
      WHERE o.ocorrido_em >= $3 AND o.ocorrido_em < $2 AND ($4::text IS NULL OR o.plataforma = $4)
      ORDER BY o.ocorrido_em`, [ini, fim, pini, slug]),
    // chargebacks (data do dash) de clientes que já tinham falado com o CS antes
    query(`
      WITH cb AS (
        SELECT lower(p.customer_email) AS em, min(v.cb_em) AS cb_em, (min(v.cb_em) >= $1) AS atual
        FROM dash_vendas v JOIN dash_pedidos p ON p.plataforma = v.plataforma AND p.external_id = v.external_id
        WHERE v.plataforma = ANY($4) AND v.chargeback AND v.cb_em >= $3 AND v.cb_em < $2 AND p.customer_email IS NOT NULL
        GROUP BY 1)
      SELECT count(*) FILTER (WHERE atual)::int AS total, count(*) FILTER (WHERE NOT atual)::int AS total_ant,
             count(*) FILTER (WHERE atual AND (EXISTS (SELECT 1 FROM email_ia.emails e WHERE lower(e.remetente_email) = cb.em
                                                         AND e.plataforma_origem IS NULL AND e.data_email < cb.cb_em)
                                             OR EXISTS (SELECT 1 FROM chat_atendimentos c WHERE lower(c.email) = cb.em
                                                          AND coalesce(c.iniciado_em, c.criado_em) < cb.cb_em)))::int AS apos_contato,
             count(*) FILTER (WHERE NOT atual AND (EXISTS (SELECT 1 FROM email_ia.emails e WHERE lower(e.remetente_email) = cb.em
                                                             AND e.plataforma_origem IS NULL AND e.data_email < cb.cb_em)
                                                 OR EXISTS (SELECT 1 FROM chat_atendimentos c WHERE lower(c.email) = cb.em
                                                              AND coalesce(c.iniciado_em, c.criado_em) < cb.cb_em)))::int AS apos_contato_ant
      FROM cb`, [ini, fim, pini, slug ? [slug].filter((p) => COMPLETAS.includes(p)) : COMPLETAS]).then((r) => r.rows[0]).catch(() => ({})),
    query('SELECT count(*)::int AS n FROM retencao_ofertas').then((r) => r.rows[0].n).catch(() => 0),
  ]);

  const soma = (arr, f) => arr.reduce((a, x) => a + (f(x) ?? 0), 0);
  const atuais = ofertas.rows.filter((o) => o.atual);
  const anteriores = ofertas.rows.filter((o) => !o.atual);
  const preservadas = (arr) => arr.filter((o) => o.status === 'aceito' && !o.reembolsou);
  const valor = (arr) => soma(preservadas(arr), (o) => o.preservado);

  // por degrau (o degrau que valeu: o aceito, ou o oferecido quando ainda não há aceito)
  const porDegrau = new Map();
  for (const o of atuais) {
    const k = (o.degrau_aceito || o.degrau_oferecido || '—').trim();
    const g = porDegrau.get(k) ?? { degrau: k, feitas: 0, aceitas: 0, retidas: 0 };
    g.feitas += 1;
    if (o.status === 'aceito') { g.aceitas += 1; if (!o.reembolsou) g.retidas += 1; }
    porDegrau.set(k, g);
  }
  const serie = new Map();
  for (const o of preservadas(atuais)) {
    const d = new Date(o.ocorrido_em).toISOString().slice(0, 10);
    serie.set(d, (serie.get(d) ?? 0) + (o.preservado ?? 0));
  }

  const r4 = { valor: valor(atuais), valor_ant: valor(anteriores), aceitas: preservadas(atuais).length, aceitas_ant: preservadas(anteriores).length,
    reembolsadas_depois: atuais.filter((o) => o.status === 'aceito' && o.reembolsou).length,
    serie: [...serie.entries()].sort().map(([dia, usd]) => ({ dia, usd })) };
  const custo = soma(atuais, (o) => o.concedido);
  const custoAnt = soma(anteriores, (o) => o.concedido);
  return {
    disponivel: true,
    vazio: total === 0,
    ofertas: atuais.length, ofertas_ant: anteriores.length,
    aceitas: atuais.filter((o) => o.status === 'aceito').length,
    r4,
    g2: [...porDegrau.values()].sort((a, b) => b.feitas - a.feitas),
    g3: { custo, custo_ant: custoAnt, receita: r4.valor, taxa: r4.valor > 0 ? custo / r4.valor : null, teto_sugerido: 0.3 },
    g4: {
      protecao: atuais.filter((o) => o.protecao).length, protecao_ant: anteriores.filter((o) => o.protecao).length,
      chargebacks: cbs.total ?? 0, chargebacks_apos_contato: cbs.apos_contato ?? 0,
      chargebacks_ant: cbs.total_ant ?? 0, chargebacks_apos_contato_ant: cbs.apos_contato_ant ?? 0,
    },
  };
}
