-- ═══════════════════════════════════════════════════════════════════════════
--  088 · SLA mais rápido: janelas de turno pré-calculadas (pedido do Lucas, 07/10/2026)
--
--  `minutos_em_turno` (073) refazia a união dos turnos a cada chamada, e a fila/painel da equipe a chamam por ticket (~1.000 vezes por tela).
--  Agora a união por board e dia da semana fica numa tabela pequena (`turno_janelas`), recalculada por gatilho quando os turnos ou as pessoas
--  dos turnos mudam; a função só soma a sobreposição dos dias com essas janelas. O RESULTADO É O MESMO da função antiga (mesma regra: seg–sex pelos
--  dias do turno, horário de Brasília, união dos turnos do board; board sem ninguém atribuído usa todos os turnos). Idempotente.
--  Voltar atrás: reexecutar a definição de `minutos_em_turno` da migração 073.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.turno_janelas (
  board_id bigint   NOT NULL,   -- 0 = todos os turnos (boards sem escala própria)
  isodow   smallint NOT NULL,   -- 1 = segunda … 7 = domingo
  ini      time     NOT NULL,
  fim      time     NOT NULL
);
CREATE INDEX IF NOT EXISTS turno_janelas_idx ON email_ia.turno_janelas (board_id, isodow);

CREATE OR REPLACE FUNCTION email_ia.recalcular_turno_janelas() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM email_ia.turno_janelas;
  INSERT INTO email_ia.turno_janelas (board_id, isodow, ini, fim)
  WITH base AS (
    SELECT a.board_id, d.dia::smallint AS isodow, t.inicio AS ini, t.fim AS fim
      FROM email_ia.suporte_escalado_turnos t
      JOIN email_ia.suporte_escalado_turno_agentes a ON a.turno_id = t.id
      CROSS JOIN LATERAL unnest(t.dias_semana) AS d(dia)
    UNION ALL
    SELECT 0, d.dia::smallint, t.inicio, t.fim
      FROM email_ia.suporte_escalado_turnos t
      CROSS JOIN LATERAL unnest(t.dias_semana) AS d(dia)
  ), ordenado AS (
    SELECT board_id, isodow, ini, fim,
           max(fim) OVER (PARTITION BY board_id, isodow ORDER BY ini, fim ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS fim_anterior
      FROM base
  ), ilhas AS (
    SELECT board_id, isodow, ini, fim,
           sum(CASE WHEN fim_anterior IS NULL OR ini > fim_anterior THEN 1 ELSE 0 END) OVER (PARTITION BY board_id, isodow ORDER BY ini, fim) AS grupo
      FROM ordenado
  )
  SELECT board_id, isodow, min(ini), max(fim) FROM ilhas GROUP BY board_id, isodow, grupo;
END $f$;

CREATE OR REPLACE FUNCTION email_ia.trg_recalcular_turno_janelas() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM email_ia.recalcular_turno_janelas();
  RETURN NULL;
END $f$;
DROP TRIGGER IF EXISTS trg_turnos_janelas ON email_ia.suporte_escalado_turnos;
CREATE TRIGGER trg_turnos_janelas AFTER INSERT OR UPDATE OR DELETE ON email_ia.suporte_escalado_turnos
  FOR EACH STATEMENT EXECUTE FUNCTION email_ia.trg_recalcular_turno_janelas();
DROP TRIGGER IF EXISTS trg_turno_agentes_janelas ON email_ia.suporte_escalado_turno_agentes;
CREATE TRIGGER trg_turno_agentes_janelas AFTER INSERT OR UPDATE OR DELETE ON email_ia.suporte_escalado_turno_agentes
  FOR EACH STATEMENT EXECUTE FUNCTION email_ia.trg_recalcular_turno_janelas();

SELECT email_ia.recalcular_turno_janelas();

-- Versão rápida (mesmo resultado da 073): soma a sobreposição de cada dia com as janelas já unidas do board.
-- Em plpgsql de propósito: o plano da consulta é reaproveitado entre as ~1.000 chamadas de uma tela (a versão SQL era replanejada a cada chamada).
CREATE OR REPLACE FUNCTION email_ia.minutos_em_turno(p_de timestamptz, p_ate timestamptz, p_board bigint DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  v_alvo  bigint;
  v_total numeric := 0;
  v_dia   date;
  v_ultimo date;
  j       record;
  v_ini   timestamptz;
  v_fim   timestamptz;
BEGIN
  IF p_ate IS NULL OR p_de IS NULL OR p_ate <= p_de THEN RETURN 0; END IF;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM email_ia.turno_janelas WHERE board_id = p_board) THEN p_board ELSE 0 END INTO v_alvo;
  v_dia := (p_de AT TIME ZONE 'America/Sao_Paulo')::date;
  v_ultimo := least((p_ate AT TIME ZONE 'America/Sao_Paulo')::date, v_dia + 90);
  WHILE v_dia <= v_ultimo LOOP
    FOR j IN SELECT ini, fim FROM email_ia.turno_janelas WHERE board_id = v_alvo AND isodow = extract(isodow FROM v_dia)::smallint LOOP
      v_ini := greatest((v_dia + j.ini) AT TIME ZONE 'America/Sao_Paulo', p_de);
      v_fim := least((v_dia + j.fim) AT TIME ZONE 'America/Sao_Paulo', p_ate);
      IF v_fim > v_ini THEN v_total := v_total + extract(epoch FROM (v_fim - v_ini)) / 60.0; END IF;
    END LOOP;
    v_dia := v_dia + 1;
  END LOOP;
  RETURN v_total;
END $f$;
