-- ═══════════════════════════════════════════════════════════════════════════
--  075 · v_sla_respostas_agente só olha casos dos últimos 90 dias (074)
--
--  A view calcula os minutos de turno de CADA resposta toda vez que é lida (fila em lista a cada 30 s e painel de KPIs). Sem limite, o custo
--  cresce com o histórico inteiro; os painéis só usam janelas de até 30 dias. Casos com mais de 90 dias saem da view (os dados seguem em
--  respostas_agente). A ordem (1ª, 2ª…) continua certa porque o corte é pelo caso, não pela resposta. Só recria a view. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW email_ia.v_sla_respostas_agente AS
WITH r AS (
  SELECT ra.id, ra.caso_id, ra.board_id, ra.para_email, ra.enviado_em,
         row_number() OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS ordem,
         lag(ra.enviado_em) OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS resposta_anterior_em
    FROM email_ia.respostas_agente ra
    JOIN email_ia.suporte_escalado c ON c.id = ra.caso_id AND c.criado_em >= now() - interval '90 days'
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
COMMENT ON VIEW email_ia.v_sla_respostas_agente IS 'Tempo em turno de cada resposta do agente (1ª e 2ª em diante) e se ficou dentro da meta; casos dos últimos 90 dias (074/075).';
