-- ═══════════════════════════════════════════════════════════════════════════
--  QUANDO a conversa aconteceu — não quando foi gravada.
--
--  `criado_em` marca o fechamento do registro: para conversa abandonada, isso
--  é 30+ minutos DEPOIS do cliente sair. O filtro de tempo do dashboard deve
--  recortar pelo momento em que a conversa começou; esta coluna guarda isso,
--  enviada pelo bot (Conversation.startedAt). Anulável: nos registros antigos
--  o fechamento continua sendo a melhor aproximação, e as consultas usam
--  coalesce(iniciado_em, criado_em).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_atendimentos
  ADD COLUMN IF NOT EXISTS iniciado_em timestamptz;

COMMENT ON COLUMN chat_atendimentos.iniciado_em
  IS 'Quando a conversa COMEÇOU (primeira mensagem). Nulo = registro antigo; use criado_em.';

-- O filtro de tempo passa a perguntar por esta expressão.
CREATE INDEX IF NOT EXISTS idx_chat_atendimentos_inicio
  ON chat_atendimentos (coalesce(iniciado_em, criado_em) DESC);
