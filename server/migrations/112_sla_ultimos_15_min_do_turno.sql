-- ═══════════════════════════════════════════════════════════════════════════
--  112 · Suporte Humano — 5º momento, item 4: SLA dos tickets que chegam nos últimos 15 minutos do turno (Késsia, 19/10/2026)
--
--  Regra da Késsia: ticket que chega nos 15 minutos finais do turno do agente continua contando NORMALMENTE (minutos corridos) e vence naquele mesmo dia,
--  em vez de ficar parado até o próximo turno. Ticket que chega DEPOIS do turno continua como antes: a contagem começa no próximo turno, só com as horas de turno.
--    · `minutos_sla(de, ate, board)`: se `de` cai entre (fim do turno − 15 min) e o fim do turno, conta os minutos corridos até o fim daquele dia (meia-noite de
--      Brasília) e, se ainda não venceu, segue contando só dentro dos turnos dos dias seguintes; nos demais casos é exatamente `minutos_em_turno`.
--    · As views `v_sla_suporte_escalado` (fila, painel, "Restam…") e `v_sla_respostas_agente` (tempo médio de resposta por agente) passam a usar `minutos_sla`
--      (reescritas ao vivo, trocando só o nome da função). `minutos_pausados` (Pendente) segue igual.
--  Vale para a 1ª resposta (a partir da chegada do ticket) e para a 2ª em diante (a partir do e-mail do cliente). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.minutos_sla(p_de timestamptz, p_ate timestamptz, p_board bigint DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  v_alvo bigint; v_dia date; j record; v_fim_dia timestamptz;
BEGIN
  IF p_ate IS NULL OR p_de IS NULL OR p_ate <= p_de THEN RETURN 0; END IF;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM email_ia.turno_janelas WHERE board_id = p_board) THEN p_board ELSE 0 END INTO v_alvo;
  v_dia := (p_de AT TIME ZONE 'America/Sao_Paulo')::date;
  FOR j IN SELECT ini, fim FROM email_ia.turno_janelas WHERE board_id = v_alvo AND isodow = extract(isodow FROM v_dia)::smallint LOOP
    IF p_de >= ((v_dia + j.fim) - interval '15 minutes') AT TIME ZONE 'America/Sao_Paulo'
       AND p_de < (v_dia + j.fim) AT TIME ZONE 'America/Sao_Paulo' THEN
      v_fim_dia := ((v_dia + 1)::timestamp) AT TIME ZONE 'America/Sao_Paulo';
      RETURN extract(epoch FROM (least(p_ate, v_fim_dia) - p_de)) / 60.0
             + CASE WHEN p_ate > v_fim_dia THEN email_ia.minutos_em_turno(v_fim_dia, p_ate, p_board) ELSE 0 END;
    END IF;
  END LOOP;
  RETURN email_ia.minutos_em_turno(p_de, p_ate, p_board);
END $f$;
COMMENT ON FUNCTION email_ia.minutos_sla(timestamptz, timestamptz, bigint) IS 'Minutos de SLA: igual a minutos_em_turno, exceto quando o ticket chega nos 15 min finais do turno — aí conta em minutos corridos até o fim do dia (112).';

DO $$
DECLARE v text; v_def text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_sla_suporte_escalado', 'v_sla_respostas_agente'] LOOP
    v_def := pg_get_viewdef(('email_ia.' || v)::regclass, true);
    IF position('email_ia.minutos_em_turno(' IN v_def) > 0 THEN
      EXECUTE 'CREATE OR REPLACE VIEW email_ia.' || v || ' AS ' || replace(v_def, 'email_ia.minutos_em_turno(', 'email_ia.minutos_sla(');
    ELSIF position('email_ia.minutos_sla(' IN v_def) = 0 THEN
      RAISE EXCEPTION 'view % não usa minutos_em_turno nem minutos_sla: não sei o que trocar.', v;
    END IF;
  END LOOP;
END $$;
