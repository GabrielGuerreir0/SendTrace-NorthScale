-- ═══════════════════════════════════════════════════════════════════════════
--  042 · Quem resolveu o ticket (IA ou humano)
--
--  Motivo (21/09/2026): a especificação da Visão Geral v2 (pré-requisito P8) pede saber quem
--  resolveu. Hoje só dá para reconhecer a IA por uma assinatura: o UPDATE do fluxo n8n grava
--  `resolvido_em` e `ultima_resposta_ia_em` no MESMO instante; a rota manual do painel só grava
--  `resolvido_em`. Isso funciona desde 25/08 e não distingue "humano" de "script".
--
--  Agora a coluna guarda a resposta de verdade:
--    'ia'      — o fluxo da IA fechou o ticket (o trigger marca sozinho, sem mexer no n8n);
--    'humano'  — alguém fechou pelo painel (a rota marca);
--    NULL      — sem registro (histórico e limpezas em lote por script).
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.tickets ADD COLUMN IF NOT EXISTS resolvido_por text;

DO $$ BEGIN
  ALTER TABLE email_ia.tickets
    ADD CONSTRAINT tickets_resolvido_por_chk CHECK (resolvido_por IS NULL OR resolvido_por IN ('ia', 'humano'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Histórico: só a assinatura da IA é certa; o resto fica "sem registro" (não chutar "humano").
UPDATE email_ia.tickets
   SET resolvido_por = 'ia'
 WHERE resolvido_por IS NULL AND status = 'resolvido' AND resolvido_em IS NOT NULL AND resolvido_em = ultima_resposta_ia_em;

CREATE OR REPLACE FUNCTION email_ia.trg_ticket_resolvido_por() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'resolvido' THEN
    -- acabou de resolver neste UPDATE, com a assinatura do fluxo da IA
    IF (OLD.status IS DISTINCT FROM 'resolvido' OR NEW.resolvido_em IS DISTINCT FROM OLD.resolvido_em)
       AND NEW.resolvido_em IS NOT NULL AND NEW.resolvido_em = NEW.ultima_resposta_ia_em THEN
      NEW.resolvido_por := 'ia';
    END IF;
  ELSE
    NEW.resolvido_por := NULL;   -- reaberto: a próxima resolução decide de novo
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ticket_resolvido_por ON email_ia.tickets;
CREATE TRIGGER trg_ticket_resolvido_por BEFORE UPDATE ON email_ia.tickets
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_ticket_resolvido_por();

COMMENT ON COLUMN email_ia.tickets.resolvido_por IS
  'ia = fechado pelo fluxo da IA (trigger); humano = fechado pelo painel; NULL = sem registro (histórico ou script).';
