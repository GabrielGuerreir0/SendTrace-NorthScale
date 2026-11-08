-- ═══════════════════════════════════════════════════════════════════════════
--  127 · Rastreio: origem também para a JetStream + reembolso/chargeback na view da tela (pedido do Lucas, 07/11/2026)
--
--  1) `atualizar_rastreio_fullstack_origem()` (124) só olhava rastreios da FullStack. Em 07/11, 543 rastreios `WP-…` da JetStream ficavam
--     "sem plataforma" mesmo tendo referência da JVZoo (`jvzoo_referencia.paykey`), e 501 deles são upsell/downsell
--     (`compras_upsell_downsell` já tem plataforma, produto e nome). O caminho 1 (e os demais) passa a valer para FullStack E JetStream.
--     O resto da função é idêntico ao da 124.
--  2) A view `rastreio_pedido_d` ganha, NO FIM, `reembolsado_em` e `chargeback_em` (só do pedido de front; origem = NULL). A API de Rastreio
--     usa isso para tirar reembolsado/chargeback da conta do card "Não encontrado" (colunas novas só no fim: CREATE OR REPLACE VIEW permite).
--
--  Depois do deploy:  SET statement_timeout = 0; SELECT public.atualizar_rastreio_fullstack_origem();
--  Aditiva e idempotente. Desfazer: reaplicar o corpo da função da 124 e a view sem as 2 colunas finais (DROP VIEW + CREATE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.atualizar_rastreio_fullstack_origem() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  -- rastreios (FullStack e JetStream) que a tela deixa sem pedido de front
  CREATE TEMP TABLE _s ON COMMIT DROP AS
    SELECT r.transacao_id AS id, r.order_created_at
    FROM public.rastreio_pedidos r
    WHERE r.provedor IN ('fullstack', 'jetstream')
      AND NOT EXISTS (SELECT 1 FROM public.disparos_pos_venda d WHERE d.transacao_id = r.transacao_id);
  CREATE INDEX ON _s (id);
  ANALYZE _s;

  DELETE FROM public.rastreio_fullstack_origem;

  -- 1) JVZoo: o ID do rastreio é o paykey "WP-…"/"PT-…"
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, nome, pedido_ref, criado_em)
  SELECT s.id, 'jvzoo_referencia.paykey', 'jvzoo', coalesce(d.produto, u.produto), coalesce(d.nome, u.nome), j.transacao_id,
         coalesce(d.criado_em, u.criado_em, s.order_created_at)
  FROM _s s JOIN public.jvzoo_referencia j ON j.paykey = s.id
  LEFT JOIN LATERAL (SELECT produto, nome, criado_em FROM public.disparos_pos_venda WHERE transacao_id = j.transacao_id LIMIT 1) d ON true
  LEFT JOIN LATERAL (SELECT produto, nome, criado_em FROM public.compras_upsell_downsell WHERE transacao_id = j.transacao_id LIMIT 1) u ON true
  ON CONFLICT (transacao_id) DO NOTHING;

  -- 2) o id_rastreio que o front guarda
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, nome, pedido_ref, criado_em)
  SELECT s.id, 'disparos.id_rastreio', d.plataforma, d.produto, d.nome, d.transacao_id, coalesce(d.criado_em, s.order_created_at)
  FROM _s s JOIN public.disparos_pos_venda d ON d.id_rastreio = s.id
  ON CONFLICT (transacao_id) DO NOTHING;

  -- 3) BuyGoods/Digistore24: o ID do rastreio é o parent_external_id do pedido no dash (pedido + upsell juntos)
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, pedido_ref, valor, moeda, potes, criado_em)
  SELECT s.id, 'dash.parent_external_id', x.plataforma,
         (array_agg(x.product_name ORDER BY x.funnel_step NULLS LAST, x.ordered_at))[1],
         min(x.external_id), sum(x.gross), min(x.currency), sum(x.bottles)::int, coalesce(min(x.ordered_at), s.order_created_at)
  FROM _s s JOIN public.dash_pedidos x ON x.parent_external_id = s.id
  GROUP BY s.id, s.order_created_at, x.plataforma
  ON CONFLICT (transacao_id) DO NOTHING;

  -- 4) o ID do rastreio é o próprio external_id do dash
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, pedido_ref, valor, moeda, potes, criado_em)
  SELECT s.id, 'dash.external_id', x.plataforma, x.product_name, x.external_id, x.gross, x.currency, x.bottles, coalesce(x.ordered_at, s.order_created_at)
  FROM _s s JOIN public.dash_pedidos x ON x.external_id = s.id
  ON CONFLICT (transacao_id) DO NOTHING;

  -- 5) Vupim: o UUID começa pelo horário; o produto/pedido/valor só entram se o prefixo apontar para UM pedido
  CREATE TEMP TABLE _vp ON COMMIT DROP AS
    SELECT upper(left(external_id, 8)) AS k, count(*) AS pedidos,
           CASE WHEN count(*) = 1 THEN min(external_id) END AS ext,
           CASE WHEN count(DISTINCT product_name) = 1 THEN min(product_name) END AS prod,
           CASE WHEN count(*) = 1 THEN max(gross) END AS valor,
           CASE WHEN count(*) = 1 THEN min(currency) END AS moeda,
           CASE WHEN count(*) = 1 THEN max(bottles) END AS potes,
           min(ordered_at) AS data_pedido
    FROM public.dash_pedidos WHERE plataforma = 'vupim' GROUP BY 1;
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, pedido_ref, valor, moeda, potes, criado_em)
  SELECT s.id, 'vupim prefixo 8 do UUID', 'vupim', v.prod, v.ext, v.valor, v.moeda, v.potes, coalesce(v.data_pedido, s.order_created_at)
  FROM _s s JOIN _vp v ON v.k = upper(split_part(s.id, '-', 1))
  ON CONFLICT (transacao_id) DO NOTHING;

  -- mesmo texto de plataforma que disparos_pos_venda usa (o filtro da tela compara o texto exato)
  UPDATE public.rastreio_fullstack_origem
     SET plataforma = CASE lower(plataforma) WHEN 'jvzoo' THEN 'JVZoo' WHEN 'buygoods' THEN 'BuyGoods'
                                             WHEN 'digistore24' THEN 'DigiStore24' WHEN 'vupim' THEN 'Vupim'
                                             WHEN 'clickbank' THEN 'ClickBank' ELSE plataforma END;
  UPDATE public.rastreio_fullstack_origem SET gerado_em = now();

  SELECT count(*) INTO n FROM public.rastreio_fullstack_origem;
  RETURN n;
END
$fn$;
COMMENT ON FUNCTION public.atualizar_rastreio_fullstack_origem() IS 'Refaz rastreio_fullstack_origem (124; 127 inclui JetStream). Chamar com SET statement_timeout = 0 na sessão.';

CREATE OR REPLACE VIEW public.rastreio_pedido_d AS
SELECT d.transacao_id, d.nome, d.email, d.produto, d.plataforma, d.criado_em,
       NULL::numeric AS valor_origem, NULL::text AS moeda_origem,
       d.reembolsado_em, d.chargeback_em
FROM public.disparos_pos_venda d
UNION ALL
SELECT o.transacao_id, o.nome, NULL::text, o.produto, o.plataforma, o.criado_em, o.valor, o.moeda,
       NULL::timestamptz, NULL::timestamptz
FROM public.rastreio_fullstack_origem o
WHERE NOT EXISTS (SELECT 1 FROM public.disparos_pos_venda d WHERE d.transacao_id = o.transacao_id);

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
