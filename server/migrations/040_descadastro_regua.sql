-- ═══════════════════════════════════════════════════════════════════════════
--  040 · Descadastro dos e-mails de pós-venda (rodapé + List-Unsubscribe)
--
--  Motivo (19/09/2026): reclamações de spam no Postmark (0,138%, limite ~0,1%) vindas de AOL/Yahoo. Os e-mails
--  da régua não tinham nenhum jeito de o cliente pedir pra parar, então ele aperta "spam". Agora cada e-mail leva
--  um link "Unsubscribe" no rodapé e (quando o envio passar pela API do Postmark) o cabeçalho List-Unsubscribe.
--
--  Descadastrar = parar de receber os e-mails da RÉGUA. NÃO cancela pedido nem garantia (a página avisa isso).
--
--  Peças:
--   • email_descadastros           — quem pediu pra sair (e-mail em minúsculo, 1 linha por pessoa)
--   • descadastro_token(email)     — assinatura do link (sha256 do e-mail + segredo do banco); sem extensão
--   • descadastro_url(email)       — o link completo, pra o fluxo n8n só colar no e-mail
--   • descadastrar(email, origem)  — grava e cancela o que a pessoa ainda tinha na fila
--
--  Idempotente. O segredo é gerado uma vez (config_disparos.descadastro_segredo) e nunca sobrescrito.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.email_descadastros (
  email      text PRIMARY KEY,                       -- minúsculo
  criado_em  timestamptz NOT NULL DEFAULT now(),
  origem     text NOT NULL DEFAULT 'link',           -- 'link' (página), 'one-click' (botão do Gmail/Yahoo/AOL)
  ip         text
);

COMMENT ON TABLE public.email_descadastros IS
  'Quem pediu pra parar de receber os e-mails da régua de pós-venda. O Processador de Disparos não reivindica esses e-mails.';

INSERT INTO public.config_disparos (chave, valor)
VALUES ('descadastro_segredo', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (chave) DO NOTHING;

-- o mesmo domínio que já vai no pixel de abertura dos e-mails
INSERT INTO public.config_disparos (chave, valor)
VALUES ('descadastro_base_url', 'https://sendtrace.thenorthscales.com')
ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION public.descadastro_token(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $f$
  SELECT substr(encode(sha256(convert_to(
           lower(btrim(p_email)) || '|' || (SELECT valor FROM public.config_disparos WHERE chave = 'descadastro_segredo'),
           'UTF8')), 'hex'), 1, 32);
$f$;

CREATE OR REPLACE FUNCTION public.descadastro_url(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $f$
  SELECT rtrim((SELECT valor FROM public.config_disparos WHERE chave = 'descadastro_base_url'), '/')
         || '/descadastrar?e='
         || replace(replace(replace(replace(replace(replace(lower(btrim(p_email)), '%', '%25'), '+', '%2B'), '&', '%26'), '#', '%23'), '?', '%3F'), '@', '%40')
         || '&t=' || public.descadastro_token(p_email);
$f$;

CREATE OR REPLACE FUNCTION public.descadastrar(p_email text, p_origem text DEFAULT 'link', p_ip text DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
AS $f$
DECLARE cancelados integer;
BEGIN
  INSERT INTO public.email_descadastros (email, origem, ip)
  VALUES (lower(btrim(p_email)), p_origem, p_ip)
  ON CONFLICT (email) DO NOTHING;
  UPDATE public.disparos_pos_venda SET status = 'cancelado'
   WHERE lower(email) = lower(btrim(p_email)) AND status = 'ativo';
  GET DIAGNOSTICS cancelados = ROW_COUNT;
  RETURN cancelados;
END;
$f$;

-- trava: as funções precisam devolver algo antes de o deploy seguir
DO $$
BEGIN
  IF public.descadastro_token('teste@example.com') IS NULL OR length(public.descadastro_token('teste@example.com')) <> 32 THEN
    RAISE EXCEPTION 'descadastro_token não funcionou — nada foi aplicado.';
  END IF;
  IF public.descadastro_url('a+b@example.com') NOT LIKE '%/descadastrar?e=a%2Bb%40example.com&t=%' THEN
    RAISE EXCEPTION 'descadastro_url não funcionou — nada foi aplicado.';
  END IF;
END $$;
