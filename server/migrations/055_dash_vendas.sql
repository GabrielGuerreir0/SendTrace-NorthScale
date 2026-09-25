-- ═══════════════════════════════════════════════════════════════════════════
--  055 · dash_vendas — uma linha por VENDA do dash, com o estorno já ligado à venda
--
--  Fase 2 do Rodrigo (25/09/2026): R1 (reembolso D30), R2 (chargeback), R3 (valor estornado) e C1 (curva).
--
--  ATENÇÃO — como o estorno se liga à venda muda por plataforma (achado de 25/09 nos dados reais):
--   · JVZoo, BuyGoods, ClickBank, CartPanda…  → o estorno vem NA PRÓPRIA linha da venda (refund_model
--     'in-place': status REFUNDED/CHARGEBACK, refunded_usd/chargeback_usd preenchidos).
--   · Digistore24 → o estorno é uma LINHA SEPARADA (refund_model 'extra-row', gross negativo) que aponta em
--     parent_external_id para o ID DO PEDIDO — e esse ID fica na coluna session_id da venda, NÃO no external_id
--     (que é o número da transação). Ligar por external_id não acha nenhum estorno da Digistore (0 de 6.233);
--     por session_id casam 97%.
--
--  A visão materializada guarda o resultado dessa ligação (refresh depois de cada sincronização, em
--  server/dash.js) — a Home consulta ela em milissegundos em vez de refazer o JOIN de 160 mil linhas.
--  `reembolsada`/`chargeback` = houve estorno (valor > 0 OU status), `reemb_em`/`cb_em` = QUANDO.
--
--  Idempotente (IF NOT EXISTS). Só cria objetos novos.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS dash_pedidos_session_idx ON dash_pedidos (plataforma, session_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS dash_vendas AS
SELECT p.plataforma, p.external_id, p.status, p.product_type, p.funnel_step, p.family, p.product_id, p.product_name,
       p.ordered_at,
       coalesce(p.original_gross, p.gross)                                        AS valor,
       greatest(p.refunded_usd, coalesce(f.refunded_usd, 0))                      AS reemb_usd,
       greatest(p.chargeback_usd, coalesce(f.chargeback_usd, 0))                  AS cb_usd,
       coalesce(p.refunded_at, f.refunded_at)                                     AS reemb_em,
       coalesce(p.chargeback_at, f.chargeback_at)                                 AS cb_em,
       (greatest(p.refunded_usd, coalesce(f.refunded_usd, 0)) > 0 OR p.status = 'REFUNDED')      AS reembolsada,
       (greatest(p.chargeback_usd, coalesce(f.chargeback_usd, 0)) > 0 OR p.status = 'CHARGEBACK') AS chargeback
FROM dash_pedidos p
LEFT JOIN LATERAL (
  SELECT sum(c.refunded_usd) AS refunded_usd, sum(c.chargeback_usd) AS chargeback_usd,
         min(c.refunded_at) AS refunded_at, min(c.chargeback_at) AS chargeback_at
  FROM dash_pedidos c
  WHERE c.plataforma = p.plataforma
    AND c.parent_external_id = CASE WHEN p.plataforma = 'digistore24' THEN p.session_id ELSE p.external_id END
    AND c.external_id <> p.external_id
    AND c.refund_model = 'extra-row' AND c.gross < 0
) f ON true
WHERE NOT (p.refund_model = 'extra-row' AND p.gross < 0)                 -- a linha negativa não é uma venda
  AND p.status IN ('APPROVED', 'REFUNDED', 'CHARGEBACK')
  AND coalesce(p.original_gross, p.gross) > 0;

-- Índice único: permite REFRESH MATERIALIZED VIEW CONCURRENTLY (a Home não fica sem leitura durante o refresh).
CREATE UNIQUE INDEX IF NOT EXISTS dash_vendas_pk      ON dash_vendas (plataforma, external_id);
CREATE INDEX        IF NOT EXISTS dash_vendas_ordered ON dash_vendas (plataforma, ordered_at);
CREATE INDEX        IF NOT EXISTS dash_vendas_reemb   ON dash_vendas (reemb_em) WHERE reemb_em IS NOT NULL;
CREATE INDEX        IF NOT EXISTS dash_vendas_cb      ON dash_vendas (cb_em)    WHERE cb_em IS NOT NULL;

COMMENT ON MATERIALIZED VIEW dash_vendas IS
  'Uma linha por venda do dash, com o estorno ligado à venda (Digistore por session_id; as demais in-place). Atualizada após cada sincronização.';
