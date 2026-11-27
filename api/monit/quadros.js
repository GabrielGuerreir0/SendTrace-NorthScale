/**
 * MONIT-SPPL — Fase 2: quadros Q1–Q5 e KPIs (seção 7), rastreios gerados hoje/ontem/semana, painel "Reembolsos e chargebacks × logística" (seção 8),
 * tabelinhas de Sem rastreio e a BUSCA em toda a base (seção 11). Tudo calculado ao vivo (consultas leves); só a classificação é materializada.
 *
 * FUSO: os dias úteis seguem `sppl_somar_dias_uteis` (America/New_York, como a view `sppl_logistica` e o painel original); o "dia" de rastreios gerados
 * usa America/Sao_Paulo, o horário do time (seção 13.5). A diferença só aparece perto da meia-noite.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { montarWhere } from './consultas.js';

const MOV = `coalesce(e.status, split_part(e.substatus, '_', 1))`;

/**
 * KPIs e quadros (dataset `kpis`). Universo: em aberto = não cancelado, sem reembolso/chargeback na RÉGUA (`reembolsado_em`/`chargeback_em`; os eventos da
 * plataforma não entram aqui, como no painel), e não entregue de fato (entregue pela fulfillment ou 17Track, exceto devolvido: texto "original sender",
 * "returned to sender" ou "return parcel" ou subestado Exception_Returned/Returning). Movimento real conta também os eventos que chegam só com o
 * subestado (coalesce(status, 1ª parte do subestado)) — por isso `corrigidos` conta quem cai num quadro diferente da view `sppl_logistica`.
 */
export async function kpis(desde) {
  const { rows: [r] } = await query(
    `WITH b AS (
       SELECT p.transacao_id, p.status_interno, p.tracking_number, p.shipped_at, coalesce(p.order_created_at, dv.criado_em) AS data_pedido,
              (dv.transacao_id IS NOT NULL) AS na_regua, g.numero AS numero_17t, g.ultimo_status, g.ultimo_substatus, ev.mov, ev.etq
         FROM rastreio_pedidos p
         LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
         LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
         LEFT JOIN LATERAL (SELECT max(e.ocorreu_em) FILTER (WHERE ${MOV} NOT IN ('InfoReceived', 'NotFound')) AS mov,
                                   min(e.ocorreu_em) FILTER (WHERE ${MOV} = 'InfoReceived') AS etq
                              FROM rastreio_17t_eventos e WHERE e.numero = g.numero) ev ON true
        WHERE coalesce(p.order_created_at, dv.criado_em) >= $1::date AND p.status_interno <> 'cancelled'
          AND dv.reembolsado_em IS NULL AND dv.chargeback_em IS NULL
          AND (NOT (p.status_interno = 'delivered' OR coalesce(g.ultimo_status, '') = 'Delivered')
               OR coalesce(p.tracking_status ~* 'original sender|returned to sender|return parcel' OR g.ultimo_substatus IN ('Exception_Returned', 'Exception_Returning'), false))
     ), q AS (
       SELECT b.*, CASE
           WHEN b.status_interno = 'pending' AND coalesce(b.tracking_number, '') = '' AND sppl_somar_dias_uteis(b.data_pedido, 2) <= now() THEN 1
           WHEN coalesce(b.tracking_number, '') <> '' AND b.numero_17t IS NOT NULL AND b.mov IS NULL AND coalesce(b.ultimo_status, '') <> 'Delivered'
                AND sppl_somar_dias_uteis(coalesce(b.etq, b.shipped_at, b.data_pedido), 2) <= now() THEN 2
           WHEN b.mov IS NOT NULL AND coalesce(b.ultimo_status, '') <> 'Delivered' AND b.mov <= now() - interval '15 days' THEN 5
           WHEN b.mov IS NOT NULL AND coalesce(b.ultimo_status, '') <> 'Delivered' AND b.mov <= now() - interval '10 days' THEN 4
           WHEN b.mov IS NOT NULL AND coalesce(b.ultimo_status, '') <> 'Delivered' AND b.mov <= now() - interval '5 days' THEN 3 END AS quadro
         FROM b
     )
     SELECT count(*)::int AS abertos,
            count(*) FILTER (WHERE NOT q.na_regua AND q.status_interno <> 'nao_encontrado')::int AS fora_monitoramento,
            count(*) FILTER (WHERE q.status_interno = 'nao_encontrado')::int AS nao_encontrados,
            count(*) FILTER (WHERE q.quadro IS NOT NULL)::int AS em_quadro,
            count(*) FILTER (WHERE q.quadro = 1)::int AS q1, count(*) FILTER (WHERE q.quadro = 2)::int AS q2, count(*) FILTER (WHERE q.quadro = 3)::int AS q3,
            count(*) FILTER (WHERE q.quadro = 4)::int AS q4, count(*) FILTER (WHERE q.quadro = 5)::int AS q5,
            count(*) FILTER (WHERE q.quadro IS NULL AND coalesce(q.ultimo_status, '') <> 'Delivered' AND EXISTS (
              SELECT 1 FROM sppl_regras r WHERE r.origem = 'status_17t' AND r.ativa AND r.prioridade IN ('P0', 'P1') AND r.status_17t = q.ultimo_status
                 AND (r.substatus_17t IS NULL OR r.substatus_17t = q.ultimo_substatus)))::int AS graves_sem_quadro,
            count(*) FILTER (WHERE q.quadro IS DISTINCT FROM l.quadro)::int AS corrigidos,
            (SELECT count(*)::int FROM sppl_ocorrencias o WHERE o.situacao = 'aberta' AND o.aberta_em >= $1::date) AS ocorr_abertas,
            (SELECT count(*)::int FROM sppl_ocorrencias o WHERE o.situacao = 'aberta' AND o.aberta_em >= $1::date AND o.prazo_ate < now()) AS ocorr_vencidas,
            now() AS gerado_em
       FROM q LEFT JOIN sppl_logistica l ON l.transacao_id = q.transacao_id`, [desde]);
  return r;
}

/** Códigos gerados (`shipped_at`) hoje, ontem e nesta semana (segunda a domingo), por fulfillment, no horário de São Paulo. */
export async function rastreiosGerados() {
  const { rows } = await query(
    `WITH h AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje)
     SELECT p.provedor AS fulfillment,
            count(*) FILTER (WHERE (p.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date = h.hoje)::int AS hoje,
            count(*) FILTER (WHERE (p.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date = h.hoje - 1)::int AS ontem,
            count(*) FILTER (WHERE (p.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('week', h.hoje)::date)::int AS semana
       FROM rastreio_pedidos p, h
      WHERE p.provedor IN ('fullstack', 'jetstream', 'redrock') AND coalesce(p.tracking_number, '') <> '' AND p.shipped_at >= now() - interval '10 days'
      GROUP BY 1 ORDER BY 1`);
  const ordem = ['fullstack', 'jetstream', 'redrock'];
  const itens = ordem.map((f) => rows.find((x) => x.fulfillment === f) ?? { fulfillment: f, hoje: 0, ontem: 0, semana: 0 });
  const total = itens.reduce((t, x) => ({ hoje: t.hoje + x.hoje, ontem: t.ontem + x.ontem, semana: t.semana + x.semana }), { hoje: 0, ontem: 0, semana: 0 });
  return { itens, total };
}

/** Sem rastreio por plataforma e por fulfillment (as duas tabelinhas), com os filtros globais. */
export async function semRastreioTabelas(f) {
  const { sql: where, valores } = montarWhere({ ...f, grupo: 'semrastreio', classe: undefined, causa: undefined, multi: undefined, tratado: undefined, q: undefined });
  const { rows } = await query(`SELECT m.classe, m.plataforma, m.fulfillment, count(*)::int AS n FROM monit_pedidos m ${where} GROUP BY 1, 2, 3`, valores);
  const soma = (chave) => { const mapa = {}; for (const r of rows) { const k = r[chave] ?? ''; (mapa[k] ??= {})[r.classe] = (mapa[k][r.classe] ?? 0) + r.n; } return mapa; };
  return { por_plataforma: soma('plataforma'), por_fulfillment: soma('fulfillment') };
}

/** "Reembolsos e chargebacks × logística" (seção 8): uma linha por situação logística, avaliada na ordem da especificação. */
export async function reembolsoLogistica(desde) {
  const { rows } = await query(
    `WITH x AS (
       SELECT dv.transacao_id, (dv.chargeback_em IS NOT NULL) AS chargeback, coalesce(dv.chargeback_em, dv.reembolsado_em) AS quando, dv.criado_em, p.total,
              CASE
                WHEN p.transacao_id IS NULL THEN 'sem_registro'
                WHEN p.status_interno = 'cancelled' THEN 'cancelado'
                WHEN p.tracking_status ~* 'original sender|returned to sender' OR g.ultimo_substatus IN ('Exception_Returned', 'Exception_Returning') THEN 'devolvido'
                WHEN p.status_interno = 'delivered' OR g.ultimo_status = 'Delivered' THEN 'entregue'
                WHEN p.status_interno = 'nao_encontrado' THEN 'nao_encontrado'
                WHEN coalesce(p.tracking_number, '') = '' THEN 'sem_codigo'
                WHEN g.numero IS NULL THEN 'codigo_nao_lido'
                WHEN coalesce(g.ultimo_status, '') IN ('', 'InfoReceived', 'NotFound') THEN 'aguardando_coleta'
                WHEN g.ultimo_status IN ('DeliveryFailure', 'Exception', 'AvailableForPickup', 'Expired') THEN 'problema_entrega'
                ELSE 'em_transito' END AS situacao
         FROM disparos_pos_venda dv
         LEFT JOIN rastreio_pedidos p ON p.transacao_id = dv.transacao_id
         LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
        WHERE dv.criado_em >= $1::date AND (dv.reembolsado_em IS NOT NULL OR dv.chargeback_em IS NOT NULL))
     SELECT situacao, count(*) FILTER (WHERE NOT chargeback)::int AS reembolsos, count(*) FILTER (WHERE chargeback)::int AS chargebacks, count(*)::int AS pedidos,
            round(avg(extract(epoch FROM (quando - criado_em)) / 86400))::int AS dias_ate_reembolsar, coalesce(sum(total), 0) AS valor
       FROM x GROUP BY 1`, [desde]);
  const ordem = ['sem_registro', 'cancelado', 'devolvido', 'entregue', 'nao_encontrado', 'sem_codigo', 'codigo_nao_lido', 'aguardando_coleta', 'problema_entrega', 'em_transito'];
  return ordem.map((s) => rows.find((r) => r.situacao === s) ?? { situacao: s, reembolsos: 0, chargebacks: 0, pedidos: 0, dias_ate_reembolsar: null, valor: 0 });
}

/** Busca em TODA a base (mínimo 4 caracteres), ignorando os demais filtros. Marca quem NÃO está na lista de pedidos em aberto. */
export async function buscar(q) {
  const termo = String(q ?? '').trim();
  if (termo.length < 4) throw new ErroHttp(400, 'Digite pelo menos 4 caracteres.');
  const padrao = `%${termo.slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await query(
    `SELECT p.transacao_id AS pedido_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido, dv.nome AS nome_cliente, dv.email AS email_cliente,
            CASE WHEN p.status_interno = 'cancelled' THEN 'Cancelado'
                 WHEN dv.chargeback_em IS NOT NULL THEN 'Chargeback' WHEN dv.reembolsado_em IS NOT NULL THEN 'Reembolsado'
                 WHEN p.tracking_status ~* 'original sender|returned to sender' OR g.ultimo_substatus IN ('Exception_Returned', 'Exception_Returning') THEN 'Devolvido'
                 WHEN p.status_interno = 'delivered' OR g.ultimo_status = 'Delivered' THEN 'Entregue'
                 WHEN p.status_interno = 'nao_encontrado' THEN 'Não encontrado na fulfillment'
                 WHEN coalesce(p.tracking_number, '') = '' THEN 'Sem código de rastreio' ELSE 'Em andamento' END AS situacao,
            p.delivered_at AS entregue_em, coalesce(p.provedor, 'sem fulfillment') AS fulfillment, p.tracking_number AS rastreio,
            coalesce(nullif(btrim(dv.plataforma), ''), nullif(btrim(cu.plataforma), '')) AS plataforma, coalesce(p.order_created_at, dv.criado_em) AS data_pedido,
            (m.transacao_id IS NULL) AS fora_da_lista, m.classe
       FROM rastreio_pedidos p
       LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
       LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
       LEFT JOIN compras_upsell_downsell cu ON cu.transacao_id = p.transacao_id
       LEFT JOIN monit_pedidos m ON m.transacao_id = p.transacao_id
      WHERE p.transacao_id ILIKE $1 OR p.order_number ILIKE $1 OR p.tracking_number ILIKE $1 OR dv.email ILIKE $1 OR dv.nome ILIKE $1
      ORDER BY coalesce(p.order_created_at, dv.criado_em) DESC NULLS LAST LIMIT 200`, [padrao]);
  return { itens: rows, fora_da_lista: rows.filter((r) => r.fora_da_lista).length };
}
