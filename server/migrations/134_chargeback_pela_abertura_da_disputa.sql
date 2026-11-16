-- ════════════════════════════════════════════════════════════════════════════
--  134 · Suporte Humano — chargeback contado pela ABERTURA da disputa; reversão indireta só sem estorno (pedido do Lucas, 16/11/2026)
--
--  Achado (#10274): a cliente abriu disputa na JVZoo em 16/09, escreveu em 24/09 e foi respondida em 20/10, mas `disparos_pos_venda.chargeback_em` diz 04/11
--  (data em que o chargeback foi lançado, não em que a disputa foi aberta). Com isso o indicador "Chargeback após 1º e-mail" dizia "Sim" e, antes de a data
--  chegar, a reversão indireta já tinha marcado o ticket. Em 930 dos 1.192 chargebacks DISPUTE da JVZoo a data gravada fica a mais de 2 dias da abertura.
--    · email_ia.chargeback_aberto_em(email): quando o cliente abriu o chargeback = dia da disputa do aviso exato da JVZoo (jvzoo_referencia.disputa_dia,
--      00h de São Paulo) ou, sem aviso, disparos_pos_venda.chargeback_em.
--    · email_ia.cliente_tem_estorno(email): chargeback em alguma venda, ou reembolso e nenhuma compra ativa. Reversão indireta é cliente que parou de responder
--      SEM reembolso nem chargeback: quem tem estorno sai da reversão (api/reversaoIndireta.js) e vai para "Reembolsado pela plataforma" (api/reembolsoPlataforma.js).
--    · atualizar_indicadores_gerenciais passa a usar chargeback_aberto_em.
--    · Correção única: o indicador de chargeback preenchido pelo SISTEMA é recalculado (o que a gestão digitou não é tocado). Cópia do antes em
--      email_ia.ficha_indicadores_bkp_134.
--  Idempotente. Desfazer: restaurar os campos a partir da cópia e recriar a função da 110.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION email_ia.chargeback_aberto_em(p_email text) RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT max(CASE WHEN j.disputa_dia IS NOT NULL THEN j.disputa_dia::timestamp AT TIME ZONE 'America/Sao_Paulo' ELSE d.chargeback_em END)
    FROM public.disparos_pos_venda d LEFT JOIN public.jvzoo_referencia j ON j.transacao_id = d.transacao_id
   WHERE lower(d.email) = lower(btrim(p_email)) AND d.chargeback_em IS NOT NULL
$f$;

CREATE OR REPLACE FUNCTION email_ia.cliente_tem_estorno(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT email_ia.chargeback_aberto_em(p_email) IS NOT NULL
      OR (EXISTS (SELECT 1 FROM public.disparos_pos_venda d WHERE lower(d.email) = lower(btrim(p_email)) AND d.reembolsado_em IS NOT NULL)
          AND NOT email_ia.cliente_tem_compra_ativa(p_email))
$f$;

CREATE OR REPLACE FUNCTION email_ia.atualizar_indicadores_gerenciais(p_simular boolean DEFAULT false)
RETURNS TABLE (reembolsos integer, chargebacks integer) LANGUAGE plpgsql AS $f$
DECLARE v_r integer; v_c integer;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _ind_ger (caso_id bigint PRIMARY KEY, reembolso_em date, chargeback_em date) ON COMMIT DROP;
  TRUNCATE _ind_ger;
  INSERT INTO _ind_ger
  WITH base AS (
    SELECT s.id AS caso_id, lower(s.remetente_email) AS email, coalesce(t.primeiro_email_em, s.criado_em) AS primeiro_em
      FROM email_ia.suporte_escalado s
      LEFT JOIN email_ia.tickets t ON lower(t.remetente_email) = lower(s.remetente_email)
     WHERE s.ticket_mae_id IS NULL AND s.criado_em > now() - interval '365 days'
  ), ev AS (
    SELECT b.caso_id, b.email, b.primeiro_em,
           (SELECT max(d.reembolsado_em) FROM public.disparos_pos_venda d WHERE lower(d.email) = b.email AND d.reembolsado_em IS NOT NULL) AS reembolso_em,
           email_ia.chargeback_aberto_em(b.email) AS chargeback_em
      FROM base b
  )
  SELECT e.caso_id,
         CASE WHEN e.reembolso_em > e.primeiro_em AND NOT email_ia.cliente_tem_compra_ativa(e.email) THEN e.reembolso_em::date END,
         CASE WHEN e.chargeback_em > e.primeiro_em THEN (e.chargeback_em AT TIME ZONE 'America/Sao_Paulo')::date END
    FROM ev e
   WHERE (e.reembolso_em > e.primeiro_em OR e.chargeback_em > e.primeiro_em);
  DELETE FROM _ind_ger WHERE reembolso_em IS NULL AND chargeback_em IS NULL;
  SELECT count(*) FILTER (WHERE i.reembolso_em IS NOT NULL
                            AND coalesce((SELECT f.reembolso_apos_1o_email FROM email_ia.suporte_escalado_ficha f WHERE f.suporte_escalado_id = i.caso_id), '') = ''),
         count(*) FILTER (WHERE i.chargeback_em IS NOT NULL
                            AND coalesce((SELECT f.chargeback_apos_1o_email FROM email_ia.suporte_escalado_ficha f WHERE f.suporte_escalado_id = i.caso_id), '') = '')
    INTO v_r, v_c FROM _ind_ger i;
  IF NOT p_simular THEN
    INSERT INTO email_ia.suporte_escalado_ficha (suporte_escalado_id, reembolso_apos_1o_email, data_reembolso_total, chargeback_apos_1o_email, data_chargeback,
                                                  indicadores_atualizado_por, indicadores_atualizado_em, atualizado_por)
    SELECT i.caso_id, CASE WHEN i.reembolso_em IS NOT NULL THEN 'Sim' END, i.reembolso_em, CASE WHEN i.chargeback_em IS NOT NULL THEN 'Sim' END, i.chargeback_em,
           'Sistema', now(), 'Sistema'
      FROM _ind_ger i
    ON CONFLICT (suporte_escalado_id) DO UPDATE SET
      reembolso_apos_1o_email  = coalesce(NULLIF(email_ia.suporte_escalado_ficha.reembolso_apos_1o_email, ''), EXCLUDED.reembolso_apos_1o_email),
      data_reembolso_total     = coalesce(email_ia.suporte_escalado_ficha.data_reembolso_total, EXCLUDED.data_reembolso_total),
      chargeback_apos_1o_email = coalesce(NULLIF(email_ia.suporte_escalado_ficha.chargeback_apos_1o_email, ''), EXCLUDED.chargeback_apos_1o_email),
      data_chargeback          = coalesce(email_ia.suporte_escalado_ficha.data_chargeback, EXCLUDED.data_chargeback),
      indicadores_atualizado_por = 'Sistema', indicadores_atualizado_em = now()
    WHERE (email_ia.suporte_escalado_ficha.reembolso_apos_1o_email IS NULL AND EXCLUDED.reembolso_apos_1o_email IS NOT NULL)
       OR (email_ia.suporte_escalado_ficha.chargeback_apos_1o_email IS NULL AND EXCLUDED.chargeback_apos_1o_email IS NOT NULL);
  END IF;
  RETURN QUERY SELECT coalesce(v_r, 0), coalesce(v_c, 0);
END $f$;

-- correção única do indicador de chargeback que o SISTEMA preencheu com a data do lançamento
CREATE TABLE IF NOT EXISTS email_ia.ficha_indicadores_bkp_134 (
  suporte_escalado_id bigint PRIMARY KEY, chargeback_apos_1o_email text, data_chargeback date, indicadores_atualizado_por text, copiado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TEMP TABLE _cb134 ON COMMIT DROP AS
  SELECT f.suporte_escalado_id AS caso_id, f.data_chargeback AS antes,
         CASE WHEN a.aberto > coalesce(t.primeiro_email_em, s.criado_em) THEN (a.aberto AT TIME ZONE 'America/Sao_Paulo')::date END AS depois
    FROM email_ia.suporte_escalado_ficha f
    JOIN email_ia.suporte_escalado s ON s.id = f.suporte_escalado_id
    LEFT JOIN email_ia.tickets t ON lower(t.remetente_email) = lower(s.remetente_email)
    CROSS JOIN LATERAL (SELECT email_ia.chargeback_aberto_em(s.remetente_email) AS aberto) a
   WHERE f.chargeback_apos_1o_email = 'Sim' AND coalesce(f.indicadores_atualizado_por, 'Sistema') = 'Sistema';
DELETE FROM _cb134 WHERE depois IS NOT DISTINCT FROM antes;
INSERT INTO email_ia.ficha_indicadores_bkp_134 (suporte_escalado_id, chargeback_apos_1o_email, data_chargeback, indicadores_atualizado_por)
  SELECT f.suporte_escalado_id, f.chargeback_apos_1o_email, f.data_chargeback, f.indicadores_atualizado_por
    FROM email_ia.suporte_escalado_ficha f JOIN _cb134 c ON c.caso_id = f.suporte_escalado_id
ON CONFLICT (suporte_escalado_id) DO NOTHING;
UPDATE email_ia.suporte_escalado_ficha f
   SET chargeback_apos_1o_email = CASE WHEN c.depois IS NOT NULL THEN 'Sim' END, data_chargeback = c.depois,
       indicadores_atualizado_por = 'Sistema', indicadores_atualizado_em = now()
  FROM _cb134 c WHERE c.caso_id = f.suporte_escalado_id;
