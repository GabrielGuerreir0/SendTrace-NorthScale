-- ═══════════════════════════════════════════════════════════════════════════
--  099 · SPPL — janela de datas do registro no 17TRACK (decisão do Lucas, 13/10/2026)
--  Só pedidos enviados nos últimos N dias entram no 17TRACK (padrão 30). 0 = sem limite. Evita registrar pedido antigo (~2.000 com mais de 30 dias,
--  quase todos com mais de 90) e abrir card de problema que já não importa. Só insere a chave se ainda não existe. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO config_disparos (chave, valor) VALUES ('sppl_17track_janela_dias', '30') ON CONFLICT (chave) DO NOTHING;
