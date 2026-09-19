-- ═══════════════════════════════════════════════════════════════════════════
--  037 · Eventos do Postmark (webhook do n8n) — alimenta a aba "Postmark" do painel
--
--  O fluxo n8n "Postmark — Eventos de Entrega (webhook)" grava aqui todo evento que o Postmark
--  manda (Delivery, Bounce, SpamComplaint, Open, Click, SubscriptionChange) e, quando o endereço
--  já foi suprimido, cancela a sequência dele em `disparos_pos_venda`. O fluxo já faz
--  CREATE TABLE IF NOT EXISTS — esta migração só garante a tabela também no `npm run setup`.
--  Idempotente. Não guarda payload inteiro: só os campos que o painel usa.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.postmark_eventos (
  id          bigserial PRIMARY KEY,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  tipo        text NOT NULL,
  subtipo     text,
  email       text,
  message_id  text,
  tag         text,
  stream      text,
  assunto     text,
  detalhes    text,
  ocorreu_em  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_postmark_eventos_email ON public.postmark_eventos (lower(email));
CREATE INDEX IF NOT EXISTS idx_postmark_eventos_tipo_data ON public.postmark_eventos (tipo, recebido_em);
