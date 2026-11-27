-- ═════════════════════════════════════════════════════════════════════════
--  144 · SLA: ticket antigo sem resposta conta do ÚLTIMO e-mail que pede resposta, não da criação do ticket (pedido da Késsia, 26/11/2026)
--
--  Sintoma: tickets abertos há meses (ex.: criados em agosto) em que o cliente voltou a escrever mostravam "estourado há 900 h", porque a 1ª
--  resposta contava desde a CRIAÇÃO do ticket. O prazo de cada e-mail deve contar a partir do momento em que aquele e-mail chegou.
--  Regra nova (continua a da 139: só e-mail com `pede_resposta IS NOT FALSE` conta; não analisado entra como "pede"):
--    · 1ª resposta pendente: o relógio parte do último e-mail que pede resposta (nunca antes da criação/sla_inicio_em do ticket);
--    · 1ª resposta já dada (métrica do agente): início = último e-mail que pede resposta antes da resposta (nunca antes da criação/sla_inicio_em);
--    · da 2ª resposta em diante e "vez do agente": igual à 139 (não muda).
--  Colunas novas do ticket iniciado pela equipe (143, idempotentes aqui também): origem = 'equipe' nasce com primeira/última resposta do agente já
--  preenchidas, então não tem relógio de agente até o cliente escrever — nada a tratar nas views.
--  Mesmas colunas das views de antes. As views são calculadas na leitura: o histórico das métricas se corrige sozinho. Idempotente.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS iniciado_por text;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS iniciado_pela_equipe_em timestamptz;

CREATE OR REPLACE VIEW email_ia.v_sla_respostas_agente AS
WITH r AS (
  SELECT ra.id, ra.caso_id, ra.board_id, ra.para_email, ra.enviado_em,
         row_number() OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS ordem,
         lag(ra.enviado_em) OVER (PARTITION BY ra.caso_id ORDER BY ra.enviado_em, ra.id) AS resposta_anterior_em
    FROM email_ia.respostas_agente ra
    JOIN email_ia.suporte_escalado c ON c.id = ra.caso_id AND c.criado_em >= (now() - interval '90 days')
   WHERE ra.caso_id IS NOT NULL
), i AS (
  SELECT r.id, r.caso_id, r.board_id, r.para_email, r.enviado_em, r.ordem, r.resposta_anterior_em, s.prioridade_nivel,
         CASE WHEN r.ordem = 1 THEN
                GREATEST(COALESCE(s.sla_inicio_em, s.criado_em),
                         COALESCE((SELECT max(e.data_email) FROM email_ia.emails e
                                    WHERE lower(e.remetente_email) = lower(r.para_email)
                                      AND e.data_email >= COALESCE(s.sla_inicio_em, s.criado_em) AND e.data_email < r.enviado_em
                                      AND e.pede_resposta IS NOT FALSE),
                                  COALESCE(s.sla_inicio_em, s.criado_em)))
              ELSE COALESCE(
                     (SELECT min(e.data_email) FROM email_ia.emails e
                       WHERE lower(e.remetente_email) = lower(r.para_email)
                         AND e.data_email > r.resposta_anterior_em AND e.data_email < r.enviado_em
                         AND e.pede_resposta IS NOT FALSE),
                     (SELECT min(e.data_email) FROM email_ia.emails e
                       WHERE lower(e.remetente_email) = lower(r.para_email)
                         AND e.data_email > r.resposta_anterior_em AND e.data_email < r.enviado_em)) END AS inicio_em
    FROM r JOIN email_ia.suporte_escalado s ON s.id = r.caso_id
), m AS (
  SELECT i.id, i.caso_id, i.board_id, i.para_email, i.enviado_em, i.ordem, i.resposta_anterior_em, i.prioridade_nivel, i.inicio_em,
         email_ia.sla_meta_minutos(i.prioridade_nivel) AS meta_min,
         CASE WHEN i.inicio_em IS NOT NULL THEN email_ia.minutos_sla(i.inicio_em, i.enviado_em, i.board_id) ELSE NULL::numeric END AS minutos
    FROM i
)
SELECT m.id AS resposta_id, m.caso_id, m.board_id, m.ordem, (m.ordem = 1) AS primeira, m.prioridade_nivel, m.inicio_em, m.enviado_em,
       m.minutos, m.meta_min,
       CASE WHEN m.minutos IS NULL OR m.meta_min IS NULL THEN NULL::boolean ELSE m.minutos <= m.meta_min::numeric END AS dentro_da_meta
  FROM m;

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, s.criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         COALESCE(fi.status_ticket, '') = 'Pendente' AS pausado,
         (s.status = ANY (ARRAY['pendente','iniciado','lead_respondeu','esperando_resposta','em_analise','pendente_consulta','pendente_recorrencia'])
            AND COALESCE(fi.status_ticket, '') <> ALL (ARRAY['Resolvido','Fechado'])) AS aberto,
         (s.primeira_resposta_agente_em IS NOT NULL AND s.ultimo_email_cliente_em IS NOT NULL
            AND s.ultimo_email_cliente_em > COALESCE(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
            AND s.status = ANY (ARRAY['pendente','iniciado','lead_respondeu','esperando_resposta','em_analise','pendente_consulta','pendente_recorrencia'])
            AND COALESCE(fi.status_ticket, '') <> ALL (ARRAY['Resolvido','Fechado'])
            AND (pe.qtd = 0 OR pe.ultimo_pede_em IS NOT NULL)) AS vez_do_agente,
         COALESCE(pe.ultimo_pede_em, s.ultimo_email_cliente_em) AS vez_inicio_em,
         -- 1ª resposta (pendente ou dada): o relógio parte do último e-mail que pede resposta antes dela (nunca antes da criação do ticket)
         GREATEST(s.criado_em, COALESCE(pf.ultimo_pede_em, s.criado_em)) AS primeira_inicio_em
    FROM email_ia.suporte_escalado s
    LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
    LEFT JOIN LATERAL (SELECT max(e.data_email) FILTER (WHERE e.pede_resposta IS NOT FALSE) AS ultimo_pede_em
                         FROM email_ia.emails e
                        WHERE lower(e.remetente_email) = lower(s.remetente_email)
                          AND e.data_email >= s.criado_em
                          AND e.data_email < COALESCE(s.primeira_resposta_agente_em, 'infinity'::timestamptz)) pf ON true
    LEFT JOIN LATERAL (SELECT count(*) AS qtd, max(e.data_email) FILTER (WHERE e.pede_resposta IS NOT FALSE) AS ultimo_pede_em
                         FROM email_ia.emails e
                        WHERE lower(e.remetente_email) = lower(s.remetente_email)
                          AND e.data_email > COALESCE(s.ultima_resposta_agente_em, '-infinity'::timestamptz)) pe ON true
), c AS (
  SELECT b.caso_id, b.board_id, b.status, b.prioridade_nivel, b.tag_motivo, b.criado_em, b.primeira_resposta_agente_em, b.ultima_resposta_agente_em,
         b.ultimo_email_cliente_em, b.meta_min, b.pausado, b.aberto, b.vez_do_agente,
         CASE WHEN b.primeira_resposta_agente_em IS NOT NULL OR b.aberto
              THEN GREATEST(0::numeric, email_ia.minutos_sla(b.primeira_inicio_em, COALESCE(b.primeira_resposta_agente_em, now()), b.board_id)
                                        - email_ia.minutos_pausados(b.caso_id, b.primeira_inicio_em, COALESCE(b.primeira_resposta_agente_em, now()), b.board_id))
              ELSE NULL::numeric END AS primeira_resposta_min,
         CASE WHEN b.vez_do_agente
              THEN GREATEST(0::numeric, email_ia.minutos_sla(b.vez_inicio_em, now(), b.board_id)
                                        - email_ia.minutos_pausados(b.caso_id, b.vez_inicio_em, now(), b.board_id))
              ELSE NULL::numeric END AS vez_agente_min
    FROM base b
)
SELECT c.caso_id, c.board_id, c.status, c.prioridade_nivel, c.tag_motivo, c.criado_em, c.meta_min,
       c.primeira_resposta_agente_em, c.primeira_resposta_min,
       CASE WHEN c.meta_min IS NULL OR c.primeira_resposta_min IS NULL THEN NULL::text
            WHEN c.primeira_resposta_min > c.meta_min::numeric THEN 'estourado'
            WHEN c.primeira_resposta_agente_em IS NULL THEN 'em_andamento'
            ELSE 'dentro' END AS primeira_resposta_sla,
       c.vez_do_agente, c.ultimo_email_cliente_em, c.vez_agente_min,
       CASE WHEN c.meta_min IS NULL OR c.vez_agente_min IS NULL THEN NULL::text
            WHEN c.vez_agente_min > c.meta_min::numeric THEN 'estourado'
            ELSE 'em_andamento' END AS vez_agente_sla,
       c.pausado
  FROM c;
