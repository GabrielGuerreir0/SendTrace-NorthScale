-- ═══════════════════════════════════════════════════════════════════════════
--  080 · E-mail dos 30 dias para quem só respondeu o formulário (decisão do Lucas, 06/10/2026)
--
--  Cliente que respondeu o formulário e NUNCA recebeu mensagem de agente: o card sai do suporte (vai para a coluna "Formulário"), recebe o e-mail
--  dos 30 dias e só volta quando RESPONDER — aí vira Pendente num dos boards `recebe_pos_forms` (Thalison, Klebson, Ramon), na fila "1º e-mail".
--  O SLA desse card começa na hora da resposta (`sla_inicio_em`), não na criação antiga do card. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- Quem já recebeu o e-mail (canário) e ainda não respondeu sai das colunas também (idempotente).
UPDATE email_ia.suporte_escalado s SET status = 'pos30_aguardando'
 WHERE s.status IN ('pendente', 'formulario') AND s.origem IS DISTINCT FROM 'pos_forms_30d'
   AND s.primeira_resposta_agente_em IS NULL AND s.iniciado_em IS NULL
   AND EXISTS (SELECT 1 FROM email_ia.mensagens_sistema m WHERE m.email = lower(s.remetente_email) AND m.respondida_em IS NULL);

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS sla_inicio_em timestamptz;
COMMENT ON COLUMN email_ia.suporte_escalado.sla_inicio_em IS 'Quando o SLA começa a contar, se for diferente da criação do card (card reativado pelo e-mail dos 30 dias, 080).';

-- Resposta do cliente ao e-mail do sistema: card finalizado OU parado em Formulário volta como Pendente, num dos boards do pós-forms, com o SLA recomeçando agora.
CREATE OR REPLACE FUNCTION email_ia.trg_pos30_reabertura() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email_id IS DISTINCT FROM OLD.email_id AND email_ia.pos30_pendente(NEW.remetente_email) IS NOT NULL THEN
    IF OLD.status IN ('finalizado', 'formulario', 'pos30_aguardando') THEN
      NEW.origem := 'pos_forms_30d';
      NEW.status := 'pendente';
      NEW.iniciado_em := NULL;
      NEW.finalizado_em := NULL;
      NEW.sla_inicio_em := now();
      NEW.board_id := email_ia.escolher_board(true);   -- NULL = nenhum dos 3 disponível: fica sem board com aviso
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Tira o card de TODAS as colunas depois que o e-mail dos 30 dias saiu (Pendente ou Formulário, sem nenhuma resposta de agente): status
-- 'pos30_aguardando' não tem coluna no Kanban nem entra na fila do Suporte Humano. O card só volta quando o cliente responder o e-mail (ver trg_pos30_reabertura).
CREATE OR REPLACE FUNCTION email_ia.pos30_estacionar(p_email text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  UPDATE email_ia.suporte_escalado SET status = 'pos30_aguardando', atualizado_em = now()
   WHERE lower(remetente_email) = lower(p_email) AND status IN ('pendente', 'formulario') AND origem IS DISTINCT FROM 'pos_forms_30d'
     AND primeira_resposta_agente_em IS NULL AND iniciado_em IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
    VALUES (v_id, 'Sistema', 'Pós-forms (automático): nenhum agente falou com este cliente; o e-mail dos 30 dias foi enviado e o card saiu de todas as colunas. Ele volta para o suporte (Thalison, Klebson ou Ramon) quando o cliente responder.');
  END IF;
  RETURN v_id IS NOT NULL;
END $$;

-- Card direto no humano (saúde / 30 dias ou mais): quem nunca falou com agente e está em Formulário, Pendente ou aguardando passa para os boards do pós-forms como Pendente.
CREATE OR REPLACE FUNCTION email_ia.pos30_criar_caso_humano(p_email text, p_nome text, p_resumo text, p_motivo text, p_nota text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_status text; v_origem text;
BEGIN
  SELECT id, status, origem INTO v_id, v_status, v_origem FROM email_ia.suporte_escalado WHERE lower(remetente_email) = lower(p_email);
  IF v_id IS NULL THEN
    INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, status, origem)
    VALUES (lower(p_email), p_nome, p_resumo, p_motivo, 'pendente', 'pos_forms_30d') RETURNING id INTO v_id;
  ELSIF v_origem IS DISTINCT FROM 'pos_forms_30d' AND v_status IN ('formulario', 'pendente', 'pos30_aguardando') THEN
    UPDATE email_ia.suporte_escalado
       SET status = 'pendente', iniciado_em = NULL, finalizado_em = NULL, origem = 'pos_forms_30d', board_id = email_ia.escolher_board(true), sla_inicio_em = now(),
           resumo_conversa = left(coalesce(nullif(resumo_conversa, ''), '') || E'\n[' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '] ' || p_resumo, 4000),
           motivo_escalonamento = p_motivo, atualizado_em = now()
     WHERE id = v_id;
  ELSE
    RETURN v_id;
  END IF;
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (v_id, 'Sistema', p_nota);
  RETURN v_id;
END $$;

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, coalesce(s.sla_inicio_em, s.criado_em) AS criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         (s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')) AS aberto,
         (s.primeira_resposta_agente_em IS NOT NULL AND s.ultimo_email_cliente_em IS NOT NULL AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
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
         CASE WHEN r.ordem = 1 THEN coalesce(s.sla_inicio_em, s.criado_em)
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

-- "Formulário — não respondeu a tempo" (o cliente não preencheu o formulário no prazo): não entra no fluxo dos 30 dias; vai para FINALIZADO e reabre sozinho se o cliente voltar a escrever
-- (o V2 já reabre card finalizado como Pendente, no mesmo board). p_aplicar = false só conta. Só mexe em quem nunca falou com agente.
CREATE OR REPLACE FUNCTION email_ia.pos30_finalizar_nao_respondeu(p_aplicar boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF NOT p_aplicar THEN
    SELECT count(*) INTO n FROM email_ia.suporte_escalado
     WHERE status = 'formulario_nao_respondeu_a_tempo' AND primeira_resposta_agente_em IS NULL AND iniciado_em IS NULL;
    RETURN n;
  END IF;
  WITH f AS (
    UPDATE email_ia.suporte_escalado SET status = 'finalizado', finalizado_em = coalesce(finalizado_em, now()), atualizado_em = now()
     WHERE status = 'formulario_nao_respondeu_a_tempo' AND primeira_resposta_agente_em IS NULL AND iniciado_em IS NULL
    RETURNING id)
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
  SELECT id, 'Sistema', 'Finalizado automaticamente: o cliente não respondeu o formulário a tempo e nenhum agente falou com ele. Se voltar a escrever, o card reabre sozinho.' FROM f;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
