-- ═══════════════════════════════════════════════════════════════════════════
--  142 · MONIT-SPPL — Monitoramento Logístico (Késsia, 26/11/2026): tabela de apoio da classificação + tratativas no Suporte Ativo
--
--  1) `monit_pedidos`: UMA linha por pedido EM ABERTO já classificado (14 regras de texto → 24 classes, 5 grupos; seções 4 e 5 da especificação),
--     incluindo os SEM RASTREIO (grupo 'semrastreio', seção 6) para a lista, os filtros e a planilha serem uns só.
--     É recalculada pelo servidor (`api/monit/atualizar.js`, a cada 10 min e no botão "Atualizar") com o SQL de `api/monit/sqlClassificacao.js`;
--     o filtro de reembolso (`reemb`) fica como coluna, então a tela escolhe sem recalcular. `monit_leitura` guarda a hora REAL da última leitura.
--  2) Funções: `monit_data_us` (texto MM/DD/AAAA → data, sem estourar com data inválida) e `monit_dias_uteis` (dias úteis entre duas datas, segunda a
--     sexta menos `sppl_feriados`, no mesmo fuso America/New_York de `sppl_somar_dias_uteis`, para a classe e o número mostrado nunca discordarem).
--  3) TRATATIVAS: não há tabela paralela. Uma tratativa é uma linha de `sppl_ativo_acoes` (tipo = 'tratativa') presa ao ticket do pedido no Suporte
--     Ativo; ganha colunas próprias (tipo da tratativa, nota, classe do pedido na hora, modelo/assunto do e-mail) e `removida_em` (remover = marcar,
--     o histórico fica). Pedido sem ticket aberto ganha um ticket (`criado_pelo_monit = true`) só para guardar as tratativas.
--
--  Só ADICIONA (tabelas, colunas, funções). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS monit_pedidos (
  transacao_id         text PRIMARY KEY,
  pedido               text,
  email_cliente        text,
  nome_cliente         text,
  classe               text NOT NULL,
  grupo                text NOT NULL,
  causa                text,
  texto_transportadora text,
  evento_em            timestamptz,
  dias_desde_evento    int,                        -- sem rastreio: dias ÚTEIS desde o pedido
  dias_uteis           int,                        -- só sem rastreio: dias úteis desde o pedido
  fulfillment          text,
  transportadora       text,
  rastreio             text,
  qtd_rastreios        int,
  outros_rastreios     text,
  transferido          boolean NOT NULL DEFAULT false,
  link_rastreio        text,
  endereco             text,
  produtos             text,
  quantidade           int,
  valor                numeric,
  moeda                text,
  data_pedido          timestamptz,
  idade_dias           int,
  ultima_movimentacao  timestamptz,
  dias_sem_movimentacao int,
  plataforma           text,                       -- NULL = "Não identificada" (sem registro de venda no SendTrace)
  reembolso_cb         text NOT NULL DEFAULT 'Não', -- 'Chargeback' | 'Reembolso' | 'Em outra compra do cliente' | 'Não'
  reemb                boolean NOT NULL DEFAULT false, -- reembolso/chargeback de verdade (filtro `reemb`); "Em outra compra" NÃO conta
  tem_17t              boolean NOT NULL DEFAULT false,
  ultimo_status        text,
  status_interno       text,
  calculado_em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monit_pedidos_classe_idx ON monit_pedidos (grupo, classe);
CREATE INDEX IF NOT EXISTS monit_pedidos_data_idx ON monit_pedidos (data_pedido DESC);
CREATE INDEX IF NOT EXISTS monit_pedidos_ful_idx ON monit_pedidos (fulfillment);
CREATE INDEX IF NOT EXISTS monit_pedidos_rastreio_idx ON monit_pedidos (rastreio);

CREATE TABLE IF NOT EXISTS monit_leitura (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lido_em      timestamptz,
  duracao_ms   int,
  linhas       int,
  erro         text,
  iniciado_em  timestamptz            -- preenchido enquanto uma atualização roda (evita duas ao mesmo tempo)
);
INSERT INTO monit_leitura (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION monit_data_us(t text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $f$
BEGIN
  RETURN to_date(t, 'MM/DD/YYYY')::timestamp AT TIME ZONE 'America/New_York';
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION monit_dias_uteis(de timestamptz, ate timestamptz) RETURNS int LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN de IS NULL OR ate IS NULL THEN NULL ELSE
    (SELECT count(*)::int
       FROM generate_series((de AT TIME ZONE 'America/New_York')::date + 1, (ate AT TIME ZONE 'America/New_York')::date, interval '1 day') d
      WHERE extract(isodow FROM d) < 6 AND NOT EXISTS (SELECT 1 FROM sppl_feriados f WHERE f.data = d::date)) END
$f$;

-- ── Tratativas dentro do Suporte Ativo (sem tabela paralela) ──
ALTER TABLE sppl_ativo_tickets ADD COLUMN IF NOT EXISTS criado_pelo_monit boolean NOT NULL DEFAULT false;
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS trat_tipo    text;   -- email_cliente | plataforma | fulfillment | transportadora | reenvio | endereco | outro
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS trat_nota    text;
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS trat_classe  text;   -- classe do pedido no momento
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS trat_modelo  text;   -- e-mail marcado como enviado: nome do modelo
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS trat_assunto text;   --   e assunto (em inglês)
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS removida_em  timestamptz;
ALTER TABLE sppl_ativo_acoes ADD COLUMN IF NOT EXISTS removida_por text;
CREATE INDEX IF NOT EXISTS sppl_ativo_acoes_trat_idx ON sppl_ativo_acoes (ticket_id, em DESC) WHERE trat_tipo IS NOT NULL;

COMMENT ON TABLE monit_pedidos IS 'MONIT-SPPL (142): pedidos em aberto classificados (24 classes / 5 grupos). Recalculada por api/monit/atualizar.js; ver monit_leitura.lido_em.';
