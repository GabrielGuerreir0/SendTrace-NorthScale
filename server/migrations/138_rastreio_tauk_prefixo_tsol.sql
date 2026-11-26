-- ═══════════════════════════════════════════════════════════════════════════
--  138 · Rastreio: pedidos "Tsol…" da FullStack são da Tauk (pedido do Lucas, 26/11/2026)
--
--  A Tauk (call center) repassa o pedido à FullStack trocando o "KN-" por "Tsol" e mantendo os 10 caracteres depois do prefixo. Em 26/11 eram 783
--  rastreios "Tsol…" sem origem (696 de novembro). Esta migração:
--    1) cria public.tauk_vendas: só o que liga o rastreio à venda (KN-…, valor, reembolso, status, produto, data). SEM nome, e-mail, telefone nem endereço.
--       Quem preenche: /root/tauk_vendas/tauk_vendas.py (API da Tauk, GET /client/sales), de hora em hora.
--    2) acrescenta à `atualizar_rastreio_fullstack_origem()` o caminho 7: prefixo Tsol -> plataforma 'Tauk', pedido de origem 'KN-…', e produto/valor/reembolso
--       quando a venda está em tauk_vendas.
--  A função abaixo é a versão que estava VIVA em produção (inclui o caminho 6, Logicall, aplicado fora do repositório em 13/11) mais o caminho 7.
--  Não roda a função aqui. Depois do deploy:  SET statement_timeout = 0; SELECT public.atualizar_rastreio_fullstack_origem();
--  Desfazer: DROP TABLE public.tauk_vendas (depois de reaplicar a função sem o bloco 7).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tauk_vendas (
  chave             text PRIMARY KEY,          -- os 10 caracteres hex do order_id da Tauk, em maiúsculas ("KN-532D1E1B3F" -> "532D1E1B3F")
  order_id          text NOT NULL,             -- order_id da Tauk (KN-…)
  tauk_id           bigint,                    -- id da venda na API da Tauk (para buscar o detalhe)
  valor             numeric,
  valor_reembolsado numeric,
  moeda             text,
  status            text,                      -- external_status da Tauk (COMPLETE…)
  tipo_pedido       text,
  produto           text,                      -- nomes dos itens sem o "(1234) " do começo, separados por " + "
  criado_em         timestamptz,
  reembolsado_em    timestamptz,               -- 1ª vez que a carga viu reembolso > 0
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tauk_vendas_criado ON public.tauk_vendas (criado_em DESC);
COMMENT ON TABLE public.tauk_vendas IS 'Vendas da Tauk (call center) ligadas ao rastreio da FullStack (138). Sem dado de cliente. Carga: /root/tauk_vendas/tauk_vendas.py.';

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;

CREATE OR REPLACE FUNCTION public.atualizar_rastreio_fullstack_origem()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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

  -- 6) Logicall (13/11/2026): o call center manda o clientOrderId (10 hex) como referenceNum; reenvio = clientOrderId + 'R' + número.
  --    Vendas e reembolsos vêm de public.logicall_vendas (carga /root/logicall_vendas/logicall_vendas.py).
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, pedido_ref, valor, moeda, criado_em, reembolsado_em)
  SELECT s.id, CASE WHEN s.id ~* '^[0-9a-f]{10}R[0-9]+$' THEN 'logicall clientOrderId (reenvio)' ELSE 'logicall clientOrderId' END,
         'Logicall', v.produto, v.client_order_id, v.valor, v.moeda, coalesce(v.criado_em, s.order_created_at), v.reembolsado_em
  FROM _s s JOIN public.logicall_vendas v ON v.chave = upper(substring(s.id from '^([0-9A-Fa-f]{10})(R[0-9]+)?$'))
  ON CONFLICT (transacao_id) DO NOTHING;

  -- 7) Tauk (26/11/2026, confirmado pelo Lucas): a Tauk (call center) manda o pedido para a FullStack trocando o "KN-" por "Tsol" e mantendo os 10 caracteres
  --    (KN-2D3002886D -> Tsol2D3002886D); reenvio = Tsol + 10 caracteres + 'R' + número. A venda vem de public.tauk_vendas (carga /root/tauk_vendas/tauk_vendas.py,
  --    API GET /client/sales). Sem a venda na tabela ainda, o rastreio já ganha a plataforma e o pedido de origem.
  INSERT INTO public.rastreio_fullstack_origem (transacao_id, caminho, plataforma, produto, pedido_ref, valor, moeda, criado_em, reembolsado_em)
  SELECT s.id, CASE WHEN s.id ~* '^Tsol[0-9a-f]{10}R[0-9]+$' THEN 'tauk prefixo Tsol (reenvio)' ELSE 'tauk prefixo Tsol' END, 'Tauk',
         v.produto, 'KN-' || upper(substring(s.id from '^Tsol([0-9A-Fa-f]{10})')), v.valor, coalesce(v.moeda, 'USD'), coalesce(v.criado_em, s.order_created_at),
         CASE WHEN coalesce(v.valor_reembolsado, 0) > 0 THEN coalesce(v.reembolsado_em, v.atualizado_em) END
  FROM _s s LEFT JOIN public.tauk_vendas v ON v.chave = upper(substring(s.id from '^Tsol([0-9A-Fa-f]{10})'))
  WHERE s.id ~* '^Tsol[0-9a-f]{10}(R[0-9]+)?$'
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
$function$;
