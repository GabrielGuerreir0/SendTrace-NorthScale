-- ═════════════════════════════════════════════════════════════════════════════
--  126 · Cadastra os produtos que vendem e o SendTrace não conhecia
--
--  Motivo (06/11/2026, cruzamento Atlas × SendTrace × dash — pedido do Lucas, "sim" a cadastrar):
--  LungFresh (832 vendas em 90 dias no dash), Gelazen (231), Lumicept (69), Giant Power (18),
--  ImmuneGuard (2) e ProstaFlow (1) não existiam em `produtos`, então `resolve_produto()` devolvia
--  `*` e o pedido caía na régua genérica ("your order"), sem produto na Visão Geral e nas taxas de
--  reembolso por produto. O LungFresh sozinho tem 699 pedidos em `*`.
--
--  O QUE FAZ
--   1. Cadastra os 6 em `produtos` na linha '1' (padrão: "Confiança"), a MESMA linha de `*`. Ou seja,
--      a copy que o cliente recebe não muda; só passa a ter produto. A linha própria de cada um
--      (pulmão, gelatina…) é decisão do CS e se muda depois com:
--        UPDATE produtos SET linha = '<n>' WHERE slug = '<slug>';
--      Não precisa de alias: a grafia dos pedidos ("LungFresh - 6 Bottles", "Gelazen 3 Bottles
--      (Last Chance)") já normaliza para o próprio slug.
--   2. Reatribui o produto dos pedidos ENCERRADOS (concluido, cancelado, falhou) que estão em `*`,
--      como a 044 fez. Pedido `ativo` fica como está: já recebeu e-mails com o texto genérico e trocar
--      o nome no meio da régua deixaria a sequência incoerente (23 pedidos hoje). Kits ("A + B")
--      ficam em `*` de propósito, como na 035. O slug anterior fica em `disparos_slug_backfill_126`.
--      Desfazer:
--        UPDATE disparos_pos_venda d SET produto_slug = b.slug_anterior
--          FROM disparos_slug_backfill_126 b WHERE b.id = d.id;
--
--  Idempotente. Rodar com `psql -1` (o `npm run setup` já roda em transação).
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO produtos (slug, nome, linha, ativo) VALUES
  ('lungfresh',   'LungFresh',   '1', true),
  ('gelazen',     'Gelazen',     '1', true),
  ('lumicept',    'Lumicept',    '1', true),
  ('giantpower',  'Giant Power', '1', true),
  ('immuneguard', 'ImmuneGuard', '1', true),
  ('prostaflow',  'ProstaFlow',  '1', true)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS disparos_slug_backfill_126 (
  id            bigint PRIMARY KEY,           -- disparos_pos_venda.id
  slug_anterior text NOT NULL,
  corrigido_em  timestamptz NOT NULL DEFAULT now()
);

WITH alvo AS (
  SELECT d.id, d.produto_slug AS anterior, resolve_produto(d.produto) AS novo
  FROM disparos_pos_venda d
  WHERE d.produto_slug = '*' AND d.status IN ('concluido', 'cancelado', 'falhou')
    AND d.produto NOT LIKE '%+%'
    AND resolve_produto(d.produto) IN ('lungfresh', 'gelazen', 'lumicept', 'giantpower', 'immuneguard', 'prostaflow')
), salva AS (
  INSERT INTO disparos_slug_backfill_126 (id, slug_anterior)
  SELECT id, anterior FROM alvo
  ON CONFLICT (id) DO NOTHING
)
UPDATE disparos_pos_venda d
SET produto_slug = a.novo
FROM alvo a
WHERE d.id = a.id;

-- ── trava: confere o resultado, senão desfaz tudo ───────────────────────────

DO $$
DECLARE
  g text;
BEGIN
  FOR g IN SELECT unnest(ARRAY['LungFresh - 6 Bottles', 'LungFresh 3 Bottles', 'Gelazen 6 Bottles (Last Chance)',
                               'Lumicept 6 Bottles (LastChance)', 'ProstaFlow 6 Bottles', 'Giant Power 3 Bottles', 'ImmuneGuard 2 Bottles'])
  LOOP
    IF resolve_produto(g) = '*' THEN
      RAISE EXCEPTION '"%" ainda cai em * — nada foi aplicado.', g;
    END IF;
  END LOOP;
  IF resolve_produto('LungFresh - 6 Bottles') IS DISTINCT FROM 'lungfresh' THEN
    RAISE EXCEPTION 'LungFresh não resolveu para lungfresh — nada foi aplicado.';
  END IF;
  -- linha '1' = a mesma de * (a copy do cliente não muda)
  IF (SELECT count(*) FROM produtos WHERE slug IN ('lungfresh','gelazen','lumicept','giantpower','immuneguard','prostaflow') AND linha = '1' AND ativo) <> 6 THEN
    RAISE EXCEPTION 'os 6 produtos deviam estar ativos na linha 1 — nada foi aplicado.';
  END IF;
  -- pedido ativo e kit não podem ter sido tocados
  IF EXISTS (SELECT 1 FROM disparos_slug_backfill_126 b JOIN disparos_pos_venda d ON d.id = b.id
              WHERE d.status = 'ativo' OR d.produto LIKE '%+%') THEN
    RAISE EXCEPTION 'a reatribuição tocou pedido ativo ou kit — nada foi aplicado.';
  END IF;
END
$$;
