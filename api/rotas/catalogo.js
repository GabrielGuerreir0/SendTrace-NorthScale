/**
 * O catálogo canônico de produtos e as exceções de nomenclatura.
 *
 * NÃO confundir com `GET /api/metricas/produtos/`, que é outra coisa: o
 * catálogo DERIVADO da fila, usado para popular o filtro do topo do painel.
 * Este aqui é o editável — a fonte do nome de exibição, do link do e-book e
 * do e-mail de suporte que a copy por produto usa.
 *
 * `'*'` é a linha do padrão: o produto fictício que todo produto sem copy
 * própria herda. Apagá-la quebraria a cascata inteira, então o DELETE recusa.
 */
import { ProdutoCatalogo, ProdutoAlias } from '../esquemas.js';
import { registrarCrud, ErroHttp } from '../comum.js';

export default async function rotasCatalogo(app) {
  registrarCrud(app, {
    rota: '/api/produtos/',
    tabela: 'produtos',
    chave: 'slug',
    esquema: ProdutoCatalogo,
    tag: 'Catálogo',
    colunas: 'slug, nome, nome_sms, forma, uso, link_ebook, email_suporte, ativo, atualizado_em',
    buscaEm: ['slug', 'nome'],
    ordenaveis: ['slug', 'nome', 'atualizado_em'],
    ordemPadrao: 'nome ASC',
    filtros: { ativo: { coluna: 'ativo', esquema: { type: 'boolean' } } },
    aoEntrar: (corpo, metodo) => {
      const dados = { ...corpo, atualizado_em: new Date() };
      // No PATCH, campo ausente é campo não mexido — mas o slug nunca muda:
      // é a chave que a copy e a fila referenciam.
      if (metodo === 'patch') delete dados.slug;
      return dados;
    },
  });

  // O hook vale só para as rotas deste plugin (encapsulamento do Fastify) e
  // barra o DELETE do padrão antes de chegar no handler genérico do CRUD.
  app.addHook('preHandler', async (req) => {
    if (req.method === 'DELETE' && req.params?.slug === '*') {
      throw new ErroHttp(400, "O produto '*' é o padrão da cascata — não pode ser apagado.");
    }
  });

  registrarCrud(app, {
    rota: '/api/produto-aliases/',
    tabela: 'produto_aliases',
    chave: 'alias',
    esquema: ProdutoAlias,
    tag: 'Catálogo',
    colunas: 'alias, produto_slug, criado_em',
    buscaEm: ['alias', 'produto_slug'],
    ordenaveis: ['alias', 'produto_slug', 'criado_em'],
    ordemPadrao: 'alias ASC',
    filtros: { produto_slug: { coluna: 'produto_slug' } },
  });
}
