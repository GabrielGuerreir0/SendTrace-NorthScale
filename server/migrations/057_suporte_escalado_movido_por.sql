-- ═══════════════════════════════════════════════════════════════════════════
--  057 · Suporte Escalado — quem moveu o card e motivo de reabertura (30/09/2026)
--
--  Pedido do Lucas: registrar QUEM moveu um caso entre colunas e mostrar no card POR QUE um caso finalizado voltou a Pendente.
--    · suporte_escalado_historico.movido_por  nome do usuário do painel que moveu; NULL = sistema/automação (n8n, rotinas, scripts).
--      O painel grava o usuário na sessão do banco (set_config 'sendtrace.usuario', só dentro da transação do UPDATE) e o gatilho
--      do histórico copia. Só vale daqui para frente (movimentos antigos ficam NULL).
--    · nota automática (autor 'Sistema') quando um caso passa de finalizado para pendente, com o motivo provável:
--        movido na mão por X  |  cliente escreveu de novo  |  resposta da IA a e-mail ANTIGO  |  sem e-mail novo (rotina/sistema).
--  Aditiva e idempotente. Desfazer: DROP TRIGGER trg_nota_motivo_reabertura; DROP FUNCTION email_ia.trg_nota_motivo_reabertura();
--  restaurar trg_suporte_escalado_historico da 030 e (opcional) DROP COLUMN movido_por.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_historico ADD COLUMN IF NOT EXISTS movido_por text;

CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_historico() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  v_usuario text := nullif(current_setting('sendtrace.usuario', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO email_ia.suporte_escalado_historico (suporte_escalado_id, board_id, status_anterior, status_novo, movido_por)
    VALUES (NEW.id, NEW.board_id, NULL, NEW.status, v_usuario);
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO email_ia.suporte_escalado_historico (suporte_escalado_id, board_id, status_anterior, status_novo, movido_por)
    VALUES (NEW.id, NEW.board_id, OLD.status, NEW.status, v_usuario);
  END IF;
  RETURN NEW;
END
$f$;

CREATE OR REPLACE FUNCTION email_ia.trg_nota_motivo_reabertura() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  v_usuario text := nullif(current_setting('sendtrace.usuario', true), '');
  v_fin     timestamptz := COALESCE(OLD.finalizado_em, OLD.atualizado_em, now() - interval '1 hour');
  v_novo    record;
  v_ia      record;
  v_nota    text;
BEGIN
  IF v_usuario IS NOT NULL THEN
    v_nota := 'Movido de Finalizado para Pendente manualmente por ' || v_usuario || '.';
  ELSE
    SELECT e.data_email, left(coalesce(e.assunto, ''), 70) AS assunto INTO v_novo
      FROM email_ia.emails e
     WHERE lower(e.remetente_email) = lower(NEW.remetente_email) AND e.data_email > v_fin
     ORDER BY e.data_email DESC LIMIT 1;
    SELECT e.data_email, left(coalesce(e.assunto, ''), 70) AS assunto INTO v_ia
      FROM email_ia.emails e
     WHERE lower(e.remetente_email) = lower(NEW.remetente_email)
       AND e.resposta_enviada_em >= now() - interval '10 minutes' AND e.data_email <= v_fin
     ORDER BY e.resposta_enviada_em DESC LIMIT 1;
    IF v_novo.data_email IS NOT NULL THEN
      v_nota := 'Reaberto automaticamente: o cliente escreveu de novo em ' || to_char(v_novo.data_email AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' — "' || v_novo.assunto || '".';
    ELSIF v_ia.data_email IS NOT NULL THEN
      v_nota := 'Reaberto pela resposta automática da IA a um e-mail ANTIGO do cliente (de ' || to_char(v_ia.data_email AT TIME ZONE 'America/Sao_Paulo', 'DD/MM') || ', "' || v_ia.assunto || '"). Não há e-mail novo do cliente depois da finalização.';
    ELSE
      v_nota := 'Reaberto sem e-mail novo do cliente e sem resposta da IA (rotina ou script do sistema).';
    END IF;
  END IF;
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (NEW.id, 'Sistema', v_nota);
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS trg_nota_motivo_reabertura ON email_ia.suporte_escalado;
CREATE TRIGGER trg_nota_motivo_reabertura AFTER UPDATE OF status ON email_ia.suporte_escalado
  FOR EACH ROW WHEN (OLD.status = 'finalizado' AND NEW.status = 'pendente') EXECUTE FUNCTION email_ia.trg_nota_motivo_reabertura();
