-- ═══════════════════════════════════════════════════════════════════════════
--  O dashboard do suporte IA: o que cada conversa PRODUZIU, em colunas.
--
--  O resumo em texto já existia; o que faltava era o que se conta: qual o
--  motivo do contato, se a IA resolveu, se havia pedido de reembolso e se ele
--  foi revertido, quanto durou, em que etapa da régua o cliente estava e a
--  nota que ele deu no fim. Sem isso, cada KPI do dashboard exigiria reler
--  todos os resumos com uma IA — caro, lento e não-auditável.
--
--  Tudo ANULÁVEL de propósito: as conversas antigas não têm esses dados, e o
--  bot de uma versão anterior continua gravando sem eles. NULL = "não
--  informado", e as taxas são calculadas só sobre quem informou.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_atendimentos
  -- O motivo do contato, num vocabulário curto que o bot escolhe:
  -- 'rastreamento', 'reembolso', 'cancelamento', 'pedido_duplicado',
  -- 'uso_do_produto', 'cobranca', 'endereco', 'outro'. Texto livre (sem
  -- CHECK) para um motivo novo entrar sem migração — o ranking agrupa
  -- pelo valor gravado.
  ADD COLUMN IF NOT EXISTS motivo            text,
  -- A IA fechou sozinha? true = resolvida (retida, orientada ou reembolso
  -- emitido pela própria IA); false = escalada para humano / abandonada.
  ADD COLUMN IF NOT EXISTS resolvido         boolean,
  -- O cliente PEDIU reembolso nesta conversa?
  ADD COLUMN IF NOT EXISTS reembolso_pedido  boolean NOT NULL DEFAULT false,
  -- Dos que pediram: a IA reverteu (cliente retido)? NULL quando não houve
  -- pedido — uma taxa sobre zero pedidos não existe.
  ADD COLUMN IF NOT EXISTS reembolso_evitado boolean,
  -- Nota de satisfação (1–5 estrelas), dada pelo cliente ao fim. NULL = não
  -- avaliou; a média é só sobre quem avaliou.
  ADD COLUMN IF NOT EXISTS csat              smallint CHECK (csat BETWEEN 1 AND 5),
  -- Duração da conversa em segundos (primeira mensagem → encerramento).
  ADD COLUMN IF NOT EXISTS duracao_s         integer,
  -- Em que etapa da régua o pedido estava quando o cliente chamou — é a
  -- "performance da régua": onde na jornada nascem os contatos. Preenchida
  -- pela API na gravação, a partir do pedido; o bot não precisa saber.
  ADD COLUMN IF NOT EXISTS etapa_regua       integer;

COMMENT ON COLUMN chat_atendimentos.motivo
  IS 'Motivo do contato (rastreamento, reembolso, cancelamento, pedido_duplicado, uso_do_produto, cobranca, endereco, outro).';
COMMENT ON COLUMN chat_atendimentos.resolvido
  IS 'true = a IA fechou sozinha; false = escalada/abandonada; NULL = conversa de antes da coluna.';
COMMENT ON COLUMN chat_atendimentos.reembolso_evitado
  IS 'Dos pedidos de reembolso: a IA reverteu? NULL quando não houve pedido.';
COMMENT ON COLUMN chat_atendimentos.etapa_regua
  IS 'Etapa da régua em que o pedido estava no momento do contato.';

-- O dashboard pergunta sempre por janela de tempo ("últimos N dias", "24h ×
-- 24h anteriores") — sem este índice, cada KPI varreria a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_chat_atendimentos_criado
  ON chat_atendimentos (criado_em DESC);

-- ═══════════════════════════════════════════════════════════════════════════
--  Perguntas que a IA NÃO conseguiu responder — o backlog da base de
--  conhecimento. Uma linha por ocorrência (não um contador): é o que permite
--  ver "31 vezes, sendo 12 nesta semana" e ler exemplos reais da frase.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_perguntas_sem_resposta (
  id            bigserial   PRIMARY KEY,
  -- A pergunta como o cliente fez (curta; o bot corta antes de mandar).
  pergunta      text        NOT NULL,
  transacao_id  text,
  email         text,
  produto       text,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE chat_perguntas_sem_resposta
  IS 'Uma linha por pergunta que a IA não soube responder. O ranking agrupa por texto normalizado.';

-- O ranking agrupa por texto em minúsculas; a janela recorta por data.
CREATE INDEX IF NOT EXISTS idx_chat_perguntas_texto
  ON chat_perguntas_sem_resposta (lower(pergunta));
CREATE INDEX IF NOT EXISTS idx_chat_perguntas_criado
  ON chat_perguntas_sem_resposta (criado_em DESC);
