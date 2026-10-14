-- ═══════════════════════════════════════════════════════════════════════════
--  101 · SPPL, 2º momento da Késsia: Monitoramento Logístico (5 quadros) + Suporte Ativo (e-mail em massa)
--
--  Pedido da Késsia (PDF "SPPL - NORTHSCALE", 2º momento, 14/10/2026). Fica dentro de Rastreio de Pedidos.
--
--  1) View `sppl_logistica`: UMA linha por pedido ainda em aberto (pendente ou enviado, sem reembolso/chargeback, ticket do Suporte Ativo não
--     fechado) já classificada em um dos 5 quadros do dashboard. Os quadros são DISJUNTOS e vêm do dado real, não das ocorrências do motor:
--       1 Sem rastreio        pendente, sem código, mais de 2 dias ÚTEIS desde a compra
--       2 Sem despacho        código gerado e aceito no 17TRACK, ainda sem NENHUMA movimentação real, mais de 2 dias úteis desde a etiqueta
--       3 Monitorar           com movimentação real; 5 a 9 dias corridos desde a última
--       4 Atenção             10 a 14 dias
--       5 Críticos            15 dias ou mais
--     "Movimentação relevante" = último evento do 17TRACK que NÃO seja InfoReceived (etiqueta criada) nem NotFound. Criar etiqueta ou atualização
--     administrativa NÃO zera a contagem. Pedido com código mas sem registro no 17TRACK fica fora dos quadros 2–5 (sem dado confiável) e é contado
--     à parte (`sem_17track`).
--  2) Suporte Ativo: `sppl_ativo_tickets` (5 grupos de propriedades), `sppl_ativo_acoes` (registro de tudo), `sppl_ativo_envios` (fila de e-mails
--     individuais) e a view `sppl_ativo_respostas` (respostas dos clientes, FILA SEPARADA da fila normal do suporte).
--  3) Guarda opcional: resposta de cliente a e-mail do Suporte Ativo NÃO abre card novo no Suporte Escalado (interruptor
--     `sppl_ativo_isolar_respostas`, padrão ligado; erro no gatilho nunca bloqueia a gravação do e-mail).
--
--  Só ADICIONA (tabelas, views, 1 gatilho, 1 função, chaves de config). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Endereço de entrega (o relatório do 2º momento pede). Preenchido pelo script de rastreio da fulfillment (RedRock) quando disponível; vazio = "—". ──
ALTER TABLE rastreio_pedidos ADD COLUMN IF NOT EXISTS endereco_entrega text;

-- ── Suporte Ativo ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sppl_ativo_tickets (
  id                bigserial PRIMARY KEY,
  transacao_id      text NOT NULL,
  numero_pedido     text,
  email             text,
  nome              text,
  produto           text,
  plataforma        text,
  fulfillment       text,
  transportadora    text,
  -- A. Rastreio (o código original é preservado mesmo quando há reenvio)
  rastreio_original text,
  link_rastreio     text,
  rastreio_reenvio  text,
  link_reenvio      text,
  -- B, C, D, E: propriedades separadas (as listas de valores ficam em api/sppl/ativoConstantes.js; aqui é texto livre para poder evoluir)
  status_logistico  text NOT NULL DEFAULT 'Caso novo - Analisar',
  motivo_problema   text NOT NULL DEFAULT 'Caso novo — Analisar',
  status_suporte    text NOT NULL DEFAULT 'Caso novo - Analisar',
  status_ticket     text NOT NULL DEFAULT 'aberto' CHECK (status_ticket IN ('aberto','resolvido','fechado')),
  quadro_origem     smallint,
  selecionado_por   text,
  selecionado_em    timestamptz NOT NULL DEFAULT now(),
  atendida_em       timestamptz,          -- a equipe deu a resposta do cliente por tratada
  fechado_em        timestamptz,
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);
-- no máximo UM ticket não fechado por pedido; fechado o pedido pode voltar a ser selecionado
CREATE UNIQUE INDEX IF NOT EXISTS sppl_ativo_tickets_aberto_uq ON sppl_ativo_tickets (transacao_id) WHERE status_ticket <> 'fechado';
CREATE INDEX IF NOT EXISTS sppl_ativo_tickets_status_idx ON sppl_ativo_tickets (status_ticket, selecionado_em DESC);
CREATE INDEX IF NOT EXISTS sppl_ativo_tickets_email_idx ON sppl_ativo_tickets (lower(email));
CREATE INDEX IF NOT EXISTS sppl_ativo_tickets_transacao_idx ON sppl_ativo_tickets (transacao_id);

CREATE TABLE IF NOT EXISTS sppl_ativo_acoes (
  id         bigserial PRIMARY KEY,
  ticket_id  bigint NOT NULL REFERENCES sppl_ativo_tickets(id) ON DELETE CASCADE,
  tipo       text NOT NULL,               -- selecionado | propriedades | email_enfileirado | email_enviado | email_falhou | atendida | fechado | reaberto
  detalhe    jsonb,
  por        text,
  em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sppl_ativo_acoes_ticket_idx ON sppl_ativo_acoes (ticket_id, em DESC);

CREATE TABLE IF NOT EXISTS sppl_ativo_envios (
  id            bigserial PRIMARY KEY,
  ticket_id     bigint NOT NULL REFERENCES sppl_ativo_tickets(id) ON DELETE CASCADE,
  lote          text NOT NULL,            -- uma operação de envio em massa
  para_email    text NOT NULL,            -- UM destinatário por mensagem (cada cliente recebe o seu e-mail)
  assunto       text NOT NULL,
  texto         text NOT NULL,            -- já personalizado para este cliente
  status        text NOT NULL DEFAULT 'fila' CHECK (status IN ('fila','enviando','enviado','falhou','cancelado')),
  tentativas    smallint NOT NULL DEFAULT 0,
  erro          text,
  message_id    text,
  criado_por    text,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  enviado_em    timestamptz
);
CREATE INDEX IF NOT EXISTS sppl_ativo_envios_fila_idx ON sppl_ativo_envios (status, proxima_tentativa_em);
CREATE INDEX IF NOT EXISTS sppl_ativo_envios_ticket_idx ON sppl_ativo_envios (ticket_id, enviado_em DESC);
CREATE INDEX IF NOT EXISTS sppl_ativo_envios_lote_idx ON sppl_ativo_envios (lote);

-- ── Monitoramento logístico: os 5 quadros ──────────────────────────────────

CREATE OR REPLACE VIEW sppl_logistica AS
WITH base AS (
  SELECT p.transacao_id, p.status_interno, p.provedor, p.tracking_number, p.carrier_code, p.tracking_url, p.shipped_at, p.total,
         coalesce(nullif(p.order_number, ''), p.transacao_id) AS numero_pedido,
         coalesce(p.order_created_at, d.criado_em) AS data_pedido,
         d.nome, d.email, d.plataforma, d.produto,
         g.numero AS numero_17t, g.ultimo_status, g.ultimo_substatus
    FROM rastreio_pedidos p
    JOIN disparos_pos_venda d ON d.transacao_id = p.transacao_id
    LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
   WHERE p.status_interno IN ('pending', 'shipped')
     AND d.reembolsado_em IS NULL AND d.chargeback_em IS NULL
     AND NOT EXISTS (SELECT 1 FROM sppl_ativo_tickets t WHERE t.transacao_id = p.transacao_id AND t.status_ticket = 'fechado' AND t.fechado_em IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM sppl_ativo_tickets t2 WHERE t2.transacao_id = p.transacao_id AND t2.status_ticket <> 'fechado'))
), mov AS (
  SELECT b.*,
         (SELECT max(e.ocorreu_em) FROM rastreio_17t_eventos e WHERE e.numero = b.numero_17t AND e.status NOT IN ('InfoReceived', 'NotFound')) AS ultima_movimentacao_em,
         (SELECT min(e.ocorreu_em) FROM rastreio_17t_eventos e WHERE e.numero = b.numero_17t AND e.status = 'InfoReceived') AS etiqueta_em
    FROM base b
), dias AS (
  SELECT m.*, CASE WHEN m.ultima_movimentacao_em IS NOT NULL THEN floor(extract(epoch FROM (now() - m.ultima_movimentacao_em)) / 86400)::int END AS dias_sem_movimentacao
    FROM mov m
)
SELECT d.transacao_id, d.numero_pedido, d.nome, d.email, d.plataforma, d.produto, d.data_pedido,
       floor(extract(epoch FROM (now() - d.data_pedido)) / 86400)::int AS idade_dias,
       d.provedor AS fulfillment, d.carrier_code, d.tracking_number, d.tracking_url, d.shipped_at, d.total,
       d.numero_17t, d.ultimo_status, d.ultimo_substatus, d.ultima_movimentacao_em, d.etiqueta_em, d.dias_sem_movimentacao,
       (coalesce(d.tracking_number, '') <> '' AND d.numero_17t IS NULL) AS sem_17track,
       CASE
         WHEN d.status_interno = 'pending' AND coalesce(d.tracking_number, '') = '' AND sppl_somar_dias_uteis(d.data_pedido, 2) <= now() THEN 1
         WHEN coalesce(d.tracking_number, '') <> '' AND d.numero_17t IS NOT NULL AND d.ultima_movimentacao_em IS NULL
              AND coalesce(d.ultimo_status, '') <> 'Delivered' AND sppl_somar_dias_uteis(coalesce(d.etiqueta_em, d.shipped_at, d.data_pedido), 2) <= now() THEN 2
         WHEN d.ultima_movimentacao_em IS NOT NULL AND coalesce(d.ultimo_status, '') <> 'Delivered' AND d.dias_sem_movimentacao >= 15 THEN 5
         WHEN d.ultima_movimentacao_em IS NOT NULL AND coalesce(d.ultimo_status, '') <> 'Delivered' AND d.dias_sem_movimentacao >= 10 THEN 4
         WHEN d.ultima_movimentacao_em IS NOT NULL AND coalesce(d.ultimo_status, '') <> 'Delivered' AND d.dias_sem_movimentacao >= 5 THEN 3
       END AS quadro
  FROM dias d;

COMMENT ON VIEW sppl_logistica IS 'SPPL 2º momento (101): pedidos em aberto classificados nos 5 quadros do Monitoramento Logístico. Ver o cabeçalho da migração 101 para os critérios.';

-- ── Respostas dos clientes aos e-mails do Suporte Ativo (fila própria) ─────

CREATE OR REPLACE VIEW sppl_ativo_respostas AS
SELECT t.id AS ticket_id, e.id AS email_id, e.data_email, e.assunto, e.corpo_texto, e.remetente_email
  FROM sppl_ativo_tickets t
  JOIN LATERAL (SELECT min(v.enviado_em) AS primeiro FROM sppl_ativo_envios v WHERE v.ticket_id = t.id AND v.status = 'enviado') x ON x.primeiro IS NOT NULL
  JOIN email_ia.emails e ON lower(e.remetente_email) = lower(t.email) AND e.data_email > x.primeiro;

-- ── Guarda: resposta a e-mail do Suporte Ativo não abre card no Suporte Escalado ──

INSERT INTO config_disparos (chave, valor) VALUES ('sppl_ativo_isolar_respostas', 'true') ON CONFLICT (chave) DO NOTHING;
INSERT INTO config_disparos (chave, valor) VALUES ('sppl_ativo_max_por_hora', '120') ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION email_ia.trg_isolar_resposta_sppl_ativo() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF coalesce((SELECT valor FROM config_disparos WHERE chave = 'sppl_ativo_isolar_respostas'), 'true') <> 'true' THEN RETURN NEW; END IF;
  IF EXISTS (
       SELECT 1 FROM sppl_ativo_tickets t
         JOIN sppl_ativo_envios v ON v.ticket_id = t.id AND v.status = 'enviado' AND v.enviado_em > now() - interval '45 days'
        WHERE lower(t.email) = lower(NEW.remetente_email) AND t.status_ticket <> 'fechado') THEN
    RETURN NULL;   -- a resposta fica só na fila do Suporte Ativo (o e-mail continua gravado em email_ia.emails)
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_isolar_resposta_sppl_ativo: %', SQLERRM;
  RETURN NEW;      -- nunca bloqueia o escalonamento por causa de erro neste gatilho
END $f$;

DROP TRIGGER IF EXISTS trg_isolar_resposta_sppl_ativo ON email_ia.suporte_escalado;
CREATE TRIGGER trg_isolar_resposta_sppl_ativo BEFORE INSERT ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_isolar_resposta_sppl_ativo();
