-- ═══════════════════════════════════════════════════════════════════════════
--  107 · Suporte Humano — campo "Comissão" em Propriedades (pedido da Késsia, 18/10/2026)
--
--  Lista suspensa Sim / Não passível / Sob análise, com histórico PRÓPRIO: quem preencheu, data e hora de cada alteração desse campo
--  (colunas comissao_atualizado_por/_em na ficha + eventos do bloco 'comissao' em suporte_escalado_eventos), independente de
--  `propriedades_atualizado_por` (que só guarda quem mexeu nas Propriedades por último). O campo é opcional e não entra nas Propriedades obrigatórias.
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS comissao text;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS comissao_atualizado_por text;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS comissao_atualizado_em timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_escalado_ficha_comissao_valores') THEN
    ALTER TABLE email_ia.suporte_escalado_ficha ADD CONSTRAINT suporte_escalado_ficha_comissao_valores
      CHECK (comissao IS NULL OR comissao IN ('Sim', 'Não passível', 'Sob análise'));
  END IF;
END $$;
COMMENT ON COLUMN email_ia.suporte_escalado_ficha.comissao IS 'Comissão (107): Sim | Não passível | Sob análise. Histórico próprio em suporte_escalado_eventos (bloco comissao).';

-- O gatilho dos eventos passa a olhar também o campo comissao (ator = comissao_atualizado_por). Reescreve a função ao vivo, sem copiar o corpo.
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('email_ia.trg_ficha_eventos'::regproc);
  IF position('(''comissao'', ''comissao'')' IN v_def) = 0 THEN
    IF position('(''ajuda'', ''status_ajuda'')' IN v_def) = 0 THEN
      RAISE EXCEPTION 'trg_ficha_eventos mudou: não achei o ponto de inserção do campo comissao.';
    END IF;
    v_def := replace(v_def, '(''ajuda'', ''status_ajuda'')', '(''ajuda'', ''status_ajuda''), (''comissao'', ''comissao'')');
    EXECUTE v_def;
  END IF;
END $$;
