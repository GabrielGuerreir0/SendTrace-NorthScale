/**
 * Readmes de produto — o conhecimento da IA de suporte.
 *
 * Quem escreve é o time, pelo painel. Quem lê é o CHATBOT (NorthSupportCB):
 * ele baixa os readmes ativos e os injeta no próprio prompt, então descrever
 * um produto novo aqui é literalmente ensinar a IA sobre ele — sem deploy,
 * sem editar arquivo em servidor nenhum.
 *
 * Leitura exige conta ativa (o bot tem a dele); escrita exige administrador,
 * porque o texto vira comportamento na frente de cliente real.
 */
import { ProdutoReadme } from '../esquemas.js';
import { registrarCrud } from '../comum.js';

const COLUNAS = 'produto, readme, ativo, atualizado_em, atualizado_por';

export default async function rotasProdutos(app) {
  registrarCrud(app, {
    rota: '/api/produto-readmes/',
    tabela: 'produto_readmes',
    chave: 'produto',
    esquema: ProdutoReadme,
    tag: 'Produtos',
    colunas: COLUNAS,
    buscaEm: ['produto', 'readme'],
    ordenaveis: ['produto', 'atualizado_em'],
    ordemPadrao: 'produto ASC',
    filtros: {
      ativo: { coluna: 'ativo', esquema: { type: 'boolean', description: 'Só os que a IA recebe (true) ou só os desligados (false).' } },
    },
    // O carimbo é posto aqui, não confiado ao cliente: um readme com data de
    // atualização mentirosa faria o bot parecer atualizado sem estar.
    aoEntrar: (corpo) => ({ ...corpo, atualizado_em: new Date() }),
  });
}
