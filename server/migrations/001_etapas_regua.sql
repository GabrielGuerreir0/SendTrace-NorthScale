-- ═══════════════════════════════════════════════════════════════════════════
--  001 · etapas_regua — a CADÊNCIA da régua (quando cada etapa dispara)
--
--  Só a estrutura mínima. Quem descreve o QUE cada etapa envia é a tabela
--  mensagens_regua, criada na 002 — porque toda etapa dispara e-mail e SMS ao
--  mesmo tempo, então o canal é atributo da mensagem, não da etapa.
--
--  A semente também vive na 002, junto com a copy. Aqui não entra nenhuma
--  linha: uma régua sem mensagem não significa nada.
--
--  IDEMPOTENTE e NÃO toca em disparos_pos_venda.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS etapas_regua (
  -- Casa com disparos_pos_venda.etapa_atual (smallint, começa em 0).
  etapa         smallint     PRIMARY KEY,

  nome          text         NOT NULL,
  -- Horas de espera ATÉ A PRÓXIMA etapa. NULL na última etapa da régua.
  -- A 002 promove para numeric: a etapa 0 dispara em 30 min, não em horas
  -- inteiras, então a espera dela até o Dia 1 é 23,5 h.
  espera_h      integer      CHECK (espera_h IS NULL OR espera_h >= 0),
  -- Etapa desligada continua aparecendo no painel, mas marcada como inativa,
  -- para você enxergar quem ficou parado nela depois de desativá-la.
  ativo         boolean      NOT NULL DEFAULT true,

  descricao     text,
  atualizado_em timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE etapas_regua IS 'Cadência da régua de pós-venda: quando cada etapa dispara. A copy fica em mensagens_regua.';
COMMENT ON COLUMN etapas_regua.ativo IS 'false = etapa desativada; o painel ainda mostra quem ficou parado nela.';
