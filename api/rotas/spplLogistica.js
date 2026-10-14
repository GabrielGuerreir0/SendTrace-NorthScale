/**
 * SPPL — Monitoramento Logístico (2º momento da Késsia, 14/10/2026): os 5 quadros do dashboard e o relatório de pedidos. SOMENTE LEITURA.
 * Os quadros vêm da view `sppl_logistica` (migração 101); os critérios estão no cabeçalho da migração e na tela. Dado pessoal (nome, e-mail,
 * endereço) só para quem já tem a página Rastreio (a mesma regra da ficha do pedido).
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const QUADROS = [1, 2, 3, 4, 5];

/** Roda sobre `pag` (a página já recortada da view `sppl_logistica`, ver `consultaPagina`): os joins pesados só valem para as linhas que saem.
 * Produtos do pedido (principal + upsells/downsells), garrafas e valor: do dash quando existe; senão o produto da fila + compras de upsell na janela de 6 h. */
export const SELECT_RELATORIO = `
  SELECT l.total_filtro, l.transacao_id, l.numero_pedido, l.nome, l.email, l.plataforma, l.quadro, l.sem_17track,
         p.endereco_entrega AS endereco,
         l.fulfillment, coalesce(t17.provedor, l.carrier_code) AS transportadora,
         coalesce(dash.produtos, l.produto || coalesce(' + ' || cud.itens, '')) AS produtos,
         dash.quantidade, coalesce(dash.valor, l.total) AS valor,
         l.tracking_number AS rastreio,
         coalesce(nullif(l.tracking_url, ''), CASE WHEN coalesce(l.tracking_number, '') <> '' THEN 'https://t.17track.net/pt#nums=' || l.tracking_number END) AS link_rastreio,
         l.data_pedido, l.idade_dias, l.ultima_movimentacao_em, l.dias_sem_movimentacao,
         coalesce(l.ultimo_substatus, l.ultimo_status) AS ultimo_status,
         tk.id AS ticket_id, tk.status_ticket
    FROM pag l
    JOIN rastreio_pedidos p ON p.transacao_id = l.transacao_id
    LEFT JOIN LATERAL (SELECT e.provedor_17t AS provedor FROM rastreio_17t_eventos e WHERE e.numero = l.numero_17t AND e.provedor_17t IS NOT NULL ORDER BY e.ocorreu_em DESC LIMIT 1) t17 ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(x.product_name, ' + ' ORDER BY x.funnel_step NULLS FIRST, x.ordered_at) AS produtos, sum(x.bottles)::int AS quantidade, sum(x.gross) AS valor
        FROM dash_pedidos x
       WHERE x.plataforma = lower(btrim(l.plataforma)) AND (x.external_id = l.transacao_id OR x.parent_external_id = l.transacao_id OR x.session_id = l.transacao_id)) dash ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(c.produto, ' + ' ORDER BY c.criado_em) AS itens FROM compras_upsell_downsell c
       WHERE lower(c.email) = lower(l.email) AND c.criado_em BETWEEN l.data_pedido AND l.data_pedido + interval '6 hours') cud ON true
    LEFT JOIN LATERAL (SELECT id, status_ticket FROM sppl_ativo_tickets WHERE transacao_id = l.transacao_id AND status_ticket <> 'fechado' LIMIT 1) tk ON true`;

function filtros(q) {
  const where = []; const valores = [];
  const add = (sql, v) => { valores.push(v); where.push(sql.replace('?', `$${valores.length}`)); };
  if (q.quadro === 'sem17') where.push('l.sem_17track');
  else if (q.quadro === 'todos' || q.quadro === undefined || q.quadro === '') where.push('l.quadro IS NOT NULL');
  else { const n = Number(q.quadro); if (!QUADROS.includes(n)) throw new ErroHttp(400, 'Quadro inválido (1 a 5).'); add('l.quadro = ?', n); }
  if (q.plataforma) add('lower(btrim(l.plataforma)) = ?', String(q.plataforma).toLowerCase().slice(0, 40));
  if (q.fulfillment) add('l.fulfillment = ?', String(q.fulfillment).slice(0, 40));
  if (q.suporte_ativo === 'sim') where.push(`EXISTS (SELECT 1 FROM sppl_ativo_tickets tt WHERE tt.transacao_id = l.transacao_id AND tt.status_ticket <> 'fechado')`);
  if (q.suporte_ativo === 'nao') where.push(`NOT EXISTS (SELECT 1 FROM sppl_ativo_tickets tt WHERE tt.transacao_id = l.transacao_id AND tt.status_ticket <> 'fechado')`);
  if (q.busca) {
    const b = `%${String(q.busca).slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; valores.push(b);
    where.push(`(l.transacao_id ILIKE $${valores.length} OR l.numero_pedido ILIKE $${valores.length} OR l.nome ILIKE $${valores.length} OR l.email ILIKE $${valores.length} OR l.tracking_number ILIKE $${valores.length})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', valores };
}

export default async function rotasSpplLogistica(app) {
  app.get('/api/rastreio/sppl/logistica/resumo', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — contagem dos 5 quadros do Monitoramento Logístico', security: [{ bearerAuth: [] }] },
  }, async () => {
    const { rows } = await query(`SELECT quadro, count(*)::int AS n, count(*) FILTER (WHERE sem_17track)::int AS sem17 FROM sppl_logistica GROUP BY 1`);
    const quadros = Object.fromEntries(QUADROS.map((q) => [q, rows.find((r) => r.quadro === q)?.n ?? 0]));
    const extra = (await query(`SELECT (SELECT count(*)::int FROM sppl_ativo_tickets WHERE status_ticket <> 'fechado') AS tickets_abertos`)).rows[0];
    extra.sem_17track = rows.reduce((t, r) => t + r.sem17, 0);
    return { quadros, ...extra, gerado_em: new Date().toISOString() };
  });

  app.get('/api/rastreio/sppl/logistica/pedidos', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — relatório de pedidos de um quadro (ou de todos), com paginação; `todos=1` devolve até 5000 linhas para exportar',
      security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const f = filtros(req.query ?? {});
    const todos = req.query?.todos === '1';
    const tamanho = todos ? 5000 : Math.min(200, Math.max(1, Number(req.query?.tamanho) || 50));
    const pagina = Math.max(1, Number(req.query?.pagina) || 1);
    // A view sppl_logistica é cara (~2 s com ~5 mil pedidos): roda UMA vez (count(*) OVER) e os joins do relatório só valem para a página.
    const { rows } = await query(
      `WITH pag AS MATERIALIZED (
         SELECT l.*, count(*) OVER ()::int AS total_filtro FROM sppl_logistica l ${f.sql}
          ORDER BY l.dias_sem_movimentacao DESC NULLS LAST, l.idade_dias DESC NULLS LAST, l.transacao_id LIMIT ${tamanho} OFFSET ${todos ? 0 : (pagina - 1) * tamanho})
       ${SELECT_RELATORIO} ORDER BY l.dias_sem_movimentacao DESC NULLS LAST, l.idade_dias DESC NULLS LAST, l.transacao_id`,
      f.valores,
    );
    let total = rows[0]?.total_filtro ?? 0;
    if (!rows.length && pagina > 1) total = (await query(`SELECT count(*)::int AS n FROM sppl_logistica l ${f.sql}`, f.valores)).rows[0].n;
    for (const r of rows) delete r.total_filtro;
    return { total, pagina: todos ? 1 : pagina, tamanho, cortado: todos && total > tamanho, itens: rows };
  });
}
