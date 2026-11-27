-- MONIT-SPPL — teste dos DIAS ÚTEIS com fim de semana e feriados dos EUA (spec, checklist de aceite item 3).
-- Roda dentro de BEGIN … ROLLBACK: não grava nada (os feriados de teste entram e saem na mesma transação). Cada ASSERT falho aborta com a mensagem do caso.
--   · direto no Postgres:  psql -v ON_ERROR_STOP=1 -f api/monit/diasUteis.teste.sql
--   · pelo node:           TESTE_BANCO=1 DATABASE_URL=… node --test api/monit/diasUteis.test.js   (o teste lê este mesmo arquivo)
-- `monit_dias_uteis(de, ate)` conta os dias úteis em (de, ate], segunda a sexta menos `sppl_feriados`, no fuso America/New_York — o mesmo calendário de
-- `sppl_somar_dias_uteis` (a regra "+2 dias úteis" das classes). Casos de 2026: sexta 20/11, Thanksgiving quinta 26/11, Natal sexta 25/12.
BEGIN;

CREATE FUNCTION pg_temp.du(a text, b text) RETURNS int LANGUAGE sql AS
  $f$ SELECT monit_dias_uteis(a::timestamp AT TIME ZONE 'America/New_York', b::timestamp AT TIME ZONE 'America/New_York') $f$;

DELETE FROM sppl_feriados WHERE data IN ('2026-11-26', '2026-12-25');   -- (desfeito pelo ROLLBACK) parte de um calendário sem esses dois dias

DO $t$
BEGIN
  -- fim de semana
  ASSERT pg_temp.du('2026-11-20 12:00', '2026-11-23 12:00') = 1, 'sexta → segunda = 1 dia útil';
  ASSERT pg_temp.du('2026-11-20 12:00', '2026-11-22 12:00') = 0, 'sexta → domingo = 0';
  ASSERT pg_temp.du('2026-11-21 12:00', '2026-11-22 12:00') = 0, 'sábado → domingo = 0';
  ASSERT pg_temp.du('2026-11-20 23:30', '2026-11-23 00:30') = 1, 'sexta à noite → segunda de madrugada = 1 (conta pela data de Nova York)';
  ASSERT pg_temp.du('2026-11-23 12:00', '2026-11-23 18:00') = 0, 'mesmo dia = 0';
  ASSERT pg_temp.du(NULL, '2026-11-23 12:00') IS NULL, 'sem data = NULL';
  -- sem feriado cadastrado, a semana do Thanksgiving tem 4 dias úteis (ter, qua, qui, sex)
  ASSERT pg_temp.du('2026-11-23 12:00', '2026-11-27 12:00') = 4, 'sem feriado: segunda → sexta = 4';
  ASSERT pg_temp.du('2026-12-23 12:00', '2026-12-28 12:00') = 3, 'sem feriado: quarta → segunda do Natal = 3 (qui, sex, seg)';
  ASSERT sppl_somar_dias_uteis('2026-11-24 12:00'::timestamp AT TIME ZONE 'America/New_York', 2) = '2026-11-26 12:00'::timestamp AT TIME ZONE 'America/New_York', 'sem feriado: ter 24 + 2 úteis = qui 26';
END $t$;

INSERT INTO sppl_feriados (data, descricao) VALUES ('2026-11-26', 'Thanksgiving'), ('2026-12-25', 'Christmas');

DO $t$
BEGIN
  -- com feriado
  ASSERT pg_temp.du('2026-11-23 12:00', '2026-11-27 12:00') = 3, 'Thanksgiving: segunda → sexta = 3 (qui 26 não conta)';
  ASSERT pg_temp.du('2026-11-25 12:00', '2026-11-26 12:00') = 0, 'véspera → Thanksgiving = 0';
  ASSERT monit_dias_uteis('2026-11-25 12:00'::timestamp AT TIME ZONE 'America/New_York', '2026-11-27 02:00+00'::timestamptz) = 0,'data de NY (qui 26 à noite = sex 27 02:00 UTC) cai no feriado = 0';
  ASSERT pg_temp.du('2026-11-25 12:00', '2026-11-27 12:00') = 1, 'qua → sexta com Thanksgiving no meio = 1';
  ASSERT pg_temp.du('2026-12-23 12:00', '2026-12-28 12:00') = 2, 'Natal (sex 25): quarta → segunda = 2 (qui 24 e seg 28)';
  ASSERT pg_temp.du('2026-12-24 12:00', '2026-12-25 12:00') = 0, 'véspera → Natal = 0';
  ASSERT pg_temp.du('2026-12-25 12:00', '2026-12-28 12:00') = 1, 'Natal → segunda = 1';
  -- a mesma regra da soma (+2 dias úteis) pula o feriado e concorda com a contagem
  ASSERT sppl_somar_dias_uteis('2026-11-24 12:00'::timestamp AT TIME ZONE 'America/New_York', 2) = '2026-11-27 12:00'::timestamp AT TIME ZONE 'America/New_York', 'ter 24 + 2 úteis pula o Thanksgiving = sex 27';
  ASSERT pg_temp.du('2026-11-24 12:00', '2026-11-27 12:00') = 2, 'a contagem concorda com a soma: ter 24 → sex 27 = 2';
  RAISE NOTICE 'dias úteis: todos os casos de fim de semana e feriado passaram';
END $t$;

ROLLBACK;
