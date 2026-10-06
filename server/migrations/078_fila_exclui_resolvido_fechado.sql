-- ═══════════════════════════════════════════════════════════════════════════
--  078 · Ticket "Resolvido" ou "Fechado" (campo "Status do ticket" da ficha, em Propriedades) sai da fila do agente e do SLA (pedido do Lucas, 06/10/2026)
--
--  A fila e o painel só olhavam o status do card no Kanban; o PDF da Késsia diz que o agente classifica o ticket nas propriedades. Agora, com a ficha em
--  Resolvido ou Fechado, o caso deixa de contar como aberto (sem cobrança de SLA, sem aparecer na fila). Voltou para Aberto/Pendente: volta. Não mexe no Kanban.
--  Só recria a view v_sla_suporte_escalado. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, s.criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         (s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')
            AND coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')) AS aberto,
         (s.primeira_resposta_agente_em IS NOT NULL AND s.ultimo_email_cliente_em IS NOT NULL AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
            AND s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')
            AND coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')) AS vez_do_agente
    FROM email_ia.suporte_escalado s
    LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
), c AS (
  SELECT b.*,
         CASE WHEN b.primeira_resposta_agente_em IS NOT NULL OR b.aberto
              THEN email_ia.minutos_em_turno(b.criado_em, coalesce(b.primeira_resposta_agente_em, now()), b.board_id) END AS primeira_resposta_min,
         CASE WHEN b.vez_do_agente
              THEN email_ia.minutos_em_turno(b.ultimo_email_cliente_em, now(), b.board_id) END AS vez_agente_min
    FROM base b
)
SELECT c.caso_id, c.board_id, c.status, c.prioridade_nivel, c.tag_motivo, c.criado_em, c.meta_min,
       c.primeira_resposta_agente_em, c.primeira_resposta_min,
       CASE WHEN c.meta_min IS NULL OR c.primeira_resposta_min IS NULL THEN NULL
            WHEN c.primeira_resposta_min > c.meta_min THEN 'estourado'
            WHEN c.primeira_resposta_agente_em IS NULL THEN 'em_andamento'
            ELSE 'dentro' END AS primeira_resposta_sla,
       c.vez_do_agente, c.ultimo_email_cliente_em, c.vez_agente_min,
       CASE WHEN c.meta_min IS NULL OR c.vez_agente_min IS NULL THEN NULL
            WHEN c.vez_agente_min > c.meta_min THEN 'estourado'
            ELSE 'em_andamento' END AS vez_agente_sla
  FROM c;
COMMENT ON VIEW email_ia.v_sla_suporte_escalado IS 'SLA dentro do turno por caso: 1ª resposta e vez do agente (2ª em diante); metas 3 h Alta / 4 h Média (073).';
