-- ═══════════════════════════════════════════════════════════════════════════
--  007 · A copy passa a existir em TRÊS linhas
--
--  O buraco que isto fecha: o painel guardava uma única versão dos textos,
--  mas o workflow tem três (Linha 1, 2 e 3) e um seletor que troca entre elas.
--  Trocar a linha mudava a campanha real e o painel continuava mostrando os
--  mesmos textos — ou seja, exibia a copy errada sem nenhum aviso.
--
--  Agora a chave é (etapa, canal, LINHA). O que existia vira Linha 1, porque é
--  de lá que a copy transcrita veio.
--
--  Linhas 2 e 3 nascem VAZIAS de propósito. Os textos delas vivem no n8n e
--  ninguém os passou para cá — inventar um conteúdo plausível seria pior que a
--  ausência: o painel afirmaria com confiança uma mensagem que nunca foi
--  enviada. A tela diz "ainda não cadastrada" e ensina como preencher.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mensagens_regua
  ADD COLUMN IF NOT EXISTS linha text NOT NULL DEFAULT '1';

ALTER TABLE mensagens_regua
  DROP CONSTRAINT IF EXISTS mensagens_regua_linha_check;
ALTER TABLE mensagens_regua
  ADD CONSTRAINT mensagens_regua_linha_check CHECK (linha IN ('1', '2', '3'));

-- Troca a chave primária: sem isto, a segunda linha de uma mesma etapa/canal
-- seria recusada como duplicata.
ALTER TABLE mensagens_regua DROP CONSTRAINT IF EXISTS mensagens_regua_pkey;
ALTER TABLE mensagens_regua ADD PRIMARY KEY (etapa, canal, linha);

CREATE INDEX IF NOT EXISTS mensagens_regua_linha_idx ON mensagens_regua (linha, etapa);

COMMENT ON COLUMN mensagens_regua.linha IS
  'Qual das três versões da copy. A linha ativa é escolhida no painel e vale para todos os envios.';
