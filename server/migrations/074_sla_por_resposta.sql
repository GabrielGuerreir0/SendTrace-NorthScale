-- ═══════════════════════════════════════════════════════════════════════════
--  074 · SLA por resposta do agente (base da fila em lista e do painel de KPIs — pedido da Késsia, PDF de 05/10/2026, itens 7 e 8)
--
--  Uma linha por resposta enviada por support@ (respostas_agente, 069), com o tempo EM TURNO (073) que o agente levou:
--    · ordem 1 (1ª resposta)         = resposta − criação do caso;
--    · ordem ≥ 2 (2ª em diante)      = resposta − o PRIMEIRO e-mail do cliente que chegou depois da resposta anterior
--                                      (se o cliente não tem e-mail gravado nesse intervalo, a linha fica sem tempo e não entra em média).
--  Meta pela prioridade do caso (3 h Alta / 4 h Média, 073). O agente é o dono do board na hora da resposta (`board_id`).
--  Só cria uma view; não mexe em nenhum dado. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW email_ia.v_sla_respostas_agente AS
WITH r AS (
  SELECT ra.id, ra.caso_id, ra.board_id, ra.para_email, ra.enviado_em,
         row_number() OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS ordem,
         lag(ra.enviado_em) OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS resposta_anterior_em
    FROM email_ia.respostas_agente ra
   WHERE ra.caso_id IS NOT NULL
), i AS (
  SELECT r.*, s.prioridade_nivel,
         CASE WHEN r.ordem = 1 THEN s.criado_em
              ELSE (SELECT min(e.data_email) FROM email_ia.emails e
                     WHERE lower(e.remetente_email) = lower(r.para_email)
                       AND e.data_email > r.resposta_anterior_em AND e.data_email < r.enviado_em) END AS inicio_em
    FROM r JOIN email_ia.suporte_escalado s ON s.id = r.caso_id
), m AS (
  SELECT i.*, email_ia.sla_meta_minutos(i.prioridade_nivel) AS meta_min,
         CASE WHEN i.inicio_em IS NOT NULL THEN email_ia.minutos_em_turno(i.inicio_em, i.enviado_em, i.board_id) END AS minutos
    FROM i
)
SELECT m.id AS resposta_id, m.caso_id, m.board_id, m.ordem, (m.ordem = 1) AS primeira, m.prioridade_nivel, m.inicio_em, m.enviado_em,
       m.minutos, m.meta_min,
       CASE WHEN m.minutos IS NULL OR m.meta_min IS NULL THEN NULL ELSE m.minutos <= m.meta_min END AS dentro_da_meta
  FROM m;
COMMENT ON VIEW email_ia.v_sla_respostas_agente IS 'Tempo em turno de cada resposta do agente (1ª e 2ª em diante) e se ficou dentro da meta (074).';
