-- ═══════════════════════════════════════════════════════════════════════════
--  091 · SPPL — interruptores do job de registro no 17TRACK
--  Nasce DESLIGADO (sppl_17track_ativo = 'false'): quem decide ligar é o Lucas, depois de escolher o pacote do 17TRACK.
--  Só insere chaves que ainda não existem (nunca sobrescreve o que o admin mudou). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO config_disparos (chave, valor) VALUES
  ('sppl_17track_ativo', 'false'),
  ('sppl_17track_cota_reserva', '20'),
  ('sppl_17track_lote_por_rodada', '200')
ON CONFLICT (chave) DO NOTHING;

-- Motor do SPPL: também nasce desligado, com teto de ocorrências novas por rodada (evita enxurrada no 1º dia).
INSERT INTO config_disparos (chave, valor) VALUES
  ('sppl_motor_ativo', 'false'),
  ('sppl_motor_max_novas_por_rodada', '200')
ON CONFLICT (chave) DO NOTHING;

-- "Sem movimentação há 5/10/15 dias" conta DIAS CORRIDOS (o PDF fala em dias parado, não em dias úteis). Suposição reversível: só mexe na semente
-- que a migração 090 criou e que ninguém editou (atualizado_por IS NULL).
UPDATE sppl_regras SET dias_uteis = false WHERE categoria IN ('sem_movimento_5d','sem_movimento_10d','sem_movimento_15d') AND atualizado_por IS NULL;
