-- ═══════════════════════════════════════════════════════════════════════════
--  089 · Suporte Humano — troca de agente sempre entra no histórico (PDF da Késsia de 07/10/2026, 3º momento, item 4)
--
--  Antes: "Atribuído ao agente" era deduzido das linhas de `suporte_escalado_historico`, que o gatilho 057 só grava quando o STATUS muda.
--  Transferir um ticket que já estava "Pendente" para outro agente não mudava o status → nenhuma linha → a troca não aparecia.
--  Agora: um gatilho em `suporte_escalado` grava em `suporte_escalado_eventos` (quem, de qual agente, para qual) sempre que `board_id` muda
--  (transferência, transferência em massa, mesclagem, roteador). Autor = usuário do painel (`sendtrace.usuario`) ou "Sistema".
--  A API deixa de mostrar a atribuição deduzida quando já existe o evento do mesmo instante (sem duplicar). Só adiciona função e gatilho. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.trg_troca_de_agente() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  v_usuario text := nullif(current_setting('sendtrace.usuario', true), '');
BEGIN
  IF NEW.board_id IS DISTINCT FROM OLD.board_id THEN
    INSERT INTO email_ia.suporte_escalado_eventos (caso_id, ator, bloco, campo, de, para, detalhe)
    VALUES (NEW.id, coalesce(v_usuario, 'Sistema'), 'ticket', 'agente',
            (SELECT nome FROM email_ia.suporte_escalado_boards WHERE id = OLD.board_id),
            (SELECT nome FROM email_ia.suporte_escalado_boards WHERE id = NEW.board_id),
            CASE WHEN v_usuario IS NULL THEN 'Automático' END);
  END IF;
  RETURN NULL;
END $f$;

DROP TRIGGER IF EXISTS trg_troca_de_agente ON email_ia.suporte_escalado;
CREATE TRIGGER trg_troca_de_agente AFTER UPDATE OF board_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_troca_de_agente();
