-- ═══════════════════════════════════════════════════════════════════════════
--  110 · Suporte Humano — 5º momento, item 7: dois indicadores gerenciais em Propriedades (pedido da Késsia, 19/10/2026)
--
--  Campos (junto à Comissão, só a gestão edita): Reembolso após 1º e-mail (Sim/Não) · Data do reembolso total · Chargeback após 1º e-mail (Sim/Não) · Data do chargeback.
--  Preenchimento AUTOMÁTICO (`atualizar_indicadores_gerenciais`, roda a cada 30 min no servidor e vale para tickets criados nos últimos 365 dias):
--    · Reembolso total após o 1º e-mail = o cliente tem pedido reembolsado DEPOIS do 1º e-mail dele para nós e já não tem nenhuma compra ativa
--      (reembolso parcial — só um upsell, por exemplo — NÃO conta). Data = a do reembolso.
--    · Chargeback após o 1º e-mail = pedido do cliente virou chargeback DEPOIS do 1º e-mail. Data = a do chargeback.
--    Só PREENCHE campo vazio (nunca sobrescreve o que a gestão digitou). Sem evento, o campo fica em branco — as telas e o CSV leem em branco como "Não".
--  Histórico de quem mudou e quando: eventos do bloco 'indicadores' em suporte_escalado_eventos. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS reembolso_apos_1o_email text;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS data_reembolso_total date;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS chargeback_apos_1o_email text;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS data_chargeback date;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS indicadores_atualizado_por text;
ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS indicadores_atualizado_em timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_escalado_ficha_indicadores_valores') THEN
    ALTER TABLE email_ia.suporte_escalado_ficha ADD CONSTRAINT suporte_escalado_ficha_indicadores_valores
      CHECK ((reembolso_apos_1o_email IS NULL OR reembolso_apos_1o_email IN ('Sim', 'Não')) AND (chargeback_apos_1o_email IS NULL OR chargeback_apos_1o_email IN ('Sim', 'Não')));
  END IF;
END $$;

-- O gatilho dos eventos passa a olhar também estes campos (ator = indicadores_atualizado_por). Reescreve a função ao vivo, sem copiar o corpo.
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('email_ia.trg_ficha_eventos'::regproc);
  IF position('(''indicadores'', ''reembolso_apos_1o_email'')' IN v_def) = 0 THEN
    IF position('(''comissao'', ''comissao'')' IN v_def) = 0 THEN
      RAISE EXCEPTION 'trg_ficha_eventos mudou: não achei o ponto de inserção dos indicadores.';
    END IF;
    v_def := replace(v_def, '(''comissao'', ''comissao'')',
      '(''comissao'', ''comissao''), (''indicadores'', ''reembolso_apos_1o_email''), (''indicadores'', ''data_reembolso_total''), (''indicadores'', ''chargeback_apos_1o_email''), (''indicadores'', ''data_chargeback'')');
    EXECUTE v_def;
  END IF;
END $$;

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
           (SELECT max(d.chargeback_em)  FROM public.disparos_pos_venda d WHERE lower(d.email) = b.email AND d.chargeback_em  IS NOT NULL) AS chargeback_em
      FROM base b
  )
  SELECT e.caso_id,
         CASE WHEN e.reembolso_em > e.primeiro_em AND NOT email_ia.cliente_tem_compra_ativa(e.email) THEN e.reembolso_em::date END,
         CASE WHEN e.chargeback_em > e.primeiro_em THEN e.chargeback_em::date END
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
