/**
 * Upsell/downsell comprado pelo mesmo lead/cliente, à parte da régua de
 * pós-venda — só registrado (nenhum e-mail/SMS automático pra eles).
 *
 * Quem escreve são os 3 fluxos de Reporting (n8n). O painel só lê, pra
 * mostrar um selo na tabela de Régua de pós-venda quando o mesmo e-mail
 * também aparece aqui.
 */
import { CompraUpsellDownsell } from '../esquemas.js';
import { registrarCrud } from '../comum.js';

const COLUNAS = 'id, transacao_id, nome, email, telefone, produto, tag_produto, '
  + 'etapa_funil, plataforma, criado_em, reembolsado_em, chargeback_em';

export default async function rotasUpsellDownsell(app) {
  registrarCrud(app, {
    rota: '/api/upsell-downsell/',
    tabela: 'compras_upsell_downsell',
    chave: 'id',
    esquema: CompraUpsellDownsell,
    tag: 'Upsell/Downsell',
    colunas: COLUNAS,
    somenteLeitura: true,
    buscaEm: ['email', 'produto', 'transacao_id'],
    ordenaveis: ['criado_em'],
    ordemPadrao: 'criado_em DESC',
    filtros: {
      etapa_funil: { coluna: 'etapa_funil', esquema: { type: 'string', description: "'upsell', 'downsell' ou 'outro'." } },
      plataforma: { coluna: 'plataforma' },
    },
  });
}
