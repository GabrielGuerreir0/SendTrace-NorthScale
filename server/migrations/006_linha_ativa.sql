-- ═══════════════════════════════════════════════════════════════════════════
--  006 · Linha de mensagens ativa (Linha 1 / 2 / 3)
--
--  O n8n expõe um webhook que troca qual das três versões da copy está ativa,
--  mas NÃO expõe consulta: não dá para perguntar "qual está valendo agora".
--
--  Por isso o painel guarda a última troca aqui, no banco — e não no
--  localStorage do navegador. A linha ativa é uma configuração GLOBAL: se
--  ficasse no navegador, cada administrador veria um valor diferente conforme
--  o computador de onde tivesse trocado da última vez, e quem nunca trocou não
--  veria nada.
--
--  Fica explícito que isto é ÚLTIMO VALOR CONHECIDO, não fonte da verdade: se
--  alguém chamar o webhook por fora do painel, este registro fica velho. A
--  interface diz isso na tela em vez de fingir certeza.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS painel_linha_mensagens (
  -- Uma linha só na tabela. O CHECK garante isso: é configuração global,
  -- não histórico de entidades.
  id           smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  linha        text         NOT NULL CHECK (linha IN ('1', '2', '3')),
  trocada_em   timestamptz  NOT NULL DEFAULT now(),
  trocada_por  bigint       REFERENCES painel_usuarios(id) ON DELETE SET NULL,
  -- Resposta crua do webhook, para depurar divergência sem adivinhar.
  resposta     text
);

COMMENT ON TABLE painel_linha_mensagens IS
  'Última linha de copy ativada PELO PAINEL. Não é fonte da verdade: o n8n não tem endpoint de consulta.';

-- Histórico das trocas. Uma mudança global de campanha sem registro de quem
-- fez e quando é a primeira coisa que falta quando um número muda de repente.
CREATE TABLE IF NOT EXISTS painel_linha_historico (
  id           bigserial    PRIMARY KEY,
  linha        text         NOT NULL,
  em           timestamptz  NOT NULL DEFAULT now(),
  por          bigint       REFERENCES painel_usuarios(id) ON DELETE SET NULL,
  sucesso      boolean      NOT NULL,
  detalhe      text
);

CREATE INDEX IF NOT EXISTS painel_linha_historico_em_idx ON painel_linha_historico (em DESC);
