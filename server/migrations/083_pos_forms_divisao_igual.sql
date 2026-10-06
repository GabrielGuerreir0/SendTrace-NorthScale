-- ═══════════════════════════════════════════════════════════════════════════
--  083 · Cards do fluxo dos 30 dias: divisão IGUAL entre os 3 boards (ajuste da 082, 06/10/2026)
--
--  A 082 equilibrava pela carga TOTAL de cada agente (fila normal incluída); como o Ramon tinha bem menos pendentes, recebeu 10 dos 11 cards. Agora a escolha é, nesta ordem:
--  (1) o board com MENOS cards do próprio fluxo esperando atendimento (Pendente / Lead respondeu, origem pos_forms_30d) → divisão igual dos casos do pós-forms;
--  (2) empate: o com menos pendentes no total; (3) empate: sorteio. O sorteio dos contatos normais não muda. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.escolher_board(p_so_pos_forms boolean DEFAULT false) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  escolhido BIGINT;
BEGIN
  IF coalesce(p_so_pos_forms, false) THEN
    SELECT b.id INTO escolhido
      FROM email_ia.suporte_escalado_boards b
      JOIN public.painel_usuarios u ON u.id = b.usuario_id
     WHERE b.recebe_pos_forms AND u.ativo
     ORDER BY (SELECT count(*) FROM email_ia.suporte_escalado s WHERE s.board_id = b.id AND s.origem = 'pos_forms_30d' AND s.status IN ('pendente', 'lead_respondeu')),
              (SELECT count(*) FROM email_ia.suporte_escalado s WHERE s.board_id = b.id AND s.status IN ('pendente', 'lead_respondeu')),
              random()
     LIMIT 1;
    RETURN escolhido;
  END IF;

  WITH elegiveis AS (
    SELECT b.id AS board_id
    FROM email_ia.suporte_escalado_boards b
    JOIN public.painel_usuarios u ON u.id = b.usuario_id
    WHERE b.ativo AND u.ativo
  ),
  velocidade AS (
    SELECT t.board_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY t.horas) AS mediana_h
    FROM (
      SELECT h.board_id,
             extract(epoch FROM (h.mudou_em -
               lag(h.mudou_em) OVER (PARTITION BY h.suporte_escalado_id ORDER BY h.mudou_em))
             ) / 3600.0 AS horas
      FROM email_ia.suporte_escalado_historico h
      WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em > now() - interval '14 days'
    ) t
    WHERE t.horas IS NOT NULL
    GROUP BY t.board_id
  ),
  volume_hoje AS (
    SELECT h.board_id, count(*) AS total
    FROM email_ia.suporte_escalado_historico h
    WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em::date = now()::date
    GROUP BY h.board_id
  ),
  base AS (
    SELECT el.board_id,
           coalesce(v.mediana_h,
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mediana_h) FROM velocidade),
             24) AS mediana_h,
           coalesce(vh.total, 0) AS volume_hoje
    FROM elegiveis el
    LEFT JOIN velocidade v ON v.board_id = el.board_id
    LEFT JOIN volume_hoje vh ON vh.board_id = el.board_id
  ),
  pontuado AS (
    SELECT board_id, (1.0 / GREATEST(mediana_h, 0.1)) * (1.0 / (1 + volume_hoje)) AS peso
    FROM base
  ),
  sorteio AS (
    SELECT board_id, sum(peso) OVER (ORDER BY board_id) AS acumulado, sum(peso) OVER () AS total
    FROM pontuado
  )
  SELECT board_id INTO escolhido FROM sorteio
  WHERE acumulado >= random() * total ORDER BY acumulado LIMIT 1;
  RETURN escolhido;
END;
$$;
