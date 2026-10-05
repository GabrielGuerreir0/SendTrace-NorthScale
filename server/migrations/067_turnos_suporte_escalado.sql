-- ═══════════════════════════════════════════════════════════════════════════
--  067 · Turnos dos agentes do Suporte Escalado (pedido da Késsia, PDF de 05/10/2026, itens 4 e 5)
--
--  Grupos de turno (horário de Brasília, segunda a sexta) e quem trabalha em cada um. Uma pessoa pode estar em mais de um turno,
--  conforme o admin definir. "Disponível para receber tickets" continua sendo o `ativo` do board: o agente disponível recebe card a
--  qualquer hora; o turno só vai definir QUANDO o SLA conta (cálculo do SLA é outra entrega: esta migração não calcula nada).
--  Turnos iniciais, do PDF: 1º 08:00–15:00, 2º 10:00–17:00, 3º 15:00–22:00 (ninguém atribuído até o admin escolher).
--  Só cria tabelas e os 3 grupos iniciais. Não mexe em casos, boards nem roteador. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_turnos (
  id           bigserial PRIMARY KEY,
  nome         text NOT NULL,
  inicio       time NOT NULL,
  fim          time NOT NULL,
  dias_semana  smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  criado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suporte_escalado_turnos_horario_chk CHECK (fim > inicio)
);
COMMENT ON TABLE email_ia.suporte_escalado_turnos IS 'Grupos de turno do Suporte Escalado (067). Horário de America/Sao_Paulo; dias_semana 1=segunda … 7=domingo.';

CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_turno_agentes (
  turno_id  bigint NOT NULL REFERENCES email_ia.suporte_escalado_turnos(id) ON DELETE CASCADE,
  board_id  bigint NOT NULL REFERENCES email_ia.suporte_escalado_boards(id) ON DELETE CASCADE,
  PRIMARY KEY (turno_id, board_id)
);
COMMENT ON TABLE email_ia.suporte_escalado_turno_agentes IS 'Quem trabalha em cada turno (067). Uma pessoa pode estar em mais de um.';

INSERT INTO email_ia.suporte_escalado_turnos (nome, inicio, fim)
SELECT v.nome, v.inicio::time, v.fim::time
  FROM (VALUES ('1º turno', '08:00', '15:00'), ('2º turno', '10:00', '17:00'), ('3º turno', '15:00', '22:00')) AS v(nome, inicio, fim)
 WHERE NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado_turnos);
