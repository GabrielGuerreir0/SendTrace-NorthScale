-- ═══════════════════════════════════════════════════════════════════════════
--  043 · Risco guardado no ticket
--
--  Motivo (21/09/2026): a Visão Geral v2 (seção 06, pré-requisito P9) pede que o ticket carregue o
--  risco. Até aqui a Home calculava tudo na hora, a cada abertura, por palavras-chave nos e-mails.
--  Agora o cálculo mora no banco (`email_ia.recalcular_risco`) e o resultado fica no ticket:
--    risco_nivel    'critico' | 'alto' | 'medio' | 'baixo'  (NULL = fora do radar)
--    risco_score    0–100 (pesos da seção 06)
--    risco_sinais   rótulos legíveis dos sinais que somaram
--    risco_flags    os sinais crus (disputa, reacao, fraude, pede_reembolso, muito_negativo,
--                   negativo, reincidente, pedido_parado, sem_resposta_24h) — a Home e a IA leem daqui
--    risco_no_radar entrou na lista de acompanhamento (algum sinal, exceto "sem resposta 24 h")
--    risco_primeiro_critico_em / risco_primeira_reacao_em  base dos indicadores G1 (2 h) e G6 (24 h)
--
--  Quando recalcula:
--    · a cada e-mail novo do cliente (trigger em email_ia.emails; nunca bloqueia a entrada do e-mail);
--    · a cada poucos minutos pelo painel (`SELECT email_ia.recalcular_risco()`), porque "pedido parado"
--      e "sem resposta há 24 h" dependem do relógio e a janela de 30 dias anda.
--
--  As palavras-chave e os pesos são os mesmos de api/rotas/visaoGeral.js (RE_DISPUTA, RE_REACAO,
--  RE_FRAUDE, classificarRisco). Mexeu lá, mexa aqui.
--
--  Idempotente (IF NOT EXISTS / OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.tickets
  ADD COLUMN IF NOT EXISTS risco_nivel               text,
  ADD COLUMN IF NOT EXISTS risco_score               integer,
  ADD COLUMN IF NOT EXISTS risco_sinais              text[],
  ADD COLUMN IF NOT EXISTS risco_flags               jsonb,
  ADD COLUMN IF NOT EXISTS risco_no_radar            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS risco_primeiro_critico_em timestamptz,
  ADD COLUMN IF NOT EXISTS risco_primeira_reacao_em  timestamptz,
  ADD COLUMN IF NOT EXISTS risco_calculado_em        timestamptz;

DO $$ BEGIN
  ALTER TABLE email_ia.tickets
    ADD CONSTRAINT tickets_risco_nivel_chk
    CHECK (risco_nivel IS NULL OR risco_nivel IN ('critico', 'alto', 'medio', 'baixo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_risco ON email_ia.tickets (risco_nivel, risco_score DESC) WHERE risco_no_radar;

-- p_email NULL = todos os tickets; senão só o daquele cliente (usado pelo trigger).
CREATE OR REPLACE FUNCTION email_ia.recalcular_risco(p_email text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  re_disputa text := '(charge ?back|disput(e|ed|ing)\M|(call|contact|notify|report|tell|inform|dispute)(ed|ing)? (my |the )?(bank|credit card|card company|card issuer)|\mbbb\M|better business bureau|attorney general|lawyer|attorney|legal action|lawsuit|\msu(e|ing) you|small claims|advogado)';
  re_reacao  text := '(allergic reaction|\mrash\M|\mhives\M|nauseous|nausea|vomit|dizzy|dizziness|chest pain|palpitations|shortness of breath|swelling|swollen|hospital|emergency room|diarrhea|migraine|panic attack)';
  re_fraude  text := '(fraud|scammed|scamming|rip(ped)? me off)';
  re_critico text := '(' || substr(re_disputa, 2, length(re_disputa) - 2) || '|' || substr(re_reacao, 2, length(re_reacao) - 2)
                         || '|' || substr(re_fraude, 2, length(re_fraude) - 2) || ')';
  alvo text := lower(p_email);
  n integer;
BEGIN
  WITH base AS (
    SELECT lower(remetente_email) AS em,
           bool_or(t ~ re_disputa)  AS disputa,
           bool_or(t ~ re_reacao)   AS reacao,
           bool_or(t ~ re_fraude)   AS fraude,
           bool_or(categoria IN ('devolucao', 'cancelamento')) AS pede_reembolso,
           bool_or(sentimento = 'muito_negativo') AS muito_negativo,
           bool_or(sentimento = 'negativo')       AS negativo,
           min(data_email) FILTER (WHERE t ~ re_critico) AS primeiro_critico,
           min(data_email) FILTER (WHERE t ~ re_reacao)  AS primeira_reacao
    FROM (SELECT remetente_email, categoria, sentimento, data_email,
                 lower(coalesce(assunto, '') || ' ' || left(coalesce(corpo_texto, ''), 4000)) AS t
          FROM email_ia.emails
          WHERE plataforma_origem IS NULL AND data_email >= now() - interval '30 days'
            AND (alvo IS NULL OR lower(remetente_email) = alvo)) x
    GROUP BY 1
  ),
  reincid AS (
    SELECT lower(remetente_email) AS em FROM email_ia.emails
    WHERE categoria IN ('devolucao', 'troca') AND (alvo IS NULL OR lower(remetente_email) = alvo)
    GROUP BY 1 HAVING count(*) >= 2
  ),
  pedido AS (
    SELECT DISTINCT ON (lower(d.email)) lower(d.email) AS em,
           (r.status_interno = 'pending' AND d.criado_em <= now() - interval '5 days') OR
           (r.status_interno = 'shipped' AND r.shipped_at IS NOT NULL AND r.shipped_at <= now() - interval '15 days') AS parado
    FROM disparos_pos_venda d JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
    WHERE d.email IS NOT NULL AND (alvo IS NULL OR lower(d.email) = alvo)
    ORDER BY lower(d.email), d.criado_em DESC
  ),
  sinais AS (
    SELECT t.id, (b.em IS NOT NULL) AS tem_base,
           coalesce(b.disputa, false) AS disputa, coalesce(b.reacao, false) AS reacao, coalesce(b.fraude, false) AS fraude,
           coalesce(b.pede_reembolso, false) AS pede_reembolso,
           coalesce(b.muito_negativo, false) AS muito_negativo, coalesce(b.negativo, false) AS negativo,
           (i.em IS NOT NULL) AS reincidente, coalesce(p.parado, false) AS pedido_parado,
           coalesce(t.status <> 'resolvido' AND t.ultimo_email_em IS NOT NULL
                    AND t.ultimo_email_em < now() - interval '24 hours'
                    AND (t.ultima_resposta_ia_em IS NULL OR t.ultima_resposta_ia_em < t.ultimo_email_em), false) AS sem_resposta_24h,
           b.primeiro_critico, b.primeira_reacao
    FROM email_ia.tickets t
    LEFT JOIN base b    ON b.em = lower(t.remetente_email)
    LEFT JOIN reincid i ON i.em = lower(t.remetente_email)
    LEFT JOIN pedido p  ON p.em = lower(t.remetente_email)
    WHERE alvo IS NULL OR lower(t.remetente_email) = alvo
  ),
  pontos AS (
    SELECT s.*,
           (s.tem_base AND (s.disputa OR s.reacao OR s.fraude OR s.pede_reembolso OR s.muito_negativo OR s.negativo
                            OR s.reincidente OR s.pedido_parado)) AS no_radar,
           least(100,
                 (CASE WHEN s.disputa THEN 35 ELSE 0 END) + (CASE WHEN s.reacao THEN 30 ELSE 0 END)
               + (CASE WHEN s.pede_reembolso THEN 20 ELSE 0 END)
               + (CASE WHEN s.muito_negativo THEN 15 WHEN s.negativo THEN 8 ELSE 0 END)
               + (CASE WHEN s.reincidente THEN 10 ELSE 0 END) + (CASE WHEN s.pedido_parado THEN 10 ELSE 0 END)
               + (CASE WHEN s.sem_resposta_24h THEN 5 ELSE 0 END)) AS score
    FROM sinais s
  )
  UPDATE email_ia.tickets t SET
    risco_no_radar = q.no_radar,
    risco_score = CASE WHEN q.no_radar THEN q.score END,
    risco_nivel = CASE WHEN NOT q.no_radar THEN NULL
                       WHEN q.disputa OR q.reacao OR q.fraude OR q.score >= 70 THEN 'critico'
                       WHEN q.score >= 40 THEN 'alto'
                       WHEN q.score >= 20 THEN 'medio'
                       ELSE 'baixo' END,
    risco_sinais = CASE WHEN q.no_radar THEN array_remove(ARRAY[
        CASE WHEN q.disputa THEN 'Menção a disputa, banco, BBB ou advogado' END,
        CASE WHEN q.fraude THEN 'Suspeita de fraude' END,
        CASE WHEN q.reacao THEN 'Relato de reação física' END,
        CASE WHEN q.pede_reembolso THEN 'Pede reembolso' END,
        CASE WHEN q.muito_negativo THEN 'Sentimento muito negativo' WHEN q.negativo THEN 'Sentimento negativo' END,
        CASE WHEN q.reincidente THEN 'Reincidente (2+ devoluções)' END,
        CASE WHEN q.pedido_parado THEN 'Pedido parado' END,
        CASE WHEN q.sem_resposta_24h THEN 'Sem resposta há mais de 24 h' END], NULL) END,
    risco_flags = CASE WHEN q.no_radar THEN jsonb_build_object(
        'disputa', q.disputa, 'reacao', q.reacao, 'fraude', q.fraude, 'pede_reembolso', q.pede_reembolso,
        'muito_negativo', q.muito_negativo, 'negativo', q.negativo, 'reincidente', q.reincidente,
        'pedido_parado', q.pedido_parado, 'sem_resposta_24h', q.sem_resposta_24h) END,
    risco_primeiro_critico_em = q.primeiro_critico,
    risco_primeira_reacao_em  = q.primeira_reacao,
    risco_calculado_em = now()
  FROM pontos q
  WHERE q.id = t.id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- E-mail novo → recalcula só aquele cliente. Roda DEPOIS de `email_ticket` (que cria/atualiza o ticket;
-- triggers do mesmo momento disparam em ordem alfabética). Qualquer falha aqui é engolida: um risco
-- desatualizado é aceitável, e-mail perdido não.
CREATE OR REPLACE FUNCTION email_ia.trg_email_risco() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plataforma_origem IS NULL AND coalesce(NEW.remetente_email, '') <> '' THEN
    BEGIN
      PERFORM email_ia.recalcular_risco(NEW.remetente_email);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recalcular_risco falhou para %: %', NEW.remetente_email, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS email_zrisco ON email_ia.emails;
CREATE TRIGGER email_zrisco AFTER INSERT ON email_ia.emails
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_email_risco();

COMMENT ON COLUMN email_ia.tickets.risco_nivel IS
  'critico | alto | medio | baixo; NULL = fora do radar. Calculado por email_ia.recalcular_risco (mesmos pesos da seção 06).';
COMMENT ON COLUMN email_ia.tickets.risco_flags IS
  'Sinais crus do risco: disputa, reacao, fraude, pede_reembolso, muito_negativo, negativo, reincidente, pedido_parado, sem_resposta_24h.';

-- Preenche o histórico (roda uma vez; o painel refaz de tempos em tempos).
SELECT email_ia.recalcular_risco();
