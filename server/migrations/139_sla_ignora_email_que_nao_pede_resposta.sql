-- ═════════════════════════════════════════════════════════════════════════
--  139 · SLA: e-mail do cliente marcado "não pede resposta" não puxa o relógio do e-mail novo (pedido da Késsia, 26/11/2026)
--
--  Sintoma: o cliente manda um agradecimento (a equipe decide não responder); dias depois manda uma dúvida. Ao responder a dúvida, o SLA da
--  resposta contava desde o agradecimento e registrava violação contra o agente.
--  Causa: em `v_sla_respostas_agente` o início da 2ª resposta em diante era o PRIMEIRO e-mail do cliente depois da resposta anterior, qualquer
--  que fosse (`pede_resposta` falso incluído). E em `v_sla_suporte_escalado` a "vez do agente" era acionada por qualquer e-mail novo.
--  Regra nova: só conta e-mail com `pede_resposta IS NOT FALSE` (não analisado entra como "pede", como a lista do suporte já trata).
--    · respostas: início = 1º e-mail que pede resposta entre a resposta anterior e esta; se nenhum, mantém o início de antes (o agente
--      respondeu um e-mail marcado "não pede" — a resposta continua medida, como hoje);
--    · vez do agente: precisa existir e-mail que pede resposta depois da última resposta do agente (ou nenhum e-mail gravado, caso dos cards
--      de origem sem e-mail); o relógio parte do ÚLTIMO e-mail que pede resposta (mesma semântica de antes, restrita a esses e-mails).
--  NÃO muda a fila (situação "Ag. resposta do agente/do cliente"), só os indicadores de SLA. As views são calculadas na leitura: o histórico
--  das métricas se corrige sozinho (não há dado reescrito). Mesmas colunas de antes. Idempotente.
-- ═════════════════════════════════════════════════════════════════════════

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
         CASE WHEN r.ordem = 1 THEN COALESCE(s.sla_inicio_em, s.criado_em)
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
         COALESCE(pe.ultimo_pede_em, s.ultimo_email_cliente_em) AS vez_inicio_em
    FROM email_ia.suporte_escalado s
    LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
    LEFT JOIN LATERAL (SELECT count(*) AS qtd, max(e.data_email) FILTER (WHERE e.pede_resposta IS NOT FALSE) AS ultimo_pede_em
                         FROM email_ia.emails e
                        WHERE lower(e.remetente_email) = lower(s.remetente_email)
                          AND e.data_email > COALESCE(s.ultima_resposta_agente_em, '-infinity'::timestamptz)) pe ON true
), c AS (
  SELECT b.caso_id, b.board_id, b.status, b.prioridade_nivel, b.tag_motivo, b.criado_em, b.primeira_resposta_agente_em, b.ultima_resposta_agente_em,
         b.ultimo_email_cliente_em, b.meta_min, b.pausado, b.aberto, b.vez_do_agente,
         CASE WHEN b.primeira_resposta_agente_em IS NOT NULL OR b.aberto
              THEN GREATEST(0::numeric, email_ia.minutos_sla(b.criado_em, COALESCE(b.primeira_resposta_agente_em, now()), b.board_id)
                                        - email_ia.minutos_pausados(b.caso_id, b.criado_em, COALESCE(b.primeira_resposta_agente_em, now()), b.board_id))
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
