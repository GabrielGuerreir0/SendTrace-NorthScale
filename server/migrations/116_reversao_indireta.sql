-- ═══════════════════════════════════════════════════════════════════════════
--  116 · Suporte Humano — Reversão indireta automática (pedido da Késsia, 21/10/2026)
--
--  Ticket de Reembolso/Chargeback em que o nosso agente mandou o último e-mail, esperava resposta e o cliente sumiu é classificado sozinho:
--    Tipo de resolução = Reversão indireta - 10D / 30D / 60D / concluída - superior a 60D (pelos dias desde a ÚLTIMA mensagem do agente);
--    Detalhamento "Verificando - Ag. Cliente" vira "Cliente não retornou" (qualquer outro detalhamento não muda);
--    em dúvida sobre se a mensagem esperava resposta: Tipo de resolução = "Analisar - Possível caso de reversão indireta" (e nada mais muda).
--  A decisão "a mensagem esperava resposta?" é de uma IA (Claude) que lê SÓ o texto da última mensagem do agente. Cada decisão fica guardada aqui
--  (uma por ticket e por mensagem do agente): a IA não é chamada de novo para a mesma mensagem, e a faixa de dias acompanha o tempo sozinha.
--
--  Tudo nasce DESLIGADO: `reversao_indireta_ativo = false`. Com ele desligado a rotina não grava em ticket nenhum; só a simulação
--  (node api/reversaoIndiretaCli.js simular) roda e gera a planilha para conferência.
--  Os novos valores de Tipo de resolução ficam na lista da API (api/rotas/suporteEscaladoFicha.js); não há trava no banco.
--  Aditiva e idempotente. Desfazer: DROP TABLE email_ia.reversao_indireta_avaliacoes; DELETE FROM config_disparos WHERE chave LIKE 'reversao_indireta_%';
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.reversao_indireta_avaliacoes (
  id             bigserial PRIMARY KEY,
  caso_id        bigint       NOT NULL,                       -- email_ia.suporte_escalado.id (ticket principal)
  agente_em      timestamptz  NOT NULL,                       -- hora da última mensagem do agente que foi avaliada
  decisao        text         NOT NULL CHECK (decisao IN ('espera_resposta', 'nao_espera', 'duvida')),
  motivo         text,                                        -- uma frase da IA explicando
  modelo         text,
  avaliado_em    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (caso_id, agente_em)
);
COMMENT ON TABLE email_ia.reversao_indireta_avaliacoes IS 'Decisão da IA (116): a última mensagem do agente esperava resposta do cliente? Uma por ticket e por mensagem; evita chamar a IA de novo.';

CREATE TABLE IF NOT EXISTS email_ia.reversao_indireta_log (
  id            bigserial PRIMARY KEY,
  caso_id       bigint      NOT NULL,
  rodada_em     timestamptz NOT NULL DEFAULT now(),
  dias          integer     NOT NULL,
  tipo_antes    text,
  tipo_depois   text,
  detalhe_antes text,
  detalhe_depois text,
  decisao       text
);
CREATE INDEX IF NOT EXISTS reversao_indireta_log_caso ON email_ia.reversao_indireta_log (caso_id, rodada_em DESC);
COMMENT ON TABLE email_ia.reversao_indireta_log IS 'O que a rotina de reversão indireta gravou em cada ticket (116): antes e depois, para desfazer se preciso.';

INSERT INTO config_disparos (chave, valor) VALUES
  ('reversao_indireta_ativo', 'false'),          -- liga a gravação nos tickets (só depois de conferida a simulação)
  ('reversao_indireta_modelo', 'claude-haiku-4-5'),
  ('reversao_indireta_ultima_rodada', '')
ON CONFLICT (chave) DO NOTHING;

-- libera as tabelas novas para o papel de leitura (migração 115), se ele já existir
DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
