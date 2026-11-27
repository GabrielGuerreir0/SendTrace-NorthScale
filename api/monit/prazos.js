/**
 * MONIT-SPPL — Fase 4: aba Prazos (seção 9). Quantos dias corridos o pedido leva em cada etapa, da compra até a entrega, agrupado por fulfillment, pagamento,
 * mês do pedido e total. Respeita `desde` e `reemb` (mesma regra da seção 4: reembolso/chargeback na régua OU evento da plataforma).
 *
 * Datas: pedido (t_ped), código gerado (t_cod = shipped_at, só com código), 1º movimento (t_mov = 1º evento do 17Track que não é etiqueta criada nem "label /
 * data received / data was sent / created", e só vale se vier no máximo 1 dia antes do código), entrega (t_ent = delivered_at da fulfillment ou a data do último
 * evento quando o 17Track diz Delivered). Cada etapa só conta pedidos que já têm as duas datas; os limites de cada etapa estão no SQL (>= 0, e >= -1 em cod→mov).
 */
import { query } from '../../server/db.js';

const EV_REEMB = `('RFND', 'refund', 'sale.refunded', 'chargeback', 'sale.chargeback')`;
/** [chave, fim, início, mínimo aceito em dias] */
const ETAPAS = [
  ['ped_cod', 't_cod', 't_ped', 0], ['cod_mov', 't_mov', 't_cod', -1], ['mov_ent', 't_ent', 't_mov', 0], ['cod_ent', 't_ent', 't_cod', 0], ['ped_ent', 't_ent', 't_ped', 0],
];
const dias = (fim, ini) => `extract(epoch FROM (${fim} - ${ini})) / 86400`;
const AGG = ETAPAS.map(([k, fim, ini, min]) => {
  const v = dias(fim, ini); const ok = `(${fim} IS NOT NULL AND ${ini} IS NOT NULL AND ${v} >= ${min})`;
  return `round((avg(${v}) FILTER (WHERE ${ok}))::numeric, 1) AS ${k}, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${v}) FILTER (WHERE ${ok}))::numeric, 1) AS ${k}_med, count(*) FILTER (WHERE ${ok})::int AS ${k}_n`;
}).join(',\n            ');

export async function prazos({ desde, reemb }) {
  const filtroReemb = reemb === 'sem' ? 'WHERE NOT x.reemb' : reemb === 'com' ? 'WHERE x.reemb' : '';
  const { rows } = await query(
    `WITH x AS (
       SELECT p.transacao_id, coalesce(p.order_created_at, dv.criado_em, p.criado_em) AS t_ped,
              CASE WHEN coalesce(p.tracking_number, '') <> '' THEN p.shipped_at END AS t_cod,
              coalesce(p.provedor, 'nao_encontrado') AS ful,
              coalesce(nullif(btrim(dv.plataforma), ''), nullif(btrim(cu.plataforma), ''), 'Não identificada') AS plat,
              (dv.reembolsado_em IS NOT NULL OR dv.chargeback_em IS NOT NULL OR EXISTS (SELECT 1 FROM eventos_plataforma ep WHERE ep.transacao_id = p.transacao_id AND ep.evento IN ${EV_REEMB})) AS reemb,
              ev.mov, ev.ultimo, g.ultimo_status, p.delivered_at
         FROM rastreio_pedidos p
         LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
         LEFT JOIN compras_upsell_downsell cu ON cu.transacao_id = p.transacao_id
         LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
         LEFT JOIN LATERAL (SELECT min(e.ocorreu_em) FILTER (WHERE coalesce(e.status, split_part(e.substatus, '_', 1)) IS DISTINCT FROM 'InfoReceived'
                                                              AND NOT (coalesce(e.descricao, '') ~* 'label|data received|data was sent' OR lower(btrim(coalesce(e.descricao, ''))) = 'created')) AS mov,
                                   max(e.ocorreu_em) AS ultimo
                              FROM rastreio_17t_eventos e WHERE e.numero = g.numero) ev ON true
        WHERE coalesce(p.order_created_at, dv.criado_em, p.criado_em) >= $1::date
     ), y AS (
       SELECT x.*, CASE WHEN x.t_cod IS NOT NULL AND x.mov >= x.t_cod - interval '1 day' THEN x.mov END AS t_mov,
              coalesce(x.delivered_at, CASE WHEN x.ultimo_status = 'Delivered' THEN x.ultimo END) AS t_ent,
              to_char(x.t_ped AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes
         FROM x ${filtroReemb}
     )
     SELECT CASE WHEN GROUPING(ful) = 0 THEN 'ful' WHEN GROUPING(plat) = 0 THEN 'plat' WHEN GROUPING(mes) = 0 THEN 'mes' ELSE 'total' END AS nivel,
            coalesce(ful, plat, mes) AS chave, count(*)::int AS pedidos,
            ${AGG}
       FROM y GROUP BY GROUPING SETS ((ful), (plat), (mes), ())`, [desde]);
  return { itens: rows, desde, reemb };
}
