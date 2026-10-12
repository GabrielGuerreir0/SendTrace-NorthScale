-- ═══════════════════════════════════════════════════════════════════════════
--  095 · SPPL — o alerta de logística e o lead de e-mail ficam com a MESMA pessoa (pedido do Lucas, 12/10/2026)
--
--  (1) Alerta → dono do lead: ao atribuir o alerta, se o cliente do pedido já tem card no Suporte Escalado (aberto OU finalizado), o alerta vai para o
--      agente desse card (desde que ele receba SPPL e o usuário esteja ativo); sem card, segue o sorteio ponderado da 094.
--  (2) Contato depois → dono do alerta: card NOVO do cliente (ou card finalizado/em formulário reaberto por e-mail novo) que tem alerta de logística ABERTO
--      nasce/volta no board do agente do alerta, em vez do sorteio — inclusive no fluxo pós-forms (decisão do Lucas: "a 2 segue A").
--      Card ABERTO de outro agente nunca é tomado dele. Movimento manual de card pelo agente não é desfeito.
--  (3) Correção: o sorteio do roteador do Suporte Escalado (escolher_board) usava `random()` no WHERE, que roda UMA VEZ POR LINHA e favorece o primeiro board
--      da ordem (medido: 5 agentes iguais, 3000 sorteios → 582/977/881/450/110). Agora um único número por sorteio. Em produção só o Munhoz está ativo no
--      roteador, então hoje não muda nada na prática; passa a valer quando houver mais de um agente ativo.
--  Só CREATE OR REPLACE de funções + 1 trigger novo. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- e-mail do cliente de um pedido (mesma ordem de preferência do sppl_abrir_card)
CREATE OR REPLACE FUNCTION email_ia.sppl_email_do_pedido(p_transacao text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT lower(x.email) FROM (
    SELECT d.email, 1 AS ord FROM public.disparos_pos_venda d WHERE d.transacao_id = p_transacao AND d.email IS NOT NULL
    UNION ALL
    SELECT u.email, 2 FROM public.compras_upsell_downsell u WHERE u.transacao_id = p_transacao AND u.email IS NOT NULL
  ) x ORDER BY x.ord LIMIT 1
$f$;

-- (1) agente que já atende o cliente (card do e-mail, em qualquer status), se ele pode receber SPPL
CREATE OR REPLACE FUNCTION email_ia.sppl_board_do_lead(p_email text) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT b.id FROM email_ia.suporte_escalado s
    JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
    JOIN public.painel_usuarios u ON u.id = b.usuario_id
   WHERE lower(s.remetente_email) = lower(p_email) AND b.recebe_sppl AND u.ativo
   ORDER BY s.atualizado_em DESC NULLS LAST LIMIT 1
$f$;

-- (2) agente dono do alerta de logística ABERTO do cliente (o mais recente)
CREATE OR REPLACE FUNCTION email_ia.sppl_board_do_alerta(p_email text) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT b.id FROM public.sppl_ocorrencias o
    JOIN email_ia.suporte_escalado_boards b ON b.id = o.board_id
    JOIN public.painel_usuarios u ON u.id = b.usuario_id
   WHERE o.situacao NOT IN ('resolvida', 'cancelada') AND b.recebe_sppl AND u.ativo
     AND (EXISTS (SELECT 1 FROM public.disparos_pos_venda d WHERE d.transacao_id = o.transacao_id AND lower(d.email) = lower(p_email))
       OR EXISTS (SELECT 1 FROM public.compras_upsell_downsell c WHERE c.transacao_id = o.transacao_id AND lower(c.email) = lower(p_email)))
   ORDER BY o.aberta_em DESC LIMIT 1
$f$;

-- responsável de um alerta novo: dono do lead; sem lead, sorteio
CREATE OR REPLACE FUNCTION email_ia.sppl_escolher_board_para(p_transacao text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT coalesce(email_ia.sppl_board_do_lead(email_ia.sppl_email_do_pedido(p_transacao)), email_ia.sppl_escolher_board())
$f$;

-- (2) card novo / reaberto de cliente com alerta aberto → board do alerta. Roda depois de "rotear" e do pós-forms (ordem alfabética dos BEFORE) e antes de "x_recorrencia".
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_sppl_dono() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origem IS DISTINCT FROM 'sppl' THEN
      b := email_ia.sppl_board_do_alerta(NEW.remetente_email);
      IF b IS NOT NULL THEN NEW.board_id := b; END IF;
    END IF;
  ELSIF NEW.email_id IS DISTINCT FROM OLD.email_id AND OLD.status IN ('finalizado', 'formulario', 'pos30_aguardando') AND NEW.status = 'pendente' THEN
    b := email_ia.sppl_board_do_alerta(NEW.remetente_email);
    IF b IS NOT NULL THEN NEW.board_id := b; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_sppl_dono ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_sppl_dono BEFORE INSERT OR UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_sppl_dono();

-- pós-forms direto no humano: respeita o dono do alerta (era só escolher_board(true))
CREATE OR REPLACE FUNCTION email_ia.pos30_criar_caso_humano(p_email text, p_nome text, p_resumo text, p_motivo text, p_nota text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_status text; v_origem text;
BEGIN
  SELECT id, status, origem INTO v_id, v_status, v_origem FROM email_ia.suporte_escalado WHERE lower(remetente_email) = lower(p_email);
  IF v_id IS NULL THEN
    INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, status, origem)
    VALUES (lower(p_email), p_nome, p_resumo, p_motivo, 'pendente', 'pos_forms_30d') RETURNING id INTO v_id;
  ELSIF v_origem IS DISTINCT FROM 'pos_forms_30d' AND v_status IN ('formulario', 'pendente', 'pos30_aguardando') THEN
    UPDATE email_ia.suporte_escalado
       SET status = 'pendente', iniciado_em = NULL, finalizado_em = NULL, origem = 'pos_forms_30d', board_id = coalesce(email_ia.sppl_board_do_alerta(p_email), email_ia.escolher_board(true)), sla_inicio_em = now(),
           resumo_conversa = left(coalesce(nullif(resumo_conversa, ''), '') || E'\n[' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '] ' || p_resumo, 4000),
           motivo_escalonamento = p_motivo, atualizado_em = now()
     WHERE id = v_id;
  ELSE
    RETURN v_id;
  END IF;
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (v_id, 'Sistema', p_nota);
  RETURN v_id;
END $$;

-- (3) sorteio do roteador com um único número aleatório
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
  ),
  r AS MATERIALIZED (SELECT random() AS x)   -- um só número por sorteio (antes: random() por linha, favorecia o primeiro board da ordem)
  SELECT board_id INTO escolhido FROM sorteio
  WHERE acumulado >= (SELECT x FROM r) * total ORDER BY acumulado LIMIT 1;
  RETURN escolhido;
END;
$$;
