-- ═══════════════════════════════════════════════════════════════════════════
--  103 · SPPL — view sppl_logistica mais barata (mesma lógica da 101)
--  As duas subconsultas por pedido (última movimentação e data da etiqueta) eram duplicadas pelo planejador em ~17 pontos do SELECT;
--  com ~5 mil pedidos a view levava ~2–4 s e estourava o statement_timeout de 15 s quando o servidor estava ocupado.
--  Agora cada pedido faz UMA leitura agregada (LATERAL). Resultado idêntico; só troca a definição da view (idempotente).
-- ═══════════════════════════════════════════════════════════════════════════

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
  SELECT b.*, ev.ultima_movimentacao_em, ev.etiqueta_em
    FROM base b
    LEFT JOIN LATERAL (
      SELECT max(e.ocorreu_em) FILTER (WHERE e.status NOT IN ('InfoReceived', 'NotFound')) AS ultima_movimentacao_em,
             min(e.ocorreu_em) FILTER (WHERE e.status = 'InfoReceived') AS etiqueta_em
        FROM rastreio_17t_eventos e WHERE e.numero = b.numero_17t) ev ON true
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

COMMENT ON VIEW sppl_logistica IS 'SPPL 2º momento (101/103): pedidos em aberto classificados nos 5 quadros do Monitoramento Logístico. Ver o cabeçalho da migração 101 para os critérios.';
