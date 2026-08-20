-- ═══════════════════════════════════════════════════════════════════════════
--  Pixel de rastreamento de abertura — régua de pós-venda.
--
--  Uma linha por HIT (não uma coluna aberto_em): o mesmo cliente pode abrir
--  o e-mail mais de uma vez, e cada abertura conta.
--
--  Sem FK para disparos_pos_venda de propósito: um disparo pode ser movido
--  para disparos_apagados_bkp numa limpeza manual (já aconteceu em 01/08,
--  ver referencia-banco-sendtrace.md) e a abertura registrada antes disso
--  não pode virar erro de integridade nem sumir junto.
--
--  O token (formato "d<disparo_id>.<etapa>.<sufixo aleatório>") é gerado no
--  node "Montar Mensagem" do fluxo n8n "Processador de Disparos" — decisão
--  consciente de NÃO assinar com HMAC: o Code node do n8n não garante que
--  `require('crypto')` esteja liberado no sandbox desta instância, e o
--  custo de um token não assinado é baixo (alguém que soubesse um disparo_id
--  poderia forjar uma abertura falsa — só polui a métrica, não expõe nem
--  altera dado real). Ver POST /pixel/:token em api/rotas/pixel.js.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS aberturas_disparo (
  id          bigserial   PRIMARY KEY,
  disparo_id  bigint      NOT NULL,
  etapa       int         NOT NULL,
  token       text        NOT NULL,
  ip          inet,
  user_agent  text,
  aberto_em   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE aberturas_disparo
  IS 'Aberturas do pixel de rastreamento embutido nos e-mails da régua (Processador de Disparos). 1 linha por hit.';

CREATE INDEX IF NOT EXISTS idx_aberturas_disparo_disparo_id ON aberturas_disparo (disparo_id);
CREATE INDEX IF NOT EXISTS idx_aberturas_disparo_token ON aberturas_disparo (token);
