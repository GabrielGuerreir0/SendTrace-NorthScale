/**
 * SPPL — pedidos "não encontrados" (a Red Rock devolveu 404). Lista SEPARADA dos alertas: são milhares e a ação não é cobrar transportadora,
 * é levar exemplos à fulfillment. Só leitura; sem dado pessoal (nada de nome, e-mail ou endereço): pedido, produto, plataforma, datas e o
 * id usado na consulta. `todos=1` libera até 5.000 linhas para exportar.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const FAIXAS = {
  ate7: `d.criado_em >= now() - interval '7 days'`,
  de7a30: `d.criado_em < now() - interval '7 days' AND d.criado_em >= now() - interval '30 days'`,
  mais30: `d.criado_em < now() - interval '30 days'`,
};
const BASE = `FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
  WHERE r.status_interno = 'nao_encontrado'
    AND d.reembolsado_em IS NULL AND d.chargeback_em IS NULL`;

export default async function rotasSpplNaoEncontrados(app) {
  app.get('/api/rastreio/sppl/nao-encontrados', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — pedidos que a Red Rock não encontrou (lista separada dos alertas)', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const q = req.query ?? {};
    const where = []; const valores = [];
    if (q.faixa) { if (!FAIXAS[q.faixa]) throw new ErroHttp(400, 'Faixa inválida.'); where.push(FAIXAS[q.faixa]); }
    if (q.plataforma) { valores.push(String(q.plataforma).slice(0, 40)); where.push(`btrim(d.plataforma) = $${valores.length}`); }
    if (q.busca) { valores.push(`%${String(q.busca).slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(r.transacao_id ILIKE $${valores.length} OR d.produto ILIKE $${valores.length})`); }
    const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
    const exportar = q.todos === '1';
    const porPagina = exportar ? 5000 : Math.min(Math.max(Number(q.page_size) || 50, 1), 200);
    const pagina = exportar ? 1 : Math.max(Number(q.page) || 1, 1);

    const total = (await query(`SELECT count(*)::int AS n ${BASE}${extra}`, valores)).rows[0].n;
    const { rows } = await query(
      `SELECT r.transacao_id, coalesce(d.id_rastreio, r.transacao_id) AS id_consulta, d.produto, btrim(d.plataforma) AS plataforma, d.criado_em AS comprado_em,
              floor(extract(epoch FROM (now() - d.criado_em)) / 86400)::int AS dias, r.ultima_consulta_em
         ${BASE}${extra} ORDER BY d.criado_em DESC NULLS LAST LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`, valores);
    // resumo SEM os filtros de faixa/busca (sempre o quadro geral), por plataforma e faixa
    const resumo = (await query(
      `SELECT coalesce(btrim(d.plataforma), '(sem plataforma)') AS plataforma,
              count(*) FILTER (WHERE ${FAIXAS.ate7})::int AS ate7, count(*) FILTER (WHERE ${FAIXAS.de7a30})::int AS de7a30,
              count(*) FILTER (WHERE ${FAIXAS.mais30})::int AS mais30, count(*)::int AS total
         ${BASE} GROUP BY 1 ORDER BY 5 DESC`)).rows;
    return { total, pagina, pedidos: rows, resumo };
  });
}
