-- ═══════════════════════════════════════════════════════════════════════════
--  038 · Respostas dos formulários do Drive (reembolso e devolução) + perfil do cliente
--
--  Os formulários "Refund Request Form" e "Return Confirmation Form" são enviados aos casos do quadro
--  "Formulário" do Suporte Escalado, mas as respostas ficavam só nas planilhas do Google. O fluxo n8n
--  "Forms — Sincronizar respostas (Drive)" importa as planilhas (CSV) aqui a cada 15 min e chama
--  `classificar_formularios()`, que atribui a cada resposta um PERFIL e um DESTINO sugerido:
--    'automatica' → a IA de e-mail pode responder sozinha (sem decidir dinheiro nunca)
--    'escalada'   → vai pra equipe humana (Suporte Escalado)
--  REGRA DE OURO: na dúvida, escalada. Menção a advogado/órgão/disputa/golpe, efeito adverso, cliente que
--  insiste (respondeu >1 vez) e o que não se encaixa em nenhum perfil vão sempre pra equipe.
--
--  Idempotente. Reclassificar tudo: UPDATE formularios_respostas SET perfil = NULL; SELECT classificar_formularios();
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.formularios_respostas (
  id                bigserial PRIMARY KEY,
  chave             text NOT NULL UNIQUE,                 -- md5(formulário|carimbo|e-mail|pedido): evita duplicar a linha
  formulario        text NOT NULL CHECK (formulario IN ('reembolso', 'envio')),
  respondido_em     timestamptz,
  email             text,                                  -- minúsculo; NULL se o cliente digitou algo que não é e-mail
  nome              text,
  pedido            text,
  produto           text,
  qtd_potes         text,
  motivo            text,                                  -- "What is the reason for your refund request?"
  recebeu_produto   boolean,
  usou_produto      boolean,
  produto_em_casa   text,                                  -- 'Yes, sealed' | 'Yes, opened' | 'I no longer have it'
  contatou_suporte  boolean,
  problema_entrega  boolean,
  esperava_resultado text,
  o_que_melhorar    text,
  rastreio          text,                                  -- só do formulário de devolução (envio)
  transportadora    text,
  lacrado           text,
  qtd_devolvida     text,
  dados             jsonb NOT NULL,                        -- a linha inteira da planilha, por cabeçalho
  perfil            text,
  destino           text CHECK (destino IN ('automatica', 'escalada')),
  motivo_destino    text,
  classificado_em   timestamptz,
  importado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_formularios_email ON public.formularios_respostas (lower(email));
CREATE INDEX IF NOT EXISTS idx_formularios_form_data ON public.formularios_respostas (formulario, respondido_em DESC);
CREATE INDEX IF NOT EXISTS idx_formularios_perfil ON public.formularios_respostas (perfil);

COMMENT ON TABLE public.formularios_respostas IS
  'Respostas dos Google Forms de reembolso e devolução, importadas das planilhas do Drive, com perfil e destino sugerido.';

CREATE OR REPLACE FUNCTION public.classificar_formularios()
 RETURNS integer
 LANGUAGE plpgsql
AS $f$
DECLARE n integer;
BEGIN
  WITH base AS (
    SELECT f.id, f.formulario, f.recebeu_produto, f.usou_produto, f.produto_em_casa, f.problema_entrega,
           f.motivo, f.lacrado, f.rastreio,
           -- só os VALORES das respostas em texto livre: nome, e-mail, endereço, pedido e rastreio ficam de fora
           -- (um nome como "Linda Sue" já disparou "sue" como se fosse ameaça de processo)
           (SELECT lower(string_agg(value, ' ')) FROM jsonb_each_text(f.dados)
             WHERE key !~* '^(full name|email|shipping address|address the product|order number|tracking|proof of shipment|carimbo)') AS texto,
           (SELECT count(*) FROM public.formularios_respostas x
             WHERE x.formulario = f.formulario AND x.email IS NOT NULL AND x.email = f.email) AS n_resp
    FROM public.formularios_respostas f WHERE f.perfil IS NULL
  ), s AS (
    SELECT b.*,
      (texto ~ '\y(lawyer|attorney|attorneys|lawsuit|sue|suing|bbb|ftc|police)\y'
        OR texto ~ 'legal action|attorney general|better business bureau') AS risco_legal,
      (texto ~ '\y(charge ?back|disputes?|disputed|disputing)\y' OR texto ~ 'credit card company|my bank') AS risco_disputa,
      (texto ~ '\y(scam|scammed|fraud|fraudulent|rip ?off|ripped off)\y') AS risco_golpe,
      (coalesce(motivo, '') ~* 'side effect'
        OR texto ~ '\y(allerg\w*|nausea\w*|nauseous|hospital|rash|vomit\w*|dizz\w*)\y') AS saude
    FROM base b
  ), c AS (
    SELECT s.id, s.formulario, s.lacrado, s.rastreio,
      (s.risco_legal OR s.risco_disputa OR s.risco_golpe) AS risco,
      CASE
        WHEN s.formulario = 'envio'                                              THEN 'devolucao_enviada'
        WHEN s.risco_legal OR s.risco_disputa OR s.risco_golpe                  THEN 'risco_reputacional'
        WHEN s.saude                                                            THEN 'efeito_adverso'
        WHEN s.n_resp > 1                                                       THEN 'reincidente'
        WHEN s.recebeu_produto IS FALSE                                         THEN 'nao_recebeu'
        WHEN s.problema_entrega IS TRUE OR coalesce(s.motivo, '') ~* 'different product' THEN 'entrega_ou_produto_errado'
        WHEN s.recebeu_produto IS TRUE AND s.usou_produto IS NOT TRUE
             AND coalesce(s.produto_em_casa, '') ILIKE 'yes, sealed'            THEN 'devolver_lacrado'
        WHEN s.usou_produto IS TRUE                                             THEN 'usou_sem_resultado'
        ELSE 'outro'
      END AS perfil
    FROM s
  )
  UPDATE public.formularios_respostas f
  SET perfil = c.perfil,
      destino = CASE
        WHEN c.perfil = 'devolucao_enviada'
          THEN CASE WHEN coalesce(c.lacrado, '') ILIKE 'yes' AND coalesce(c.rastreio, '') <> '' AND NOT c.risco THEN 'automatica' ELSE 'escalada' END
        WHEN c.perfil IN ('nao_recebeu', 'devolver_lacrado') THEN 'automatica'
        ELSE 'escalada'
      END,
      motivo_destino = CASE
        WHEN c.perfil = 'devolucao_enviada'
          THEN CASE WHEN coalesce(c.lacrado, '') ILIKE 'yes' AND coalesce(c.rastreio, '') <> '' AND NOT c.risco
                    THEN 'Devolução confirmada, tudo lacrado e com rastreio: a IA confirma o recebimento do formulário e o próximo passo.'
                    ELSE 'Devolução com produto aberto/parcial, sem rastreio ou com sinal de risco: a equipe confere.' END
        WHEN c.perfil = 'nao_recebeu'                THEN 'Diz que não recebeu: a IA responde com o rastreio do pedido; se constar entregue ou parado, escalar.'
        WHEN c.perfil = 'devolver_lacrado'           THEN 'Recebeu, não usou e o produto está lacrado: a IA envia as instruções de devolução.'
        WHEN c.perfil = 'risco_reputacional'         THEN 'Cita advogado, órgão, disputa no cartão ou golpe: só a equipe responde.'
        WHEN c.perfil = 'efeito_adverso'             THEN 'Relata efeito adverso ou reação: só a equipe responde.'
        WHEN c.perfil = 'reincidente'                THEN 'Respondeu o formulário mais de uma vez (está insistindo): a equipe assume.'
        WHEN c.perfil = 'entrega_ou_produto_errado'  THEN 'Problema na entrega ou produto diferente do pedido: a equipe resolve com o fulfillment.'
        WHEN c.perfil = 'usou_sem_resultado'         THEN 'Usou o produto: decisão de garantia é humana.'
        ELSE 'Não se encaixa em nenhum perfil: na dúvida, a equipe.'
      END,
      classificado_em = now()
  FROM c WHERE f.id = c.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$f$;
