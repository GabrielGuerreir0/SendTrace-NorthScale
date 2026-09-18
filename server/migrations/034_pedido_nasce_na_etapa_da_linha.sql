-- ═══════════════════════════════════════════════════════════════════════════
--  034 · O pedido nasce na PRIMEIRA ETAPA da linha do produto
--
--  Achado (18/09/2026, consulta em produção): os 3 fluxos Reporting gravam
--  todo pedido novo com `etapa_atual = 0` (literal no INSERT), e o
--  `Processador de Disparos` usa `etapa_atual` direto pra buscar a copy
--  (`Montar Mensagem`: buscar(slug, etapa_atual, canal)) — sem converter pra
--  faixa da linha. Resultado medido em `disparos_pos_venda`: NENHUM pedido de
--  produto das linhas 4-10 (Famílias 1-6) jamais teve `etapa_atual` na faixa
--  própria (10-16, 20-26, …, 70-76): todos andaram 0→5→6 (concluido) usando a
--  copy genérica da linha 1. As réguas por família, ativadas em produção em
--  10/09 (Família 1) e 17/09 (Famílias 2-6), nunca chegaram a rodar.
--
--  Correção no banco, num lugar só, valendo pras 3 plataformas sem reimportar
--  fluxo: o trigger BEFORE INSERT que já resolve `produto_slug` passa a
--  também posicionar o pedido na primeira etapa ATIVA da linha do produto
--  quando o INSERT manda 0. Linha '1' (genérica) e produto sem linha própria
--  continuam começando em 0 — nada muda pra eles.
--
--  O resto do motor já é genérico: `Reivindicar Lote` pega a etapa_atual se
--  ela existir ativa em `etapas_regua`; `Avancar Etapa` soma 1 e conclui
--  quando etapa+1 não existe (36→37 conclui a linha 6, por exemplo) e usa a
--  espera_h da etapa corrente.
--
--  NÃO mexe em pedidos que já existem (o backlog é decisão à parte — ver o
--  bloco comentado no fim). Enquanto o Processador estiver desligado, nada
--  é enviado de qualquer jeito.
--
--  Rodar com `psql -1`. Idempotente (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trg_disparos_produto_slug()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  primeira integer;
BEGIN
  -- Só preenche o que veio vazio: um INSERT que já mande o slug manda nele.
  IF NEW.produto_slug IS NULL THEN
    NEW.produto_slug := resolve_produto(NEW.produto);
  END IF;

  -- Os fluxos Reporting sempre mandam etapa_atual = 0. Produto com linha
  -- própria (faixa 10-16, 20-26, …) começa na primeira etapa ATIVA dela.
  -- Um INSERT que já mande outro número manda nele.
  IF NEW.etapa_atual = 0 THEN
    SELECT min(e.etapa) INTO primeira
    FROM etapas_regua e
    WHERE e.ativo
      AND e.linha = (SELECT p.linha FROM produtos p WHERE p.slug = NEW.produto_slug);
    IF primeira IS NOT NULL THEN
      NEW.etapa_atual := primeira;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── trava: confere o que a função vai enxergar, sem inserir nada ────────────

DO $$
DECLARE
  n integer;
BEGIN
  -- Diabetes (glycoeden, linha 6) deve começar na 30; Pressão Alta (honeyflush, linha 10) na 70;
  -- NeuroMind Pro (linha 4) na 10; produto genérico '*' (linha 1) na 0.
  SELECT min(e.etapa) INTO n FROM etapas_regua e WHERE e.ativo AND e.linha = (SELECT linha FROM produtos WHERE slug = 'glycoeden');
  IF n IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'glycoeden deveria começar na 30, achei % — nada foi aplicado.', n; END IF;

  SELECT min(e.etapa) INTO n FROM etapas_regua e WHERE e.ativo AND e.linha = (SELECT linha FROM produtos WHERE slug = 'honeyflush');
  IF n IS DISTINCT FROM 70 THEN RAISE EXCEPTION 'honeyflush deveria começar na 70, achei % — nada foi aplicado.', n; END IF;

  SELECT min(e.etapa) INTO n FROM etapas_regua e WHERE e.ativo AND e.linha = (SELECT linha FROM produtos WHERE slug = 'neuromindpro');
  IF n IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'neuromindpro deveria começar na 10, achei % — nada foi aplicado.', n; END IF;

  SELECT min(e.etapa) INTO n FROM etapas_regua e WHERE e.ativo AND e.linha = (SELECT linha FROM produtos WHERE slug = '*');
  IF n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'produto genérico deveria começar na 0, achei % — nada foi aplicado.', n; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
--  NÃO RODAR AGORA — decisão de backlog (só quando for religar o Processador)
--
--  Pedidos já gravados e ainda `ativo` em etapa 0 continuam com a etapa antiga
--  (0) e o slug antigo. Se a decisão for tratá-los como pedido novo da família
--  certa (em vez de contatá-los por campanha à parte), reposicionar assim:
--
--  UPDATE disparos_pos_venda d
--  SET produto_slug = resolve_produto(d.produto),
--      etapa_atual  = COALESCE((SELECT min(e.etapa) FROM etapas_regua e
--                                WHERE e.ativo
--                                  AND e.linha = (SELECT p.linha FROM produtos p
--                                                  WHERE p.slug = resolve_produto(d.produto))), 0)
--  WHERE d.status = 'ativo' AND d.etapa_atual = 0;
-- ═══════════════════════════════════════════════════════════════════════════
