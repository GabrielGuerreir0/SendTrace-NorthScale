-- ═══════════════════════════════════════════════════════════════════════════
--  070 · Ciclo agente ↔ lead no Suporte Escalado (pedido do Lucas, 05/10/2026)
--
--  Pendente (agente ainda não respondeu) → Esperando resposta (agente respondeu, aguarda o lead)
--    → LEAD RESPONDEU (coluna nova: o lead respondeu, aguarda o agente) → agente responde → Esperando resposta → … até o agente mover para Finalizado.
--
--  Regras (todas por gatilho no banco, sem mexer em fluxo n8n):
--   1) Resposta do agente (email_ia.respostas_agente, migração 069): se o caso está em pendente, iniciado ou lead_respondeu, vai para esperando_resposta
--      — ou para lead_respondeu se o lead JÁ escreveu depois dessa resposta (a leitura da pasta Enviados pode atrasar alguns minutos).
--      Também marca o 1º toque humano (primeiro_toque_humano_em) com a hora real da resposta.
--   2) E-mail novo do lead (o fluxo de e-mails atualiza o email_id do caso): se o caso está em esperando_resposta, vai para lead_respondeu.
--      Registra a hora desse e-mail em ultimo_email_cliente_em (comparada com a hora das respostas do agente).
--   3) Não mexe em formulario, reembolsado, finalizado, pendente_recorrencia, em_analise nem formulario_nao_respondeu_a_tempo (têm processo próprio);
--      finalizado continua reabrindo como pendente (regra antiga).
--   4) A mudança automática NÃO limpa o alerta de ameaça (só pessoa pelo painel limpa) e aparece no histórico como "Sistema".
--  Também cria a coluna "Lead respondeu" em todos os boards (ordem logo depois de "Esperando resposta"). Os cards que já existem NÃO são movidos aqui
--  (catch-up à parte, com simulação). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

SET LOCAL statement_timeout = '300s';

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS ultimo_email_cliente_em timestamptz;
COMMENT ON COLUMN email_ia.suporte_escalado.ultimo_email_cliente_em IS 'Hora do último e-mail do cliente no caso (070). Comparada com respostas_agente.enviado_em para saber de quem é a vez.';

-- Coluna nova em todos os boards.
INSERT INTO email_ia.suporte_escalado_colunas (board_id, chave, rotulo, descricao, ordem)
SELECT b.id, 'lead_respondeu', 'Lead respondeu', 'O cliente respondeu — a bola está com o agente.', 4
  FROM email_ia.suporte_escalado_boards b
 WHERE NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = b.id AND c.chave = 'lead_respondeu');

-- Carga inicial: último e-mail do cliente = o mais recente entre o e-mail ligado ao caso e os e-mails diretos do mesmo endereço.
UPDATE email_ia.suporte_escalado s
   SET ultimo_email_cliente_em = greatest(
         (SELECT e.data_email FROM email_ia.emails e WHERE e.id = s.email_id),
         (SELECT max(e2.data_email) FROM email_ia.emails e2 WHERE e2.plataforma_origem IS NULL AND lower(e2.remetente_email) = lower(s.remetente_email)),
         s.criado_em)
 WHERE s.ultimo_email_cliente_em IS NULL;

-- Caso novo: o e-mail do cliente é o que o criou.
-- E-mail novo num caso existente (o fluxo troca o email_id): registra a hora e, se o caso espera o lead, passa a vez para o agente.
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_cliente_escreveu() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v_quando timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ultimo_email_cliente_em := coalesce(NEW.ultimo_email_cliente_em, (SELECT e.data_email FROM email_ia.emails e WHERE e.id = NEW.email_id), now());
    RETURN NEW;
  END IF;
  IF NEW.email_id IS NOT NULL AND NEW.email_id IS DISTINCT FROM OLD.email_id THEN
    SELECT e.data_email INTO v_quando FROM email_ia.emails e WHERE e.id = NEW.email_id;
    NEW.ultimo_email_cliente_em := coalesce(v_quando, now());
    IF OLD.status = 'esperando_resposta' AND NEW.status = 'esperando_resposta' THEN
      NEW.status := 'lead_respondeu';
    END IF;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_cliente_escreveu ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_cliente_escreveu BEFORE INSERT OR UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_cliente_escreveu();

-- Resposta do agente: atualiza as datas, marca o 1º toque humano e passa a vez para o lead (ou de volta ao agente, se o lead já escreveu depois).
CREATE OR REPLACE FUNCTION email_ia.trg_resposta_agente_atualiza_caso() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.caso_id IS NOT NULL THEN
    UPDATE email_ia.suporte_escalado s
       SET primeira_resposta_agente_em = least(coalesce(s.primeira_resposta_agente_em, NEW.enviado_em), NEW.enviado_em),
           ultima_resposta_agente_em   = greatest(coalesce(s.ultima_resposta_agente_em, NEW.enviado_em), NEW.enviado_em),
           primeiro_toque_humano_em    = coalesce(s.primeiro_toque_humano_em, NEW.enviado_em),
           status = CASE WHEN s.status IN ('pendente', 'iniciado', 'lead_respondeu')
                         THEN CASE WHEN coalesce(s.ultimo_email_cliente_em, '-infinity'::timestamptz) > NEW.enviado_em THEN 'lead_respondeu' ELSE 'esperando_resposta' END
                         ELSE s.status END
     WHERE s.id = NEW.caso_id;
  END IF;
  RETURN NEW;
END $f$;
