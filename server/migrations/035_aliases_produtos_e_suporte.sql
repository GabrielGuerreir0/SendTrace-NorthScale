-- ═══════════════════════════════════════════════════════════════════════════
--  035 · Aliases de produto, FlushPril e e-mail de suporte do rodapé
--
--  Achados do diagnóstico em produção (18/09/2026):
--
--  1) `resolve_produto()` normaliza o nome que a plataforma manda
--     (minúsculas, sem "(…)", sem prefixo "M3 -", sem "N bottles", só a-z0-9) e
--     compara com `produto_aliases.alias` OU com `produtos.slug`. "NeuroRecall
--     6 Bottles" vira `neurorecall`, mas o slug cadastrado é `neurorecallpro`, e
--     `produto_aliases` estava VAZIA — então ~4.340 pedidos do NeuroRecall
--     caíram no slug '*' (régua genérica da linha 1, e nenhum e-mail de Área
--     VIP). Alias resolve isso sem renomear o slug.
--  2) Mais dois nomes que só diferem por sufixo comercial:
--     "M3 - AFF - NeuroMind Pro" (`affneuromindpro`) e "Neuro Mind Pro 6 Bottles
--     + 2 Bottles FREE" (`neuromindprofree`) → neuromindpro.
--  3) FlushPril vende (pedidos em 16/09) mas não existia em `produtos`. Entra na
--     linha '10' (Pressão Alta), como o documento do CS classifica ("Pressão
--     Alta"). É uma suposição fácil de reverter:
--       UPDATE produtos SET linha = '1' WHERE slug = 'flushpril';
--  4) `produtos.email_suporte` do produto '*' (o padrão que todos herdam) era uma
--     URL ("https://support.thenorthscales.com/"), então o rodapé de TODO e-mail
--     da régua mostrava "Email: https://…" com link `mailto:https://…` quebrado.
--     Passa a ser o mesmo endereço do remetente.
--  5) Pedidos AINDA NÃO ENVIADOS (status 'ativo', etapa 0) que caíram em '*' são
--     reposicionados pro slug e pra 1ª etapa certos. Não mexe em pedido que já
--     recebeu algo (etapa_atual > 0), nem em 'falhou'/'concluido'.
--
--  Bundles multi-produto ("1 Flex Guard + 1 Night Calm + 1 Honey Flush", "Bundle
--  Blessed Kit", …) ficam de fora de propósito: continuam na régua genérica.
--
--  Rodar com `psql -1`. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO produto_aliases (alias, produto_slug) VALUES
  ('neurorecall',      'neurorecallpro'),
  ('affneuromindpro',  'neuromindpro'),
  ('neuromindprofree', 'neuromindpro')
ON CONFLICT DO NOTHING;

INSERT INTO produtos (slug, nome, linha, ativo)
VALUES ('flushpril', 'FlushPril', '10', true)
ON CONFLICT (slug) DO NOTHING;

UPDATE produtos
SET email_suporte = 'support@northsupplements.online', atualizado_em = now()
WHERE slug = '*' AND email_suporte ~* '^https?://';

UPDATE disparos_pos_venda d
SET produto_slug = resolve_produto(d.produto),
    etapa_atual  = COALESCE(
      (SELECT min(e.etapa) FROM etapas_regua e
        WHERE e.ativo AND e.linha = (SELECT p.linha FROM produtos p WHERE p.slug = resolve_produto(d.produto))),
      0)
WHERE d.status = 'ativo' AND d.etapa_atual = 0 AND d.produto_slug = '*'
  AND resolve_produto(d.produto) <> '*';

-- ── trava: confere o resultado, senão desfaz tudo (psql -1) ─────────────────

DO $$
BEGIN
  IF resolve_produto('NeuroRecall 6 Bottles') IS DISTINCT FROM 'neurorecallpro' THEN
    RAISE EXCEPTION 'NeuroRecall 6 Bottles não resolveu pra neurorecallpro — nada foi aplicado.';
  END IF;
  IF resolve_produto('M3 - NeuroRecall (6 Bottles)') IS DISTINCT FROM 'neurorecallpro' THEN
    RAISE EXCEPTION 'M3 - NeuroRecall (6 Bottles) não resolveu — nada foi aplicado.';
  END IF;
  IF resolve_produto('FlushPril 2 Bottles') IS DISTINCT FROM 'flushpril' THEN
    RAISE EXCEPTION 'FlushPril 2 Bottles não resolveu — nada foi aplicado.';
  END IF;
  IF resolve_produto('Neuro Mind Pro 3 Bottles') IS DISTINCT FROM 'neuromindpro' THEN
    RAISE EXCEPTION 'Neuro Mind Pro deixou de resolver — nada foi aplicado.';
  END IF;
  IF (SELECT email_suporte FROM produtos WHERE slug = '*') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'email_suporte do produto * não é um e-mail — nada foi aplicado.';
  END IF;
END $$;

-- conferência (aparece no fim da execução)
SELECT (SELECT count(*) FROM produto_aliases) AS aliases,
       (SELECT email_suporte FROM produtos WHERE slug = '*') AS suporte_padrao,
       (SELECT count(*) FROM disparos_pos_venda WHERE status = 'ativo' AND etapa_atual = 0 AND produto_slug = '*') AS ativos_ainda_no_slug_curinga;
