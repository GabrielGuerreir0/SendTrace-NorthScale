-- ═══════════════════════════════════════════════════════════════════════════
--  119 · E-mail "seu código de rastreio" ao lead (pedido do Lucas, 23/10/2026)
--
--  Quando o fulfillment (RedRock, FullStack ou Jetpack) gera o código de rastreio e o pedido passa a ter `tracking_number` + `shipped_at`,
--  o lead recebe UM e-mail com o código e um botão para a página pública /rastreio (já preenchida com o pedido). Quem envia é o fluxo n8n
--  "Rastreio — e-mail do código" (Postmark SMTP, mesma credencial da confirmação de compra); este arquivo só guarda o controle.
--
--  `rastreio_email_codigo`: uma linha por pedido que já foi reservado para envio (a PK impede repetir). Status: reservado → enviado | falhou.
--  Chaves em config_disparos (nascem DESLIGADAS):
--      rastreio_email_ativo  = 'false'   liga/desliga o envio (além da chave mestra `emails_automaticos_ativo`)
--      rastreio_email_desde  = ''        só pedidos enviados (shipped_at) a partir deste instante entram; preenchido NA HORA de ligar
--                                        (senão o histórico inteiro com código receberia o e-mail)
--  Aditiva e idempotente. Desfazer: UPDATE config_disparos SET valor='false' WHERE chave='rastreio_email_ativo';  (DROP TABLE se quiser apagar o controle)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.rastreio_email_codigo (
  transacao_id    text PRIMARY KEY,
  tracking_number text NOT NULL,
  provedor        text,
  email           text NOT NULL,                       -- minúsculo
  status          text NOT NULL DEFAULT 'reservado' CHECK (status IN ('reservado', 'enviado', 'falhou')),
  erro            text,
  reservado_em    timestamptz NOT NULL DEFAULT now(),
  enviado_em      timestamptz
);
CREATE INDEX IF NOT EXISTS rastreio_email_codigo_status_idx ON public.rastreio_email_codigo (status, reservado_em);
COMMENT ON TABLE public.rastreio_email_codigo IS 'Controle do e-mail com o código de rastreio (119): um por pedido; a PK impede envio repetido.';

INSERT INTO public.config_disparos (chave, valor) VALUES ('rastreio_email_ativo', 'false') ON CONFLICT (chave) DO NOTHING;
INSERT INTO public.config_disparos (chave, valor) VALUES ('rastreio_email_desde', '') ON CONFLICT (chave) DO NOTHING;

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
