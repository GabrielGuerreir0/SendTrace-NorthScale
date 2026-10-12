-- ═══════════════════════════════════════════════════════════════════════════
--  094 · SPPL — o sorteio do responsável deixa de depender de o agente estar ATIVO no roteador do Suporte Escalado
--
--  Em 12/10 só o board do Munhoz estava ativo no Suporte Escalado; ativar os demais só para receber alerta de logística os faria receber também tickets do
--  Suporte Escalado (a coluna `ativo` do board é a do roteador). O sorteio do SPPL passa a olhar só `recebe_sppl` + usuário ativo.
--  Decisão do Lucas (12/10, a confirmar com a Késsia): recebem Munhoz, Vitória, Thalison, Klebson e Ramon; a Késsia (gestão) fica de fora do sorteio.
--  `recebe_sppl` passa a nascer FALSE para board novo (antes TRUE). Esta migração roda uma vez; depois o ajuste é pelo interruptor na tela (Regras do SPPL).
--  Só mexe em: 1 função (CREATE OR REPLACE), o default de 1 coluna e o valor atual dessa coluna. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_boards ALTER COLUMN recebe_sppl SET DEFAULT false;

UPDATE email_ia.suporte_escalado_boards
   SET recebe_sppl = (lower(btrim(nome)) IN ('munhoz', 'vitória', 'vitoria', 'thalison', 'klebson', 'ramon'));

CREATE OR REPLACE FUNCTION email_ia.sppl_escolher_board() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  escolhido bigint;
BEGIN
  WITH elegiveis AS (
    SELECT b.id AS board_id
      FROM email_ia.suporte_escalado_boards b
      JOIN public.painel_usuarios u ON u.id = b.usuario_id
     WHERE u.ativo AND b.recebe_sppl   -- NÃO olha b.ativo: ele liga o agente no roteador do Suporte Escalado (tickets), e o SPPL não deve mexer nisso
  ),
  velocidade AS (
    SELECT t.board_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.horas) AS mediana_h
      FROM (
        SELECT h.board_id,
               extract(epoch FROM (h.mudou_em - lag(h.mudou_em) OVER (PARTITION BY h.suporte_escalado_id ORDER BY h.mudou_em))) / 3600.0 AS horas
          FROM email_ia.suporte_escalado_historico h
         WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em > now() - interval '14 days'
      ) t
     WHERE t.horas IS NOT NULL
     GROUP BY t.board_id
  ),
  abertas AS (
    SELECT o.board_id, count(*) AS n
      FROM public.sppl_ocorrencias o
     WHERE o.board_id IS NOT NULL AND o.situacao NOT IN ('resolvida', 'cancelada')
     GROUP BY o.board_id
  ),
  base AS (
    SELECT el.board_id,
           coalesce(v.mediana_h, (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mediana_h) FROM velocidade), 24) AS mediana_h,
           coalesce(a.n, 0) AS abertas
      FROM elegiveis el
      LEFT JOIN velocidade v ON v.board_id = el.board_id
      LEFT JOIN abertas a ON a.board_id = el.board_id
  ),
  pontuado AS (
    SELECT board_id, (1.0 / GREATEST(mediana_h, 0.1)) * (1.0 / (1 + abertas)) AS peso FROM base
  ),
  sorteio AS (
    SELECT board_id, sum(peso) OVER (ORDER BY board_id) AS acumulado, sum(peso) OVER () AS total FROM pontuado
  ),
  -- UM só número aleatório por sorteio. `random()` direto no WHERE roda UMA VEZ POR LINHA e favorece quem vem primeiro na ordem
  -- (medido em 12/10: com 5 agentes iguais, 3000 sorteios deram 582/977/881/450/110 em vez de ~600 cada).
  r AS MATERIALIZED (SELECT random() AS x)
  SELECT board_id INTO escolhido FROM sorteio WHERE acumulado >= (SELECT x FROM r) * total ORDER BY acumulado LIMIT 1;
  RETURN escolhido;
END $$;
