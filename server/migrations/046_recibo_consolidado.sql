-- ═══════════════════════════════════════════════════════════════════════════
--  046 · Recibo consolidado da jornada (construído em 22/09/2026, PAUSADO)
--
--  Pedido do Lucas: um único e-mail, logo após a compra, listando TUDO que o lead comprou
--  (front + upsell/downsell), o preço de cada item e o total — pra ele nunca ter a surpresa de
--  "não sabia que tinha comprado isso" mais tarde. Substitui a ideia do recibo por pedido (que
--  saía um e-mail por transação); este manda UM e-mail por jornada.
--
--  Como decide quando a jornada terminou: não existe um evento de "cliente saiu do checkout" —
--  nem JVZoo, nem Digistore24, nem BuyGoods mandam isso. A saída é esperar um tempo fixo depois da
--  compra do front (mesma ideia da "janela D0" já discutida pro e-mail de confirmação de cobrança).
--  Testado com os upsells/downsells reais dos últimos 7 dias: 90% chegam em até 20 minutos depois
--  do front, 99,9% em até 75 minutos — por isso o padrão é 75 min. Configurável sem deploy.
--
--  Como casa upsell/downsell com o front: mesmo e-mail + mesma plataforma + criado_em depois do
--  front e dentro da janela — pega sempre o front MAIS RECENTE antes do upsell (evita que dois
--  pedidos próximos do mesmo cliente se misturem).
--
--  O valor de cada item usa a mesma prioridade do R3 da Visão Geral (migração 043): o evento da
--  própria plataforma (eventos_plataforma) quando existe, o rastreio como piso quando não existe.
--
--  PAUSADO DE PROPÓSITO (duas travas, independentes):
--   1) `config_disparos.recibo_consolidado_ativo = 'false'` — `recibo_consolidado_fila()` devolve
--      vazio enquanto isso não virar 'true'. Ninguém envia nada só por essa migração existir.
--   2) O fluxo do n8n que consome essa fila (a construir/importar depois) deve subir INATIVO.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES
  ('recibo_consolidado_ativo',       'false'),
  ('recibo_consolidado_espera_min',  '75')
ON CONFLICT (chave) DO NOTHING;

-- O que já foi enviado (idempotência do envio + registro pro suporte consultar depois:
-- "o cliente diz que não sabia que comprou X" -> confere aqui o que foi mandado pra ele).
CREATE TABLE IF NOT EXISTS recibo_consolidado_enviado (
  disparo_id   bigint PRIMARY KEY REFERENCES disparos_pos_venda(id),
  email        text NOT NULL,
  itens        jsonb NOT NULL,
  valor_total  numeric,
  moeda        text,
  enviado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recibo_consolidado_email ON recibo_consolidado_enviado (lower(email));

-- Itens da jornada de um front (o front + upsell/downsell casados por e-mail/plataforma/janela).
-- Retorna uma linha por item: nome do produto, quantidade (sempre 1 — cada compra é 1 linha),
-- valor (evento da plataforma > rastreio) e a etapa (front/upsell/downsell).
CREATE OR REPLACE FUNCTION public.recibo_consolidado_itens(p_disparo_id bigint)
RETURNS TABLE (etapa_funil text, produto text, valor numeric, moeda text)
LANGUAGE sql STABLE AS $$
  WITH front AS (
    SELECT d.id, d.transacao_id, btrim(d.plataforma) AS plataforma, lower(d.email) AS email,
           d.criado_em, coalesce(pr.nome, nullif(d.produto, ''), 'Produto') AS produto
    FROM disparos_pos_venda d
    LEFT JOIN produtos pr ON pr.slug = d.produto_slug AND pr.slug <> '*'
    WHERE d.id = p_disparo_id
  ),
  janela AS (
    SELECT (SELECT valor::int FROM config_disparos WHERE chave = 'recibo_consolidado_espera_min') AS min
  ),
  acompanhantes AS (
    SELECT u.transacao_id, u.etapa_funil, u.plataforma,
           coalesce(pr.nome, nullif(u.produto, ''), 'Produto') AS produto, u.criado_em
    FROM compras_upsell_downsell u
    JOIN front f ON lower(u.email) = f.email AND u.plataforma IS NOT DISTINCT FROM f.plataforma
      AND u.criado_em >= f.criado_em AND u.criado_em < f.criado_em + interval '3 hours'
      -- a mesma transação nunca pode contar 2x: o bug conhecido da JVZoo (downsell "(Last Chance)"
      -- que o filtro deixa passar como se fosse compra nova, ver Pendências e Roadmap) grava a
      -- MESMA compra nas duas tabelas — 1.683 casos assim hoje. Sem este filtro, o cliente veria
      -- o mesmo item listado 2x no recibo.
      AND u.transacao_id <> f.transacao_id
    LEFT JOIN produtos pr ON pr.slug = resolve_produto(u.produto) AND pr.slug <> '*'
  ),
  todos AS (
    SELECT 'front' AS etapa_funil, f.produto, f.transacao_id, f.plataforma FROM front f
    UNION ALL
    SELECT a.etapa_funil, a.produto, a.transacao_id, a.plataforma FROM acompanhantes a
  ),
  valorizado AS (
    SELECT t.etapa_funil, t.produto, t.transacao_id, t.plataforma,
           (SELECT abs(e.valor) FROM eventos_plataforma e
             WHERE e.transacao_id = t.transacao_id AND btrim(e.plataforma) = t.plataforma
               AND e.evento IN ('SALE', 'payment', 'neworder') AND e.valor IS NOT NULL
             ORDER BY e.recebido_em ASC LIMIT 1) AS valor_evento,
           (SELECT r.total FROM rastreio_pedidos r WHERE r.transacao_id = t.transacao_id) AS valor_rastreio
    FROM todos t
  )
  SELECT etapa_funil, produto, coalesce(valor_evento, valor_rastreio) AS valor, 'USD'::text AS moeda
  FROM valorizado
  ORDER BY CASE etapa_funil WHEN 'front' THEN 0 WHEN 'upsell' THEN 1 WHEN 'downsell' THEN 2 ELSE 3 END;
$$;

-- Fila de fronts prontos pra receber o recibo consolidado: a janela de espera já passou,
-- ainda não foi enviado, e o interruptor geral está ligado (senão devolve vazio sempre).
CREATE OR REPLACE FUNCTION public.recibo_consolidado_fila(p_limite integer DEFAULT 50)
RETURNS TABLE (disparo_id bigint, email text, nome text, plataforma text, criado_em timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.email, d.nome, d.plataforma, d.criado_em
  FROM disparos_pos_venda d
  WHERE (SELECT valor FROM config_disparos WHERE chave = 'recibo_consolidado_ativo') = 'true'
    AND d.email IS NOT NULL
    AND d.criado_em <= now() - ((SELECT valor::int FROM config_disparos WHERE chave = 'recibo_consolidado_espera_min') || ' minutes')::interval
    AND NOT EXISTS (SELECT 1 FROM recibo_consolidado_enviado r WHERE r.disparo_id = d.id)
  ORDER BY d.criado_em
  LIMIT p_limite;
$$;

COMMENT ON FUNCTION public.recibo_consolidado_fila IS
  'Fronts prontos pro recibo consolidado (janela vencida, ainda não enviado). Devolve vazio enquanto recibo_consolidado_ativo <> ''true''.';
COMMENT ON FUNCTION public.recibo_consolidado_itens IS
  'Itens da jornada de um front (front + upsell/downsell casados por e-mail+plataforma+janela), com valor do evento da plataforma ou do rastreio.';
