-- ═══════════════════════════════════════════════════════════════════════════
--  053 · Recorrência: todo contato de cliente JÁ COBRADO na renovação vira caso no Suporte Escalado
--
--  Decisão do Lucas (25/09/2026), para acompanhar de perto a reação à cobrança (pedido da Vitória): antes só
--  aparecia na coluna "Pendente - Recorrência" o que a IA decidia escalar; quem escrevia e ficava só com a IA
--  não aparecia. Agora, quando CHEGA e-mail de um cliente com recorrência que já teve a 1ª renovação cobrada
--  (e o e-mail é do dia da 1ª renovação em diante), o caso é aberto no Kanban — e o roteamento da 050/051 o
--  leva para "Pendente - Recorrência". Com o caso aberto a IA deixa de responder esse cliente (mesma regra de
--  todo caso escalado): quem atende é uma pessoa.
--
--  Fica de fora: cliente com reembolso/chargeback (não se atende — vai para Reembolsado, decisão de 25/09),
--  e-mail de antes da 1ª cobrança, e cliente que só comprou e ainda não foi cobrado.
--  Se o caso já existe, não duplica: só atualiza o e-mail do caso; se estava Finalizado, reabre (como o n8n).
--
--  O caso é aberto na CHEGADA do e-mail, antes da IA classificar: o resumo é só o assunto. Se a IA escalar depois,
--  o n8n sobrescreve resumo e motivo (ON CONFLICT DO UPDATE). Erro no gatilho vira WARNING e nunca bloqueia a
--  gravação do e-mail. Idempotente (OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.recorrencia_escalar_contato(
  p_email text, p_email_id bigint, p_nome text, p_assunto text, p_data timestamptz
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_email, '') = '' OR p_data IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.recorrencia_clientes c
       WHERE c.email = lower(btrim(p_email)) AND c.cobrancas > 0
         AND (p_data AT TIME ZONE 'America/Sao_Paulo')::date
             >= (c.primeira_cobranca_em AT TIME ZONE 'America/Sao_Paulo')::date) THEN
    RETURN false;
  END IF;
  IF email_ia.recorrencia_estado(p_email) = 'reembolsado' THEN RETURN false; END IF;

  INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, email_id, status)
  VALUES (lower(btrim(p_email)), p_nome,
          'Cliente com recorrência já cobrada na renovação escreveu depois da cobrança. Assunto: ' || coalesce(nullif(btrim(p_assunto), ''), '(sem assunto)'),
          'Contato de cliente com recorrência já cobrada (acompanhamento da reação à cobrança)',
          p_email_id, 'pendente')
  ON CONFLICT (lower(remetente_email)) DO UPDATE SET
    status        = CASE WHEN email_ia.suporte_escalado.status = 'finalizado' THEN 'pendente' ELSE email_ia.suporte_escalado.status END,
    iniciado_em   = CASE WHEN email_ia.suporte_escalado.status = 'finalizado' THEN NULL ELSE email_ia.suporte_escalado.iniciado_em END,
    finalizado_em = CASE WHEN email_ia.suporte_escalado.status = 'finalizado' THEN NULL ELSE email_ia.suporte_escalado.finalizado_em END,
    email_id      = EXCLUDED.email_id,
    atualizado_em = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION email_ia.trg_emails_recorrencia_escalar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM email_ia.recorrencia_escalar_contato(NEW.remetente_email, NEW.id, NEW.remetente_nome, NEW.assunto, NEW.data_email);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'recorrencia: falha ao escalar contato do e-mail %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emails_recorrencia_escalar ON email_ia.emails;
CREATE TRIGGER trg_emails_recorrencia_escalar
  AFTER INSERT ON email_ia.emails
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_emails_recorrencia_escalar();

-- Quem já escreveu depois da cobrança e está sem caso agora: abre o caso com o e-mail mais recente.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (c.email) c.email, e.id AS email_id, e.remetente_nome, e.assunto, e.data_email
    FROM public.recorrencia_clientes c
    JOIN email_ia.emails e ON lower(e.remetente_email) = c.email
    WHERE c.cobrancas > 0
      AND (e.data_email AT TIME ZONE 'America/Sao_Paulo')::date
          >= (c.primeira_cobranca_em AT TIME ZONE 'America/Sao_Paulo')::date
      AND NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado s WHERE lower(s.remetente_email) = c.email)
    ORDER BY c.email, e.data_email DESC
  LOOP
    PERFORM email_ia.recorrencia_escalar_contato(r.email, r.email_id, r.remetente_nome, r.assunto, r.data_email);
  END LOOP;
END $$;
