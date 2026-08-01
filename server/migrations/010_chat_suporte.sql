-- ═══════════════════════════════════════════════════════════════════════════
--  Resumo do chat de suporte, por pedido.
--
--  Quem escreve aqui é OUTRA aplicação: o chatbot de suporte. Ao fim de uma
--  conversa, ele localiza o pedido pelo E-MAIL do cliente (a coluna já
--  existe) e grava um resumo do atendimento — assim o painel e os próximos
--  atendimentos enxergam o histórico sem ter que reler a conversa inteira.
--
--  Colunas NOVAS e anuláveis de propósito: o worker do n8n e o painel não
--  as conhecem, e um DEFAULT obrigatório quebraria o INSERT que eles fazem.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE disparos_pos_venda
  ADD COLUMN IF NOT EXISTS chat_resumo    text,
  ADD COLUMN IF NOT EXISTS chat_resumo_em timestamptz;

COMMENT ON COLUMN disparos_pos_venda.chat_resumo
  IS 'Resumo do atendimento gravado pelo chatbot de suporte. Nulo = nunca houve chat.';
COMMENT ON COLUMN disparos_pos_venda.chat_resumo_em
  IS 'Quando o chatbot gravou/atualizou o resumo pela última vez.';

-- O bot chega pelo e-mail, não pelo id. Sem índice, cada busca dele varre a
-- fila inteira. Em minúsculas porque é assim que a rota compara: o mesmo
-- cliente digita Ana@x.com num dia e ana@x.com no outro.
CREATE INDEX IF NOT EXISTS idx_disparos_email
  ON disparos_pos_venda (lower(email));
