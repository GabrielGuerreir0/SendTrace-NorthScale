-- ═══════════════════════════════════════════════════════════════════════════
--  051 · Recorrência: quem cancelou/reembolsou vai sozinho para "Reembolsado"; roteamento a cada e-mail novo
--
--  Continua a 050 (pedido da Vitória + decisão do Lucas, 25/09/2026):
--   • "não precisamos atender alguém que já teve o reembolso feito" — cliente de recorrência com reembolso ou
--     chargeback NUNCA fica em Pendente: caso novo/reaberto/transferido/com e-mail novo entra direto em
--     "Reembolsado", e o caso que já estava em Pendente / Pendente - Recorrência é movido quando o evento chega.
--   • A Vitória pediu que a verificação seja feita a CADA e-mail novo: o n8n, quando o cliente escreve de novo,
--     só troca o `email_id` do caso aberto (ON CONFLICT DO UPDATE) — agora essa troca também reavalia a coluna.
--   • Cancelou SÓ a recorrência (CANCEL-REBILL, sem reembolso) NÃO vai para Reembolsado: volta para a Pendente
--     normal, como a Vitória descreveu (a pessoa ainda pode ter reclamação).
--   Quem só está em Formulário / Iniciado / Esperando resposta não é tocado (já tem gente ou formulário no meio).
--
--  Limite assumido: a regra é por e-mail do cliente, não por pedido (mesmo limite da varredura de 20/09).
--  Idempotente (IF NOT EXISTS / OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.recorrencia_clientes ADD COLUMN IF NOT EXISTS cancelada_motivo text;
ALTER TABLE public.recorrencia_clientes DROP CONSTRAINT IF EXISTS recorrencia_clientes_cancelada_motivo_check;
ALTER TABLE public.recorrencia_clientes ADD CONSTRAINT recorrencia_clientes_cancelada_motivo_check
  CHECK (cancelada_motivo IN ('reembolso', 'chargeback', 'cancelamento'));

-- tudo que estava cancelado até aqui veio de reembolso/chargeback (o CANCEL-REBILL nunca chegou no banco)
UPDATE public.recorrencia_clientes SET cancelada_motivo = 'reembolso'
 WHERE situacao = 'cancelada' AND cancelada_motivo IS NULL;

-- Move os casos ABERTOS em Pendente / Pendente - Recorrência de um cliente para "Reembolsado" (se o board tiver
-- a coluna). Automático, não é toque humano: não mexe em primeiro_toque_humano_em.
CREATE OR REPLACE FUNCTION email_ia.recorrencia_mover_para_reembolsado(p_email text) RETURNS int
LANGUAGE sql AS $$
  WITH mov AS (
    UPDATE email_ia.suporte_escalado s
       SET status = 'reembolsado', iniciado_em = coalesce(s.iniciado_em, now()), atualizado_em = now()
     WHERE lower(s.remetente_email) = lower(btrim(p_email))
       AND s.status IN ('pendente', 'pendente_recorrencia')
       AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                   WHERE c.board_id = s.board_id AND c.chave = 'reembolsado')
    RETURNING 1)
  SELECT count(*)::int FROM mov
$$;

-- Estado do cliente para o roteamento: 'recorrencia' (tem recorrência ativa), 'reembolsado' (só tem cancelada por
-- reembolso/chargeback) ou NULL (não é de recorrência, ou cancelou só a recorrência → Pendente normal).
CREATE OR REPLACE FUNCTION email_ia.recorrencia_estado(p_email text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN bool_or(situacao = 'ativa') THEN 'recorrencia'
    WHEN bool_or(situacao = 'cancelada' AND cancelada_motivo IN ('reembolso', 'chargeback')) THEN 'reembolsado'
  END
  FROM public.recorrencia_clientes WHERE email = lower(btrim(p_email))
$$;

-- Aplica UM evento (mesma da 050, agora com o motivo do cancelamento e o movimento automático do caso aberto).
CREATE OR REPLACE FUNCTION public.recorrencia_aplicar_evento(
  p_plataforma text, p_evento text, p_email text, p_produto text, p_product_id text,
  p_valor numeric, p_paykey text, p_quando timestamptz
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_cli bigint;
  v_motivo text;
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
    UPDATE public.recorrencia_clientes SET situacao = 'ativa', cancelada_em = NULL, cancelada_motivo = NULL WHERE id = v_cli;
    PERFORM public.recorrencia_recalcular(v_cli);

  ELSIF p_evento IN ('RFND', 'CGBK', 'CANCEL-REBILL') THEN
    v_motivo := CASE p_evento WHEN 'RFND' THEN 'reembolso' WHEN 'CGBK' THEN 'chargeback' ELSE 'cancelamento' END;
    UPDATE public.recorrencia_clientes
       SET situacao = 'cancelada', cancelada_em = coalesce(cancelada_em, p_quando), atualizado_em = now(),
           -- reembolso/chargeback nunca é rebaixado por um cancelamento posterior
           cancelada_motivo = CASE WHEN cancelada_motivo IN ('reembolso', 'chargeback') THEN cancelada_motivo ELSE v_motivo END
     WHERE email = p_email AND product_id = p_product_id;
    IF v_motivo IN ('reembolso', 'chargeback') AND email_ia.recorrencia_estado(p_email) = 'reembolsado' THEN
      PERFORM email_ia.recorrencia_mover_para_reembolsado(p_email);
    END IF;

  ELSIF p_evento = 'UNCANCEL-REBILL' THEN
    UPDATE public.recorrencia_clientes
       SET situacao = 'ativa', cancelada_em = NULL, cancelada_motivo = NULL, atualizado_em = now()
     WHERE email = p_email AND product_id = p_product_id;
  END IF;
END;
$$;

-- Roteamento do caso quando ele ENTRA como pendente (novo, reaberto depois de finalizado, transferido de board) ou
-- quando chega e-mail novo do cliente (o n8n troca o email_id do caso aberto). Só mexe em casos que estão em
-- Pendente / Pendente - Recorrência; arrastar o card na mão NÃO é desfeito (não troca email_id).
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_recorrencia() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_alvo   text;
BEGIN
  IF NEW.status IN ('pendente', 'pendente_recorrencia') AND NEW.board_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status = 'finalizado'
          OR NEW.board_id IS DISTINCT FROM OLD.board_id
          OR NEW.email_id IS DISTINCT FROM OLD.email_id) THEN
    v_estado := email_ia.recorrencia_estado(NEW.remetente_email);
    v_alvo := CASE v_estado WHEN 'reembolsado' THEN 'reembolsado'
                            WHEN 'recorrencia' THEN 'pendente_recorrencia'
                            ELSE 'pendente' END;
    IF v_alvo <> NEW.status AND EXISTS (SELECT 1 FROM email_ia.suporte_escalado_colunas c
                                        WHERE c.board_id = NEW.board_id AND c.chave = v_alvo) THEN
      NEW.status := v_alvo;
      IF v_alvo = 'reembolsado' THEN NEW.iniciado_em := coalesce(NEW.iniciado_em, now()); END IF;
    END IF;
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
  BEFORE INSERT OR UPDATE OF status, board_id, email_id ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_suporte_escalado_recorrencia();

-- Casos que já estão abertos agora: cliente com reembolso/chargeback e caso em Pendente / Pendente - Recorrência.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT email FROM public.recorrencia_clientes
            WHERE situacao = 'cancelada' AND cancelada_motivo IN ('reembolso', 'chargeback') LOOP
    IF email_ia.recorrencia_estado(r.email) = 'reembolsado' THEN
      PERFORM email_ia.recorrencia_mover_para_reembolsado(r.email);
    END IF;
  END LOOP;
END $$;
