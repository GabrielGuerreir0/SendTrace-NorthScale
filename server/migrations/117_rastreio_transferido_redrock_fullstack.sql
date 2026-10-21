-- ═══════════════════════════════════════════════════════════════════════════
--  117 · Rastreio — pedidos TRANSFERIDOS da RedRock para a FullStack (pedido do Lucas, 21/10/2026)
--
--  A RedRock parou de enviar (último envio por produto em 13/10 FlushPril e NeuroRecall, 17/10 GlycoEden). Os pedidos que ela deixou pendentes
--  foram levados para a FullStack (mesma referência `WP-…`). Este campo marca, em `rastreio_pedidos`, quando o pedido passou de `redrock`
--  para `fullstack`, para a tela de Rastreio mostrar a etiqueta "TRANSFERIDO REDROCK → FULLSTACK" e a sub-aba "Transferidos".
--  Só é preenchido por quem troca o parceiro (rastreio_fullstack.py e transferir_redrock_fullstack.py). Aditiva e idempotente.
--  Desfazer: UPDATE rastreio_pedidos SET transferido_redrock_em = NULL;  (e, se quiser, DROP COLUMN)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE rastreio_pedidos ADD COLUMN IF NOT EXISTS transferido_redrock_em timestamptz;
COMMENT ON COLUMN rastreio_pedidos.transferido_redrock_em IS 'Quando o pedido passou da RedRock para a FullStack (117). NULL = nunca foi transferido.';
CREATE INDEX IF NOT EXISTS rastreio_pedidos_transferido_idx ON rastreio_pedidos (transferido_redrock_em) WHERE transferido_redrock_em IS NOT NULL;

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
