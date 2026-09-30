-- ═══════════════════════════════════════════════════════════════════════════
--  058 · Suporte Escalado — rotina que move para "Reembolsado" os casos em Pendente cujo cliente já foi reembolsado (30/09/2026)
--
--  Origem: em 30/09 havia 40 casos em Pendente com cliente reembolsado/chargeback (dado do dash); o nó "Limpar Kanban" do n8n usa os
--  campos de reembolso de disparos_pos_venda, que não guardam esses estornos. Função email_ia.mover_reembolsados_pendentes(aplicar):
--    · regra do Manual v2 (E19/E16): cliente com TODOS os pedidos reembolsados (grupo A) ou com o pedido principal (front) reembolsado
--      e upsell ainda ativo (grupo B) -> status 'reembolsado', mesmo board. NÃO move quem só teve upsell/downsell reembolsado (grupo C).
--    · estorno da Digistore24 = linha de valor negativo ligada ao pedido por parent_external_id = session_id/external_id (ver Dash Fase 2);
--      JVZoo = status no próprio pedido. BuyGoods não envia estorno (fica fora).
--    · aplicar=false só lista; aplicar=true move, grava nota (autor 'Sistema') e registra em email_ia.log_reembolsados_pendentes.
--  Não envia e-mail. Agendamento: cron diário na VPS (ver Correções/reembolsados_em_pendente/CRON.md). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.log_reembolsados_pendentes (
  id              bigserial PRIMARY KEY,
  executado_em    timestamptz NOT NULL DEFAULT now(),
  caso_id         bigint NOT NULL,
  board_id        bigint,
  status_anterior text,
  grupo           text
);

CREATE OR REPLACE FUNCTION email_ia.mover_reembolsados_pendentes(p_aplicar boolean DEFAULT false)
RETURNS TABLE (caso_id bigint, board_id bigint, status_anterior text, grupo text) LANGUAGE plpgsql AS $f$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _mrp ON COMMIT DROP AS SELECT 0::bigint AS caso_id, 0::bigint AS board_id, ''::text AS status_anterior, ''::text AS grupo WHERE false;
  TRUNCATE _mrp;
  INSERT INTO _mrp
  WITH p AS (
    SELECT s.id, s.board_id, s.status, lower(s.remetente_email) AS em
      FROM email_ia.suporte_escalado s WHERE s.status IN ('pendente', 'pendente_recorrencia')
  ), dd AS (
    SELECT p.id AS cid, x.external_id, x.session_id, x.funnel_step, upper(x.status) AS st, x.gross, nullif(x.parent_external_id, '') AS parent
      FROM p JOIN dash_pedidos x ON lower(x.customer_email) = p.em
  ), ped AS (
    SELECT a.*, (a.st IN ('REFUNDED', 'CHARGEBACK') OR EXISTS (
             SELECT 1 FROM dd b WHERE b.cid = a.cid AND b.gross < 0 AND b.parent IS NOT NULL AND b.parent IN (a.session_id, a.external_id))) AS efetivo
      FROM dd a WHERE a.gross >= 0
  ), c AS (
    SELECT cid, count(*) FILTER (WHERE efetivo) AS n_reemb, count(*) FILTER (WHERE NOT efetivo) AS n_ativos,
           bool_or(efetivo AND funnel_step IS NOT DISTINCT FROM 1) AS front_reemb
      FROM ped GROUP BY cid
  )
  SELECT p.id, p.board_id, p.status, CASE WHEN c.n_ativos = 0 THEN 'A' ELSE 'B' END
    FROM c JOIN p ON p.id = c.cid
   WHERE c.n_reemb > 0 AND (c.n_ativos = 0 OR c.front_reemb);

  IF p_aplicar THEN
    UPDATE email_ia.suporte_escalado s SET status = 'reembolsado', iniciado_em = coalesce(s.iniciado_em, now()), atualizado_em = now()
     WHERE s.id IN (SELECT m.caso_id FROM _mrp m) AND s.status IN ('pendente', 'pendente_recorrencia');
    INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
      SELECT m.caso_id, 'Sistema', 'Movido automaticamente para Reembolsado: o cliente tem pedido reembolsado/chargeback (dado do dash). Nenhuma resposta automática foi enviada por esta movimentação.'
        FROM _mrp m;
    INSERT INTO email_ia.log_reembolsados_pendentes (caso_id, board_id, status_anterior, grupo)
      SELECT m.caso_id, m.board_id, m.status_anterior, m.grupo FROM _mrp m;
  END IF;
  RETURN QUERY SELECT m.caso_id, m.board_id, m.status_anterior, m.grupo FROM _mrp m ORDER BY m.caso_id;
END
$f$;
