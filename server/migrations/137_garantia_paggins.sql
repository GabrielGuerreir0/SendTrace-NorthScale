-- ═══════════════════════════════════════════════════════════════════════════
--  137 · Garantia da Paggins (60 dias, confirmado pelo Lucas em 26/11/2026)
--
--  Acrescenta a Paggins ao mapa plataforma→dias de `config_disparos` (migração 024). Só cria a chave
--  'Paggins'; as demais plataformas e o `_padrao` ficam como estão. A Vupim continua no padrão (60).
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE config_disparos
SET valor = (valor::jsonb || '{"Paggins":60}'::jsonb)::text
WHERE chave = 'garantia_dias_por_plataforma'
  AND valor::jsonb -> 'Paggins' IS NULL;
