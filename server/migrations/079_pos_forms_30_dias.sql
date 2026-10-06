-- ═══════════════════════════════════════════════════════════════════════════
--  079 · E-mail automático da regra dos 30 dias (PDF do CS de 06/10/2026) — NASCE DESLIGADO
--
--  Substitui o desenho da 063 (nunca aplicada: sem ofertas 15/30/50%, sem Kanban pós-forms). Uma única mensagem automática ao cliente que preencheu o formulário
--  de reembolso (menos de 30 dias de uso, sem motivo de saúde). Resposta do cliente (qualquer uma) → card no Suporte Humano, distribuído SÓ entre os boards
--  marcados `recebe_pos_forms` (Thalison, Klebson e Ramon). Saúde ou ≥ 30 dias → card direto (sem e-mail). Sem resposta → nada acontece.
--
--  O que cria: `mensagens_sistema` (o e-mail EXATO enviado + a resposta), `pos30_respostas` (decisão por resposta do formulário), coluna `origem` no caso,
--  coluna `recebe_pos_forms` nos boards, gatilhos que reconhecem a resposta do cliente (V2 do n8n NÃO muda) e a escolha de board restrita.
--  Travas: `pos30_ativo = 'false'` e `pos30_desde` AUSENTE (o histórico do formulário nunca recebe nada). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO email_ia.config (chave, valor) VALUES
  ('pos30_ativo', 'false'),
  ('pos30_limite_dia', '30'),
  ('pos30_validade_dias', '60'),
  ('pos30_assunto', 'About your refund request')
ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION email_ia.pos30_cfg(p_chave text, p_padrao text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce((SELECT valor FROM email_ia.config WHERE chave = p_chave), p_padrao)
$f$;

ALTER TABLE email_ia.suporte_escalado_boards ADD COLUMN IF NOT EXISTS recebe_pos_forms boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN email_ia.suporte_escalado_boards.recebe_pos_forms IS 'Board que recebe os casos do e-mail automático dos 30 dias (079). Só quem tem true entra no sorteio desses casos.';
UPDATE email_ia.suporte_escalado_boards SET recebe_pos_forms = true
 WHERE nome ILIKE ANY (ARRAY['%thalison%', '%klebson%', '%ramon%'])
   AND NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado_boards WHERE recebe_pos_forms);

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS origem text;
COMMENT ON COLUMN email_ia.suporte_escalado.origem IS 'De onde veio o caso: NULL = contato normal; pos_forms_30d = e-mail automático dos 30 dias (079).';

CREATE TABLE IF NOT EXISTS email_ia.mensagens_sistema (
  id               bigserial PRIMARY KEY,
  tipo             text NOT NULL,                       -- 'pos_forms_30d'
  email            text NOT NULL,                       -- minúsculo
  nome             text,
  assunto          text,
  corpo_texto      text NOT NULL,                       -- o texto EXATO enviado
  message_id       text UNIQUE,                         -- cabeçalho Message-ID do e-mail enviado
  resposta_form_id bigint,
  enviado_em       timestamptz NOT NULL DEFAULT now(),
  respondida_em    timestamptz,
  caso_id          bigint
);
CREATE INDEX IF NOT EXISTS mensagens_sistema_email_idx ON email_ia.mensagens_sistema (email, enviado_em DESC);
COMMENT ON TABLE email_ia.mensagens_sistema IS 'E-mails automáticos enviados pelo sistema ao cliente (079): texto exato, hora e a resposta. Alimenta a conversa do ticket.';

CREATE TABLE IF NOT EXISTS email_ia.pos30_respostas (
  form_id       bigint PRIMARY KEY REFERENCES public.formularios_respostas(id),
  email         text,
  decisao       text CHECK (decisao IN ('enviar', 'humano_saude', 'humano_30dias', 'revisar', 'pular')),
  motivo        text,                                   -- por que pulou/revisar (sem dado pessoal)
  dias_uso      integer,
  vago          boolean,
  saude         boolean,
  usou          boolean,
  status        text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'enviando', 'enviado', 'humano', 'pulado', 'revisar', 'erro')),   -- 'enviando' parado = envio incerto: nunca reenvia sozinho
  mensagem_id   bigint,
  caso_id       bigint,
  tentativas    smallint NOT NULL DEFAULT 0,
  erro          text,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_ia.pos30_respostas IS 'Decisão do e-mail dos 30 dias por resposta do formulário de reembolso (079).';

-- Escolha do board (sorteio por velocidade e volume, o mesmo do roteador de sempre); p_so_pos_forms restringe aos boards `recebe_pos_forms`.
CREATE OR REPLACE FUNCTION email_ia.escolher_board(p_so_pos_forms boolean DEFAULT false) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  escolhido BIGINT;
BEGIN
  WITH elegiveis AS (
    SELECT b.id AS board_id
    FROM email_ia.suporte_escalado_boards b
    JOIN public.painel_usuarios u ON u.id = b.usuario_id
    WHERE b.ativo AND u.ativo AND (NOT coalesce(p_so_pos_forms, false) OR b.recebe_pos_forms)
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

CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_rotear() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  escolhido BIGINT;
BEGIN
  IF NEW.board_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  escolhido := email_ia.escolher_board(coalesce(NEW.origem = 'pos_forms_30d', false));   -- origem NULL = contato normal (todos os boards)
  IF escolhido IS NULL THEN
    RAISE WARNING 'suporte_escalado: sem board elegível para % — ficará sem board_id.', NEW.remetente_email;
  ELSE
    NEW.board_id := escolhido;
  END IF;
  RETURN NEW;
END;
$$;

-- Última mensagem do sistema ainda sem resposta, dentro da validade.
CREATE OR REPLACE FUNCTION email_ia.pos30_pendente(p_email text) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT m.id FROM email_ia.mensagens_sistema m
   WHERE m.email = lower(p_email) AND m.respondida_em IS NULL
     AND m.enviado_em > now() - make_interval(days => email_ia.pos30_cfg('pos30_validade_dias', '60')::int)
   ORDER BY m.enviado_em DESC LIMIT 1
$f$;

-- Contato novo de quem recebeu o e-mail: marca a origem (o roteador logo depois já restringe aos boards certos).
CREATE OR REPLACE FUNCTION email_ia.trg_pos30_marca_origem() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origem IS NULL AND email_ia.pos30_pendente(NEW.remetente_email) IS NOT NULL THEN
    NEW.origem := 'pos_forms_30d';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_0_pos30 ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_0_pos30 BEFORE INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_pos30_marca_origem();

-- Cliente com card antigo FINALIZADO que responde o e-mail: o V2 reabre o card; aqui ele passa para um dos boards do pós-forms.
-- (Card aberto com outro agente NÃO é tomado dele: só a resposta é registrada.)
CREATE OR REPLACE FUNCTION email_ia.trg_pos30_reabertura() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email_id IS DISTINCT FROM OLD.email_id AND email_ia.pos30_pendente(NEW.remetente_email) IS NOT NULL THEN
    IF OLD.status = 'finalizado' THEN
      NEW.origem := 'pos_forms_30d';
      NEW.board_id := email_ia.escolher_board(true);   -- NULL = nenhum dos 3 disponível: fica sem board com aviso
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_0_pos30_upd ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_0_pos30_upd BEFORE UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_pos30_reabertura();

-- Texto do resumo que vai como nota interna no card.
CREATE OR REPLACE FUNCTION email_ia.pos30_nota(p_msg bigint) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT 'Pós-forms (automático) — regra dos 30 dias. Tempo de uso informado: '
         || CASE WHEN r.vago THEN 'vago (sem número de dias)' WHEN r.usou IS FALSE THEN 'não usou o produto' WHEN r.dias_uso IS NOT NULL THEN r.dias_uso || ' dia(s)' ELSE 'não informado' END
         || '. Motivo de saúde/alergia: ' || CASE WHEN r.saude THEN 'sim' ELSE 'não' END
         || '. E-mail dos 30 dias enviado em ' || to_char(m.enviado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
         || CASE WHEN m.respondida_em IS NOT NULL THEN '; o cliente respondeu em ' || to_char(m.respondida_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') ELSE '' END || '.'
    FROM email_ia.mensagens_sistema m LEFT JOIN email_ia.pos30_respostas r ON r.form_id = m.resposta_form_id
   WHERE m.id = p_msg
$f$;

-- Depois que o card existe/é reaberto: registra a resposta na mensagem do sistema e deixa o resumo em nota interna.
CREATE OR REPLACE FUNCTION email_ia.trg_pos30_registra_resposta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_msg bigint;
BEGIN
  v_msg := email_ia.pos30_pendente(NEW.remetente_email);
  IF v_msg IS NOT NULL THEN
    UPDATE email_ia.mensagens_sistema SET respondida_em = now(), caso_id = NEW.id WHERE id = v_msg;
    INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (NEW.id, 'Sistema', email_ia.pos30_nota(v_msg));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_pos30_registra_resposta_ins ON email_ia.suporte_escalado;
CREATE TRIGGER trg_pos30_registra_resposta_ins AFTER INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_pos30_registra_resposta();
DROP TRIGGER IF EXISTS trg_pos30_registra_resposta_upd ON email_ia.suporte_escalado;
CREATE TRIGGER trg_pos30_registra_resposta_upd AFTER UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW WHEN (NEW.email_id IS DISTINCT FROM OLD.email_id) EXECUTE FUNCTION email_ia.trg_pos30_registra_resposta();

-- Cards pós-forms que ficaram sem board (os 3 indisponíveis): entrega quando algum voltar. O script chama a cada rodada.
CREATE OR REPLACE FUNCTION email_ia.pos30_entregar_orfaos() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer := 0; r record; b bigint;
BEGIN
  FOR r IN SELECT id FROM email_ia.suporte_escalado WHERE origem = 'pos_forms_30d' AND board_id IS NULL AND status NOT IN ('finalizado', 'reembolsado') ORDER BY criado_em LOOP
    b := email_ia.escolher_board(true);
    EXIT WHEN b IS NULL;
    UPDATE email_ia.suporte_escalado SET board_id = b WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Card direto no humano (saúde, ≥ 30 dias, ou revisão): mesmo padrão do V2 (1 card por e-mail; finalizado reabre), restrito aos boards do pós-forms.
-- Quem já tem card aberto NÃO é tocado (devolve o id existente).
CREATE OR REPLACE FUNCTION email_ia.pos30_criar_caso_humano(p_email text, p_nome text, p_resumo text, p_motivo text, p_nota text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_status text;
BEGIN
  SELECT id, status INTO v_id, v_status FROM email_ia.suporte_escalado WHERE lower(remetente_email) = lower(p_email);
  IF v_id IS NULL THEN
    INSERT INTO email_ia.suporte_escalado (remetente_email, nome, resumo_conversa, motivo_escalonamento, status, origem)
    VALUES (lower(p_email), p_nome, p_resumo, p_motivo, 'pendente', 'pos_forms_30d') RETURNING id INTO v_id;
  ELSIF v_status = 'finalizado' THEN
    UPDATE email_ia.suporte_escalado
       SET status = 'pendente', iniciado_em = NULL, finalizado_em = NULL, origem = 'pos_forms_30d', board_id = email_ia.escolher_board(true),
           resumo_conversa = left(coalesce(nullif(resumo_conversa, ''), '') || E'\n[' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '] ' || p_resumo, 4000),
           motivo_escalonamento = p_motivo, atualizado_em = now()
     WHERE id = v_id;
  ELSE
    RETURN v_id;
  END IF;
  INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota) VALUES (v_id, 'Sistema', p_nota);
  RETURN v_id;
END $$;

CREATE OR REPLACE VIEW email_ia.v_pos30_resumo AS
SELECT status, decisao, count(*)::int AS total, min(criado_em) AS desde, max(atualizado_em) AS ultimo
  FROM email_ia.pos30_respostas GROUP BY status, decisao;
