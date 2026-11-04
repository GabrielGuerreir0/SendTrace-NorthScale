-- ═══════════════════════════════════════════════════════════════════════════
--  125 · Eventos da Vupim para o Atlas (04/11/2026)
--
--  O fluxo n8n "Vupim → Atlas" recebe os webhooks da Vupim (vendas, checkouts iniciados/abandonados, reembolsos, chargebacks), confere a assinatura,
--  tira os dados pessoais e grava UMA linha por evento aqui. NENHUM dado pessoal (e-mail, nome, telefone, endereço, IP) entra nesta tabela.
--  Serve ao Perfil da oferta do Atlas (checkouts iniciados × vendas por produto/oferta) e a qualquer consulta de leitura.
--  `eventos_plataforma` (a tabela do fluxo antigo) continua igual: ela guarda o evento cru só de vendas e é lida pelo dash/régua.
--
--  `event_id` é o `eventId` da Vupim (igual em retentativas e reenvios): UNIQUE + ON CONFLICT DO NOTHING deduplica sem apagar nada.
--  Valores: `valor`/`valor_usd` já em unidade da moeda (a Vupim manda na menor unidade; o fluxo divide por 100).
--
--  Aditiva e idempotente. Desfazer: DROP TABLE public.vupim_eventos_atlas;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.vupim_eventos_atlas (
  id                    bigserial PRIMARY KEY,
  recebido_em           timestamptz NOT NULL DEFAULT now(),
  event_id              text,                 -- eventId da Vupim (dedupe)
  evento                text NOT NULL,        -- sale.approved, checkout.initiated, checkout.abandoned, sale.refunded, sale.chargeback…
  em                    timestamptz,          -- momento do evento, segundo a Vupim
  transacao_id          text,
  transacao_pai_id      text,
  produto_id            text,
  produto               text,
  oferta_id             text,
  oferta                text,
  origem                text,                 -- direct, upsell, downsell, renewal, call_center
  etapa_funil           text,
  status                text,
  pagamento             text,                 -- credit_card, pix, boleto
  pais                  text,
  moeda                 text,
  valor                 numeric,
  valor_usd             numeric,
  afiliado_id           text,
  utm_source            text,
  utm_campaign          text,
  landing_url           text,
  aid                   text                  -- sub1 do link (id do afiliado quando a página manda)
);
CREATE UNIQUE INDEX IF NOT EXISTS vupim_eventos_atlas_event_id_uq ON public.vupim_eventos_atlas (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vupim_eventos_atlas_oferta_idx ON public.vupim_eventos_atlas (produto, oferta, recebido_em DESC);
CREATE INDEX IF NOT EXISTS vupim_eventos_atlas_evento_idx ON public.vupim_eventos_atlas (evento, recebido_em DESC);
COMMENT ON TABLE public.vupim_eventos_atlas IS 'Eventos da Vupim sem dados pessoais, gravados pelo fluxo n8n "Vupim → Atlas" (125). Dedupe por event_id.';

-- libera a leitura (conector/Atlas) como nas outras migrações recentes
DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
