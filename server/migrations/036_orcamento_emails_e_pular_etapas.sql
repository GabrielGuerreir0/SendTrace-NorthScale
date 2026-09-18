-- ═══════════════════════════════════════════════════════════════════════════
--  036 · Teto de e-mails por ciclo do Postmark (125 mil) + régua que PULA etapas inativas
--        + Área VIP dentro do e-mail D0 (sem e-mail separado)
--
--  Pedido (18/09/2026): "preciso que não passe de 125 mil e-mails enviados por mês".
--  O plano do Postmark renova em 18/10/2026 (ciclo 18/09 → 18/10).
--
--  Como o teto é garantido (não só estimado):
--   1) `email_envios_log` registra cada e-mail da régua enviado (trigger em
--      `disparos_pos_venda`: quando o Processador avança a etapa depois de enviar).
--   2) `email_saldo_regua_hoje()` calcula quantos e-mails a régua ainda pode mandar HOJE:
--        orçamento do ciclo (limite × (1 − margem)) − já usado no ciclo
--        − reserva pras respostas da IA/boas-vindas (que não têm teto, é suporte)
--        ÷ dias que faltam pra renovar; menos o que a régua já mandou hoje.
--      O Processador só reivindica pedidos até esse saldo (LIMIT LEAST(15, saldo)).
--      Estourou o dia → a fila ESPERA até amanhã (atrasa, nunca passa do teto).
--   3) O que não é da régua entra na conta: respostas da IA (`email_ia.emails.
--      resposta_enviada_em`) e boas-vindas (`email_ia.tickets.boas_vindas_enviada_em`).
--
--  `proxima_etapa_ativa()` deixa o motor pular etapas desativadas (a régua fica com 3
--  e-mails por pedido: D0, D3, D5) sem encerrar a sequência no primeiro buraco.
--
--  A Área VIP passa a ir como parágrafo+link dentro do e-mail D0 dos 3 produtos com Área
--  VIP (cópia por produto), e o e-mail separado de +20min sai dos fluxos Reporting.
--
--  Em produção foi aplicada à mão em 18/09/2026 com o "emails this period" do Postmark (200) em
--  `orcamento_usado_inicial`; este arquivo (SQL puro, pra o `npm run setup` do deploy rodar sem
--  erro) usa 0 e NÃO sobrescreve o valor que já existe (ON CONFLICT DO NOTHING).
--  Na renovação do plano (18/10) atualizar `orcamento_ciclo_fim`, `orcamento_log_desde` e
--  `orcamento_usado_inicial` em config_disparos.
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. log de envios da régua ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_envios_log (
  id     bigserial PRIMARY KEY,
  quando timestamptz NOT NULL DEFAULT now(),
  origem text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_envios_log_quando ON email_envios_log (quando);

CREATE OR REPLACE FUNCTION public.trg_log_envio_regua()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- O Processador reivindica ('processando') e, depois de enviar, avança a etapa e volta
  -- pra 'ativo' ou 'concluido'. Isso é 1 e-mail enviado (conta a mais se a etapa não tinha
  -- e-mail e foi só pulada: erra pro lado seguro).
  IF OLD.status = 'processando' AND NEW.status IN ('ativo', 'concluido')
     AND NEW.etapa_atual > OLD.etapa_atual THEN
    INSERT INTO email_envios_log (origem) VALUES ('regua');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS disparos_log_envio ON disparos_pos_venda;
CREATE TRIGGER disparos_log_envio AFTER UPDATE ON disparos_pos_venda
  FOR EACH ROW EXECUTE FUNCTION trg_log_envio_regua();

-- ── 2. configuração do teto ─────────────────────────────────────────────────

INSERT INTO config_disparos (chave, valor) VALUES
  ('orcamento_limite_ciclo',   '125000'),
  ('orcamento_margem_pct',     '8'),
  ('orcamento_ciclo_fim',      '2026-10-18 00:00:00-03'),
  ('orcamento_usado_inicial',  '0'),
  ('orcamento_log_desde',      now()::text),
  ('orcamento_reserva_ia_dia', '450')
ON CONFLICT (chave) DO NOTHING;

-- ── 3. próxima etapa ATIVA da mesma linha ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.proxima_etapa_ativa(atual integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  SELECT min(e2.etapa)
  FROM etapas_regua e2
  WHERE e2.ativo
    AND e2.etapa > atual
    AND e2.linha IS NOT DISTINCT FROM (SELECT e1.linha FROM etapas_regua e1 WHERE e1.etapa = atual);
$function$;

-- ── 4. saldo de e-mails da régua pra hoje ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_saldo_regua_hoje()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  WITH cfg AS (
    SELECT (SELECT valor::numeric     FROM config_disparos WHERE chave = 'orcamento_limite_ciclo')   AS lim,
           (SELECT valor::numeric     FROM config_disparos WHERE chave = 'orcamento_margem_pct')     AS marg,
           (SELECT valor::timestamptz FROM config_disparos WHERE chave = 'orcamento_ciclo_fim')      AS fim,
           (SELECT valor::numeric     FROM config_disparos WHERE chave = 'orcamento_usado_inicial')  AS ini,
           (SELECT valor::timestamptz FROM config_disparos WHERE chave = 'orcamento_log_desde')      AS desde,
           (SELECT valor::numeric     FROM config_disparos WHERE chave = 'orcamento_reserva_ia_dia') AS reserva,
           (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS hoje0
  ), gasto AS (
    -- tudo que saiu no ciclo ATÉ o começo de hoje (régua + IA + boas-vindas)
    SELECT (SELECT count(*) FROM email_envios_log l, cfg WHERE l.quando >= cfg.desde AND l.quando < cfg.hoje0)
         + (SELECT count(*) FROM email_ia.emails e, cfg WHERE e.resposta_enviada_em >= cfg.desde AND e.resposta_enviada_em < cfg.hoje0)
         + (SELECT count(*) FROM email_ia.tickets t, cfg WHERE t.boas_vindas_enviada_em >= cfg.desde AND t.boas_vindas_enviada_em < cfg.hoje0) AS ate_ontem
  ), rest AS (
    SELECT GREATEST(1, ceil(extract(epoch FROM (cfg.fim - now())) / 86400.0)) AS dias FROM cfg
  ), tetos AS (
    SELECT (cfg.lim * (1 - cfg.marg / 100.0) - cfg.ini - g.ate_ontem - cfg.reserva * r.dias) / r.dias AS cap_regua_dia
    FROM cfg, gasto g, rest r
  )
  SELECT GREATEST(0, floor(t.cap_regua_dia)
                     - (SELECT count(*) FROM email_envios_log l, cfg WHERE l.quando >= cfg.hoje0))::integer
  FROM tetos t;
$function$;

-- ── 5. Área VIP dentro do e-mail D0 (cópia por produto) ─────────────────────
--
-- Copia a copy '*' do D0 da linha do produto e acrescenta 1 parágrafo com o link. A busca
-- de copy do Processador já prefere a copy do produto sobre a '*'.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT m.etapa, m.canal, m.linha, v.slug, m.assunto,
       m.corpo_html || E'\n<p>Your order also includes access to the <b>' || v.nome
         || ' VIP Area</b> — exclusive content to help you get the most out of it. <a href="' || v.url
         || '">Open my VIP Area</a>.</p>',
       m.botao, m.destino,
       m.texto || ' [+ link da Área VIP no corpo — substitui o e-mail separado da etapa 900]', true
FROM (VALUES ('neuromindpro',   'NeuroMind Pro', 'https://getneuromindpro.online/area-vip/', '4', 10),
             ('neurorecallpro', 'NeuroRecall',   'https://getneurorecall.com/area-vip/',     '4', 10),
             ('glycoeden',      'GlycoEden',     'https://getglycoeden.com/area-vip/',       '6', 30)) AS v(slug, nome, url, linha, etapa)
JOIN mensagens_regua m
  ON m.linha = v.linha AND m.etapa = v.etapa AND m.produto = '*' AND m.canal = 'email'
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── trava ────────────────────────────────────────────────────────────────────

DO $$
DECLARE n integer;
BEGIN
  SELECT email_saldo_regua_hoje() INTO n;
  IF n IS NULL THEN RAISE EXCEPTION 'email_saldo_regua_hoje() devolveu NULL — nada foi aplicado.'; END IF;
  SELECT count(*) INTO n FROM mensagens_regua
   WHERE produto IN ('neuromindpro','neurorecallpro','glycoeden') AND etapa IN (10, 30) AND canal = 'email';
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 cópias de D0 com Área VIP, achei % — nada foi aplicado.', n; END IF;
END $$;

SELECT email_saldo_regua_hoje() AS saldo_da_regua_hoje,
       (SELECT valor FROM config_disparos WHERE chave = 'orcamento_usado_inicial') AS usado_inicial,
       (SELECT valor FROM config_disparos WHERE chave = 'orcamento_log_desde')     AS log_desde;
