-- ════════════════════════════════════════════════════════════════════════════
--  135 · Suporte Humano — o estorno também vem do dash e vale mesmo parcial (pedido da Késsia/Lucas, 17/11/2026)
--
--  Achado (planilha "IA SENDTRACE", 203 tickets com reembolso e tipo de resolução que não acompanhou): os 203 têm o reembolso no dash (dash_pedidos), mas
--  só 130 aparecem em disparos_pos_venda (upsell/downsell muitas vezes não está lá), e a regra da 134 só via "reembolso" quando o cliente não tinha mais
--  nenhuma compra ativa (#10135: 2 upsells reembolsados, front aprovado = ficava em reversão indireta).
--    · email_ia.reembolso_em(email): último reembolso do cliente em disparos_pos_venda OU no dash (status REFUNDED sem data usa a última atualização do dash).
--    · email_ia.chargeback_aberto_em(email): passa a olhar também os chargebacks do dash (mesma preferência pelo dia da disputa da JVZoo).
--    · email_ia.cliente_tem_estorno(email): qualquer reembolso (total ou parcial) ou chargeback. Só serve à CLASSIFICAÇÃO do ticket (tipo de resolução):
--      a regra da 105 (cliente com compra ativa não vai para a coluna Reembolsado) continua valendo, ela usa email_ia.cliente_tem_compra_ativa.
--  Idempotente. Desfazer: recriar chargeback_aberto_em e cliente_tem_estorno da 134 e DROP FUNCTION email_ia.reembolso_em(text).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION email_ia.reembolso_em(p_email text) RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT max(x.em) FROM (
    SELECT d.reembolsado_em AS em FROM public.disparos_pos_venda d
     WHERE lower(d.email) = lower(btrim(p_email)) AND d.reembolsado_em IS NOT NULL
    UNION ALL
    SELECT coalesce(p.refunded_at, p.updated_at_dash) FROM public.dash_pedidos p
     WHERE lower(p.customer_email) = lower(btrim(p_email)) AND (p.refunded_at IS NOT NULL OR upper(coalesce(p.status, '')) = 'REFUNDED')
  ) x
$f$;

CREATE OR REPLACE FUNCTION email_ia.chargeback_aberto_em(p_email text) RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT max(x.em) FROM (
    SELECT CASE WHEN j.disputa_dia IS NOT NULL THEN j.disputa_dia::timestamp AT TIME ZONE 'America/Sao_Paulo' ELSE d.chargeback_em END AS em
      FROM public.disparos_pos_venda d LEFT JOIN public.jvzoo_referencia j ON j.transacao_id = d.transacao_id
     WHERE lower(d.email) = lower(btrim(p_email)) AND d.chargeback_em IS NOT NULL
    UNION ALL   -- venda que só o dash conhece (upsell/downsell fora dos disparos)
    SELECT CASE WHEN j.disputa_dia IS NOT NULL THEN j.disputa_dia::timestamp AT TIME ZONE 'America/Sao_Paulo' ELSE coalesce(p.chargeback_at, p.updated_at_dash) END
      FROM public.dash_pedidos p LEFT JOIN public.jvzoo_referencia j ON j.transacao_id = p.external_id
     WHERE lower(p.customer_email) = lower(btrim(p_email)) AND (p.chargeback_at IS NOT NULL OR upper(coalesce(p.status, '')) = 'CHARGEBACK')
       AND NOT EXISTS (SELECT 1 FROM public.disparos_pos_venda d WHERE d.transacao_id = p.external_id AND d.chargeback_em IS NOT NULL)
  ) x
$f$;

CREATE OR REPLACE FUNCTION email_ia.cliente_tem_estorno(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT email_ia.chargeback_aberto_em(p_email) IS NOT NULL OR email_ia.reembolso_em(p_email) IS NOT NULL
$f$;
