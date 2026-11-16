-- ════════════════════════════════════════════════════════════════════════════
--  130 · Pesquisa de estorno — envio do convite por e-mail (pedido do Lucas, 16/11/2026; ClickUp 1dfjmjuc540)
--
--  O envio é feito pela API (api/pesquisaEstornoEnvio.js, a cada 10 min) pela API do Postmark (POSTMARK_SERVER_TOKEN no .env),
--  remetente support@northsupplements.online, como a régua. Cada envio entra em email_envios_log (origem 'pesquisa_estorno'),
--  então conta no teto do Postmark.
--
--  Chaves em config_disparos (o envio nasce DESLIGADO):
--    pesquisa_estorno_ativo          'false' → 'true' liga o convite e o lembrete
--    pesquisa_estorno_pct            '10'    → % dos estornos que entram no piloto (o resto vira descartado = 'fora_da_amostra')
--    pesquisa_estorno_desde          estornos a partir desta data (15/11/2026 00:00 BRT)
--    pesquisa_estorno_lembrete_ativo 'true'  → lembrete 4 dias depois, só para quem não clicou
--    pesquisa_estorno_max_rodada     '40'    → teto de e-mails por rodada de 10 min
--
--  Aditiva e idempotente. Desligar: UPDATE config_disparos SET valor = 'false' WHERE chave = 'pesquisa_estorno_ativo';
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE pesquisa_estorno_convites ADD COLUMN IF NOT EXISTS tentativas  integer NOT NULL DEFAULT 0;
ALTER TABLE pesquisa_estorno_convites ADD COLUMN IF NOT EXISTS erro        text;
ALTER TABLE pesquisa_estorno_convites ADD COLUMN IF NOT EXISTS amostra     boolean NOT NULL DEFAULT true;
ALTER TABLE pesquisa_estorno_convites ADD COLUMN IF NOT EXISTS bounce_em   timestamptz;
ALTER TABLE pesquisa_estorno_convites ADD COLUMN IF NOT EXISTS spam_em     timestamptz;

INSERT INTO public.config_disparos (chave, valor) VALUES
  ('pesquisa_estorno_ativo', 'false'),
  ('pesquisa_estorno_pct', '10'),
  ('pesquisa_estorno_desde', '2026-11-15 03:00:00+00'),
  ('pesquisa_estorno_lembrete_ativo', 'true'),
  ('pesquisa_estorno_max_rodada', '40')
ON CONFLICT (chave) DO NOTHING;
