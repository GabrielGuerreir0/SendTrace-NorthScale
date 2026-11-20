-- ═════════════════════════════════════════════════════════════════
--  136 · Rastreio — upsell/downsell em envio conjunto aponta para o pedido principal (pedido da Késsia, 20/11/2026)
--
--  Por quê: o upsell/downsell vai na mesma caixa do front, então a fulfillment não tem pedido próprio e a linha dele fica "nao_encontrado" (sem código).
--  Para a IA do suporte responder "cadê meu pedido" todo pedido precisa chegar ao código de rastreio. NÃO se copia o código para a linha do upsell:
--  o e-mail/SMS do código (rastreio_email_codigo), o 17TRACK, o SPPL e as contagens do Atlas contariam duas vezes.
--    · rastreio_pedidos.rastreio_principal_id: transacao_id do pedido principal (enviado/entregue, mesmo e-mail, ±3 dias). Só vale enquanto a linha
--      estiver em nao_encontrado; se a fulfillment passar a ter pedido próprio, o campo é ignorado.
--    · public.rastreio_resolver(tid): devolve o transacao_id cujo rastreio vale para o pedido (o principal, ou ele mesmo). As leituras de rastreio
--      voltadas ao cliente/IA fazem JOIN por esta função.
--  O preenchimento é feito por /root/rastreio_busca/atrelar_principal.py (cron horário), com backup.
--  Idempotente. Desfazer: UPDATE rastreio_pedidos SET rastreio_principal_id = NULL; DROP FUNCTION public.rastreio_resolver(text);
-- ═════════════════════════════════════════════════════════════════
ALTER TABLE public.rastreio_pedidos ADD COLUMN IF NOT EXISTS rastreio_principal_id text;
CREATE INDEX IF NOT EXISTS rastreio_pedidos_principal_idx ON public.rastreio_pedidos (rastreio_principal_id) WHERE rastreio_principal_id IS NOT NULL;
COMMENT ON COLUMN public.rastreio_pedidos.rastreio_principal_id IS 'Envio conjunto: transacao_id do pedido principal cujo rastreio vale para este (só enquanto status_interno = nao_encontrado).';

CREATE OR REPLACE FUNCTION public.rastreio_resolver(p_tid text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(
    (SELECT r.rastreio_principal_id FROM public.rastreio_pedidos r
      WHERE r.transacao_id = p_tid AND r.status_interno = 'nao_encontrado' AND r.rastreio_principal_id IS NOT NULL),
    p_tid)
$f$;
