-- ═══════════════════════════════════════════════════════════════════════════
--  098 · Biblioteca de materiais (pedido do Lucas, 13/10/2026)
--
--  Página nova do painel, aberta a todos os usuários logados: links e PDFs de bônus, áreas VIP, e-books e guias, sempre com nicho e produto.
--  Cada material tem um link (copiar) e/ou um arquivo guardado aqui (baixar). `onde_aparece` lista as pastas dos funis onde o mesmo arquivo foi
--  achado (jv/bg/ds/pa/área VIP). Só cria tabela e índices. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.biblioteca_materiais (
  id              bigserial PRIMARY KEY,
  produto_slug    text,
  produto         text NOT NULL,
  nicho           text NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('Bônus', 'E-book', 'Guia de uso', 'Área VIP', 'Rótulo / COA', 'Outro')),
  titulo          text NOT NULL,
  descricao       text,
  url             text,
  arquivo_nome    text,
  arquivo_mime    text,
  arquivo_tamanho bigint,
  arquivo_md5     text,
  conteudo        bytea,
  onde_aparece    text[] NOT NULL DEFAULT '{}',
  origem          text,
  ativo           boolean NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  atualizado_por  text,
  CONSTRAINT biblioteca_materiais_tem_conteudo CHECK (url IS NOT NULL OR conteudo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS biblioteca_materiais_nicho_produto_idx ON public.biblioteca_materiais (nicho, produto);
CREATE UNIQUE INDEX IF NOT EXISTS biblioteca_materiais_md5_produto_uq ON public.biblioteca_materiais (produto, arquivo_md5) WHERE arquivo_md5 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS biblioteca_materiais_url_produto_uq ON public.biblioteca_materiais (produto, url, tipo) WHERE conteudo IS NULL AND url IS NOT NULL;
COMMENT ON TABLE public.biblioteca_materiais IS 'Biblioteca de materiais: bônus, e-books, guias, áreas VIP por nicho e produto (098). Arquivo em `conteudo`; link em `url`.';
