-- ═══════════════════════════════════════════════════════════════════════════
--  064 · O ticket acompanha o card do Suporte Escalado (atendimento 100% humano) — 02/10/2026
--
--  Sem a IA de resposta, quem fecha o ticket (`em_aberto` / `resolvido`) era o nó "Atualizar Ticket" do fluxo que sai do ar.
--  Este gatilho faz o ticket seguir o card — MAS SÓ quando email_ia.config.escalonamento_total_ativo = 'true' (a virada liga,
--  o --reverter desliga). Enquanto a chave não existir ou for 'false', o gatilho não faz nada: pode ser aplicado antes.
--
--    card finalizado        -> ticket `resolvido` (resolvido_por = 'humano')
--    card reaberto (volta a pendente) ou movido para qualquer coluna aberta -> ticket `em_aberto` (resolvido_em limpo)
--  Não envia e-mail, não mexe no card. Idempotente. Desfazer: DROP TRIGGER trg_ticket_acompanha_card ON email_ia.suporte_escalado;
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION email_ia.trg_ticket_acompanha_card() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ativo text;
BEGIN
  SELECT valor INTO ativo FROM email_ia.config WHERE chave = 'escalonamento_total_ativo';
  IF coalesce(ativo, 'false') <> 'true' THEN RETURN NEW; END IF;

  IF NEW.status = 'finalizado' AND OLD.status IS DISTINCT FROM 'finalizado' THEN
    UPDATE email_ia.tickets
       SET status = 'resolvido', resolvido_em = coalesce(resolvido_em, now()), resolvido_por = 'humano',
           iniciado_em = coalesce(iniciado_em, now()), atualizado_em = now()
     WHERE remetente_email = lower(NEW.remetente_email) AND status IS DISTINCT FROM 'resolvido';
  ELSIF NEW.status <> 'finalizado' AND OLD.status = 'finalizado' THEN
    UPDATE email_ia.tickets
       SET status = 'em_aberto', resolvido_em = NULL, atualizado_em = now()
     WHERE remetente_email = lower(NEW.remetente_email) AND status = 'resolvido';
  ELSIF NEW.status <> 'pendente' AND NEW.status <> 'finalizado' AND OLD.status = 'pendente' THEN
    UPDATE email_ia.tickets
       SET status = 'em_aberto', iniciado_em = coalesce(iniciado_em, now()), atualizado_em = now()
     WHERE remetente_email = lower(NEW.remetente_email) AND status = 'nao_iniciado';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ticket_acompanha_card ON email_ia.suporte_escalado;
CREATE TRIGGER trg_ticket_acompanha_card AFTER UPDATE OF status ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_ticket_acompanha_card();
