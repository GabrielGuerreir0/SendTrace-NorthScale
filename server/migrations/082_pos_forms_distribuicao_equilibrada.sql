-- ═══════════════════════════════════════════════════════════════════════════
--  082 · Distribuição dos cards do fluxo dos 30 dias: equilibrada entre os 3 boards, mesmo que estejam "indisponíveis" (pedido do Lucas, 06/10/2026)
--
--  O sorteio normal pesa por VELOCIDADE e volume movimentado no dia: com um agente muito mais rápido que os outros, quase tudo caía nele (11 de 11 no Klebson). Para os casos do
--  pós-forms (`p_so_pos_forms`) agora vale o mais SIMPLES e justo: o board marcado `recebe_pos_forms` com MENOS cards esperando atendimento (Pendente / Lead respondeu); empate = sorteio.
--  E a flag "disponível" do board (`ativo`, que controla a fila normal) NÃO bloqueia esses casos — só o usuário precisa estar ativo. O sorteio normal (contatos comuns) não muda.
--  Também cria `pos30_redistribuir(aplicar)` para equilibrar os cards do pós-forms que ainda estão em Pendente sem nenhuma ação do agente. Idempotente.
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
     ORDER BY (SELECT count(*) FROM email_ia.suporte_escalado s WHERE s.board_id = b.id AND s.status IN ('pendente', 'lead_respondeu')), random()
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

-- Equilibra os cards do pós-forms que estão em Pendente sem nenhuma ação (nem resposta de agente): distribui um a um no board com menos cards. p_aplicar = false só conta.
CREATE OR REPLACE FUNCTION email_ia.pos30_redistribuir(p_aplicar boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer := 0; r record; b bigint;
BEGIN
  FOR r IN SELECT s.id, s.board_id FROM email_ia.suporte_escalado s
            WHERE s.origem = 'pos_forms_30d' AND s.status = 'pendente' AND s.primeira_resposta_agente_em IS NULL
              AND NOT EXISTS (SELECT 1 FROM email_ia.respostas_agente a WHERE lower(a.para_email) = lower(s.remetente_email))
            ORDER BY s.criado_em LOOP
    IF NOT p_aplicar THEN n := n + 1; CONTINUE; END IF;
    -- libera o card do board atual na contagem e escolhe o menos carregado
    UPDATE email_ia.suporte_escalado SET board_id = NULL WHERE id = r.id;
    b := email_ia.escolher_board(true);
    UPDATE email_ia.suporte_escalado SET board_id = coalesce(b, r.board_id) WHERE id = r.id;
    IF b IS DISTINCT FROM r.board_id THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;
