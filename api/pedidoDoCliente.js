/**
 * Pedido mais recente de um cliente, ligado ao pedido do dash (external_id) — usado pela retenção (P10) e pela ficha do Suporte Humano.
 * `chargeback_em` vem do dash (dash_vendas.cb_em) quando o pedido já virou chargeback; senão null.
 */

import { query } from '../server/db.js';

export async function pedidoDoCliente(email) {
  const { rows } = await query(
    `SELECT d.transacao_id, lower(btrim(d.plataforma)) AS plataforma, d.produto, d.criado_em,
            x.external_id AS externo_id, x.valor::float AS valor_usd, x.chargeback AS chargeback, x.cb_em AS chargeback_em
     FROM disparos_pos_venda d
     LEFT JOIN LATERAL (
       SELECT p.external_id, v.valor, v.chargeback, v.cb_em FROM dash_pedidos p
       JOIN dash_vendas v ON v.plataforma = p.plataforma AND v.external_id = p.external_id
       WHERE p.plataforma = lower(btrim(d.plataforma))
         AND ((p.plataforma = 'digistore24' AND p.session_id = d.transacao_id)
           OR (p.plataforma <> 'digistore24' AND p.external_id = d.transacao_id))
       ORDER BY p.funnel_step NULLS LAST LIMIT 1) x ON true
     WHERE lower(d.email) = lower($1) AND d.transacao_id IS NOT NULL AND btrim(d.plataforma) NOT IN ('', 'teste')
     ORDER BY d.criado_em DESC LIMIT 1`,
    [email],
  ).catch(() => ({ rows: [] }));
  return rows[0] ?? null;
}
