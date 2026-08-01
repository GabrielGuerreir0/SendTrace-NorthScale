-- ═══════════════════════════════════════════════════════════════════════════
--  Readmes de produto — o conhecimento que alimenta a IA de suporte.
--
--  Cada produto novo que entra na operação ganha um readme escrito no PAINEL:
--  o que é, como usar, prazos, perguntas frequentes, política. O chatbot de
--  suporte (NorthSupportCB) lê estes textos pela API e os injeta no prompt —
--  assim a IA aprende sobre um produto novo no momento em que alguém o
--  descreve aqui, sem deploy e sem editar arquivo em servidor nenhum.
--
--  A chave é o NOME do produto como aparece no painel (o nome limpo, sem o
--  código da oferta) — é o vocabulário que quem escreve conhece.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS produto_readmes (
  produto        text        PRIMARY KEY,
  readme         text        NOT NULL,
  ativo          boolean     NOT NULL DEFAULT true,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por text
);

COMMENT ON TABLE produto_readmes
  IS 'Conhecimento por produto para a IA de suporte. Escrito no painel, lido pelo chatbot via API.';
COMMENT ON COLUMN produto_readmes.produto
  IS 'Nome do produto como o painel mostra (sem código de oferta).';
COMMENT ON COLUMN produto_readmes.ativo
  IS 'false = a IA deixa de receber este readme, sem apagar o texto.';
