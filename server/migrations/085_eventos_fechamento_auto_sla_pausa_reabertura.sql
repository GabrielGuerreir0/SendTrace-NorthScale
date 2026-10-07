-- ═══════════════════════════════════════════════════════════════════════════
--  085 · Suporte Humano — 2º momento da solicitação da Késsia (PDF de 07/10/2026), Onda H
--
--  · eventos da ficha (item 6): `suporte_escalado_eventos` guarda quem mudou o quê e quando nos campos de Propriedades, Logística e Ajuda
--    (gatilho na ficha — vale para tela, API e rotinas). A linha do tempo do ticket junta estes eventos com o que já existia
--    (chegada, coluna do Kanban, notas, pedidos de ajuda, respostas do agente e e-mails do cliente), sem copiar nada;
--  · SLA suspenso em "Pendente" (itens 16/20): `minutos_pausados` soma os minutos de turno em que o ticket ficou Pendente e a
--    `v_sla_suporte_escalado` os desconta; a view ganha `pausado` (true enquanto o ticket está Pendente);
--  · fechamento automático (itens 16/20): `fechar_tickets_automatico(p_simular)` —
--      Resolvido há mais de 7 dias → Fechado;
--      Aberto, já respondido ao cliente, sem resposta dele há mais de 10 dias (contados da última resposta do agente) → Fechado.
--    NASCE DESLIGADO (config `fechamento_automatico_ativo` = false): rode antes `SELECT * FROM email_ia.fechar_tickets_automatico(true)` para ver
--    quantos tickets seriam fechados; ligar = UPDATE email_ia.config SET valor = 'true' WHERE chave = 'fechamento_automatico_ativo';
--  · reabertura (item 25): cliente que escreve depois de o ticket estar Fechado (ou Resolvido) reabre o ticket (status → Aberto) e o caso
--    ganha a tag TICKET REABERTO (`ficha.ticket_reaberto_em`).
--  Só cria tabela/colunas/funções, recria uma view e liga gatilhos; não apaga nada. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha ADD COLUMN IF NOT EXISTS ticket_reaberto_em timestamptz;

CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_eventos (
  id           bigserial PRIMARY KEY,
  caso_id      bigint NOT NULL REFERENCES email_ia.suporte_escalado(id) ON DELETE CASCADE,
  ocorrido_em  timestamptz NOT NULL DEFAULT now(),
  ator         text,
  bloco        text NOT NULL,
  campo        text NOT NULL,
  de           text,
  para         text,
  detalhe      text
);
CREATE INDEX IF NOT EXISTS suporte_escalado_eventos_caso_idx ON email_ia.suporte_escalado_eventos (caso_id, ocorrido_em);
COMMENT ON TABLE email_ia.suporte_escalado_eventos IS 'Alterações dos campos da ficha (Propriedades, Logística, Ajuda), por gatilho (085): base da linha do tempo do ticket e da pausa do SLA.';

CREATE OR REPLACE FUNCTION email_ia.trg_ficha_eventos() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  n jsonb := to_jsonb(NEW);
  r record;
  v_de text; v_para text; v_ator text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('propriedades', 'motivo_contato'), ('propriedades', 'detalhamento_motivo'), ('propriedades', 'tipo_resolucao'),
      ('propriedades', 'percentual_reembolso'), ('propriedades', 'valor_compra_usd'), ('propriedades', 'deducao_frascos_usd'),
      ('propriedades', 'chargeback_em'), ('propriedades', 'status_ticket'), ('propriedades', 'ticket_reaberto_em'),
      ('logistica', 'status_logistica'), ('logistica', 'motivo_reenvio'), ('logistica', 'quantidade_reenvio'),
      ('logistica', 'produto_reenvio'), ('logistica', 'observacao_reenvio'), ('logistica', 'endereco_divergencia'),
      ('logistica', 'novo_rastreio'), ('logistica', 'responsavel_board_id'),
      ('ajuda', 'status_ajuda')
    ) AS t(bloco, campo)
  LOOP
    v_de := o ->> r.campo;
    v_para := n ->> r.campo;
    IF v_de IS DISTINCT FROM v_para THEN
      v_ator := coalesce(n ->> (r.bloco || '_atualizado_por'), n ->> 'atualizado_por', 'Sistema');
      IF r.campo = 'responsavel_board_id' THEN
        v_de := (SELECT nome FROM email_ia.suporte_escalado_boards WHERE id = nullif(v_de, '')::bigint);
        v_para := (SELECT nome FROM email_ia.suporte_escalado_boards WHERE id = nullif(v_para, '')::bigint);
      END IF;
      INSERT INTO email_ia.suporte_escalado_eventos (caso_id, ator, bloco, campo, de, para, detalhe)
      VALUES (NEW.suporte_escalado_id, v_ator, r.bloco, r.campo, left(v_de, 500), left(v_para, 500),
              CASE WHEN v_ator = 'Sistema' THEN 'Automático' END);
    END IF;
  END LOOP;
  RETURN NULL;
END $f$;
DROP TRIGGER IF EXISTS trg_ficha_eventos ON email_ia.suporte_escalado_ficha;
CREATE TRIGGER trg_ficha_eventos AFTER INSERT OR UPDATE ON email_ia.suporte_escalado_ficha
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_ficha_eventos();

-- Minutos de turno (do board) em que o ticket esteve "Pendente" dentro de [p_de, p_ate]: o SLA não conta esse tempo.
-- Só conhece os períodos a partir desta migração (antes dela não havia registro de mudança de status).
CREATE OR REPLACE FUNCTION email_ia.minutos_pausados(p_caso bigint, p_de timestamptz, p_ate timestamptz, p_board bigint DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE AS $f$
  WITH ev AS (
    SELECT ocorrido_em, para FROM email_ia.suporte_escalado_eventos WHERE caso_id = p_caso AND campo = 'status_ticket'
  ), iv AS (
    SELECT ocorrido_em AS ini, lead(ocorrido_em) OVER (ORDER BY ocorrido_em) AS fim, para FROM ev
  ), recorte AS (
    SELECT greatest(ini, p_de) AS ini, least(coalesce(fim, p_ate), p_ate) AS fim FROM iv WHERE para = 'Pendente'
  )
  SELECT coalesce(sum(email_ia.minutos_em_turno(ini, fim, p_board)), 0) FROM recorte WHERE fim > ini
$f$;

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, s.criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         (coalesce(fi.status_ticket, '') = 'Pendente') AS pausado,
         (s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')
            AND coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')) AS aberto,
         (s.primeira_resposta_agente_em IS NOT NULL AND s.ultimo_email_cliente_em IS NOT NULL AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
            AND s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')
            AND coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')) AS vez_do_agente
    FROM email_ia.suporte_escalado s
    LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
), c AS (
  SELECT b.*,
         CASE WHEN b.primeira_resposta_agente_em IS NOT NULL OR b.aberto
              THEN greatest(0, email_ia.minutos_em_turno(b.criado_em, coalesce(b.primeira_resposta_agente_em, now()), b.board_id)
                               - email_ia.minutos_pausados(b.caso_id, b.criado_em, coalesce(b.primeira_resposta_agente_em, now()), b.board_id)) END AS primeira_resposta_min,
         CASE WHEN b.vez_do_agente
              THEN greatest(0, email_ia.minutos_em_turno(b.ultimo_email_cliente_em, now(), b.board_id)
                               - email_ia.minutos_pausados(b.caso_id, b.ultimo_email_cliente_em, now(), b.board_id)) END AS vez_agente_min
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
            ELSE 'em_andamento' END AS vez_agente_sla,
       c.pausado
  FROM c;
COMMENT ON VIEW email_ia.v_sla_suporte_escalado IS 'SLA dentro do turno por caso: 1ª resposta e vez do agente (2ª em diante); metas 3 h Alta / 4 h Média (073); tempo em "Pendente" não conta (085).';

-- Fechamento automático. p_simular = true só conta; false fecha. Quem fecha aparece como "Sistema" na linha do tempo.
INSERT INTO email_ia.config (chave, valor) VALUES ('fechamento_automatico_ativo', 'false') ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION email_ia.fechar_tickets_automatico(p_simular boolean DEFAULT true)
RETURNS TABLE (resolvidos_fechados integer, abertos_fechados integer) LANGUAGE plpgsql AS $f$
DECLARE
  v_resolvidos bigint[];
  v_abertos bigint[];
BEGIN
  SELECT coalesce(array_agg(fi.suporte_escalado_id), '{}') INTO v_resolvidos
    FROM email_ia.suporte_escalado_ficha fi
   WHERE fi.status_ticket = 'Resolvido'
     AND coalesce((SELECT max(ev.ocorrido_em) FROM email_ia.suporte_escalado_eventos ev
                    WHERE ev.caso_id = fi.suporte_escalado_id AND ev.campo = 'status_ticket' AND ev.para = 'Resolvido'),
                  fi.propriedades_atualizado_em, fi.atualizado_em) < now() - interval '7 days';

  SELECT coalesce(array_agg(s.id), '{}') INTO v_abertos
    FROM email_ia.suporte_escalado s
    LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
   WHERE coalesce(fi.status_ticket, 'Aberto') = 'Aberto'
     AND s.ultima_resposta_agente_em IS NOT NULL
     AND s.ultima_resposta_agente_em < now() - interval '10 days'
     AND coalesce(s.ultimo_email_cliente_em, '-infinity'::timestamptz) <= s.ultima_resposta_agente_em;

  IF NOT p_simular THEN
    UPDATE email_ia.suporte_escalado_ficha
       SET status_ticket = 'Fechado', propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_em = now()
     WHERE suporte_escalado_id = ANY (v_resolvidos);
    INSERT INTO email_ia.suporte_escalado_ficha (suporte_escalado_id, status_ticket, propriedades_atualizado_por, propriedades_atualizado_em, atualizado_por)
    SELECT unnest(v_abertos), 'Fechado', 'Sistema', now(), 'Sistema'
    ON CONFLICT (suporte_escalado_id) DO UPDATE
      SET status_ticket = 'Fechado', propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_em = now();
  END IF;
  RETURN QUERY SELECT cardinality(v_resolvidos), cardinality(v_abertos);
END $f$;

-- Cliente escreveu num ticket já Fechado/Resolvido → reabre e marca TICKET REABERTO (o fluxo de e-mails troca o email_id do caso a cada e-mail novo).
CREATE OR REPLACE FUNCTION email_ia.trg_reabrir_ticket_ficha() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.email_id IS NOT NULL AND NEW.email_id IS DISTINCT FROM OLD.email_id THEN
    UPDATE email_ia.suporte_escalado_ficha
       SET status_ticket = 'Aberto', ticket_reaberto_em = now(), propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_em = now()
     WHERE suporte_escalado_id = NEW.id AND status_ticket IN ('Fechado', 'Resolvido');
  END IF;
  RETURN NULL;
END $f$;
DROP TRIGGER IF EXISTS trg_reabrir_ticket_ficha ON email_ia.suporte_escalado;
CREATE TRIGGER trg_reabrir_ticket_ficha AFTER UPDATE OF email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_reabrir_ticket_ficha();
