-- ═══════════════════════════════════════════════════════════════════════════
--  086 · Suporte Humano — mesclar tickets (PDF da Késsia de 07/10/2026, item 9; Onda I)
--
--  O ticket de um cliente que escreveu de dois e-mails (ou abriu dois casos) vira ticket-FILHO do primeiro recebido, o ticket-MÃE:
--    · `suporte_escalado.ticket_mae_id` aponta para a mãe (a mãe nunca é filha: mesclar sempre usa a raiz);
--    · o filho vai para o board da mãe e sai do trabalho (Finalizado, ticket Fechado na ficha); quem trata é o agente da mãe;
--    · e-mail novo do cliente do filho passa para a mãe (o `email_id` da mãe recebe o do filho, então o ciclo agente ↔ lead,
--      o SLA e a reabertura da mãe funcionam como num e-mail dela); o filho volta a ficar finalizado;
--    · a mesclagem fica na linha do tempo dos dois tickets (`suporte_escalado_eventos`).
--  O número do ticket é o id do caso (decisão de 07/10): nada novo para isso. Só adiciona coluna, funções e gatilho. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS ticket_mae_id bigint REFERENCES email_ia.suporte_escalado(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE email_ia.suporte_escalado ADD CONSTRAINT suporte_escalado_mae_chk CHECK (ticket_mae_id IS NULL OR ticket_mae_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS suporte_escalado_mae_idx ON email_ia.suporte_escalado (ticket_mae_id) WHERE ticket_mae_id IS NOT NULL;
COMMENT ON COLUMN email_ia.suporte_escalado.ticket_mae_id IS 'Ticket-mãe quando este caso foi mesclado a outro (086); NULL = ticket principal.';

-- Mescla o filho na mãe. A API escolhe quem é mãe (a raiz mais antiga); aqui só se garante que a mãe não é filha de ninguém.
CREATE OR REPLACE FUNCTION email_ia.mesclar_tickets(p_mae bigint, p_filho bigint, p_por text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_board bigint;
BEGIN
  IF p_mae = p_filho THEN RAISE EXCEPTION 'Um ticket não pode ser mesclado a ele mesmo.'; END IF;
  IF EXISTS (SELECT 1 FROM email_ia.suporte_escalado WHERE id = p_mae AND ticket_mae_id IS NOT NULL) THEN
    RAISE EXCEPTION 'O ticket-mãe já é filho de outro ticket.';
  END IF;
  SELECT board_id INTO v_board FROM email_ia.suporte_escalado WHERE id = p_mae;
  -- filhos que o filho já tinha passam para a mãe
  UPDATE email_ia.suporte_escalado SET ticket_mae_id = p_mae WHERE ticket_mae_id = p_filho;
  UPDATE email_ia.suporte_escalado
     SET ticket_mae_id = p_mae, board_id = coalesce(v_board, board_id), status = 'finalizado',
         finalizado_em = coalesce(finalizado_em, now()), atualizado_em = now()
   WHERE id = p_filho;
  INSERT INTO email_ia.suporte_escalado_ficha (suporte_escalado_id, status_ticket, propriedades_atualizado_por, propriedades_atualizado_em, atualizado_por)
  VALUES (p_filho, 'Fechado', p_por, now(), p_por)
  ON CONFLICT (suporte_escalado_id) DO UPDATE
    SET status_ticket = 'Fechado', propriedades_atualizado_por = p_por, propriedades_atualizado_em = now(), atualizado_em = now();
  INSERT INTO email_ia.suporte_escalado_eventos (caso_id, ator, bloco, campo, de, para, detalhe)
  VALUES (p_mae, p_por, 'ticket', 'mesclagem', NULL, '#' || p_filho, 'Ticket #' || p_filho || ' mesclado a este (ticket-mãe)'),
         (p_filho, p_por, 'ticket', 'mesclagem', NULL, '#' || p_mae, 'Mesclado ao ticket #' || p_mae || ' (ticket-mãe)');
END $f$;

-- E-mail novo do cliente de um ticket-filho: vai para a mãe; o filho continua finalizado.
CREATE OR REPLACE FUNCTION email_ia.trg_filho_encaminha_para_mae() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.ticket_mae_id IS NOT NULL AND NEW.email_id IS NOT NULL AND NEW.email_id IS DISTINCT FROM OLD.email_id THEN
    UPDATE email_ia.suporte_escalado
       SET email_id = NEW.email_id,
           status = CASE WHEN status = 'finalizado' THEN 'pendente' ELSE status END,
           finalizado_em = CASE WHEN status = 'finalizado' THEN NULL ELSE finalizado_em END,
           atualizado_em = now()
     WHERE id = NEW.ticket_mae_id;
    UPDATE email_ia.suporte_escalado SET status = 'finalizado', atualizado_em = now() WHERE id = NEW.id AND status <> 'finalizado';
  END IF;
  RETURN NULL;
END $f$;
DROP TRIGGER IF EXISTS trg_filho_encaminha_para_mae ON email_ia.suporte_escalado;
CREATE TRIGGER trg_filho_encaminha_para_mae AFTER UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_filho_encaminha_para_mae();
