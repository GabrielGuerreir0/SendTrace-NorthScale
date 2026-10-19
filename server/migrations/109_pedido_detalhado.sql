-- ═══════════════════════════════════════════════════════════════════════════
--  109 · Suporte Humano — 5º momento, item 5: o pedido com TODOS os detalhes (pedido da Késsia, 19/10/2026)
--
--  `pedido_detalhado(disparo)` devolve uma linha por item da jornada — front, upsells e downsells (mesma regra do recibo consolidado: compras do mesmo
--  cliente e plataforma até 3 h depois do front) — com o Nº da transação de cada um (na JVZoo o front e cada upsell têm número próprio; onde o número é
--  o mesmo, ele se repete), o produto como a plataforma o chama, a quantidade de frascos (lida do nome do produto, quando vem ali) e o valor em USD
--  do primeiro evento de venda. A tela soma o TOTAL. Só leitura; não altera dados. Idempotente.
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
  )
  SELECT t.etapa_funil, t.transacao_id, coalesce(t.nome_plat, 'Produto'),
         nullif(substring(t.nome_plat FROM '(?i)(\d+)\s*(?:bottles?|frascos?)'), '')::int,
         coalesce(ev.valor, (SELECT r.total FROM rastreio_pedidos r WHERE r.transacao_id IN (t.transacao_id, 'BG-' || t.transacao_id) LIMIT 1)),
         'USD'::text
    FROM todos t
    LEFT JOIN LATERAL (
      SELECT abs(e.valor) AS valor FROM eventos_plataforma e
       WHERE e.transacao_id IN (t.transacao_id, 'BG-' || t.transacao_id) AND btrim(e.plataforma) = t.plataforma
         AND e.evento IN ('SALE', 'payment', 'neworder') AND e.valor IS NOT NULL
       ORDER BY e.recebido_em ASC LIMIT 1
    ) ev ON true
   ORDER BY CASE t.etapa_funil WHEN 'front' THEN 0 WHEN 'upsell' THEN 1 WHEN 'downsell' THEN 2 ELSE 3 END, t.transacao_id;
$f$;
