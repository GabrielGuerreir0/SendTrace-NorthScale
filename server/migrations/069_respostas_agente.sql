-- ═══════════════════════════════════════════════════════════════════════════
--  069 · Respostas dos agentes (lidas da pasta Enviados da caixa support@) — base da conversa completa, do SLA e dos KPIs
--  (pedido da Késsia, PDF de 05/10/2026)
--
--  Os agentes respondem pelo webmail da Hostinger, então o painel não via a resposta. Um leitor (script de leitura da pasta Enviados, só cabeçalhos
--  e corpo, sem apagar nada) grava aqui cada resposta enviada ao cliente; os gatilhos ligam a resposta ao caso do Suporte Escalado (pelo e-mail do
--  cliente) e atualizam `primeira_resposta_agente_em` e `ultima_resposta_agente_em` do caso.
--  A caixa é única (support@): a resposta NÃO diz qual agente enviou; quem responde pelo caso é o dono do board (`board_id` guardado na hora).
--  Só conta resposta enviada DEPOIS da criação do caso. Reaberturas não zeram as datas (tratado quando o SLA for calculado).
--  Só cria tabela, colunas, gatilhos e uma função. Não mexe em status, board nem envia e-mail. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.respostas_agente (
  id           bigserial PRIMARY KEY,
  message_id   text NOT NULL UNIQUE,
  in_reply_to  text,
  para_email   text NOT NULL,
  assunto      text,
  corpo_texto  text,
  enviado_em   timestamptz NOT NULL,
  imap_uid     bigint,
  caso_id      bigint REFERENCES email_ia.suporte_escalado(id) ON DELETE SET NULL,
  board_id     bigint,
  criado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS respostas_agente_para_idx ON email_ia.respostas_agente (lower(para_email), enviado_em);
CREATE INDEX IF NOT EXISTS respostas_agente_caso_idx ON email_ia.respostas_agente (caso_id);
COMMENT ON TABLE email_ia.respostas_agente IS 'Respostas humanas enviadas por support@ (pasta Enviados), ligadas ao caso do Suporte Escalado (069). corpo_texto sem a parte citada.';

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS primeira_resposta_agente_em timestamptz;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS ultima_resposta_agente_em timestamptz;

-- Liga a resposta ao caso do cliente (mesmo e-mail) criado antes dela, e guarda o board dono do caso na hora.
CREATE OR REPLACE FUNCTION email_ia.trg_resposta_agente_liga_caso() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.caso_id IS NULL THEN
    SELECT s.id, s.board_id INTO NEW.caso_id, NEW.board_id
      FROM email_ia.suporte_escalado s
     WHERE lower(s.remetente_email) = lower(NEW.para_email) AND s.criado_em <= NEW.enviado_em
     LIMIT 1;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_resposta_agente_liga_caso ON email_ia.respostas_agente;
CREATE TRIGGER trg_resposta_agente_liga_caso BEFORE INSERT ON email_ia.respostas_agente
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_resposta_agente_liga_caso();

-- Atualiza as datas de resposta do caso.
CREATE OR REPLACE FUNCTION email_ia.trg_resposta_agente_atualiza_caso() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.caso_id IS NOT NULL THEN
    UPDATE email_ia.suporte_escalado
       SET primeira_resposta_agente_em = least(coalesce(primeira_resposta_agente_em, NEW.enviado_em), NEW.enviado_em),
           ultima_resposta_agente_em   = greatest(coalesce(ultima_resposta_agente_em, NEW.enviado_em), NEW.enviado_em)
     WHERE id = NEW.caso_id;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_resposta_agente_atualiza_caso ON email_ia.respostas_agente;
CREATE TRIGGER trg_resposta_agente_atualiza_caso AFTER INSERT ON email_ia.respostas_agente
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_resposta_agente_atualiza_caso();

-- Religa respostas que chegaram antes do caso existir (o leitor chama no fim de cada rodada).
CREATE OR REPLACE FUNCTION email_ia.religar_respostas_agente() RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE n integer;
BEGIN
  WITH l AS (
    UPDATE email_ia.respostas_agente r SET caso_id = s.id, board_id = s.board_id
      FROM email_ia.suporte_escalado s
     WHERE r.caso_id IS NULL AND lower(s.remetente_email) = lower(r.para_email) AND s.criado_em <= r.enviado_em
    RETURNING r.caso_id, r.enviado_em
  ), a AS (
    UPDATE email_ia.suporte_escalado s
       SET primeira_resposta_agente_em = least(coalesce(s.primeira_resposta_agente_em, x.min_em), x.min_em),
           ultima_resposta_agente_em   = greatest(coalesce(s.ultima_resposta_agente_em, x.max_em), x.max_em)
      FROM (SELECT caso_id, min(enviado_em) AS min_em, max(enviado_em) AS max_em FROM l GROUP BY caso_id) x
     WHERE s.id = x.caso_id
    RETURNING s.id
  )
  SELECT count(*) INTO n FROM l;
  RETURN n;
END $f$;
