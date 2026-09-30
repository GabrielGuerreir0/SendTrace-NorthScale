-- ═══════════════════════════════════════════════════════════════════════════
--  059 · Suporte Escalado — destaque de ameaça de chargeback / ameaça legal (30/09/2026)
--
--  O cliente foi avisado de resposta em até 2 dias úteis; a equipe precisa enxergar na hora os casos com ameaça. Coluna
--  suporte_escalado.alerta_ameaca ('chargeback' | 'legal' | 'ambos'; NULL = sem alerta) + alerta_ameaca_em:
--    · liga quando o caso é criado/atualizado com o motivo da IA "CRÍTICO … chargeback/disputa/banco/ação legal" OU quando o texto
--      do e-mail que o criou traz uma ameaça (regex abaixo);
--    · liga de novo (ou amplia) quando chega uma mensagem nova do cliente com ameaça, em qualquer status do caso;
--    · SÓ sai quando uma pessoa troca o status pelo painel (o painel grava o usuário em 'sendtrace.usuario', ver 057); reabertura
--      automática, rotinas e scripts não limpam.
--  Só o começo da mensagem entra na análise (assunto + 1.500 caracteres) para não pegar texto citado/boilerplate de plataformas.
--  Aditiva e idempotente; não altera status nem envia nada. Desfazer: DROP dos 3 gatilhos + função + colunas.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS alerta_ameaca text;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS alerta_ameaca_em timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_escalado_alerta_ameaca_chk') THEN
    ALTER TABLE email_ia.suporte_escalado ADD CONSTRAINT suporte_escalado_alerta_ameaca_chk
      CHECK (alerta_ameaca IS NULL OR alerta_ameaca IN ('chargeback', 'legal', 'ambos'));
  END IF;
END $$;

-- Tipo de ameaça no texto: 'chargeback' | 'legal' | 'ambos' | NULL
CREATE OR REPLACE FUNCTION email_ia.tipo_ameaca(p_texto text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN cb AND lg THEN 'ambos' WHEN cb THEN 'chargeback' WHEN lg THEN 'legal' END
    FROM (SELECT
      lower(coalesce(p_texto, '')) ~ '(charge ?back|disput(e|ed|ing)\M|contest(ed|ing)? (the |this |my )?(charge|payment|transaction)|(call|contact|notify|report|tell|inform)(ed|ing)? (my |the )?(bank|credit card|card company|card issuer)|card (company|issuer))' AS cb,
      lower(coalesce(p_texto, '')) ~ '(\mbbb\M|better business bureau|attorney general|lawyer|attorney|legal action|lawsuit|\msu(e|ed|ing) (you|your|the company|northscale)|small claims|advogado|\mftc\M|federal trade commission|\mfcc\M|consumer (protection|affairs)|\mcfpb\M|police|sheriff|legal team)' AS lg
    ) x
$f$;

CREATE OR REPLACE FUNCTION email_ia.juntar_ameaca(a text, b text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a WHEN a = b THEN a ELSE 'ambos' END
$f$;

-- 1) caso criado/atualizado: motivo da IA ou e-mail de origem com ameaça
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_alerta_ameaca() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  v_tipo text;
BEGIN
  IF NEW.email_id IS NOT NULL THEN
    SELECT email_ia.tipo_ameaca(coalesce(e.assunto, '') || ' ' || left(coalesce(e.corpo_texto, ''), 1500)) INTO v_tipo
      FROM email_ia.emails e WHERE e.id = NEW.email_id;
  END IF;
  IF v_tipo IS NULL AND NEW.motivo_escalonamento ~* 'amea[çc]a/mencionou chargeback|amea[çc]a de chargeback|amea[çc]a legal' THEN
    v_tipo := 'chargeback';
  END IF;
  IF v_tipo IS NOT NULL THEN
    NEW.alerta_ameaca := email_ia.juntar_ameaca(NEW.alerta_ameaca, v_tipo);
    NEW.alerta_ameaca_em := now();
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_alerta_ameaca ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_alerta_ameaca BEFORE INSERT OR UPDATE OF motivo_escalonamento, email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_alerta_ameaca();

-- 2) mensagem nova do cliente com ameaça, em qualquer status do caso
CREATE OR REPLACE FUNCTION email_ia.trg_emails_alerta_ameaca() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  v_tipo text := email_ia.tipo_ameaca(coalesce(NEW.assunto, '') || ' ' || left(coalesce(NEW.corpo_texto, ''), 1500));
BEGIN
  IF v_tipo IS NOT NULL AND NEW.plataforma_origem IS NULL AND coalesce(NEW.remetente_email, '') <> '' THEN
    BEGIN
      UPDATE email_ia.suporte_escalado s
         SET alerta_ameaca = email_ia.juntar_ameaca(s.alerta_ameaca, v_tipo), alerta_ameaca_em = now()
       WHERE lower(s.remetente_email) = lower(NEW.remetente_email);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'alerta_ameaca falhou para %: %', NEW.remetente_email, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_emails_alerta_ameaca ON email_ia.emails;
CREATE TRIGGER trg_emails_alerta_ameaca AFTER INSERT ON email_ia.emails
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_emails_alerta_ameaca();

-- 3) só pessoa da equipe (status trocado pelo painel) tira o destaque
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_limpa_alerta() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND nullif(current_setting('sendtrace.usuario', true), '') IS NOT NULL THEN
    NEW.alerta_ameaca := NULL;
    NEW.alerta_ameaca_em := NULL;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_limpa_alerta ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_limpa_alerta BEFORE UPDATE OF status ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_limpa_alerta();

-- Carga inicial: casos hoje em Pendente com ameaça (motivo da IA, e-mail de origem ou mensagens desde 3 dias antes da criação do caso)
UPDATE email_ia.suporte_escalado s
   SET alerta_ameaca = q.tipo, alerta_ameaca_em = now()
  FROM (
    SELECT p.id,
           email_ia.juntar_ameaca(
             (SELECT email_ia.tipo_ameaca(string_agg(coalesce(e.assunto, '') || ' ' || left(coalesce(e.corpo_texto, ''), 1500), ' || ')) FROM email_ia.emails e
               WHERE e.plataforma_origem IS NULL AND lower(e.remetente_email) = lower(p.remetente_email) AND e.data_email >= p.criado_em - interval '3 days'),
             CASE WHEN p.motivo_escalonamento ~* 'amea[çc]a/mencionou chargeback|amea[çc]a de chargeback|amea[çc]a legal' THEN 'chargeback' END) AS tipo
      FROM email_ia.suporte_escalado p WHERE p.status IN ('pendente', 'pendente_recorrencia') AND p.alerta_ameaca IS NULL
  ) q
 WHERE s.id = q.id AND q.tipo IS NOT NULL;
