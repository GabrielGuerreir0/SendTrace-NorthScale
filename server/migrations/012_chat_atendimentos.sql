-- ═══════════════════════════════════════════════════════════════════════════
--  Histórico de atendimentos do chatbot de suporte.
--
--  O chat_resumo em disparos_pos_venda guarda só o ÚLTIMO atendimento — cada
--  conversa nova sobrescrevia a anterior. Esta tabela guarda TODOS: um
--  registro por conversa encerrada, com o desfecho e se houve risco de
--  chargeback. É daqui que a IA lê os últimos atendimentos do cliente antes
--  de responder (memória de verdade, não só a mais recente), e é daqui que o
--  painel mostra a linha do tempo no duplo clique.
--
--  A coluna antiga continua existindo e sendo atualizada (é o atalho "último
--  resumo" que a tabela de pedidos exibe) — quem escreve nas duas é a rota
--  POST /api/atendimentos/, numa tacada só.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_atendimentos (
  id                bigserial   PRIMARY KEY,
  email             text        NOT NULL,
  resumo            text        NOT NULL,
  -- 'resolvido (cliente retido)', 'escalado para humano', … — texto livre,
  -- curto, escrito pelo bot.
  desfecho          text,
  risco_chargeback  boolean     NOT NULL DEFAULT false,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE chat_atendimentos
  IS 'Um registro por conversa de suporte encerrada. A IA lê os últimos antes de responder.';

-- O acesso é sempre "os atendimentos DESTE cliente, do mais novo ao mais
-- antigo" — o índice cobre exatamente essa pergunta.
CREATE INDEX IF NOT EXISTS idx_chat_atendimentos_email
  ON chat_atendimentos (lower(email), criado_em DESC);
