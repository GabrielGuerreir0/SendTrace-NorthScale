-- ════════════════════════════════════════════════════════════════════════════
--  131 · Rastreio — prazo de envio por fulfillment, editável na aba Rastreio (pedido do Lucas, 16/11/2026)
--
--  Antes o card "Pendente de envio" separava os pedidos num corte fixo de 7 dias. Agora cada fulfillment tem o seu prazo de envio (dias corridos
--  desde a compra, a mesma regra do Atlas) e o card separa "no prazo" × "atrasado". Prazo vazio (null) = nada é marcado como atrasado.
--    config_disparos.rastreio_prazo_envio = {"fullstack": 3, "jetstream": 2, "redrock": 3}   (valores iniciais = Atlas em 13/11; Red Rock = FullStack)
--    rastreio_prazo_envio_historico       = quem mudou, quando, de → para
--  Aditiva e idempotente.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.config_disparos (chave, valor)
VALUES ('rastreio_prazo_envio', '{"fullstack": 3, "jetstream": 2, "redrock": 3}')
ON CONFLICT (chave) DO NOTHING;

CREATE TABLE IF NOT EXISTS rastreio_prazo_envio_historico (
  id     bigserial   PRIMARY KEY,
  em     timestamptz NOT NULL DEFAULT now(),
  por    text,
  de     jsonb,
  para   jsonb       NOT NULL
);
