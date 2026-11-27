-- ═══════════════════════════════════════════════════════════════════════════
--  140 · Suporte Ativo: ticket AVULSO ("Novo ticket", iniciado pela equipe) + registro do modelo usado no envio
--
--  Pedido da Késsia (CS): criar ticket fora da lista do Monitoramento Logístico, a partir do e-mail do cliente e/ou do número do pedido, para um
--  e-mail pontual (confirmar endereço, pacote retido, atraso, reenvio).
--
--  • `origem`: 'logistica' (nasceu do relatório, "Selecionar para Suporte Ativo") ou 'equipe' (iniciado pela equipe). Serve para não misturar nas
--    métricas. Todo ticket antigo é 'logistica'.
--  • `motivo_contato`: texto livre curto (por que a equipe quis falar com o cliente).
--  • CHAVE do ticket avulso em `transacao_id` (NOT NULL, único entre os não fechados): chave SINTÉTICA e legível, sempre com o prefixo `avulso:`
--      avulso:<transacao_id do pedido>   quando o pedido foi localizado (um avulso por pedido)
--      avulso:<e-mail em minúsculas>     quando o cliente não tem pedido localizado
--    O prefixo é de propósito: a view `sppl_logistica` esconde o pedido do Monitoramento quando existe ticket FECHADO com o mesmo transacao_id;
--    com a chave sintética, fechar um avulso nunca tira o pedido do Monitoramento. O pedido real fica em `pedido_transacao_id`.
--  • Envios: `modelo_id` / `modelo_nome` = qual modelo de e-mail foi usado (null = texto escrito na hora). Quem enviou já é `criado_por`.
--  • Nada do SLA do Suporte Escalado lê `sppl_ativo_*`; a resposta do cliente continua isolada por E-MAIL (gatilho da 101), então vale para avulsos.
--
--  Só ADICIONA colunas e índices. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sppl_ativo_tickets ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'logistica';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sppl_ativo_tickets_origem_chk') THEN
    ALTER TABLE sppl_ativo_tickets ADD CONSTRAINT sppl_ativo_tickets_origem_chk CHECK (origem IN ('logistica', 'equipe'));
  END IF;
END $$;
ALTER TABLE sppl_ativo_tickets ADD COLUMN IF NOT EXISTS motivo_contato text;
ALTER TABLE sppl_ativo_tickets ADD COLUMN IF NOT EXISTS pedido_transacao_id text;
CREATE INDEX IF NOT EXISTS sppl_ativo_tickets_origem_idx ON sppl_ativo_tickets (origem, status_ticket);
CREATE INDEX IF NOT EXISTS sppl_ativo_tickets_pedido_idx ON sppl_ativo_tickets (pedido_transacao_id) WHERE pedido_transacao_id IS NOT NULL;

ALTER TABLE sppl_ativo_envios ADD COLUMN IF NOT EXISTS modelo_id text;
ALTER TABLE sppl_ativo_envios ADD COLUMN IF NOT EXISTS modelo_nome text;
-- alerta de contato duplicado: busca por e-mail do destinatário
CREATE INDEX IF NOT EXISTS sppl_ativo_envios_email_idx ON sppl_ativo_envios (lower(para_email), status);

COMMENT ON COLUMN sppl_ativo_tickets.origem IS 'logistica = veio do Monitoramento Logístico; equipe = ticket avulso iniciado pela equipe (140)';
COMMENT ON COLUMN sppl_ativo_tickets.pedido_transacao_id IS 'Pedido real do ticket avulso (a chave transacao_id do avulso é sintética: avulso:<...>)';
