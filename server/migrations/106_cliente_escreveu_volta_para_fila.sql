-- ═══════════════════════════════════════════════════════════════════════════
--  106 · Suporte Humano — cliente que escreve em ticket "escondido" volta para a fila do agente (pedido da Késsia, 17-18/10/2026)
--
--  Origem: tickets #8383, #11920, #15166 (e 1.559 casos sem resposta do agente e sem propriedades): o último e-mail era da cliente, mas o ticket estava em
--  status fora da fila (formulario, formulario_nao_respondeu_a_tempo, finalizado, pendente_recorrencia) e a tela mostrava "aguardando o cliente".
--   1) E-mail novo da cliente (o n8n troca o email_id do caso) em caso em formulario / formulario_nao_respondeu_a_tempo → vai para a fila:
--      'lead_respondeu' se o agente já respondeu antes, 'pendente' se nunca respondeu. Caso finalizado que NUNCA teve resposta de agente também reabre como 'pendente'.
--      (A regra de recorrência, que roda depois, ainda pode mandar o pendente de cliente em recorrência para pendente_recorrencia.)
--   2) pendente_recorrencia passa a contar como "em aberto" na fila e no SLA (view v_sla_suporte_escalado) — o caso continua na coluna, mas o agente o vê e responde.
--  O código da fila (suporteEscaladoFila.js / suporteEscaladoKpis.js) recebe a mesma lista de status. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_cliente_escreveu() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v_quando timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ultimo_email_cliente_em := coalesce(NEW.ultimo_email_cliente_em, (SELECT e.data_email FROM email_ia.emails e WHERE e.id = NEW.email_id), now());
    RETURN NEW;
  END IF;
  IF NEW.email_id IS NOT NULL AND NEW.email_id IS DISTINCT FROM OLD.email_id THEN
    SELECT e.data_email INTO v_quando FROM email_ia.emails e WHERE e.id = NEW.email_id;
    NEW.ultimo_email_cliente_em := coalesce(v_quando, now());
    IF OLD.status = 'esperando_resposta' AND NEW.status = 'esperando_resposta' THEN
      NEW.status := 'lead_respondeu';
    ELSIF OLD.status = NEW.status AND NEW.status IN ('formulario', 'formulario_nao_respondeu_a_tempo')
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = NEW.board_id AND c.chave IN ('pendente', 'lead_respondeu')) THEN
      NEW.status := CASE WHEN NEW.primeira_resposta_agente_em IS NOT NULL THEN 'lead_respondeu' ELSE 'pendente' END;
    ELSIF OLD.status = NEW.status AND NEW.status = 'finalizado' AND NEW.primeira_resposta_agente_em IS NULL THEN
      NEW.status := 'pendente';
    END IF;
  END IF;
  RETURN NEW;
END $f$;

CREATE OR REPLACE VIEW email_ia.v_sla_suporte_escalado AS
WITH base AS (
  SELECT s.id AS caso_id, s.board_id, s.status, s.prioridade_nivel, s.tag_motivo, s.criado_em,
         s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, s.ultimo_email_cliente_em,
         email_ia.sla_meta_minutos(s.prioridade_nivel) AS meta_min,
         (coalesce(fi.status_ticket, '') = 'Pendente') AS pausado,
         (s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta', 'pendente_recorrencia')
            AND coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')) AS aberto,
         (s.primeira_resposta_agente_em IS NOT NULL AND s.ultimo_email_cliente_em IS NOT NULL AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz)
            AND s.status IN ('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta', 'pendente_recorrencia')
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
COMMENT ON VIEW email_ia.v_sla_suporte_escalado IS 'SLA dentro do turno por caso: 1ª resposta e vez do agente (2ª em diante); metas 3 h Alta / 4 h Média (073); tempo em "Pendente" não conta (085); pendente_recorrencia conta como em aberto (106).';
