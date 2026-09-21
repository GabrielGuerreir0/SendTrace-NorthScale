-- ═══════════════════════════════════════════════════════════════════════════
--  044 · "your order" (produto coringa `*`): aliases e histórico
--
--  Motivo (21/09/2026, P1 da Visão Geral v2): a Home mostrava "your order" como produto porque
--  `resolve_produto()` devolve `*` para tudo que não reconhece. `*` NÃO é lixo: é a linha padrão da
--  régua (o Processador usa `PRODUTOS['*']` como copy padrão e "your order" aparece no texto do
--  cliente). Por isso a linha `*` continua ativa e intocada aqui; o que se conserta é o que caía
--  nela sem precisar:
--
--   1. Aliases de grafias claras de um único produto (e-mails de clientes escrevem "Neuro Mind",
--      "Thermo Burn", "neurmind pro"…). Não entra texto com dois produtos nem genérico ("bottles").
--   2. Pedidos antigos que ficaram em `*` porque o alias/produto só passou a existir depois
--      (NeuroRecall ganhou alias em 18/09; ~1.700 pedidos de 28/08 a 18/09 ficaram em `*`).
--      Só mexe em pedido ENCERRADO (concluido, cancelado ou falhou): pedido `ativo` ainda vai
--      receber e-mail da régua e trocar o produto no meio mudaria o texto que ele recebe.
--      O slug anterior fica em `disparos_slug_backfill_044` para desfazer.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO produto_aliases (alias, produto_slug) VALUES
  ('neuromind',    'neuromindpro'),
  ('neurmindpro',  'neuromindpro'),
  ('neromindpro',  'neuromindpro'),
  ('nueromindpro', 'neuromindpro'),
  ('thermoburn',   'thermoburnpro'),
  ('thermburnpro', 'thermoburnpro')
ON CONFLICT (alias) DO NOTHING;

CREATE TABLE IF NOT EXISTS disparos_slug_backfill_044 (
  id            bigint PRIMARY KEY,           -- disparos_pos_venda.id
  slug_anterior text NOT NULL,
  corrigido_em  timestamptz NOT NULL DEFAULT now()
);

WITH alvo AS (
  SELECT d.id, resolve_produto(d.produto) AS novo
  FROM disparos_pos_venda d
  WHERE d.produto_slug = '*' AND d.status IN ('concluido', 'cancelado', 'falhou')
    AND resolve_produto(d.produto) <> '*'
),
log AS (
  INSERT INTO disparos_slug_backfill_044 (id, slug_anterior)
  SELECT id, '*' FROM alvo ON CONFLICT (id) DO NOTHING RETURNING id
)
UPDATE disparos_pos_venda d SET produto_slug = a.novo
FROM alvo a WHERE a.id = d.id;

COMMENT ON TABLE disparos_slug_backfill_044 IS
  'Pedidos cujo produto_slug saiu de `*` na migração 044. Para desfazer: UPDATE disparos_pos_venda SET produto_slug = slug_anterior FROM esta tabela.';
