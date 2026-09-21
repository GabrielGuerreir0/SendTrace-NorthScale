-- ═══════════════════════════════════════════════════════════════════════════
--  041 · Eventos das plataformas, guardados crus (JVZoo, Digistore24, BuyGoods)
--
--  Motivo (21/09/2026): os fluxos "Reporting" do n8n recebem o evento inteiro no webhook, mas o
--  "Normalizar Dados" só passa adiante o que a régua usa (id, nome, e-mail, produto). O resto é
--  descartado: o valor da venda em dólar, o afiliado, a comissão, a etapa do funil, a forma de
--  pagamento, o país — e, na BuyGoods, até quem salvou a venda (`sale_saved_agent`). Sem isso o
--  SendTrace não sabia dizer quanto foi reembolsado em $ nem quanto uma retenção preservou.
--
--  O evento agora é gravado por um ramo PARALELO do webhook (não bloqueia a régua): se o INSERT
--  falhar, o fluxo principal continua. `payload` guarda tudo; as colunas ao lado são só o que já
--  dá para extrair com segurança hoje — o resto se extrai do JSON quando for preciso, sem precisar
--  mexer no n8n de novo.
--
--  Idempotente (IF NOT EXISTS / OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

-- Converte "$1,234.50", "1234.5" ou "-294.00" em número; qualquer outra coisa vira NULL em vez de
-- derrubar o INSERT (um campo de valor inesperado não pode custar o evento inteiro).
CREATE OR REPLACE FUNCTION public.num_seguro(t text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN regexp_replace(coalesce(t, ''), '[$,\s]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN regexp_replace(t, '[$,\s]', '', 'g')::numeric
    ELSE NULL
  END
$$;

CREATE TABLE IF NOT EXISTS public.eventos_plataforma (
  id            bigserial PRIMARY KEY,
  recebido_em   timestamptz NOT NULL DEFAULT now(),
  plataforma    text        NOT NULL,          -- 'JVZoo' | 'DigiStore24' | 'BuyGoods'
  evento        text,                          -- tipo CRU da plataforma: SALE, RFND, CGBK, payment, refund, neworder…
  transacao_id  text,                          -- mesmo formato de disparos_pos_venda.transacao_id
  id_rastreio   text,                          -- paykey (JVZoo) ou order_id_global (BuyGoods), quando existe
  email         text,                          -- em minúsculas
  produto       text,
  valor         numeric,                       -- valor do evento; a Digistore manda NEGATIVO no reembolso
  moeda         text,
  afiliado      text,
  comissao      numeric,                       -- comissão do afiliado, quando a plataforma manda
  etapa_funil   text,                          -- funnel_step (BuyGoods) / funnel_name (JVZoo)
  pais          text,
  payload       jsonb       NOT NULL           -- o corpo inteiro do webhook, sem tirar nada
);

CREATE INDEX IF NOT EXISTS idx_eventos_plataforma_quando ON public.eventos_plataforma (plataforma, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_eventos_plataforma_transacao ON public.eventos_plataforma (transacao_id);
CREATE INDEX IF NOT EXISTS idx_eventos_plataforma_email ON public.eventos_plataforma (email);
CREATE INDEX IF NOT EXISTS idx_eventos_plataforma_evento ON public.eventos_plataforma (plataforma, evento);

COMMENT ON TABLE public.eventos_plataforma IS
  'Evento cru de cada webhook de plataforma (JVZoo, Digistore24, BuyGoods). Gravado por um ramo paralelo do n8n; não alimenta a régua.';
COMMENT ON COLUMN public.eventos_plataforma.payload IS
  'Corpo completo do webhook. A BuyGoods manda ~140 campos (comissão, funil, cartão, sale_saved_*); a JVZoo ~46; a Digistore ~39.';
