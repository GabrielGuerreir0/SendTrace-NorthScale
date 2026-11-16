-- ════════════════════════════════════════════════════════════════════════════
--  128 · Tipo de estorno (pedido do Lucas, 15/11/2026)
--
--  A JVZoo nunca manda o evento CGBK: o chargeback (DISPUTE) e o alerta de chargeback (ALERT, o cliente foi ao banco e a venda
--  foi estornada antes da disputa) chegam como RFND/REFUNDED, iguais a um reembolso. O tipo só existe na API v3.0
--  (`/transactions/{paykey}` → refund.type = REFUND | ALERT | DISPUTE). O n8n "Reporting JVzoo" passa a consultar a API a cada
--  RFND e grava o tipo aqui; DISPUTE também preenche `chargeback_em`. Base da pesquisa de motivo de estorno (ClickUp 1dfjmjuc53w).
--
--  Valores: 'REFUND', 'ALERT', 'DISPUTE' (JVZoo). NULL = sem estorno ou tipo desconhecido (outras plataformas usam chargeback_em).
--  Aditiva e idempotente. Desfazer: ALTER TABLE ... DROP COLUMN estorno_tipo (nas duas tabelas).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE disparos_pos_venda      ADD COLUMN IF NOT EXISTS estorno_tipo text;
ALTER TABLE compras_upsell_downsell ADD COLUMN IF NOT EXISTS estorno_tipo text;

COMMENT ON COLUMN disparos_pos_venda.estorno_tipo      IS 'Tipo do estorno informado pela plataforma: REFUND (reembolso), ALERT (alerta de chargeback, estornado antes da disputa) ou DISPUTE (chargeback). Migração 128.';
COMMENT ON COLUMN compras_upsell_downsell.estorno_tipo IS 'Tipo do estorno informado pela plataforma: REFUND (reembolso), ALERT (alerta de chargeback, estornado antes da disputa) ou DISPUTE (chargeback). Migração 128.';
