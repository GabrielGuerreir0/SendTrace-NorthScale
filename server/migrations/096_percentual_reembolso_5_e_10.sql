-- ═══════════════════════════════════════════════════════════════════════════
--  096 · Percentual do reembolso parcial: entram 5% e 10% (4º momento da Késsia, item 6 — 13/10/2026)
--
--  A migração 071 limitou o percentual a 15–90 (de 5 em 5). Agora vale 5–90 (de 5 em 5). Só troca a restrição; nenhum dado muda. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha DROP CONSTRAINT IF EXISTS suporte_escalado_ficha_percentual_chk;
ALTER TABLE email_ia.suporte_escalado_ficha ADD CONSTRAINT suporte_escalado_ficha_percentual_chk
  CHECK (percentual_reembolso IS NULL OR (percentual_reembolso BETWEEN 5 AND 90 AND percentual_reembolso % 5 = 0));
COMMENT ON COLUMN email_ia.suporte_escalado_ficha.percentual_reembolso IS 'Porcentagem do reembolso parcial (5–90, de 5 em 5); só com tipo_resolucao = Reembolso parcial (071, 096).';
