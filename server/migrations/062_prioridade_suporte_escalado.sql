-- ═══════════════════════════════════════════════════════════════════════════
--  062 · Prioridade P0–P3 no Suporte Escalado (Plano D30 · AB18, versão reduzida) — 01/10/2026
--
--  O ticket já guarda o risco do cliente (`risco_flags`, migração 043). Esta migração só traduz esses sinais em UMA prioridade por
--  caso, sem classificador novo, sem mexer em envio e sem mexer na tela:
--    P0  disputa (banco, chargeback, advogado, BBB)                                      — meta de atendimento até 1 h
--    P1  pede reembolso, reação/saúde, fraude, reincidente (2º contato)                  — até 4 h
--    P2  muito negativo ou negativo, sem pedido de reembolso (compra confusa, cobrança)   — até 4 h
--    P3  o resto (dúvida)                                                                 — até 24 h
--  A API passa a devolver `prioridade` e aceita `ordem=prioridade`; o Kanban não muda até a tela usar isso.
--
--  Caso novo: nasce com a prioridade do cliente (gatilho BEFORE INSERT). Risco que muda depois: um gatilho no ticket reatualiza
--  os casos ABERTOS do mesmo e-mail (finalizado/reembolsado ficam como estavam). Só leitura/ordenação: não envia e-mail.
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS prioridade smallint;
DO $$ BEGIN
  ALTER TABLE email_ia.suporte_escalado ADD CONSTRAINT suporte_escalado_prioridade_chk CHECK (prioridade IS NULL OR prioridade BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN email_ia.suporte_escalado.prioridade IS 'P0–P3 (AB18): 0 disputa · 1 reembolso/saúde/fraude/2º contato · 2 negativo · 3 dúvida. Calculada dos sinais de risco do ticket do mesmo cliente.';

CREATE OR REPLACE FUNCTION email_ia.calcular_prioridade(p_email text) RETURNS smallint
LANGUAGE sql STABLE AS $f$
  SELECT CASE
           WHEN f IS NULL THEN 3
           WHEN coalesce((f->>'disputa')::boolean, false) THEN 0
           WHEN coalesce((f->>'pede_reembolso')::boolean, false) OR coalesce((f->>'reacao')::boolean, false)
             OR coalesce((f->>'fraude')::boolean, false) OR coalesce((f->>'reincidente')::boolean, false) THEN 1
           WHEN coalesce((f->>'muito_negativo')::boolean, false) OR coalesce((f->>'negativo')::boolean, false) THEN 2
           ELSE 3
         END::smallint
  FROM (SELECT (SELECT t.risco_flags FROM email_ia.tickets t
                 WHERE lower(t.remetente_email) = lower(p_email) AND t.risco_flags IS NOT NULL
                 ORDER BY t.risco_calculado_em DESC NULLS LAST LIMIT 1) AS f) x
$f$;

-- Caso novo já nasce com prioridade.
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_prioridade() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.prioridade IS NULL THEN
    NEW.prioridade := email_ia.calcular_prioridade(NEW.remetente_email);
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_prioridade ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_prioridade BEFORE INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_prioridade();

-- Risco do ticket mudou -> reatualiza os casos abertos do mesmo cliente.
CREATE OR REPLACE FUNCTION email_ia.trg_ticket_risco_prioridade() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE nova smallint;
BEGIN
  nova := email_ia.calcular_prioridade(NEW.remetente_email);
  UPDATE email_ia.suporte_escalado s SET prioridade = nova
   WHERE lower(s.remetente_email) = lower(NEW.remetente_email)
     AND s.status NOT IN ('finalizado', 'reembolsado')
     AND s.prioridade IS DISTINCT FROM nova;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_ticket_risco_prioridade ON email_ia.tickets;
CREATE TRIGGER trg_ticket_risco_prioridade AFTER UPDATE OF risco_flags, risco_nivel ON email_ia.tickets
  FOR EACH ROW WHEN (NEW.risco_flags IS DISTINCT FROM OLD.risco_flags OR NEW.risco_nivel IS DISTINCT FROM OLD.risco_nivel)
  EXECUTE FUNCTION email_ia.trg_ticket_risco_prioridade();

-- Carga inicial: só casos abertos (os fechados ficam sem prioridade, não valem para a fila).
UPDATE email_ia.suporte_escalado s
   SET prioridade = email_ia.calcular_prioridade(s.remetente_email)
 WHERE s.status NOT IN ('finalizado', 'reembolsado') AND s.prioridade IS NULL;

CREATE INDEX IF NOT EXISTS idx_suporte_escalado_prioridade ON email_ia.suporte_escalado (prioridade, criado_em)
  WHERE status NOT IN ('finalizado', 'reembolsado');
