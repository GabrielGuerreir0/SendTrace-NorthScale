-- ═══════════════════════════════════════════════════════════════════════════
--  049 · Integração com o dash (dash.thenorthscales.com) — LEITURA + retenção
--
--  Contexto (23/09/2026): o Mike respondeu às pendências da API do dash
--  (RESPOSTA_SENDTRACE.md). Ficou combinado:
--   · O SendTrace LÊ o dash com uma chave de parceiro (X-Api-Key), só leitura:
--       GET /api/integrations/orders   (pedidos, com ?updated_since=)
--       GET /api/integrations/targets  (metas de reembolso/chargeback)
--       GET /api/integrations/catalog  (família de produto)
--   · O dash LÊ o SendTrace em GET /api/retencao (P10/R4): o que o CS ofereceu,
--     o que o cliente aceitou e quanto de receita foi preservado, por pedido.
--
--  Esta migração só cria as tabelas. Nada roda até a chave existir:
--   · sem DASH_API_KEY no .env do servidor, o sincronizador não liga;
--   · sem RETENCAO_API_KEY, /api/retencao responde 503;
--   · `retencao_ofertas` nasce vazia — o registro do degrau no ticket (P10) ainda
--     não existe no painel; a tabela é onde ele vai gravar.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- Estado do sincronizador e cópias pequenas do dash (metas, catálogo).
-- Chaves usadas: cursor_pedidos, ultimo_sync, ultima_varredura, ultimo_erro,
-- metas, catalogo. `valor` é jsonb porque o formato do catálogo é do dash.
CREATE TABLE IF NOT EXISTS dash_estado (
  chave          text PRIMARY KEY,
  valor          jsonb NOT NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- Espelho dos pedidos do dash. Chave = plataforma + externalId (é assim que o
-- Mike pediu para deduplicar). NÃO substitui `disparos_pos_venda`: aquela é a
-- fila da régua; esta é a fonte do DINHEIRO (reembolso/chargeback por pedido).
--
-- Duas formas de estorno no dado bruto (ver RESPOSTA_SENDTRACE.md, seção 2):
--   in-place  → a linha da venda vira REFUNDED/CHARGEBACK (JVZoo, BuyGoods,
--               ClickBank, Cartpanda, PagAmerican);
--   extra-row → a venda continua APPROVED e entra uma linha nova, negativa,
--               com parent_external_id apontando pra ela (Digistore24).
-- `refunded_usd`/`chargeback_usd` já vêm resolvidos e positivos: somar esses
-- dois campos dispensa saber a forma.
CREATE TABLE IF NOT EXISTS dash_pedidos (
  plataforma           text NOT NULL,
  external_id          text NOT NULL,
  parent_external_id   text,
  session_id           text,
  status               text,
  product_type         text,          -- FRONTEND | UPSELL | DOWNSELL | BUMP | SMS_RECOVERY
  funnel_step          integer,
  family               text,          -- agrupa o mesmo produto entre plataformas
  product_id           text,          -- cru da plataforma: NÃO agrupar por isto
  product_name         text,
  affiliate_id         text,
  mapped_affiliate_id  text,
  customer_email       text,
  country              text,
  currency             text,
  bottles              integer,
  gross                numeric(14,2),
  original_gross       numeric(14,2), -- valor da venda antes de qualquer evento de estorno
  net                  numeric(14,2),
  cpa                  numeric(14,2),
  refunded_usd         numeric(14,2) NOT NULL DEFAULT 0,
  chargeback_usd       numeric(14,2) NOT NULL DEFAULT 0,
  refund_model         text,          -- in-place | extra-row
  ordered_at           timestamptz,
  approved_at          timestamptz,
  refunded_at          timestamptz,
  chargeback_at        timestamptz,
  updated_at_dash      timestamptz,   -- updatedAt do dash: base do pull incremental
  bruto                jsonb,         -- a linha como veio, pra conferir semântica
  sincronizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plataforma, external_id)
);

CREATE INDEX IF NOT EXISTS dash_pedidos_ordered_idx  ON dash_pedidos (ordered_at);
CREATE INDEX IF NOT EXISTS dash_pedidos_updated_idx  ON dash_pedidos (updated_at_dash);
CREATE INDEX IF NOT EXISTS dash_pedidos_parent_idx   ON dash_pedidos (plataforma, parent_external_id);
CREATE INDEX IF NOT EXISTS dash_pedidos_email_idx    ON dash_pedidos (lower(customer_email));
CREATE INDEX IF NOT EXISTS dash_pedidos_family_idx   ON dash_pedidos (family);

-- Retenção (P10/R4): uma linha por oferta feita pelo CS a um cliente que
-- pediu reembolso. É o que o dash consulta em GET /api/retencao.
--   · transacao_id  = o externalId do dash (é o que torna auditável por pedido);
--   · status        = oferecido | aceito | recusado;
--   · atualizado_em = base do pull incremental do dash (sobe a cada UPDATE).
CREATE TABLE IF NOT EXISTS retencao_ofertas (
  id                    text PRIMARY KEY DEFAULT ('ret_' || replace(gen_random_uuid()::text, '-', '')),
  transacao_id          text NOT NULL,
  plataforma            text NOT NULL,
  email                 text,
  degrau_oferecido      text,
  degrau_aceito         text,
  valor_preservado_usd  numeric(14,2),
  status                text NOT NULL DEFAULT 'oferecido'
                        CHECK (status IN ('oferecido', 'aceito', 'recusado')),
  ocorrido_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  criado_por            text
);

CREATE INDEX IF NOT EXISTS retencao_ofertas_atualizado_idx ON retencao_ofertas (atualizado_em, id);
CREATE INDEX IF NOT EXISTS retencao_ofertas_transacao_idx  ON retencao_ofertas (transacao_id);

CREATE OR REPLACE FUNCTION public.retencao_ofertas_toca_atualizado()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS retencao_ofertas_atualizado ON retencao_ofertas;
CREATE TRIGGER retencao_ofertas_atualizado
  BEFORE UPDATE ON retencao_ofertas
  FOR EACH ROW EXECUTE FUNCTION public.retencao_ofertas_toca_atualizado();
