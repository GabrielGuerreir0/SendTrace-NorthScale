-- ═══════════════════════════════════════════════════════════════════════════
--  054 · E-mail da Digistore24 enviado DIRETO para a nossa caixa vira caso no Suporte Escalado
--
--  Problema (25/09/2026): desde 17/08 a Digistore24 escreve direto para a nossa caixa ("comprador quer cancelar /
--  devolver / dúvida de pedido", ~30–80 por semana). O fluxo de leads da Digistore só trata o e-mail que vai PARA o
--  cliente (com a NorthScale em cópia); esses ficaram fora (decisão de 17/08) e nunca tiveram dono: 351 e-mails,
--  0 respondidos, 0 ligados a caso. O e-mail traz o comprador no corpo ("Buyer email:", "Buyer name:", "Order id:").
--
--  Correção: quando a IA classifica um e-mail da Digistore direto como "pede resposta", o comprador é lido do corpo e
--  o caso é aberto no Kanban (o roteamento das migrações 050–053 decide a coluna/board). Não abre caso para
--  comprador com reembolso/chargeback (não se atende — decisão de 25/09) nem quando o e-mail não traz comprador.
--  Se o caso já existe, não duplica: atualiza o e-mail do caso e reabre se estava Finalizado.
--  A IA NÃO responde esses e-mails: quem atende é uma pessoa (a Digistore é o canal do comprador).
--
--  Carga inicial: e-mails dos últimos 30 dias, um caso por comprador (o e-mail mais recente). Os mais antigos
--  ficam de fora de propósito (a Digistore costuma já ter resolvido pelo próprio canal).
--  Erro no gatilho vira WARNING e nunca bloqueia a gravação do e-mail. Idempotente (OR REPLACE / ON CONFLICT).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.digistore_direto_escalar(
  p_email_id bigint, p_corpo text, p_assunto text, p_categoria text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_comprador text;
  v_nome      text;
  v_pedido    text;
BEGIN
  v_comprador := lower(coalesce(
    (regexp_match(p_corpo, 'buyer e-?mail\s*:\s*<?([\w.+-]+@[\w-]+\.[\w.-]+)', 'i'))[1],
    (SELECT m[1] FROM regexp_matches(substring(p_corpo from '(?:^|\n)\s*e-?mail\s*:\s*([^\n]*)'), '([\w.+-]+@[\w-]+\.[\w.-]+)', 'g') m
      WHERE m[1] !~* 'digistore24|northsupplements|thenorthscale|jvzoo|buygoods|helpdesk|no-?reply' LIMIT 1)));
  IF v_comprador IS NULL
     OR v_comprador ~* 'digistore24|northsupplements|thenorthscale|jvzoo|buygoods|helpdesk|no-?reply' THEN
    RETURN false;
  END IF;
  -- reembolso/chargeback já feito: não se atende
  IF EXISTS (SELECT 1 FROM public.disparos_pos_venda d
             WHERE lower(d.email) = v_comprador AND (d.reembolsado_em IS NOT NULL OR d.chargeback_em IS NOT NULL))
     OR email_ia.recorrencia_estado(v_comprador) = 'reembolsado' THEN
    RETURN false;
  END IF;

  v_nome   := nullif(btrim((regexp_match(p_corpo, 'buyer name\s*:\s*([^\n\r]+)', 'i'))[1]), '');
  v_pedido := nullif(btrim((regexp_match(p_corpo, 'order id\s*:\s*([A-Z0-9]+)', 'i'))[1]), '');

  INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, email_id, status)
  VALUES (v_comprador, v_nome,
          'A Digistore24 escreveu direto para a nossa caixa sobre este comprador. Assunto: '
            || coalesce(nullif(btrim(p_assunto), ''), '(sem assunto)')
            || coalesce('. Categoria: ' || p_categoria, '') || coalesce('. Pedido: ' || v_pedido, ''),
          'Digistore24 direto na nossa caixa' || coalesce(' — ' || p_categoria, '') || ' (a IA não responde: atendimento por pessoa)',
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

CREATE OR REPLACE FUNCTION email_ia.trg_emails_digistore_direto() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM email_ia.digistore_direto_escalar(NEW.id, NEW.corpo_texto, NEW.assunto, NEW.categoria);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'digistore direto: falha ao escalar o e-mail %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- Dispara quando a IA termina de classificar o e-mail (só aí se sabe se "pede resposta" e a categoria).
DROP TRIGGER IF EXISTS trg_emails_digistore_direto ON email_ia.emails;
CREATE TRIGGER trg_emails_digistore_direto
  AFTER UPDATE OF pede_resposta, analisado_em ON email_ia.emails
  FOR EACH ROW
  WHEN (NEW.plataforma_origem = 'digistore24' AND NEW.pede_resposta IS TRUE
        AND NEW.destinatario ~* 'northsupplements|thenorthscale'
        AND (OLD.pede_resposta IS DISTINCT FROM NEW.pede_resposta OR OLD.analisado_em IS DISTINCT FROM NEW.analisado_em))
  EXECUTE FUNCTION email_ia.trg_emails_digistore_direto();

-- Carga inicial: últimos 30 dias, um caso por comprador (e-mail mais recente).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (lower(coalesce((regexp_match(e.corpo_texto, 'buyer e-?mail\s*:\s*<?([\w.+-]+@[\w-]+\.[\w.-]+)', 'i'))[1], e.id::text)))
           e.id, e.corpo_texto, e.assunto, e.categoria
    FROM email_ia.emails e
    WHERE e.plataforma_origem = 'digistore24' AND e.pede_resposta IS TRUE
      AND e.destinatario ~* 'northsupplements|thenorthscale'
      AND e.data_email > now() - interval '30 days'
    ORDER BY lower(coalesce((regexp_match(e.corpo_texto, 'buyer e-?mail\s*:\s*<?([\w.+-]+@[\w-]+\.[\w.-]+)', 'i'))[1], e.id::text)), e.data_email DESC
  LOOP
    PERFORM email_ia.digistore_direto_escalar(r.id, r.corpo_texto, r.assunto, r.categoria);
  END LOOP;
END $$;
