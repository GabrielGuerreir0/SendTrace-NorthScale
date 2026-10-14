-- O relatório do SPPL junta as compras de upsell/downsell por lower(email) + janela de tempo; sem este índice cada linha varria a tabela toda.
CREATE INDEX IF NOT EXISTS idx_compras_upsell_downsell_lower_email_criado ON compras_upsell_downsell (lower(email), criado_em);
