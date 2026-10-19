-- ═══════════════════════════════════════════════════════════════════════════
--  111 · Suporte Humano — 5º momento, item 6: "o último e-mail é do cliente, mas o ticket aparece como aguardando o cliente" (Késsia, 19/10/2026)
--
--  Levantamento em produção (19/10): 2.946 tickets com o último e-mail do cliente; 2.527 fora da fila do agente. Os grupos:
--    · fechados/resolvidos DEPOIS do e-mail do cliente (2.134) — decisão de pessoa, higienização ou rotina; não é erro (só os fechados pelo SISTEMA com o
--      ticket de volta numa coluna de fila são, ver 3);
--    · cliente escreveu DEPOIS de o ticket ir para "Reembolsado" (218, 107 só nos últimos 14 dias): a coluna não é fila → o agente nunca via o e-mail;
--    · formulário/finalizado antigos (175, nenhum dos últimos 14 dias): já cobertos pela 106/108 daqui para frente;
--    · cliente escreveu depois de fechar/resolver (deveria ter reaberto): 0 — a reabertura já funciona.
--  Regras novas (daqui para frente; a correção dos que já existem é o script `Correções/aguardando_cliente`, com simulação, backup e desfazer):
--   1) Cliente escreve em ticket na coluna "Reembolsado" → o caso volta para a fila: 'lead_respondeu' (o agente já tinha respondido) ou 'pendente' (nunca respondeu).
--   2) O VETO da 105 ganha uma regra: o sistema NÃO devolve para "Reembolsado" um caso em que o cliente escreveu depois da última ida para lá e ninguém respondeu
--      (evita o vai-e-volta com o nó "Limpar Kanban: Pedidos Já Reembolsados" do n8n, que roda a cada 5 min).
--   3) Caso que entra numa coluna de fila (pendente, lead_respondeu, esperando_resposta, em_analise…) com a ficha Fechada/Resolvida: a ficha volta para Aberto
--      (sem a marca de reaberto), para o caso aparecer na fila. Vale para movimento de pessoa e de sistema.
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) cliente escreveu em "Reembolsado" → volta para a fila (acrescenta um ramo à função da 108)
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
    ELSIF OLD.status = NEW.status AND NEW.status IN ('formulario', 'formulario_nao_respondeu_a_tempo')
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = NEW.board_id AND c.chave IN ('pendente', 'lead_respondeu')) THEN
      NEW.status := CASE WHEN NEW.primeira_resposta_agente_em IS NOT NULL THEN 'lead_respondeu' ELSE 'pendente' END;
    ELSIF OLD.status = NEW.status AND NEW.status = 'finalizado' AND NEW.primeira_resposta_agente_em IS NULL THEN
      NEW.status := 'pendente';
    ELSIF OLD.status = NEW.status AND NEW.status = 'finalizado'
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_ficha f WHERE f.suporte_escalado_id = NEW.id AND f.status_ticket IN ('Fechado', 'Resolvido'))
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = NEW.board_id AND c.chave IN ('pendente', 'lead_respondeu')) THEN
      NEW.status := 'lead_respondeu';
    ELSIF OLD.status = NEW.status AND NEW.status = 'reembolsado'
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = NEW.board_id AND c.chave IN ('pendente', 'lead_respondeu')) THEN
      NEW.status := CASE WHEN NEW.primeira_resposta_agente_em IS NOT NULL THEN 'lead_respondeu' ELSE 'pendente' END;   -- 111: o cliente escreveu depois do reembolso
    END IF;
  END IF;
  RETURN NEW;
END $f$;

-- 2) veto: não devolver para Reembolsado quem escreveu depois da última ida para lá sem resposta (acrescenta uma regra à função da 105)
CREATE OR REPLACE FUNCTION email_ia.trg_veto_reembolsado_com_compra_ativa() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.status IS DISTINCT FROM 'reembolsado' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'reembolsado' THEN RETURN NEW; END IF;
  IF nullif(current_setting('sendtrace.usuario', true), '') IS NOT NULL THEN RETURN NEW; END IF;      -- pessoa moveu: vale
  IF TG_OP = 'UPDATE' AND NEW.ultimo_email_cliente_em > coalesce(NEW.ultima_resposta_agente_em, '-infinity'::timestamptz)
     AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_historico h
                  WHERE h.suporte_escalado_id = NEW.id AND h.status_novo = 'reembolsado' AND h.mudou_em < NEW.ultimo_email_cliente_em) THEN
    NEW.status := OLD.status; NEW.iniciado_em := OLD.iniciado_em; NEW.atualizado_em := OLD.atualizado_em;   -- 111: o cliente escreveu depois do reembolso e ninguém respondeu
    RETURN NEW;
  END IF;
  IF email_ia.recorrencia_estado(NEW.remetente_email) = 'reembolsado' THEN RETURN NEW; END IF;       -- regra de recorrência (051): mantém
  IF NOT email_ia.cliente_tem_compra_ativa(NEW.remetente_email) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN NEW.status := 'pendente';
  ELSE NEW.status := OLD.status; NEW.iniciado_em := OLD.iniciado_em; NEW.atualizado_em := OLD.atualizado_em;
  END IF;
  RETURN NEW;
END $f$;

-- 3) caso que entra numa coluna de fila com a ficha Fechada/Resolvida: a ficha volta para Aberto
CREATE OR REPLACE FUNCTION email_ia.trg_entrou_na_fila_reabre_ficha() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta', 'pendente_recorrencia')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND OLD.status NOT IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta', 'pendente_recorrencia') THEN
    UPDATE email_ia.suporte_escalado_ficha
       SET status_ticket = 'Aberto', propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_em = now()
     WHERE suporte_escalado_id = NEW.id AND status_ticket IN ('Fechado', 'Resolvido');
  END IF;
  RETURN NULL;
END $f$;
DROP TRIGGER IF EXISTS trg_entrou_na_fila_reabre_ficha ON email_ia.suporte_escalado;
CREATE TRIGGER trg_entrou_na_fila_reabre_ficha AFTER UPDATE OF status ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_entrou_na_fila_reabre_ficha();
