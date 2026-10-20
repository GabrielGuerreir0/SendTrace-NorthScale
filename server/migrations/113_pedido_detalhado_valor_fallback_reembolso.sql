-- ═══════════════════════════════════════════════════════════════════════════
--  113 · Suporte Humano — tabela do pedido: valor por item também quando só existe o evento de reembolso (achado da Késsia no ticket #9426, 20/10/2026)
--
--  Problema: `pedido_detalhado` (109) só lia o valor do evento de venda (SALE/payment/neworder). Em pedidos antigos da JVZoo o SALE de front e upsells não
--  foi gravado — só o RFND. O front caía no `rastreio_pedidos.total` (que é o total do pedido INTEIRO) e os upsells ficavam em branco.
--  Agora, por item: 1º evento de venda → senão 1º evento de reembolso (RFND/refund, valor absoluto) → senão (só o front) o total do rastreio menos o que os
--  outros itens já somam (nunca negativo). Reembolso parcial pode mostrar o valor reembolsado, não o da venda — só entra quando não há venda gravada.
--  Só leitura; não altera dados. Idempotente. Desfazer: reaplicar a 109.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pedido_detalhado(p_disparo_id bigint)
RETURNS TABLE (etapa_funil text, transacao_id text, produto text, quantidade integer, valor numeric, moeda text)
LANGUAGE sql STABLE AS $f$
  WITH front AS (
    SELECT d.id, d.transacao_id, btrim(d.plataforma) AS plataforma, lower(d.email) AS email, d.criado_em, nullif(btrim(d.produto), '') AS nome_plat
      FROM disparos_pos_venda d WHERE d.id = p_disparo_id
  ), acompanhantes AS (
    SELECT u.transacao_id, u.etapa_funil, u.plataforma, nullif(btrim(u.produto), '') AS nome_plat
      FROM compras_upsell_downsell u
      JOIN front f ON lower(u.email) = f.email AND u.plataforma IS NOT DISTINCT FROM f.plataforma
       AND u.criado_em >= f.criado_em AND u.criado_em < f.criado_em + interval '3 hours' AND u.transacao_id <> f.transacao_id
  ), todos AS (
    SELECT 'front'::text AS etapa_funil, f.transacao_id, f.plataforma, f.nome_plat FROM front f
    UNION ALL
    SELECT a.etapa_funil, a.transacao_id, a.plataforma, a.nome_plat FROM acompanhantes a
  ), itens AS (
    SELECT t.*, coalesce(venda.valor, reemb.valor) AS valor_item
      FROM todos t
      LEFT JOIN LATERAL (
        SELECT abs(e.valor) AS valor FROM eventos_plataforma e
         WHERE e.transacao_id IN (t.transacao_id, 'BG-' || t.transacao_id) AND btrim(e.plataforma) = t.plataforma
           AND e.evento IN ('SALE', 'payment', 'neworder') AND e.valor IS NOT NULL
         ORDER BY e.recebido_em ASC LIMIT 1
      ) venda ON true
      LEFT JOIN LATERAL (
        SELECT abs(e.valor) AS valor FROM eventos_plataforma e
         WHERE e.transacao_id IN (t.transacao_id, 'BG-' || t.transacao_id) AND btrim(e.plataforma) = t.plataforma
           AND e.evento IN ('RFND', 'refund') AND e.valor IS NOT NULL
         ORDER BY e.recebido_em ASC LIMIT 1
      ) reemb ON true
  )
  SELECT i.etapa_funil, i.transacao_id, coalesce(i.nome_plat, 'Produto'),
         nullif(substring(i.nome_plat FROM '(?i)(\d+)\s*(?:bottles?|frascos?)'), '')::int,
         coalesce(
           i.valor_item,
           CASE WHEN i.etapa_funil = 'front' THEN
             nullif(greatest(
               (SELECT r.total FROM rastreio_pedidos r WHERE r.transacao_id IN (i.transacao_id, 'BG-' || i.transacao_id) LIMIT 1)
               - coalesce((SELECT sum(o.valor_item) FROM itens o WHERE o.etapa_funil <> 'front'), 0), 0), 0)
           END),
         'USD'::text
    FROM itens i
   ORDER BY CASE i.etapa_funil WHEN 'front' THEN 0 WHEN 'upsell' THEN 1 WHEN 'downsell' THEN 2 ELSE 3 END, i.transacao_id;
$f$;
