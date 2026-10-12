-- ═══════════════════════════════════════════════════════════════════════════
--  092 · SPPL — sorteio do responsável e card no Suporte Escalado
--
--  1) email_ia.sppl_escolher_board(): sorteia o agente (board) que cuida da ocorrência. Mesmo critério do roteador do Suporte Escalado
--     (peso ∝ 1 / mediana de horas para tirar um caso de Pendente nos últimos 14 dias), trocando "casos tirados hoje" por
--     "ocorrências do SPPL ainda abertas com esse agente" — quem já tem muita ocorrência recebe menos. Só boards ativos de usuário ativo
--     e com `recebe_sppl` (nasce true; quem quiser tirar alguém do SPPL muda a coluna).
--  2) public.sppl_abrir_card(ocorrencia): para ocorrência que exige contato com o cliente, abre (ou reabre) o card do cliente no
--     Suporte Escalado, já com o board da ocorrência, e guarda o id em sppl_ocorrencias.caso_id. NÃO envia e-mail: o time conversa com o cliente.
--  3) Interruptores em config_disparos: sppl_sorteio_ativo ('true') e sppl_cards_ativo ('false' — nasce desligado: abre card em produção).
--  Só adiciona (1 coluna, 2 funções, 2 chaves). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_boards ADD COLUMN IF NOT EXISTS recebe_sppl boolean NOT NULL DEFAULT true;

INSERT INTO config_disparos (chave, valor) VALUES ('sppl_sorteio_ativo', 'true'), ('sppl_cards_ativo', 'false')
ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION email_ia.sppl_escolher_board() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  escolhido bigint;
BEGIN
  WITH elegiveis AS (
    SELECT b.id AS board_id
      FROM email_ia.suporte_escalado_boards b
      JOIN public.painel_usuarios u ON u.id = b.usuario_id
     WHERE b.ativo AND u.ativo AND b.recebe_sppl
  ),
  velocidade AS (
    SELECT t.board_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.horas) AS mediana_h
      FROM (
        SELECT h.board_id,
               extract(epoch FROM (h.mudou_em - lag(h.mudou_em) OVER (PARTITION BY h.suporte_escalado_id ORDER BY h.mudou_em))) / 3600.0 AS horas
          FROM email_ia.suporte_escalado_historico h
         WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em > now() - interval '14 days'
      ) t
     WHERE t.horas IS NOT NULL
     GROUP BY t.board_id
  ),
  abertas AS (
    SELECT o.board_id, count(*) AS n
      FROM public.sppl_ocorrencias o
     WHERE o.board_id IS NOT NULL AND o.situacao NOT IN ('resolvida', 'cancelada')
     GROUP BY o.board_id
  ),
  base AS (
    SELECT el.board_id,
           coalesce(v.mediana_h, (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mediana_h) FROM velocidade), 24) AS mediana_h,
           coalesce(a.n, 0) AS abertas
      FROM elegiveis el
      LEFT JOIN velocidade v ON v.board_id = el.board_id
      LEFT JOIN abertas a ON a.board_id = el.board_id
  ),
  pontuado AS (
    SELECT board_id, (1.0 / GREATEST(mediana_h, 0.1)) * (1.0 / (1 + abertas)) AS peso FROM base
  ),
  sorteio AS (
    SELECT board_id, sum(peso) OVER (ORDER BY board_id) AS acumulado, sum(peso) OVER () AS total FROM pontuado
  )
  SELECT board_id INTO escolhido FROM sorteio WHERE acumulado >= random() * total ORDER BY acumulado LIMIT 1;
  RETURN escolhido;
END $$;

CREATE OR REPLACE FUNCTION public.sppl_abrir_card(p_ocorrencia bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  o record; r record;
  v_email text; v_nome text; v_id bigint; v_status text; v_motivo text; v_resumo text;
BEGIN
  SELECT * INTO o FROM public.sppl_ocorrencias WHERE id = p_ocorrencia;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.caso_id IS NOT NULL OR o.situacao IN ('resolvida', 'cancelada') THEN RETURN o.caso_id; END IF;

  SELECT x.email, x.nome INTO v_email, v_nome
    FROM (
      SELECT d.email, d.nome, 1 AS ord FROM public.disparos_pos_venda d WHERE d.transacao_id = o.transacao_id AND d.email IS NOT NULL
      UNION ALL
      SELECT u.email, NULL::text, 2 FROM public.compras_upsell_downsell u WHERE u.transacao_id = o.transacao_id AND u.email IS NOT NULL
    ) x ORDER BY x.ord LIMIT 1;
  IF v_email IS NULL THEN RETURN NULL; END IF;   -- sem e-mail do cliente não há card (a ocorrência continua com o time)

  SELECT g.titulo, g.acao INTO r FROM public.sppl_regras g WHERE g.id = o.regra_id;
  v_motivo := 'SPPL — ' || coalesce(r.titulo, o.categoria);
  v_resumo := v_motivo || '. Pedido ' || o.transacao_id
           || CASE WHEN o.numero IS NOT NULL THEN ', código de rastreio ' || o.numero ELSE '' END
           || CASE WHEN o.status_17t IS NOT NULL THEN ' (17TRACK: ' || o.status_17t || coalesce(' / ' || o.substatus_17t, '') || ')' ELSE '' END
           || '. Ação: ' || coalesce(o.proxima_acao, r.acao, 'contatar o cliente') || '.';

  SELECT s.id, s.status INTO v_id, v_status FROM email_ia.suporte_escalado s WHERE lower(s.remetente_email) = lower(v_email) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, status, origem, board_id)
    VALUES (lower(v_email), v_nome, v_resumo, v_motivo, 'pendente', 'sppl', o.board_id) RETURNING id INTO v_id;
  ELSIF v_status = 'finalizado' THEN
    UPDATE email_ia.suporte_escalado
       SET status = 'pendente', iniciado_em = NULL, finalizado_em = NULL, origem = 'sppl', board_id = coalesce(o.board_id, board_id),
           motivo_escalonamento = v_motivo, atualizado_em = now(),
           resumo_conversa = left(coalesce(nullif(resumo_conversa, ''), '') || E'\n[' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '] ' || v_resumo, 8000)
     WHERE id = v_id;
  ELSIF v_status = 'reembolsado' THEN
    RETURN NULL;   -- cliente já reembolsado: não abrimos card de logística
  END IF;
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (v_id, 'Sistema (SPPL)', v_resumo);
  UPDATE public.sppl_ocorrencias SET caso_id = v_id, atualizado_em = now() WHERE id = p_ocorrencia;
  RETURN v_id;
END $$;
