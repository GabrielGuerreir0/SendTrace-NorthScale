-- ═══════════════════════════════════════════════════════════════════════════
--  052 · Reembolsado de recorrência também sai de "Formulário" e "Formulário — não respondeu a tempo"
--
--  Continua a 051 (decisão do Lucas, 25/09/2026: "não precisamos atender alguém que já teve o reembolso feito").
--  A 051 só cobria Pendente / Pendente - Recorrência. Agora, cliente de recorrência com reembolso ou chargeback
--  também é levado a "Reembolsado" quando:
--    • o caso NASCE em Formulário (o n8n grava status='formulario' quando a IA manda o link do formulário);
--    • chega e-mail novo, o caso é reaberto ou transferido de board (mesmas regras da 051);
--    • o evento de reembolso/chargeback chega com o caso já parado em Formulário.
--  Arrastar o card na mão para Formulário NÃO é desfeito: o trigger só reavalia nesses eventos, não em toda
--  troca de status. Iniciado / Esperando resposta continuam intocados (já tem gente atendendo).
--  Idempotente (OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.recorrencia_mover_para_reembolsado(p_email text) RETURNS int
LANGUAGE sql AS $$
  WITH mov AS (
    UPDATE email_ia.suporte_escalado s
       SET status = 'reembolsado', iniciado_em = coalesce(s.iniciado_em, now()), atualizado_em = now()
     WHERE lower(s.remetente_email) = lower(btrim(p_email))
       AND s.status IN ('pendente', 'pendente_recorrencia', 'formulario', 'formulario_nao_respondeu_a_tempo')
       AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                   WHERE c.board_id = s.board_id AND c.chave = 'reembolsado')
    RETURNING 1)
  SELECT count(*)::int FROM mov
$$;

CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_recorrencia() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_alvo   text;
BEGIN
  IF NEW.status IN ('pendente', 'pendente_recorrencia', 'formulario', 'formulario_nao_respondeu_a_tempo')
     AND NEW.board_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status = 'finalizado'
          OR NEW.board_id IS DISTINCT FROM OLD.board_id
          OR NEW.email_id IS DISTINCT FROM OLD.email_id) THEN
    v_estado := email_ia.recorrencia_estado(NEW.remetente_email);
    IF NEW.status IN ('formulario', 'formulario_nao_respondeu_a_tempo') THEN
      -- Formulário só é desviado para Reembolsado; recorrência ativa continua no formulário.
      v_alvo := CASE WHEN v_estado = 'reembolsado' THEN 'reembolsado' ELSE NEW.status END;
    ELSE
      v_alvo := CASE v_estado WHEN 'reembolsado' THEN 'reembolsado'
                              WHEN 'recorrencia' THEN 'pendente_recorrencia'
                              ELSE 'pendente' END;
    END IF;
    IF v_alvo <> NEW.status AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                                        WHERE c.board_id = NEW.board_id AND c.chave = v_alvo) THEN
      NEW.status := v_alvo;
      IF v_alvo = 'reembolsado' THEN NEW.iniciado_em := coalesce(NEW.iniciado_em, now()); END IF;
    END IF;
  END IF;

  IF NEW.status = 'pendente_recorrencia'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'pendente_recorrencia')
     AND NOT EXISTS (SELECT 1 FROM public.recorrencia_clientes WHERE email = lower(btrim(NEW.remetente_email))) THEN
    INSERT INTO public.recorrencia_clientes (email, product_id, origem)
    VALUES (lower(btrim(NEW.remetente_email)), 'manual', 'manual')
    ON CONFLICT (email, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Casos que já estão parados em Formulário agora, de clientes com reembolso/chargeback.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT email FROM public.recorrencia_clientes
            WHERE situacao = 'cancelada' AND cancelada_motivo IN ('reembolso', 'chargeback') LOOP
    IF email_ia.recorrencia_estado(r.email) = 'reembolsado' THEN
      PERFORM email_ia.recorrencia_mover_para_reembolsado(r.email);
    END IF;
  END LOOP;
END $$;
