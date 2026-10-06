-- ═══════════════════════════════════════════════════════════════════════════
--  073 · SLA do Suporte Escalado dentro do turno (pedido da Késsia, PDF de 05/10/2026, item 12)
--
--  Metas: Alta 3 h, Média 4 h (config `sla_alta_min` / `sla_media_min`, em minutos de TURNO). Só contam os minutos em que o agente está
--  de turno: segunda a sexta (dias do turno), horário de Brasília, união dos turnos do board dono do caso (067). Se o board ainda não
--  tem ninguém atribuído a turno (a Késsia atribui pelo painel), conta a união de todos os turnos cadastrados (hoje 08:00–22:00) — assim o
--  SLA já funciona e passa a usar a escala real assim que ela preencher. Chegada fora do turno conta a partir da abertura do próximo turno.
--
--  Dois relógios por caso (view `v_sla_suporte_escalado`):
--    · 1ª resposta  = `primeira_resposta_agente_em` − `criado_em` (ainda sem resposta: até agora, enquanto o caso está aberto);
--    · vez do agente (2ª em diante) = só enquanto o lead escreveu depois da última resposta: agora − `ultimo_email_cliente_em`.
--  Caso fora do fluxo do agente (finalizado, reembolsado, formulário, recorrência) sem resposta do agente não tem 1ª resposta cobrada. Respostas anteriores a 2ª não ficam
--  guardadas por e-mail (só a última data do cliente), então o histórico de 2ª em diante entra daqui para a frente via esta view.
--  Só cria funções e uma view; não mexe em casos, boards, gatilhos nem envia nada. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO email_ia.config (chave, valor) VALUES ('sla_alta_min', '180'), ('sla_media_min', '240') ON CONFLICT (chave) DO NOTHING;

-- Meta em minutos de turno para a prioridade (alta/media); NULL se o caso não tem prioridade.
CREATE OR REPLACE FUNCTION email_ia.sla_meta_minutos(p_nivel text) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT CASE p_nivel
           WHEN 'alta'  THEN coalesce((SELECT valor::int FROM email_ia.config WHERE chave = 'sla_alta_min'), 180)
           WHEN 'media' THEN coalesce((SELECT valor::int FROM email_ia.config WHERE chave = 'sla_media_min'), 240)
         END
$f$;

-- Minutos de turno (união dos turnos do board; todos os turnos se o board não tem nenhum) entre p_de e p_ate.
CREATE OR REPLACE FUNCTION email_ia.minutos_em_turno(p_de timestamptz, p_ate timestamptz, p_board bigint DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE AS $f$
  WITH usar AS (
    SELECT t.inicio, t.fim, t.dias_semana
      FROM email_ia.suporte_escalado_turnos t
     WHERE EXISTS (SELECT 1 FROM email_ia.suporte_escalado_turno_agentes a WHERE a.turno_id = t.id AND a.board_id = p_board)
        OR NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado_turno_agentes a WHERE a.board_id = p_board)
  ), dias AS (
    SELECT d::date AS dia
      FROM generate_series((p_de AT TIME ZONE 'America/Sao_Paulo')::date,
                           least((p_ate AT TIME ZONE 'America/Sao_Paulo')::date, (p_de AT TIME ZONE 'America/Sao_Paulo')::date + 90),
                           interval '1 day') d
  ), janelas AS (
    SELECT greatest((dias.dia + u.inicio) AT TIME ZONE 'America/Sao_Paulo', p_de) AS ini,
           least((dias.dia + u.fim) AT TIME ZONE 'America/Sao_Paulo', p_ate)      AS fim
      FROM dias JOIN usar u ON extract(isodow FROM dias.dia)::smallint = ANY (u.dias_semana)
  ), validas AS (
    SELECT ini, fim FROM janelas WHERE fim > ini
  ), marcadas AS (
    SELECT ini, fim,
           max(fim) OVER (ORDER BY ini, fim ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS fim_anterior
      FROM validas
  ), ilhas AS (
    SELECT ini, fim,
           sum(CASE WHEN fim_anterior IS NULL OR ini > fim_anterior THEN 1 ELSE 0 END) OVER (ORDER BY ini, fim) AS grupo
      FROM marcadas
  )
  SELECT coalesce(sum(extract(epoch FROM (g.fim - g.ini)) / 60.0), 0)
    FROM (SELECT min(ini) AS ini, max(fim) AS fim FROM ilhas GROUP BY grupo) g
$f$;
COMMENT ON FUNCTION email_ia.minutos_em_turno(timestamptz, timestamptz, bigint) IS 'Minutos entre p_de e p_ate que caem dentro dos turnos do board (seg–sex, America/Sao_Paulo); sem turno atribuído usa todos os turnos (073).';

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, s.criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         (s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')) AS aberto,
         (s.ultimo_email_cliente_em IS NOT NULL AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
            AND s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')) AS vez_do_agente
    FROM email_ia.suporte_escalado s
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
