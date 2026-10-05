-- ═══════════════════════════════════════════════════════════════════════════
--  068 · Tag de motivo mais esperta (ajuste da 065, pedido do Lucas em 05/10/2026)
--
--  A regra literal do PDF (só as palavras refund/cancel/return, chargeback/dispute/bank, tracking) deixava 15% dos casos em "Outros motivos"
--  mesmo quando o cliente escrevia de forma vaga ("where is my order?", "I haven't received my package", "I want my money back").
--  O que muda:
--    1) Mais palavras e frases por tag (inclui espanhol/português e erros comuns, ex.: "cancelation"). Ordem igual: chargeback > reembolso > rastreio > outros.
--    2) A parte CITADA do e-mail (histórico de resposta, "On ... wrote:", "Original Message", linhas com ">") não conta: ali estão os nossos próprios
--       textos (régua, boas-vindas), que traziam "bank", "tracking", "refund" e marcavam o cliente sem ele ter escrito isso. O assunto "Re:/Fwd:" também não conta.
--    3) Se as palavras não decidem, a categoria que a IA já deu ao e-mail desempata: cancelamento/devolução/troca/garantia → reembolso; dúvida de pedido → rastreio.
--  Os casos que já existem são reclassificados UMA vez aqui (o gatilho de imutabilidade fica desligado só durante esse UPDATE, dentro de um bloco atômico).
--  Backup da tag antiga: email_ia.suporte_escalado_tag_bkp_068 (para voltar: UPDATE com o gatilho desligado). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

SET LOCAL statement_timeout = '300s';

-- Funções da tag de motivo (reutilizadas pela migração 068 e pelos testes). Padrões entre $re$...$re$: aspas e apóstrofos sem escape.

CREATE OR REPLACE FUNCTION email_ia.re_tag_chargeback() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT $re$\m(charge.?backs?|contra.?cargos?|disputes?|disputed|disputing|disputas?|bank|banks|banking|banco|credit card compan(y|ies)|card (company|issuer)|fraud(ulent)?|fraude|scam(med|mers?)?|estafa|unauthori[sz]ed|lawyers?|attorneys?|abogado|advogado|legal action|better business bureau|bbb|ftc|attorney general|police)\M$re$
$f$;

CREATE OR REPLACE FUNCTION email_ia.re_tag_reembolso() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT $re$\m(cancell?(ed|ing|ation|ations|s)?|cancelar|cancelado|cancelaci[oó]n|refund(s|ed|ing)?|reembols\w*|reimburs\w*|returns?|returned|returning|devoluci[oó]n|devolu[cç][aã]o|devolver|money back|my money|dinheiro de volta|dinero|repay(ment)?|charged?|charges|billed|billing|double.?charge[d]?|overcharge[d]?|wrong charge|incorrect charge|credit card|my card|stop (the |my )?(charges?|billing|subscription|payments?)|unsubscribe|rip.?off|waste of money|not satisfied|dissatisfied|not happy|unhappy|(did|does|do)(n.?t| not) work(ed)?|not work(ing|ed)?|no results?)\M$re$
$f$;

CREATE OR REPLACE FUNCTION email_ia.re_tag_rastreio() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT $re$\m(tracking|rastreo|rastreio|track(ing)? (number|code|id|info|link)|where(.?s| is| are) (my|the)|d[oó]nde est[aá]|onde est[aá]|(has|have)n.?t (received|got|gotten|recieved|arrived|come|shipped)|(has|have) not (received|got|gotten|arrived|shipped|come)|not (yet )?(received|arrived|delivered|shipped)|never (received|arrived|got|came|showed)|(did|do|does)(n.?t| not) (receive|get|arrive|come)|still (waiting|no|nothing)|no (update|updates|tracking|shipping|delivery|confirmation)|order status|status of (my|the|an) order|when (will|should|can|do|does|is)[^.?!\n]{0,40}(ship|deliver|arriv|receive|get (it|my|the)|come|here)|how long[^.?!\n]{0,60}(ship|deliver|arriv|order|package|get here|take to)|shipping|shipped|shipment|delivery|deliver(ed)?|arriv(e|ed|al)|package|parcel|address|usps|ups|fedex|dhl|ontrac|courier|carrier|lost in transit|missing (package|order|item|bottle)s?|pedido)\M$re$
$f$;

-- Tira a parte citada (histórico de resposta) do corpo: o que vem depois de "On ... wrote:", "-----Original Message-----", "From: / Sent:" e as linhas com ">".
-- Se não sobrar nada (o corpo todo é encaminhamento ou citação), usa o corpo inteiro.
CREATE OR REPLACE FUNCTION email_ia.texto_sem_citacao(p_corpo text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN btrim(c) = '' THEN coalesce(p_corpo, '') ELSE c END
  FROM (SELECT regexp_replace(
                 (regexp_split_to_array(coalesce(p_corpo, ''),
                    $re$(\r?\n|^)[ \t]*(on .{5,200}wrote:|-{2,} ?original message ?-{2,}|-{2,} ?forwarded message ?-{2,}|_{8,}|from:[^\n]*\n[ \t]*(sent|date):|de:[^\n]*\n[ \t]*enviado)$re$,
                    'i'))[1],
                 $re$(^|\n)[ \t]*>[^\n]*$re$, '', 'g') AS c) x
$f$;

-- Tag: chargeback > reembolso > rastreio > outros. O assunto só entra quando não é "Re:/Fwd:" (esse assunto é nosso, não do cliente).
-- Quando as palavras não decidem, a categoria que a IA já deu ao e-mail desempata (cancelamento/devolução/troca/garantia → reembolso; dúvida de pedido → rastreio).
CREATE OR REPLACE FUNCTION email_ia.calcular_tag_motivo(p_assunto text, p_corpo text, p_categoria text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE texto text;
BEGIN
  texto := email_ia.texto_sem_citacao(p_corpo)
        || CASE WHEN coalesce(p_assunto, '') ~* '^\s*((re|fwd?|enc|res)\s*:\s*)+' THEN '' ELSE ' ' || coalesce(p_assunto, '') END;
  IF texto ~* email_ia.re_tag_chargeback() THEN RETURN 'chargeback'; END IF;
  IF texto ~* email_ia.re_tag_reembolso() THEN RETURN 'reembolso'; END IF;
  IF texto ~* email_ia.re_tag_rastreio() THEN RETURN 'rastreio'; END IF;
  IF p_categoria IN ('cancelamento', 'devolucao', 'troca', 'garantia') THEN RETURN 'reembolso'; END IF;
  IF p_categoria = 'duvida_pedido' THEN RETURN 'rastreio'; END IF;
  RETURN 'outros';
END $f$;

-- A versão de 1 argumento (065) continua existindo e agora usa as mesmas regras.
CREATE OR REPLACE FUNCTION email_ia.calcular_tag_motivo(p_texto text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$ SELECT email_ia.calcular_tag_motivo(NULL, p_texto, NULL) $f$;

-- Caso novo: tag pelo assunto, corpo e categoria do e-mail que gerou o caso (sem e-mail, pelo resumo).
CREATE OR REPLACE FUNCTION email_ia.trg_suporte_escalado_tag_motivo() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v_assunto text; v_corpo text; v_cat text; v_achou boolean;
BEGIN
  IF NEW.tag_motivo IS NULL THEN
    SELECT e.assunto, e.corpo_texto, e.categoria, true INTO v_assunto, v_corpo, v_cat, v_achou FROM email_ia.emails e WHERE e.id = NEW.email_id;
    IF v_achou IS NOT TRUE THEN v_assunto := NULL; v_corpo := NEW.resumo_conversa; v_cat := NULL; END IF;
    NEW.tag_motivo := email_ia.calcular_tag_motivo(v_assunto, v_corpo, v_cat);
  END IF;
  RETURN NEW;
END $f$;

-- Backup da tag antiga (só na primeira execução).
CREATE TABLE IF NOT EXISTS email_ia.suporte_escalado_tag_bkp_068 AS
  SELECT id, tag_motivo AS tag_antes, now() AS salvo_em FROM email_ia.suporte_escalado;

-- Reclassifica os casos existentes com as regras novas (gatilho de imutabilidade desligado só aqui).
DO $f$
BEGIN
  ALTER TABLE email_ia.suporte_escalado DISABLE TRIGGER trg_suporte_escalado_tag_imutavel;
  WITH novo AS (
    SELECT s.id, email_ia.calcular_tag_motivo(e.assunto, coalesce(e.corpo_texto, s.resumo_conversa), e.categoria) AS tag
      FROM email_ia.suporte_escalado s LEFT JOIN email_ia.emails e ON e.id = s.email_id
  )
  UPDATE email_ia.suporte_escalado s SET tag_motivo = novo.tag
    FROM novo WHERE novo.id = s.id AND s.tag_motivo IS DISTINCT FROM novo.tag;
  ALTER TABLE email_ia.suporte_escalado ENABLE TRIGGER trg_suporte_escalado_tag_imutavel;
END $f$;
