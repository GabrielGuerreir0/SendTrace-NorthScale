-- ═══════════════════════════════════════════════════════════════════════════
--  087 · Fila de saída das respostas do Suporte Humano (pedido do Lucas, 07/10/2026)
--
--  Responder pelo SendTrace levava vários segundos porque a tela esperava a SMTP da Hostinger e a cópia em Enviados. Agora a API grava a
--  resposta aqui e devolve na hora; um envio em segundo plano (a cada poucos segundos, e logo que a resposta entra) manda o e-mail,
--  registra em `respostas_agente` (o que move o card e fecha o SLA) e guarda a cópia em Enviados.
--    fila → enviando → enviado     (falha: volta para fila com espera maior, até 3 tentativas; depois "falhou" e a tela avisa o agente)
--  O Message-ID é definido na entrada, então a tela e o webmail enxergam a mesma mensagem. Só cria tabela e índice. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.respostas_fila (
  id                  bigserial PRIMARY KEY,
  caso_id             bigint NOT NULL REFERENCES email_ia.suporte_escalado(id) ON DELETE CASCADE,
  board_id            bigint,
  para_email          text NOT NULL,
  assunto             text,
  texto               text NOT NULL,
  message_id          text NOT NULL UNIQUE,
  criado_por          text,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'fila' CHECK (status IN ('fila', 'enviando', 'enviado', 'falhou')),
  tentativas          integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  erro                text,
  enviado_em          timestamptz
);
CREATE INDEX IF NOT EXISTS respostas_fila_pendentes_idx ON email_ia.respostas_fila (status, proxima_tentativa_em) WHERE status IN ('fila', 'enviando');
CREATE INDEX IF NOT EXISTS respostas_fila_caso_idx ON email_ia.respostas_fila (caso_id, criado_em DESC);
COMMENT ON TABLE email_ia.respostas_fila IS 'Respostas do agente ao cliente aguardando/concluindo o envio por SMTP (087). enviado = já está em respostas_agente.';
