-- ═══════════════════════════════════════════════════════════════════════════
--  056 · Retenção — registro da oferta pelo CS (P10 do Rodrigo)
--
--  A tabela `retencao_ofertas` (049) já existe e o dash a lê em GET /api/retencao. Faltava o que o PDF pede em P10 e
--  o CS precisa para registrar no caso:
--    · valor_concedido_usd  o que a oferta CUSTOU (reembolso parcial, reenvio, bônus) — base do G3 (custo ÷ receita preservada);
--    · protecao             o reembolso foi imediato, de proteção (caso crítico) — base do G4;
--    · caso_id              o caso do Suporte Escalado em que a oferta foi registrada (auditoria).
--  Aditiva: colunas novas com padrão seguro, nada existente muda. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE retencao_ofertas
  ADD COLUMN IF NOT EXISTS valor_concedido_usd numeric(14,2),
  ADD COLUMN IF NOT EXISTS protecao            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS caso_id             bigint;

CREATE INDEX IF NOT EXISTS retencao_ofertas_email_idx ON retencao_ofertas (lower(email));
CREATE INDEX IF NOT EXISTS retencao_ofertas_caso_idx  ON retencao_ofertas (caso_id);
