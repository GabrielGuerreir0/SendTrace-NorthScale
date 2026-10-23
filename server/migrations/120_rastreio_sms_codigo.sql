-- ═══════════════════════════════════════════════════════════════════════════
--  120 · SMS "seu código de rastreio" ao lead (pedido do Lucas, 23/10/2026; copy aprovada por ele)
--
--  Complementa a 119: depois do e-mail do código, o MESMO fluxo n8n ("Rastreio — e-mail do código") manda UM SMS curto (1 segmento, sem acento) com o
--  link curto `https://sendtrace.thenorthscales.com/r/<pedido>` (rota nova do painel, redireciona para /rastreio?pedido=). O controle fica na mesma linha
--  de `rastreio_email_codigo`: a PK continua impedindo repetição.
--
--  Colunas novas: sms_status (NULL = ainda não tentado | reservado | enviado | falhou), sms_erro, sms_reservado_em, sms_enviado_em.
--  Chaves em config_disparos (nascem DESLIGADAS):
--      rastreio_sms_ativo = 'false'    liga/desliga o SMS (além da chave mestra `emails_automaticos_ativo`)
--      rastreio_sms_desde = ''         só linhas reservadas (e-mail) a partir deste instante recebem SMS; preenchido NA HORA de ligar
--  Regras no fluxo: só telefone E.164 válido; janela 10h–20h30 de Nova York; mesmas exclusões do e-mail (reembolso, chargeback, descadastro, entregue).
--  Aditiva e idempotente. Desfazer: UPDATE config_disparos SET valor='false' WHERE chave='rastreio_sms_ativo';
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.rastreio_email_codigo ADD COLUMN IF NOT EXISTS sms_status text;
ALTER TABLE public.rastreio_email_codigo ADD COLUMN IF NOT EXISTS sms_erro text;
ALTER TABLE public.rastreio_email_codigo ADD COLUMN IF NOT EXISTS sms_reservado_em timestamptz;
ALTER TABLE public.rastreio_email_codigo ADD COLUMN IF NOT EXISTS sms_enviado_em timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rastreio_email_codigo_sms_status_chk') THEN
    ALTER TABLE public.rastreio_email_codigo ADD CONSTRAINT rastreio_email_codigo_sms_status_chk CHECK (sms_status IS NULL OR sms_status IN ('reservado', 'enviado', 'falhou'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rastreio_email_codigo_sms_idx ON public.rastreio_email_codigo (reservado_em) WHERE sms_status IS NULL;

INSERT INTO public.config_disparos (chave, valor) VALUES ('rastreio_sms_ativo', 'false') ON CONFLICT (chave) DO NOTHING;
INSERT INTO public.config_disparos (chave, valor) VALUES ('rastreio_sms_desde', '') ON CONFLICT (chave) DO NOTHING;

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
