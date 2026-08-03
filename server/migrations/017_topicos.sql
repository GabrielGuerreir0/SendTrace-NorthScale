-- ═══════════════════════════════════════════════════════════════════════════
--  Tópicos de contato — o vocabulário de motivos vira TABELA.
--
--  Antes o motivo era texto solto em chat_atendimentos. Como tabela, cada
--  tópico carrega uma DESCRIÇÃO — e é ela que a IA lê para decidir se o
--  assunto de uma conversa nova se enquadra num tópico existente ou merece
--  um novo. Texto solto não tinha onde guardar esse critério.
--
--  A coluna `motivo` (slug) continua preenchida e em sincronia: é a chave de
--  compatibilidade — as consultas de tendência e o histórico não quebram.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_topicos (
  id         bigserial   PRIMARY KEY,
  -- A chave estável, em slug ('rastreamento', 'brinde_nao_recebido').
  slug       text        NOT NULL UNIQUE,
  -- O rótulo humano que a dash mostra ('Tracking / Onde está meu pedido').
  nome       text        NOT NULL,
  -- O que CABE neste tópico — o critério de encaixe que a IA lê. Sem isto,
  -- "enquadra ou não enquadra" seria adivinhação sobre um nome de 3 palavras.
  descricao  text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE chat_topicos
  IS 'Os assuntos de contato do suporte. A IA lê as descrições para encaixar conversas novas; cria tópico quando nenhum se enquadra.';

ALTER TABLE chat_atendimentos
  ADD COLUMN IF NOT EXISTS topico_id bigint REFERENCES chat_topicos(id);

CREATE INDEX IF NOT EXISTS idx_chat_atendimentos_topico
  ON chat_atendimentos (topico_id);

-- A semente: os tópicos canônicos, com o critério de cada um por escrito.
INSERT INTO chat_topicos (slug, nome, descricao) VALUES
  ('rastreamento',     'Tracking / Onde está meu pedido', 'Onde está o pedido: rastreio, prazo de entrega, pedido atrasado ou que ainda não chegou.'),
  ('reembolso',        'Pedido de reembolso',             'O cliente pede o dinheiro de volta: reembolso, estorno, garantia de devolução.'),
  ('cancelamento',     'Cancelamento',                    'Cancelar o pedido ou a assinatura, antes ou depois do envio.'),
  ('pedido_duplicado', 'Pedido duplicado',                'Compra ou cobrança em dobro: dois pedidos iguais, cobrado duas vezes.'),
  ('uso_do_produto',   'Como utilizar o produto',         'Como usar: dose, modo de uso, instruções, o que esperar do produto.'),
  ('cobranca',         'Cobrança / Pagamento',            'Cobrança e pagamento: valor errado, fatura, cartão, cobrança não reconhecida.'),
  ('endereco',         'Troca de endereço',               'Mudar o endereço de entrega ou os dados de envio.'),
  ('outro',            'Outros assuntos',                 'O que não se enquadra em nenhum outro tópico.')
ON CONFLICT (slug) DO NOTHING;

-- Religa o histórico: atendimento que já tem motivo aponta para o tópico de
-- mesmo slug. Motivos antigos sem tópico correspondente viram tópicos novos
-- (nome legível a partir do slug), para nenhuma conversa ficar órfã.
INSERT INTO chat_topicos (slug, nome)
SELECT DISTINCT a.motivo, initcap(replace(a.motivo, '_', ' '))
FROM chat_atendimentos a
WHERE a.motivo IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chat_topicos t WHERE t.slug = a.motivo)
ON CONFLICT (slug) DO NOTHING;

UPDATE chat_atendimentos a
   SET topico_id = t.id
  FROM chat_topicos t
 WHERE a.topico_id IS NULL AND a.motivo = t.slug;
