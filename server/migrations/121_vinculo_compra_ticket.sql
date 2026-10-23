-- ═══════════════════════════════════════════════════════════════════════════
--  121 · Suporte Escalado — vincular a COMPRA certa ao ticket (pedido do Lucas, 23/10/2026)
--
--  O ticket nasce do e-mail que o lead mandou; às vezes é OUTRO e-mail que o usado na compra (esposa escreve pelo marido, e-mail novo, etc.) e o card
--  fica sem pedido. O agente, ao descobrir o e-mail ou o nº do pedido da compra, vincula na hora; o card passa a puxar as compras desse e-mail.
--
--  Colunas em suporte_escalado (NULL = sem vínculo; tudo continua valendo pelo remetente):
--      email_compra            e-mail da compra (minúsculo), resolvido a partir do e-mail ou do nº do pedido digitado
--      compra_vinculada_por    quem vinculou (e-mail do agente)
--      compra_vinculada_em     quando
--      compra_vinculada_busca  o que o agente digitou (e-mail, nº do pedido ou código de rastreio), para auditoria
--  `email_ia.email_da_compra(caso)` = coalesce(email_compra, remetente_email): o e-mail a usar para tudo que busca pedido do cliente.
--  Aditiva e idempotente. Desfazer: UPDATE email_ia.suporte_escalado SET email_compra = NULL, compra_vinculada_por = NULL, compra_vinculada_em = NULL, compra_vinculada_busca = NULL;
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS email_compra text;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS compra_vinculada_por text;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS compra_vinculada_em timestamptz;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS compra_vinculada_busca text;

COMMENT ON COLUMN email_ia.suporte_escalado.email_compra IS 'E-mail da compra vinculado pelo agente quando difere do remetente do ticket (121). NULL = vale o remetente.';
COMMENT ON COLUMN email_ia.suporte_escalado.compra_vinculada_por IS 'Quem vinculou a compra (121).';
COMMENT ON COLUMN email_ia.suporte_escalado.compra_vinculada_em IS 'Quando a compra foi vinculada (121).';
COMMENT ON COLUMN email_ia.suporte_escalado.compra_vinculada_busca IS 'O que o agente digitou para vincular: e-mail, nº do pedido ou código de rastreio (121).';

CREATE INDEX IF NOT EXISTS suporte_escalado_email_compra_idx ON email_ia.suporte_escalado (lower(email_compra)) WHERE email_compra IS NOT NULL;

CREATE OR REPLACE FUNCTION email_ia.email_da_compra(p_caso bigint) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(lower(btrim(s.email_compra)), ''), lower(btrim(s.remetente_email))) FROM email_ia.suporte_escalado s WHERE s.id = p_caso
$f$;
COMMENT ON FUNCTION email_ia.email_da_compra(bigint) IS 'E-mail a usar para buscar as compras do ticket: o vinculado pelo agente (121) ou, sem vínculo, o remetente.';

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
