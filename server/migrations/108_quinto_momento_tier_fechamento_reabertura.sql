-- ═══════════════════════════════════════════════════════════════════════════
--  108 · Suporte Humano — 5º momento da solicitação da Késsia (PDF, 19/10/2026): os dois pontos em azul
--
--  A) Itens 2 e 3 + OBS 1 e 2 (fechamento e reabertura):
--     · Resolvido há mais de 10 dias (antes: 7) → Fechado automaticamente. Aberto, já respondido ao cliente, sem resposta dele há mais de 10 dias → Fechado (já era assim).
--     · Cliente escreve em ticket FECHADO → status Aberto + marca TICKET REABERTO (ticket_reaberto_em) e o caso entra na fila do agente como pendente de resposta.
--     · Cliente escreve em ticket RESOLVIDO → status Aberto (SEM a marca de reaberto) e o caso entra na fila do agente como pendente de resposta.
--       "Entrar na fila": caso com coluna 'finalizado' (fora da fila) volta para 'lead_respondeu' (o agente já tinha respondido) ou 'pendente' (nunca respondeu).
--     · Tudo registrado no histórico do ticket pelos gatilhos que já existiam (eventos da ficha + movimento do caso).
--  B) Item 10 — Tier do valor do pedido: valor do pedido (front + upsells/downsells da mesma jornada, em USD) e Tier 1 a 6, calculados quando o ticket chega:
--       Tier 1 acima de $600 · Tier 2 $500–$599 · Tier 3 $400–$499 · Tier 4 $300–$399 · Tier 5 $200–$299 · Tier 6 até $199.
--     Sem pedido encontrado (ou sem valor registrado) o tier fica vazio. Tickets que já existem recebem o valor agora (preenchimento único).
--  (O item 1, a opção "Não reembolsado - Fora da garantia" em Tipo de resolução, é só do código da API: lista fechada em OPCOES.)
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A.1 fechamento: Resolvido passa de 7 para 10 dias (reescreve a função ao vivo, sem copiar o corpo)
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('email_ia.fechar_tickets_automatico'::regproc);
  IF position('interval ''7 days''' IN v_def) > 0 THEN
    EXECUTE replace(v_def, 'interval ''7 days''', 'interval ''10 days''');
  ELSIF position('interval ''10 days''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'fechar_tickets_automatico mudou: não achei o prazo de 7 dias.';
  END IF;
END $$;

-- ── A.2 reabertura: Fechado → Aberto + TICKET REABERTO; Resolvido → Aberto (sem a marca)
CREATE OR REPLACE FUNCTION email_ia.trg_reabrir_ticket_ficha() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.email_id IS NOT NULL AND NEW.email_id IS DISTINCT FROM OLD.email_id THEN
    UPDATE email_ia.suporte_escalado_ficha
       SET status_ticket = 'Aberto',
           ticket_reaberto_em = CASE WHEN status_ticket = 'Fechado' THEN now() ELSE ticket_reaberto_em END,
           propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_em = now()
     WHERE suporte_escalado_id = NEW.id AND status_ticket IN ('Fechado', 'Resolvido');
  END IF;
  RETURN NULL;
END $f$;

-- ── A.3 o caso reaberto entra na fila do agente: 'finalizado' com ficha Fechada/Resolvida volta como pendente (como a 106 já faz com formulário)
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
    ELSIF OLD.status = NEW.status AND NEW.status = 'finalizado'
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_ficha f WHERE f.suporte_escalado_id = NEW.id AND f.status_ticket IN ('Fechado', 'Resolvido'))
          AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c WHERE c.board_id = NEW.board_id AND c.chave IN ('pendente', 'lead_respondeu')) THEN
      NEW.status := 'lead_respondeu';   -- 5º momento, OBS 1 e 2: o agente já respondeu antes e o cliente escreveu de novo → pendente de resposta
    END IF;
  END IF;
  RETURN NEW;
END $f$;

-- ── B. Tier do valor do pedido
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS valor_pedido_usd numeric(12,2);
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS tier smallint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_escalado_tier_1_a_6') THEN
    ALTER TABLE email_ia.suporte_escalado ADD CONSTRAINT suporte_escalado_tier_1_a_6 CHECK (tier IS NULL OR tier BETWEEN 1 AND 6);
  END IF;
END $$;
COMMENT ON COLUMN email_ia.suporte_escalado.valor_pedido_usd IS 'Valor do pedido do cliente (front + upsells/downsells da jornada, USD) calculado quando o ticket chega (108).';
COMMENT ON COLUMN email_ia.suporte_escalado.tier IS 'Tier do valor do pedido (108): 1 > $600 · 2 $500–599 · 3 $400–499 · 4 $300–399 · 5 $200–299 · 6 até $199. Vazio = sem valor conhecido.';

CREATE OR REPLACE FUNCTION email_ia.tier_do_valor(p_valor numeric) RETURNS smallint LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN p_valor IS NULL THEN NULL
              WHEN p_valor >= 600 THEN 1 WHEN p_valor >= 500 THEN 2 WHEN p_valor >= 400 THEN 3
              WHEN p_valor >= 300 THEN 4 WHEN p_valor >= 200 THEN 5 ELSE 6 END::smallint
$f$;

-- Valor do pedido mais recente do cliente até o dia do ticket: soma dos itens da jornada (a mesma conta do recibo consolidado). NULL se não houver valor.
CREATE OR REPLACE FUNCTION email_ia.valor_pedido_do_cliente(p_email text, p_ate timestamptz) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT (SELECT sum(i.valor) FROM public.recibo_consolidado_itens(d.id) i)
    FROM public.disparos_pos_venda d
   WHERE lower(d.email) = lower(p_email) AND d.criado_em <= coalesce(p_ate, now()) + interval '1 day'
   ORDER BY d.criado_em DESC LIMIT 1
$f$;

CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_tier() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.valor_pedido_usd IS NULL THEN
    NEW.valor_pedido_usd := email_ia.valor_pedido_do_cliente(NEW.remetente_email, coalesce(NEW.criado_em, now()));
  END IF;
  NEW.tier := email_ia.tier_do_valor(NEW.valor_pedido_usd);
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_suporte_escalado_tier ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_tier BEFORE INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_tier();

-- Preenchimento único dos tickets que já existem
UPDATE email_ia.suporte_escalado s
   SET valor_pedido_usd = v.valor, tier = email_ia.tier_do_valor(v.valor)
  FROM (SELECT x.id, email_ia.valor_pedido_do_cliente(x.remetente_email, x.criado_em) AS valor FROM email_ia.suporte_escalado x WHERE x.valor_pedido_usd IS NULL) v
 WHERE s.id = v.id AND v.valor IS NOT NULL AND s.valor_pedido_usd IS NULL;
