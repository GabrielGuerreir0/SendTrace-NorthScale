-- ═══════════════════════════════════════════════════════════════════════════
--  071 · Percentual do reembolso parcial na ficha do Suporte Escalado (pedido do Lucas, 05/10/2026)
--
--  A opção solta "% do reembolso" do campo "Tipo de resolução" sai da lista: quando o agente escolhe "Reembolso parcial", aparece ao lado um segundo
--  campo com a porcentagem (15% a 90%, de 5 em 5). Só vale para "Reembolso parcial"; a API zera o percentual se o tipo mudar.
--  Quem já tinha "% do reembolso" salvo (nenhum caso em 05/10) passa a "Reembolso parcial". Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS percentual_reembolso smallint;
DO $$ BEGIN
  ALTER TABLE email_ia.suporte_escalado_ficha ADD CONSTRAINT suporte_escalado_ficha_percentual_chk
    CHECK (percentual_reembolso IS NULL OR (percentual_reembolso BETWEEN 15 AND 90 AND percentual_reembolso % 5 = 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN email_ia.suporte_escalado_ficha.percentual_reembolso IS 'Porcentagem do reembolso parcial (15–90, de 5 em 5); só com tipo_resolucao = Reembolso parcial (071).';

UPDATE email_ia.suporte_escalado_ficha SET tipo_resolucao = 'Reembolso parcial' WHERE tipo_resolucao = '% do reembolso';
