-- ═══════════════════════════════════════════════════════════════════════════
--  023 · etapas_regua ganha dono (linha) — corrige "completude" quebrada
--
--  Achado (10/09/2026), revisando o painel depois da migração 022: tanto
--  `resumoLinhas()` (server/dados.js) quanto o gate de `PUT /api/linha-ativa/`
--  (api/rotas/regua.js) contavam "quantas etapas uma linha precisa ter
--  pronta" olhando TODAS as etapas ativas de `etapas_regua` — certo enquanto
--  só existia uma linha (todas as etapas eram dela mesmo), mas quebrado assim
--  que a 022 cadastrou as etapas 10-16 da Família 1: o total global pulou de
--  6 para 13, e a linha '1' (que só tem 0-5) passou a aparecer como
--  "incompleta" do nada — regressão real, ao vivo, sem eu ter tocado nela.
--
--  Fix: `etapas_regua` ganha uma coluna `linha` dizendo a quem aquela etapa
--  pertence. NÃO vira chave primária composta (evita mexer na FK que
--  `mensagens_regua.etapa` já tem) — é só um atributo, suficiente pra filtrar
--  "quantas etapas ATIVAS são desta linha" em vez de "quantas existem no
--  total". Etapa -1 (recibo) fica com `linha` NULL de propósito: já é
--  `ativo=false` e compartilhada por todas as linhas (migração 020) — não
--  pertence a nenhuma em particular, e por já ser inativa não entra em
--  nenhuma conta de completude mesmo.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE etapas_regua
  ADD COLUMN IF NOT EXISTS linha text REFERENCES painel_linhas_copy(linha) ON UPDATE CASCADE;

COMMENT ON COLUMN etapas_regua.linha IS
  'A qual linha/família esta etapa pertence (sua faixa própria de número de '
  'etapa). NULL = compartilhada entre linhas (hoje só a etapa -1, o recibo).';

UPDATE etapas_regua SET linha = '1' WHERE etapa BETWEEN 0 AND 5;
UPDATE etapas_regua SET linha = '4' WHERE etapa BETWEEN 10 AND 16;
