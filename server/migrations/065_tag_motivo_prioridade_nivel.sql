-- ═══════════════════════════════════════════════════════════════════════════
--  065 · Tag de motivo do contato e prioridade Alta/Média no Suporte Escalado (pedido da Késsia, PDF de 05/10/2026)
--
--  Tag (automática, sem edição por ninguém): calculada UMA vez, quando o caso nasce, pelas palavras do 1º e-mail (assunto + corpo):
--    chargeback  chargeback, dispute, bank
--    reembolso   cancel, cancelled, cancellation, refund, refunded, return, returned
--    rastreio    tracking
--    outros      nenhuma das anteriores
--  Mais de uma tag no mesmo e-mail: vale a primeira da lista acima (chargeback > reembolso > rastreio > outros).
--  Palavra inteira (não casa "bankruptcy" nem "returnable"), sem diferenciar maiúscula/minúscula; plurais aceitos (refunds, returns, disputes).
--  Reabertura (novo e-mail do mesmo cliente) NÃO recalcula: o ticket é o mesmo.
--
--  Prioridade Alta/Média: coluna GERADA da tag (chargeback e reembolso = alta; rastreio e outros = media). Não existe jeito de editar.
--  A coluna `prioridade` (P0–P3, migração 062) continua como está: ordena a fila.
--
--  Só altera o que é novo; não envia e-mail, não mexe em status nem em board. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS tag_motivo text;
DO $$ BEGIN
  ALTER TABLE email_ia.suporte_escalado ADD CONSTRAINT suporte_escalado_tag_motivo_chk
    CHECK (tag_motivo IS NULL OR tag_motivo IN ('reembolso', 'chargeback', 'rastreio', 'outros'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN email_ia.suporte_escalado.tag_motivo IS 'Tag do motivo do contato (reembolso/chargeback/rastreio/outros), automática pelas palavras do 1º e-mail, imutável (065).';

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS prioridade_nivel text
  GENERATED ALWAYS AS (CASE WHEN tag_motivo IN ('chargeback', 'reembolso') THEN 'alta'
                            WHEN tag_motivo IS NOT NULL THEN 'media' END) STORED;
COMMENT ON COLUMN email_ia.suporte_escalado.prioridade_nivel IS 'Prioridade Alta/Média derivada da tag do motivo (065). Gerada: não editável.';

CREATE OR REPLACE FUNCTION email_ia.calcular_tag_motivo(p_texto text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE
           WHEN coalesce(p_texto, '') ~* '\m(chargebacks?|disputes?|disputed|bank)\M' THEN 'chargeback'
           WHEN coalesce(p_texto, '') ~* '\m(cancel|cancell?ed|cancellation|refunds?|refunded|returns?|returned)\M' THEN 'reembolso'
           WHEN coalesce(p_texto, '') ~* '\mtracking\M' THEN 'rastreio'
           ELSE 'outros'
         END
$f$;

-- Caso novo já nasce com a tag (texto do e-mail que gerou o caso; sem e-mail, o resumo do caso).
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_tag_motivo() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE texto text;
BEGIN
  IF NEW.tag_motivo IS NULL THEN
    SELECT coalesce(e.assunto, '') || ' ' || coalesce(e.corpo_texto, '') INTO texto FROM email_ia.emails e WHERE e.id = NEW.email_id;
    NEW.tag_motivo := email_ia.calcular_tag_motivo(coalesce(texto, NEW.resumo_conversa, ''));
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_tag_motivo ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_tag_motivo BEFORE INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_tag_motivo();

-- Casos que já existem: recebem a tag uma vez (antes de travar a edição).
UPDATE email_ia.suporte_escalado s
   SET tag_motivo = email_ia.calcular_tag_motivo(
         coalesce((SELECT coalesce(e.assunto, '') || ' ' || coalesce(e.corpo_texto, '') FROM email_ia.emails e WHERE e.id = s.email_id),
                  s.resumo_conversa, ''))
 WHERE s.tag_motivo IS NULL;

-- Imutável: depois de preenchida, ninguém troca (nem por SQL solto).
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_tag_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF OLD.tag_motivo IS NOT NULL AND NEW.tag_motivo IS DISTINCT FROM OLD.tag_motivo THEN
    RAISE EXCEPTION 'A tag do motivo do contato é automática e não pode ser alterada (caso %).', OLD.id;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_tag_imutavel ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_tag_imutavel BEFORE UPDATE OF tag_motivo ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_tag_imutavel();
