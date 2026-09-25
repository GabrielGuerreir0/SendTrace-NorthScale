-- ═══════════════════════════════════════════════════════════════════════════
--  050 · Clientes com recorrência (US$ 39 de entrada + renovação) e a coluna "Pendente - Recorrência"
--
--  Pedido da Vitória (25/09/2026): acompanhar como os clientes com recorrência reagem à cobrança.
--    1. Nova coluna "Pendente - Recorrência" no Kanban do Suporte Escalado — todo caso NOVO de cliente com
--       recorrência ativa entra nela em vez de "Pendente". Funciona igual à Pendente.
--    2. Sub-aba "Relatório de métricas" (acumulado mensal) — ver api/rotas/recorrencia.js.
--
--  Recorrência = quem COMPROU a entrada de US$ 39 dos produtos JVZoo cadastrados em `recorrencia_produtos`
--  (444185 Flex Guard + Night Calm + Honey Flush; 450957 Bundle Blessed Kit). Cerca de 31 dias depois o JVZoo
--  cobra a renovação (US$ 167, evento BILL). O mesmo product_id 444185 também vendeu a US$ 162 à vista até
--  18/08 — esses NÃO têm recorrência, por isso a regra é product_id + valor de entrada, não só o produto.
--
--  Tudo é alimentado por um gatilho em `eventos_plataforma` — o n8n não muda. Erro no gatilho vira WARNING e
--  nunca derruba a gravação do evento do webhook. Idempotente (IF NOT EXISTS / OR REPLACE / ON CONFLICT).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.recorrencia_produtos (
  plataforma    text    NOT NULL DEFAULT 'JVZoo',
  product_id    text    NOT NULL,
  valor_entrada numeric NOT NULL,
  rotulo        text,
  PRIMARY KEY (plataforma, product_id, valor_entrada)
);

INSERT INTO public.recorrencia_produtos (plataforma, product_id, valor_entrada, rotulo) VALUES
  ('JVZoo', '444185', 39, '1 Flex Guard + 1 Night Calm + 1 Honey Flush (Upgrade)'),
  ('JVZoo', '450957', 39, 'Bundle Blessed Kit (Upgrade)')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.recorrencia_produtos IS
  'Quais produtos/valores de entrada contam como recorrência. Só o product_id + valor exato; o mesmo produto vendido a outro preço (ex.: US$ 162 à vista) fica de fora.';

-- Um cliente por (e-mail, produto). `origem`: 'webhook' (evento ao vivo), 'csv' (carga histórica do export do
-- JVZoo, de antes de 21/09, quando eventos_plataforma começou) ou 'manual' (atendente moveu o card na mão pra
-- "Pendente - Recorrência" sem o cliente estar aqui — conta no relatório, sem data de cobrança).
CREATE TABLE IF NOT EXISTS public.recorrencia_clientes (
  id                   bigserial PRIMARY KEY,
  email                text        NOT NULL,                       -- em minúsculas
  plataforma           text        NOT NULL DEFAULT 'JVZoo',
  product_id           text        NOT NULL,
  produto              text,
  entrada_em           timestamptz,                                -- compra de US$ 39
  primeira_cobranca_em timestamptz,                                -- 1ª renovação
  ultima_cobranca_em   timestamptz,                                -- renovação mais recente
  cobrancas            int         NOT NULL DEFAULT 0,             -- quantas renovações
  situacao             text        NOT NULL DEFAULT 'ativa' CHECK (situacao IN ('ativa', 'cancelada')),
  cancelada_em         timestamptz,
  origem               text        NOT NULL DEFAULT 'webhook',
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, product_id)
);
CREATE INDEX IF NOT EXISTS idx_recorrencia_clientes_email ON public.recorrencia_clientes (email);

CREATE TABLE IF NOT EXISTS public.recorrencia_cobrancas (
  paykey     text PRIMARY KEY,                                     -- JVZoo paykey: dedupe entre webhook e CSV
  cliente_id bigint      NOT NULL REFERENCES public.recorrencia_clientes(id) ON DELETE CASCADE,
  tipo       text        NOT NULL CHECK (tipo IN ('entrada', 'renovacao')),
  valor      numeric,
  cobrado_em timestamptz NOT NULL,
  origem     text        NOT NULL DEFAULT 'webhook'
);
CREATE INDEX IF NOT EXISTS idx_recorrencia_cobrancas_cliente ON public.recorrencia_cobrancas (cliente_id, cobrado_em);

-- Recalcula os contadores do cliente a partir das cobranças gravadas (idempotente: rodar de novo dá o mesmo).
CREATE OR REPLACE FUNCTION public.recorrencia_recalcular(p_cliente bigint) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.recorrencia_clientes c SET
    cobrancas            = coalesce(r.n, 0),
    primeira_cobranca_em = r.primeira,
    ultima_cobranca_em   = r.ultima,
    entrada_em           = coalesce(e.em, c.entrada_em),
    atualizado_em        = now()
  FROM (SELECT p_cliente AS id) x
  LEFT JOIN (SELECT count(*) AS n, min(cobrado_em) AS primeira, max(cobrado_em) AS ultima
             FROM public.recorrencia_cobrancas WHERE cliente_id = p_cliente AND tipo = 'renovacao') r ON true
  LEFT JOIN (SELECT min(cobrado_em) AS em
             FROM public.recorrencia_cobrancas WHERE cliente_id = p_cliente AND tipo = 'entrada') e ON true
  WHERE c.id = x.id;
$$;

-- Aplica UM evento de plataforma. SALE na entrada cadastrada cria o cliente; BILL registra a renovação;
-- reembolso/chargeback/cancelamento marcam "cancelada" (o cliente continua contando no relatório).
CREATE OR REPLACE FUNCTION public.recorrencia_aplicar_evento(
  p_plataforma text, p_evento text, p_email text, p_produto text, p_product_id text,
  p_valor numeric, p_paykey text, p_quando timestamptz
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_cli bigint;
BEGIN
  IF p_plataforma IS DISTINCT FROM 'JVZoo' OR coalesce(p_email, '') = '' OR p_product_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recorrencia_produtos WHERE plataforma = 'JVZoo' AND product_id = p_product_id) THEN
    RETURN;
  END IF;
  p_email := lower(btrim(p_email));

  IF p_evento = 'SALE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.recorrencia_produtos
                   WHERE plataforma = 'JVZoo' AND product_id = p_product_id AND valor_entrada = p_valor) THEN
      RETURN;                                                    -- ex.: venda a US$ 162 à vista
    END IF;
    INSERT INTO public.recorrencia_clientes (email, product_id, produto, entrada_em)
    VALUES (p_email, p_product_id, p_produto, p_quando)
    ON CONFLICT (email, product_id) DO UPDATE SET produto = coalesce(recorrencia_clientes.produto, EXCLUDED.produto)
    RETURNING id INTO v_cli;
    INSERT INTO public.recorrencia_cobrancas (paykey, cliente_id, tipo, valor, cobrado_em)
    VALUES (p_paykey, v_cli, 'entrada', p_valor, p_quando) ON CONFLICT (paykey) DO NOTHING;
    PERFORM public.recorrencia_recalcular(v_cli);

  ELSIF p_evento = 'BILL' THEN
    INSERT INTO public.recorrencia_clientes (email, product_id, produto)
    VALUES (p_email, p_product_id, p_produto)
    ON CONFLICT (email, product_id) DO UPDATE SET produto = coalesce(recorrencia_clientes.produto, EXCLUDED.produto)
    RETURNING id INTO v_cli;
    INSERT INTO public.recorrencia_cobrancas (paykey, cliente_id, tipo, valor, cobrado_em)
    VALUES (p_paykey, v_cli, 'renovacao', p_valor, p_quando) ON CONFLICT (paykey) DO NOTHING;
    UPDATE public.recorrencia_clientes SET situacao = 'ativa', cancelada_em = NULL WHERE id = v_cli;
    PERFORM public.recorrencia_recalcular(v_cli);

  ELSIF p_evento IN ('RFND', 'CGBK', 'CANCEL-REBILL') THEN
    UPDATE public.recorrencia_clientes
       SET situacao = 'cancelada', cancelada_em = coalesce(cancelada_em, p_quando), atualizado_em = now()
     WHERE email = p_email AND product_id = p_product_id;

  ELSIF p_evento = 'UNCANCEL-REBILL' THEN
    UPDATE public.recorrencia_clientes
       SET situacao = 'ativa', cancelada_em = NULL, atualizado_em = now()
     WHERE email = p_email AND product_id = p_product_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_eventos_plataforma_recorrencia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plataforma = 'JVZoo' THEN
    BEGIN
      PERFORM public.recorrencia_aplicar_evento(
        NEW.plataforma, NEW.evento, NEW.email, NEW.produto, NEW.payload->>'product_id', NEW.valor,
        coalesce(NEW.payload->>'paykey', NEW.payload->>'transaction_id', 'ev:' || NEW.id), NEW.recebido_em);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recorrencia: falha ao aplicar evento % (%): %', NEW.id, NEW.evento, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_eventos_plataforma_recorrencia ON public.eventos_plataforma;
CREATE TRIGGER trg_eventos_plataforma_recorrencia
  AFTER INSERT ON public.eventos_plataforma
  FOR EACH ROW EXECUTE FUNCTION public.trg_eventos_plataforma_recorrencia();

-- Carga do que já está em eventos_plataforma (desde 21/09), na ordem em que chegou.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN
    SELECT * FROM public.eventos_plataforma
    WHERE plataforma = 'JVZoo' AND evento IN ('SALE', 'BILL', 'RFND', 'CGBK', 'CANCEL-REBILL', 'UNCANCEL-REBILL')
    ORDER BY id
  LOOP
    PERFORM public.recorrencia_aplicar_evento(
      e.plataforma, e.evento, e.email, e.produto, e.payload->>'product_id', e.valor,
      coalesce(e.payload->>'paykey', e.payload->>'transaction_id', 'ev:' || e.id), e.recebido_em);
  END LOOP;
END $$;

-- ── Kanban: a coluna nova em todo board + o roteamento ──────────────────────────────────────────────────────

-- ordem 1 empata com "pendente" (que tem id menor em cada board), então aparece logo depois dela.
INSERT INTO email_ia.suporte_escalado_colunas (board_id, chave, rotulo, descricao, ordem)
SELECT b.id, 'pendente_recorrencia', 'Pendente - Recorrência',
       'Cliente com recorrência (US$ 39 de entrada + renovação) — ainda ninguém olhou.', 1
FROM email_ia.suporte_escalado_boards b
WHERE NOT EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                  WHERE c.board_id = b.id AND c.chave = 'pendente_recorrencia');

-- Cliente com recorrência ATIVA (não cancelou, não pediu reembolso, não deu chargeback). A decisão vem sempre
-- do dado da compra — nunca do que o cliente escreve no e-mail.
CREATE OR REPLACE FUNCTION email_ia.recorrencia_ativa(p_email text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.recorrencia_clientes
                 WHERE email = lower(btrim(p_email)) AND situacao = 'ativa')
$$;

-- Caso que ENTRA como "pendente" (escalado novo, reaberto depois de finalizado, ou transferido de board) e cujo
-- cliente tem recorrência ativa vai para "pendente_recorrencia" — se o board tiver a coluna. Roda DEPOIS do
-- roteador de board (trg_suporte_escalado_rotear): triggers BEFORE disparam em ordem alfabética do nome, e
-- "x_recorrencia" vem depois de "rotear". Arrastar o card na mão pra Pendente NÃO é convertido de volta (só a
-- reabertura de finalizado e a troca de board são).
-- Card movido na mão PARA a coluna sem o cliente estar em recorrencia_clientes: entra como origem 'manual'
-- (conta nas contas do relatório, sem data de cobrança).
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_recorrencia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pendente' AND NEW.board_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status = 'finalizado' OR NEW.board_id IS DISTINCT FROM OLD.board_id)
     AND email_ia.recorrencia_ativa(NEW.remetente_email)
     AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                 WHERE c.board_id = NEW.board_id AND c.chave = 'pendente_recorrencia') THEN
    NEW.status := 'pendente_recorrencia';
  END IF;

  IF NEW.status = 'pendente_recorrencia'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'pendente_recorrencia')
     AND NOT EXISTS (SELECT 1 FROM public.recorrencia_clientes WHERE email = lower(btrim(NEW.remetente_email))) THEN
    INSERT INTO public.recorrencia_clientes (email, product_id, origem)
    VALUES (lower(btrim(NEW.remetente_email)), 'manual', 'manual')
    ON CONFLICT (email, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_suporte_escalado_x_recorrencia ON email_ia.suporte_escalado;
CREATE TRIGGER trg_suporte_escalado_x_recorrencia
  BEFORE INSERT OR UPDATE OF status, board_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_recorrencia();

-- O sorteio ponderado de board mede a velocidade de quem tira o caso de "pendente"; agora o caso também pode
-- sair de "pendente_recorrencia" — sem isso, o atendimento desses casos sumiria da conta. Corpo idêntico ao da
-- versão em produção, só com status_anterior IN (...) nas duas CTEs.
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_rotear() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  escolhido BIGINT;
BEGIN
  IF NEW.board_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  WITH elegiveis AS (
    SELECT b.id AS board_id
    FROM email_ia.suporte_escalado_boards b
    JOIN public.painel_usuarios u ON u.id = b.usuario_id
    WHERE b.ativo AND u.ativo
  ),
  velocidade AS (
    SELECT t.board_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY t.horas) AS mediana_h
    FROM (
      SELECT h.board_id,
             extract(epoch FROM (h.mudou_em -
               lag(h.mudou_em) OVER (PARTITION BY h.suporte_escalado_id ORDER BY h.mudou_em))
             ) / 3600.0 AS horas
      FROM email_ia.suporte_escalado_historico h
      WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em > now() - interval '14 days'
    ) t
    WHERE t.horas IS NOT NULL
    GROUP BY t.board_id
  ),
  volume_hoje AS (
    SELECT h.board_id, count(*) AS total
    FROM email_ia.suporte_escalado_historico h
    WHERE h.status_anterior IN ('pendente', 'pendente_recorrencia') AND h.mudou_em::date = now()::date
    GROUP BY h.board_id
  ),
  base AS (
    SELECT el.board_id,
           coalesce(v.mediana_h,
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mediana_h) FROM velocidade),
             24) AS mediana_h,
           coalesce(vh.total, 0) AS volume_hoje
    FROM elegiveis el
    LEFT JOIN velocidade v ON v.board_id = el.board_id
    LEFT JOIN volume_hoje vh ON vh.board_id = el.board_id
  ),
  pontuado AS (
    SELECT board_id, (1.0 / GREATEST(mediana_h, 0.1)) * (1.0 / (1 + volume_hoje)) AS peso
    FROM base
  ),
  sorteio AS (
    SELECT board_id, sum(peso) OVER (ORDER BY board_id) AS acumulado, sum(peso) OVER () AS total
    FROM pontuado
  )
  SELECT board_id INTO escolhido FROM sorteio
  WHERE acumulado >= random() * total ORDER BY acumulado LIMIT 1;

  IF escolhido IS NULL THEN
    RAISE WARNING 'suporte_escalado: sem board elegível para % — ficará sem board_id.', NEW.remetente_email;
  ELSE
    NEW.board_id := escolhido;
  END IF;
  RETURN NEW;
END;
$$;
