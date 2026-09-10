-- ═══════════════════════════════════════════════════════════════════════════
--  021 · Roteamento de régua por produto (família) + Família 1 — Neuro/Cognitivo
--
--  Contexto (10/09/2026): o Rodrigo (Head de CS) formalizou um plano pra
--  substituir o funil único genérico por réguas segmentadas por família de
--  produto, começando pela Família 1 — Neuro/Cognitivo (Memória + Neuropatia,
--  ~87% do volume). O plano supõe que já dá pra ter várias famílias rodando em
--  paralelo — isso NÃO existia: `linha` sempre foi um interruptor GLOBAL
--  (`config_disparos.linha_ativa`), a mesma copy pra TODOS os produtos ao
--  mesmo tempo (ver `server/linha.js`, `api/rotas/regua.js`). Esta migração
--  troca isso por roteamento por produto: cada produto passa a ter sua
--  própria `linha` (família), com fallback pra '1' (a linha "Confiança"
--  atual) pra ninguém mudar de comportamento sem essa coluna ser tocada.
--
--  O fluxo n8n "Processador de Disparos" (nó "Buscar Copy Ativa") já foi
--  ajustado pra ler por essa coluna em vez do config global — reimportar o
--  fluxo no VPS depois de aplicar esta migração, senão fica sem efeito.
--
--  IMPORTANTE — convenção de numeração de etapa: `etapas_regua` é global
--  (compartilhada por todas as linhas, sem coluna de linha própria), então
--  cada linha precisa da SUA PRÓPRIA faixa contígua de números de etapa, sem
--  sobrepor as demais. A linha '1' (Confiança) já usa 0-5. A Família 1 usa
--  10-16 (ver migração 022, que cadastra as etapas e a copy). Antes de criar
--  uma família nova no futuro, reservar a próxima faixa livre (17+).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. produtos.linha — qual família cada produto usa ──────────────────────

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS linha text NOT NULL DEFAULT '1'
    REFERENCES painel_linhas_copy(linha) ON UPDATE CASCADE;

COMMENT ON COLUMN produtos.linha IS
  'Família/linha de copy que este produto usa na régua de pós-venda. '
  'Não é mais um interruptor global (config_disparos.linha_ativa) — cada '
  'produto aponta pra sua própria linha; produtos sem família específica '
  'ficam na linha padrão (1 = Confiança).';

-- ── 2. nova linha — Família 1 — Neuro/Cognitivo ─────────────────────────────

INSERT INTO painel_linhas_copy (linha, nome, intuito, ordem)
VALUES (
  '4', 'Família 1 — Neuro/Cognitivo',
  'Memória + Neuropatia. Régua de 7 etapas (D0 a D25) desenhada pro pico de '
  'reembolso por arrependimento entre D2 e D5 — inclui a etapa nova de '
  'check-in de chegada (D3) que a linha genérica não tinha. E-mail apenas, '
  'todas as etapas convidam resposta do cliente.',
  2
)
ON CONFLICT (linha) DO NOTHING;

-- ── 3. cadastro do produto que faltava no catálogo ──────────────────────────
--
-- NeuroRecallPro tem pedidos reais no dashboard operacional mas nunca foi
-- cadastrado em `produtos` — sem isso, `mensagens_regua_produto_fkey` nem
-- deixa gravar copy pra ele. Cadastro mínimo; ajustar nome_sms/uso/link do
-- e-book/e-mail de suporte quando esses dados forem confirmados (pendência
-- aberta no documento do funil, Seção 10 — junto com Mind Honey 60 Pro, que
-- tem o mesmo problema no catálogo de afiliados mas já existe aqui).

INSERT INTO produtos (slug, nome, ativo)
VALUES ('neurorecallpro', 'NeuroRecall Pro', true)
ON CONFLICT (slug) DO NOTHING;

-- ── 4. atribuir os 7 produtos à linha nova — DE PROPÓSITO NÃO É AQUI ────────
--
-- Ainda faltam pendências de conteúdo antes de ligar o tráfego real pra esta
-- linha (Seção 10 do documento do funil): janela de garantia real por
-- produto/plataforma, 6 dos 7 produto_readmes ainda vazios, copy da Etapa 6
-- com placeholder `[JANELA_GARANTIA]`. Fazer o UPDATE produtos SET linha='4'
-- agora publicaria e-mail com placeholder pra cliente real assim que o
-- fluxo n8n for reimportado. Esse UPDATE vira sua própria migração (024,
-- "ativa família 1"), aplicada só depois que a migração 022 (etapas + copy
-- final da família) estiver com os placeholders reais resolvidos.
