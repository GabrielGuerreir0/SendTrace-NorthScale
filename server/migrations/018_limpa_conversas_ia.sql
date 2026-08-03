-- ═══════════════════════════════════════════════════════════════════════════
--  LIMPEZA ÚNICA: zera os dados de conversas da IA para recomeçar os testes.
--
--  Apaga o histórico de atendimentos, o backlog de perguntas sem resposta e
--  o espelho de "último atendimento" nos pedidos. Os TÓPICOS voltam à semente
--  canônica: os criados pelas conversas de teste saem junto.
--
--  A FILA (disparos_pos_venda) não é tocada além das duas colunas de espelho.
--
--  Este arquivo é descartável por desenho: depois de aplicado em produção
--  (fica registrado em painel_migracoes), ele é REMOVIDO do repositório —
--  uma migração destrutiva não pode ficar à espreita de uma instalação nova.
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE chat_atendimentos RESTART IDENTITY;
TRUNCATE chat_perguntas_sem_resposta RESTART IDENTITY;

UPDATE disparos_pos_venda
   SET chat_resumo = NULL, chat_resumo_em = NULL
 WHERE chat_resumo IS NOT NULL OR chat_resumo_em IS NOT NULL;

-- Tópicos criados durante os testes saem; a semente canônica fica.
DELETE FROM chat_topicos
 WHERE slug NOT IN ('rastreamento', 'reembolso', 'cancelamento',
                    'pedido_duplicado', 'uso_do_produto', 'cobranca',
                    'endereco', 'outro');
