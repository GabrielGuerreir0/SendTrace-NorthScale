-- ═══════════════════════════════════════════════════════════════════════════
--  081 · "Contato de agente" no fluxo dos 30 dias = resposta de agente na pasta Enviados (não `iniciado_em`) (ajuste da 080, 06/10/2026)
--
--  `iniciado_em` é gravado quando QUALQUER movimentação tira o card de Pendente (inclusive as feitas pela automação para "Formulário"), então não prova que um agente falou com
--  o cliente. O critério certo é ter resposta enviada pelo support@ (`primeira_resposta_agente_em` / `respostas_agente`). Só redefine duas funções. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.pos30_estacionar(p_email text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  UPDATE email_ia.suporte_escalado s SET status = 'pos30_aguardando', atualizado_em = now()
   WHERE lower(s.remetente_email) = lower(p_email) AND s.status IN ('pendente', 'formulario') AND s.origem IS DISTINCT FROM 'pos_forms_30d'
     AND s.primeira_resposta_agente_em IS NULL
     AND NOT EXISTS (SELECT 1 FROM email_ia.respostas_agente r WHERE lower(r.para_email) = lower(s.remetente_email))
  RETURNING s.id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
    VALUES (v_id, 'Sistema', 'Pós-forms (automático): nenhum agente falou com este cliente; o e-mail dos 30 dias foi enviado e o card saiu de todas as colunas. Ele volta para o suporte (Thalison, Klebson ou Ramon) quando o cliente responder.');
  END IF;
  RETURN v_id IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION email_ia.pos30_finalizar_nao_respondeu(p_aplicar boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF NOT p_aplicar THEN
    SELECT count(*) INTO n FROM email_ia.suporte_escalado s
     WHERE s.status = 'formulario_nao_respondeu_a_tempo' AND s.primeira_resposta_agente_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM email_ia.respostas_agente r WHERE lower(r.para_email) = lower(s.remetente_email));
    RETURN n;
  END IF;
  WITH f AS (
    UPDATE email_ia.suporte_escalado s SET status = 'finalizado', finalizado_em = coalesce(s.finalizado_em, now()), atualizado_em = now()
     WHERE s.status = 'formulario_nao_respondeu_a_tempo' AND s.primeira_resposta_agente_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM email_ia.respostas_agente r WHERE lower(r.para_email) = lower(s.remetente_email))
    RETURNING s.id)
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
  SELECT id, 'Sistema', 'Finalizado automaticamente: o cliente não respondeu o formulário a tempo e nenhum agente falou com ele. Se voltar a escrever, o card reabre sozinho.' FROM f;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
