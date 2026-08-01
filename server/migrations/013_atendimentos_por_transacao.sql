-- ═══════════════════════════════════════════════════════════════════════════
--  Atendimentos passam a ser CHAVEADOS pelo ID DE TRANSAÇÃO.
--
--  O e-mail identifica uma pessoa; a transação identifica UM pedido. Chavear
--  o atendimento pela transação amarra a conversa ao pedido certo — um
--  cliente com dois pedidos não mistura os históricos — e é o que o painel
--  mostra na linha: cada pedido com os seus próprios atendimentos.
--
--  O e-mail vira opcional (continua guardado quando conhecido, e serve de
--  fallback para achar histórico antigo). A rota POST resolve um a partir do
--  outro consultando a fila, então quem envia só a transação ainda ganha o
--  e-mail preenchido — e vice-versa.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_atendimentos
  ADD COLUMN IF NOT EXISTS transacao_id text;

ALTER TABLE chat_atendimentos
  ALTER COLUMN email DROP NOT NULL;

-- A pergunta agora é "os atendimentos DESTA transação, do mais novo ao mais
-- antigo" — o índice cobre exatamente isso.
CREATE INDEX IF NOT EXISTS idx_chat_atendimentos_transacao
  ON chat_atendimentos (transacao_id, criado_em DESC);

-- Registros de antes desta migração eram só por e-mail: ganham a transação
-- do pedido mais recente daquele e-mail, para o histórico não se partir em
-- "antes" e "depois".
UPDATE chat_atendimentos ca
SET transacao_id = (
  SELECT d.transacao_id
  FROM disparos_pos_venda d
  WHERE lower(d.email) = lower(ca.email)
  ORDER BY d.criado_em DESC
  LIMIT 1
)
WHERE ca.transacao_id IS NULL AND ca.email IS NOT NULL;
