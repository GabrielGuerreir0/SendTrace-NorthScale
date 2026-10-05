-- ═══════════════════════════════════════════════════════════════════════════
--  066 · Campos do agente no Suporte Escalado: Propriedades, Logística e Ajuda (pedido da Késsia, PDF de 05/10/2026)
--
--  1º bloco — Propriedades: motivo do contato, detalhamento, tipo de resolução e status do ticket (listas suspensas).
--  2º bloco — Logística: reenvio (motivo, quantidade 1–30, produto, observação), endereço em caso de divergência, novo rastreio e responsável.
--  3º bloco — Ajuda: o agente escala o caso a alguém da equipe com uma nota; fica registrado quem pediu e quando e quem respondeu e quando.
--
--  Uma linha de ficha por caso (criada no primeiro salvamento). Os valores das listas são validados pela API (lista fechada em
--  api/rotas/suporteEscaladoFicha.js), não por CHECK: assim a equipe pode pedir uma opção nova sem migração.
--  O "Motivo do contato" (escolhido pelo agente) NÃO é a tag automática do caso (065).
--  Só cria tabelas: não mexe em casos, status, boards nem envia e-mail. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_ficha (
  suporte_escalado_id   bigint PRIMARY KEY REFERENCES email_ia.suporte_escalado(id) ON DELETE CASCADE,
  -- Propriedades
  motivo_contato        text,
  detalhamento_motivo   text,
  tipo_resolucao        text,
  status_ticket         text,
  -- Logística
  motivo_reenvio        text,
  quantidade_reenvio    smallint CHECK (quantidade_reenvio IS NULL OR quantidade_reenvio BETWEEN 1 AND 30),
  produto_reenvio       text,
  observacao_reenvio    text,
  endereco_divergencia  text,
  novo_rastreio         text,
  responsavel_board_id  bigint REFERENCES email_ia.suporte_escalado_boards(id) ON DELETE SET NULL,
  atualizado_por        text,
  atualizado_em         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_ia.suporte_escalado_ficha IS 'Campos preenchidos pelo agente num caso do Suporte Escalado (066): Propriedades e Logística.';

CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_ajuda (
  id                    bigserial PRIMARY KEY,
  suporte_escalado_id   bigint NOT NULL REFERENCES email_ia.suporte_escalado(id) ON DELETE CASCADE,
  pedido_por            text NOT NULL,
  para_board_id         bigint NOT NULL REFERENCES email_ia.suporte_escalado_boards(id),
  nota                  text NOT NULL,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  resposta              text,
  respondido_por        text,
  respondido_em         timestamptz
);
CREATE INDEX IF NOT EXISTS suporte_escalado_ajuda_caso_idx ON email_ia.suporte_escalado_ajuda (suporte_escalado_id, criado_em);
CREATE INDEX IF NOT EXISTS suporte_escalado_ajuda_abertas_idx ON email_ia.suporte_escalado_ajuda (para_board_id) WHERE respondido_em IS NULL;
COMMENT ON TABLE email_ia.suporte_escalado_ajuda IS 'Pedidos de ajuda de um agente a alguém da equipe (066): quem pediu/quando, quem respondeu/quando.';
