-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
--  123 · Referência JVZoo por pedido: Transaction ID (WP-/PT-) e tipo de reembolso (pedido do Lucas, 30/10/2026, para o Rodrigo/Simon)
--
--  O SendTrace guarda como "pedido" da JVZoo o PreKey sem o prefixo WR- (`transacao_id`, 17 caracteres). O Transaction ID que o time vê na JVZoo (WP- cartão,
--  PT- PayPal) só existia no payload do aviso (eventos_plataforma, desde 21/09) e a JVZoo não diz, no aviso, se o reembolso veio de pedido do cliente (REFUND),
--  de alerta preventivo do banco (ALERT) ou de disputa/chargeback (DISPUTE). Esta tabela liga uma coisa à outra, uma linha por pedido:
--     transacao_id     chave do SendTrace (= disparos_pos_venda.transacao_id = dash_pedidos.external_id)
--     paykey           Transaction ID da JVZoo (WP-… ou PT-…)
--     tipo_reembolso   REFUND | ALERT | DISPUTE; NULL = sem reembolso (ou ainda não classificado)
--     reembolsado_em   quando o reembolso apareceu na JVZoo;  disputa_dia  dia em que a disputa abriu (hora de Nova York)
--     fonte            'aviso da JVZoo (exato)' ou 'financeiro (hora+valor)' (cruzamento por hora ±2 s + valor + etapa; só quando há UM candidato)
--     publicacao       publicação do financeiro de onde veio o tipo (ex.: pub131)
--  Quem preenche: o script de importação (vault: Projetos/SendTrace/Correções/base_reembolsado_plataforma/scripts, `importar_jvzoo_referencia.sql` + `monta_referencia.py`),
--  a cada nova publicação do financeiro. A API (GET /api/suporte-escalado/:id/contexto) lê esta tabela e, sem linha nela, cai no aviso da JVZoo como antes.
--  Aditiva e idempotente. Desfazer: DROP TABLE public.jvzoo_referencia;
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.jvzoo_referencia (
  transacao_id    text PRIMARY KEY,
  paykey          text NOT NULL UNIQUE,
  tipo_reembolso  text CHECK (tipo_reembolso IN ('REFUND', 'ALERT', 'DISPUTE')),
  reembolsado_em  timestamptz,
  disputa_dia     date,
  fonte           text NOT NULL,
  publicacao      text,
  atualizado_em   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.jvzoo_referencia IS 'Referência JVZoo por pedido (123): Transaction ID (WP-/PT-) e tipo de reembolso (REFUND/ALERT/DISPUTE), importados do aviso da JVZoo e do financeiro.';
COMMENT ON COLUMN public.jvzoo_referencia.transacao_id IS 'Chave do SendTrace: PreKey sem o prefixo WR- (igual a disparos_pos_venda.transacao_id).';
COMMENT ON COLUMN public.jvzoo_referencia.tipo_reembolso IS 'REFUND = pedido do cliente · ALERT = alerta preventivo do banco, a JVZoo devolveu antes · DISPUTE = chargeback (cliente contestou no banco). NULL = sem reembolso ou sem classificação.';

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
