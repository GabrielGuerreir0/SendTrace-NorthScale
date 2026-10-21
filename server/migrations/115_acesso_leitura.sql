-- ═══════════════════════════════════════════════════════════════════════════
--  115 · Acesso de LEITURA ao SendTrace (chaves por pessoa, auditoria e papel do Postgres só de leitura) — pedido do Lucas, 20/10/2026
--
--  Objetivo: dar a uma pessoa (a Késsia, com o Claude dela) acesso de SÓ LEITURA a tudo o que há no SendTrace — as telas (rotas GET da API) e as tabelas
--  (esquema, leitura de tabela e SELECT livre) —, sem poder alterar nada e com registro de quem consultou o quê.
--
--  Peças:
--    1) `chaves_leitura`   — uma chave por pessoa (`str_ro_…`); só o hash SHA-256 fica no banco; revogável; opção de mascarar nome/e-mail nos resultados.
--    2) `leitura_auditoria` — cada consulta feita com uma chave (rota, SQL, status, tempo, linhas, IP).
--    3) papel `sendtrace_leitura` — NÃO é superusuário, só tem SELECT, `default_transaction_read_only`, limite de tempo (20 s) e de conexões (6).
--       Nasce SEM LOGIN e SEM senha (nada secreto neste arquivo): quem liga o login e grava `DATABASE_URL_LEITURA` no .env é o script
--       `Correções/leitura_api/ativar_leitura.sh`. Enquanto isso não for feito, as rotas de SQL/tabela/esquema respondem 503.
--    4) `leitura_regras()` e `atualizar_grants_leitura()` — o QUE o papel NÃO enxerga (credenciais) e a concessão tabela por tabela.
--       Tabela nova nasce NEGADA para o papel (padrão seguro): para liberá-la, rode `SELECT public.atualizar_grants_leitura();` — a função devolve
--       um aviso se liberar alguma coluna com nome de segredo.
--
--  O que o papel NUNCA lê (única exceção ao "sem restrição"): hash de senha e sessões do painel e do Django, tokens de API antigos e de reset, o `descadastro_segredo`
--  (assina os links de descadastro; use a view `config_disparos_leitura`), tokens de abertura de e-mail e o CONTEÚDO BINÁRIO dos anexos/materiais (os
--  metadados — nome, tipo, tamanho — são liberados; os arquivos continuam acessíveis pelas rotas GET `/api/anexo/:id`, `/api/imagem/:id`…).
--
--  Aditiva e idempotente. Desfazer: ver Correções/leitura_api/LEIA-ME.md (DROP dos objetos abaixo e DROP ROLE sendtrace_leitura).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) chaves por pessoa ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chaves_leitura (
  id             bigserial PRIMARY KEY,
  dono           text        NOT NULL,                       -- quem usa (ex.: 'Késsia Martins')
  descricao      text,
  prefixo        text        NOT NULL,                       -- primeiros caracteres do token, só para reconhecer a chave na lista
  hash           text        NOT NULL UNIQUE,                -- SHA-256 (hex) do token; o token em si nunca é guardado
  mascarar_pii   boolean     NOT NULL DEFAULT false,         -- true: nome/e-mail/telefone/endereço saem como hash nos resultados
  criada_em      timestamptz NOT NULL DEFAULT now(),
  criada_por     text,
  revogada_em    timestamptz,
  ultimo_uso_em  timestamptz,
  usos           bigint      NOT NULL DEFAULT 0
);

-- 2) auditoria --------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leitura_auditoria (
  id        bigserial PRIMARY KEY,
  quando    timestamptz NOT NULL DEFAULT now(),
  chave_id  bigint REFERENCES public.chaves_leitura(id),
  dono      text,
  metodo    text,
  rota      text,
  consulta  text,        -- querystring (cortada)
  sql       text,        -- SQL enviado em /api/leitura/sql (cortado)
  status    integer,
  ms        integer,
  linhas    integer,
  ip        text,
  erro      text
);
CREATE INDEX IF NOT EXISTS leitura_auditoria_quando_idx ON public.leitura_auditoria (quando DESC);
CREATE INDEX IF NOT EXISTS leitura_auditoria_chave_idx  ON public.leitura_auditoria (chave_id, quando DESC);

-- 3) o papel só de leitura ---------------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sendtrace_leitura') THEN
    CREATE ROLE sendtrace_leitura NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

ALTER ROLE sendtrace_leitura CONNECTION LIMIT 6;
ALTER ROLE sendtrace_leitura SET default_transaction_read_only = on;
ALTER ROLE sendtrace_leitura SET statement_timeout = '20s';
ALTER ROLE sendtrace_leitura SET lock_timeout = '3s';
ALTER ROLE sendtrace_leitura SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE sendtrace_leitura SET search_path = public, email_ia, pg_catalog;

-- sem tabelas temporárias para ninguém além do superusuário (que ignora isto): o papel não cria objeto nenhum
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO sendtrace_leitura', current_database()); END $$;

-- 4) o que o papel NÃO enxerga --------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leitura_regras() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'negadas', jsonb_build_array(
      jsonb_build_object('tabela', 'public.auth_user',                       'motivo', 'hash de senha do Django'),
      jsonb_build_object('tabela', 'public.django_session',                  'motivo', 'sessões do Django (chave e dados)'),
      jsonb_build_object('tabela', 'public.authtoken_token',                 'motivo', 'tokens da API antiga (Django REST)'),
      jsonb_build_object('tabela', 'public.painel_sessoes',                  'motivo', 'sessões do painel (token)'),
      jsonb_build_object('tabela', 'public.painel_reset_senha',              'motivo', 'tokens de redefinição de senha'),
      jsonb_build_object('tabela', 'public.config_disparos_bkp_postmark_1810', 'motivo', 'cópia da config com o descadastro_segredo'),
      jsonb_build_object('tabela', 'public.chaves_leitura',                  'motivo', 'hashes das chaves de leitura'),
      jsonb_build_object('tabela', 'public.leitura_auditoria',               'motivo', 'registro de consultas (só administradores)')
    ),
    'parciais', jsonb_build_array(
      jsonb_build_object('tabela', 'public.painel_usuarios',     'ocultas', jsonb_build_array('senha_hash', 'senha_salt', 'senha_params', 'senha_expira_em', 'trocar_senha'), 'motivo', 'credenciais do painel'),
      jsonb_build_object('tabela', 'public.aberturas_disparo',   'ocultas', jsonb_build_array('token'),    'motivo', 'token do pixel de abertura'),
      jsonb_build_object('tabela', 'email_ia.aberturas_email',   'ocultas', jsonb_build_array('token'),    'motivo', 'token do pixel de abertura'),
      jsonb_build_object('tabela', 'email_ia.anexos',            'ocultas', jsonb_build_array('conteudo'), 'motivo', 'conteúdo binário (use /api/anexo/:id ou /api/imagem/:id)'),
      jsonb_build_object('tabela', 'email_ia.respostas_anexos',  'ocultas', jsonb_build_array('conteudo'), 'motivo', 'conteúdo binário'),
      jsonb_build_object('tabela', 'public.biblioteca_materiais','ocultas', jsonb_build_array('conteudo'), 'motivo', 'conteúdo binário (use /api/biblioteca/:id/arquivo)')
    ),
    'substituidas', jsonb_build_array(
      jsonb_build_object('tabela', 'public.config_disparos', 'use', 'public.config_disparos_leitura', 'motivo', 'a linha descadastro_segredo assina os links de descadastro')
    )
  )
$$;

-- a config sem a linha que assina o descadastro
CREATE OR REPLACE VIEW public.config_disparos_leitura AS
  SELECT * FROM public.config_disparos WHERE chave <> 'descadastro_segredo';

-- 5) concessão tabela por tabela (rode de novo quando criar tabela nova que deva ser lida) -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atualizar_grants_leitura() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  regras   jsonb := public.leitura_regras();
  r        record;
  qn       text;
  ocultas  text[];
  cols     text;
  n_total  integer := 0;
  n_parc   integer := 0;
  n_neg    integer := 0;
  suspeitas text;
BEGIN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sendtrace_leitura';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA email_ia FROM sendtrace_leitura';
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM sendtrace_leitura';
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA email_ia FROM sendtrace_leitura';
  EXECUTE 'GRANT USAGE ON SCHEMA public, email_ia TO sendtrace_leitura';

  FOR r IN
    SELECT n.nspname AS esq, c.relname AS rel, c.oid AS oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'email_ia') AND c.relkind IN ('r', 'v', 'm', 'p') AND NOT c.relispartition
     ORDER BY 1, 2
  LOOP
    qn := r.esq || '.' || r.rel;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(regras->'negadas') x WHERE x->>'tabela' = qn)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(regras->'substituidas') x WHERE x->>'tabela' = qn) THEN
      n_neg := n_neg + 1;
      CONTINUE;
    END IF;

    ocultas := NULL;
    SELECT array(SELECT jsonb_array_elements_text(x->'ocultas')) INTO ocultas
      FROM jsonb_array_elements(regras->'parciais') x WHERE x->>'tabela' = qn;

    IF ocultas IS NOT NULL THEN
      SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
        FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND NOT (attname = ANY (ocultas));
      EXECUTE format('GRANT SELECT (%s) ON %I.%I TO sendtrace_leitura', cols, r.esq, r.rel);
      n_parc := n_parc + 1;
    ELSE
      EXECUTE format('GRANT SELECT ON %I.%I TO sendtrace_leitura', r.esq, r.rel);
      n_total := n_total + 1;
    END IF;
  END LOOP;

  -- colunas liberadas com nome de segredo (para rever à mão; "chave"/"hash_md5" são nomes comuns e inofensivos aqui)
  SELECT string_agg(c.table_name || '.' || c.column_name, '; ' ORDER BY c.table_name, c.column_name) INTO suspeitas
    FROM information_schema.columns c
   WHERE c.table_schema IN ('public', 'email_ia')
     AND c.column_name ~* '(senha|password|passwd|token|secret|segredo|salt|api_?key|credential|private|(^|_)key$)'
     AND has_column_privilege('sendtrace_leitura', format('%I.%I', c.table_schema, c.table_name)::regclass, c.column_name, 'SELECT');
  IF suspeitas IS NOT NULL THEN
    RAISE NOTICE 'ATENÇÃO — colunas com nome de segredo liberadas para leitura: %', suspeitas;
  END IF;

  RETURN format('liberadas: %s · parciais: %s · negadas: %s · colunas suspeitas liberadas: %s', n_total, n_parc, n_neg, coalesce(suspeitas, 'nenhuma'));
END
$f$;

SELECT public.atualizar_grants_leitura();
