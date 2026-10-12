/**
 * SPPL — ocorrências (alertas de logística) e cobranças à fulfillment/transportadora. Dentro do Rastreio de Pedidos.
 * Quem tem a página "Rastreio" trabalha as ocorrências (é rotina do time de CS/logística); mudar REGRAS continua só admin (spplRegras.js).
 * Na v1 a cobrança só REGISTRA (quem cobrou, o quê, prazo de resposta); o envio é feito pelo time fora do sistema.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const SITUACOES = ['aberta', 'em_cobranca', 'aguardando_cliente', 'resolvida', 'cancelada'];
const ENCERRADAS = ['resolvida', 'cancelada'];
const PRIORIDADES = ['P0', 'P1', 'P2', 'P3'];
const DESTINOS = ['fulfillment', 'transportadora', 'parceiro_logistico', 'plataforma_de_venda', 'cliente'];

const texto = (v, max) => { if (v === undefined) return undefined; const t = v === null ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };
const dataIso = (v, nome) => {
  if (v === undefined) return undefined; if (v === null || v === '') return null;
  const d = new Date(v); if (Number.isNaN(d.getTime())) throw new ErroHttp(400, `${nome}: data inválida.`); return d.toISOString();
};

const BASE = `FROM sppl_ocorrencias o
  LEFT JOIN rastreio_pedidos r ON r.transacao_id = o.transacao_id
  LEFT JOIN disparos_pos_venda d ON d.transacao_id = o.transacao_id`;
const COLUNAS = `o.id, o.transacao_id, o.numero, o.categoria, o.etapa, o.prioridade, o.situacao, o.responsavel, o.board_id, o.caso_id, o.proxima_acao, o.proxima_acao_ate,
  o.aberta_em, o.prazo_ate, o.resolvida_em, o.resultado, d.produto, d.plataforma, r.provedor, r.carrier_code, r.tracking_number, r.status_interno,
  (o.situacao NOT IN ('resolvida','cancelada') AND o.prazo_ate IS NOT NULL AND o.prazo_ate < now()) AS vencida,
  floor(extract(epoch FROM (coalesce(o.resolvida_em, now()) - o.aberta_em)) / 86400)::int AS dias_aberta`;

function filtros(q) {
  const where = []; const valores = [];
  const add = (sql, v) => { valores.push(v); where.push(sql.replace('?', `$${valores.length}`)); };
  if (q.situacao === 'abertas') where.push(`o.situacao NOT IN ('resolvida','cancelada')`);
  else if (q.situacao) { if (!SITUACOES.includes(q.situacao)) throw new ErroHttp(400, 'Situação inválida.'); add('o.situacao = ?', q.situacao); }
  if (q.prioridade) { if (!PRIORIDADES.includes(q.prioridade)) throw new ErroHttp(400, 'Prioridade inválida.'); add('o.prioridade = ?', q.prioridade); }
  if (q.categoria) add('o.categoria = ?', String(q.categoria).slice(0, 80));
  if (q.vencidas === 'true') where.push(`o.situacao NOT IN ('resolvida','cancelada') AND o.prazo_ate IS NOT NULL AND o.prazo_ate < now()`);
  // busca: os curingas do LIKE (% e _) são escapados, não apagados — códigos de pedido podem ter underscore
  if (q.busca) { const b = `%${String(q.busca).slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; valores.push(b); where.push(`(o.transacao_id ILIKE $${valores.length} OR o.numero ILIKE $${valores.length} OR o.responsavel ILIKE $${valores.length})`); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', valores };
}

export default async function rotasSpplOcorrencias(app) {
  app.get('/api/rastreio/sppl/ocorrencias', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — alertas de logística (ocorrências)', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const { sql, valores } = filtros(req.query ?? {});
    const porPagina = Math.min(Math.max(Number(req.query?.page_size) || 50, 1), 200);
    const pagina = Math.max(Number(req.query?.page) || 1, 1);
    const total = (await query(`SELECT count(*)::int AS n ${BASE} ${sql}`, valores)).rows[0].n;
    const { rows } = await query(
      `SELECT ${COLUNAS} ${BASE} ${sql}
        ORDER BY (o.situacao IN ('resolvida','cancelada')), o.prioridade, (o.prazo_ate IS NULL), o.prazo_ate, o.aberta_em
        LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`, valores);
    return { total, pagina, ocorrencias: rows };
  });

  app.get('/api/rastreio/sppl/ocorrencias/resumo', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — contagens para os cartões do topo', security: [{ bearerAuth: [] }] },
  }, async () => {
    const { rows } = await query(
      `SELECT count(*) FILTER (WHERE situacao NOT IN ('resolvida','cancelada'))::int AS abertas,
              count(*) FILTER (WHERE situacao NOT IN ('resolvida','cancelada') AND prazo_ate IS NOT NULL AND prazo_ate < now())::int AS vencidas,
              count(*) FILTER (WHERE situacao NOT IN ('resolvida','cancelada') AND prioridade = 'P0')::int AS p0,
              count(*) FILTER (WHERE situacao NOT IN ('resolvida','cancelada') AND prioridade = 'P1')::int AS p1,
              count(*) FILTER (WHERE situacao = 'em_cobranca')::int AS em_cobranca,
              count(*) FILTER (WHERE situacao = 'resolvida' AND resolvida_em > now() - interval '7 days')::int AS resolvidas_7d
         FROM sppl_ocorrencias`);
    const porCategoria = (await query(
      `SELECT categoria, count(*)::int AS n FROM sppl_ocorrencias WHERE situacao NOT IN ('resolvida','cancelada') GROUP BY 1 ORDER BY 2 DESC`)).rows;
    return { ...rows[0], por_categoria: porCategoria };
  });

  app.get('/api/rastreio/sppl/ocorrencias/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — uma ocorrência com as cobranças', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  }, async (req) => {
    const { rows } = await query(`SELECT ${COLUNAS} ${BASE} WHERE o.id = $1`, [req.params.id]);
    if (!rows[0]) throw new ErroHttp(404, 'Ocorrência não encontrada.');
    const cobrancas = (await query(`SELECT id, destino, canal, mensagem, cobrado_em, cobrado_por, prazo_resposta_ate, respondida_em, resposta FROM sppl_cobrancas WHERE ocorrencia_id = $1 ORDER BY cobrado_em DESC`, [req.params.id])).rows;
    return { ...rows[0], cobrancas };
  });

  app.patch('/api/rastreio/sppl/ocorrencias/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — trabalha uma ocorrência (situação, responsável, próxima ação, resultado)', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  }, async (req) => {
    const b = req.body ?? {}; const campos = {};
    if (b.situacao !== undefined) { if (!SITUACOES.includes(b.situacao)) throw new ErroHttp(400, 'Situação inválida.'); campos.situacao = b.situacao; }
    if (b.prioridade !== undefined) { if (!PRIORIDADES.includes(b.prioridade)) throw new ErroHttp(400, 'Prioridade inválida.'); campos.prioridade = b.prioridade; }
    for (const [k, max] of [['responsavel', 200], ['proxima_acao', 1000], ['resultado', 2000]]) { const v = texto(b[k], max); if (v !== undefined) campos[k] = v; }
    const ate = dataIso(b.proxima_acao_ate, 'Próxima ação até'); if (ate !== undefined) campos.proxima_acao_ate = ate;
    if (campos.situacao && ENCERRADAS.includes(campos.situacao) && !(campos.resultado ?? null) && b.resultado === undefined) {
      const atual = (await query('SELECT resultado FROM sppl_ocorrencias WHERE id = $1', [req.params.id])).rows[0];
      if (atual && !atual.resultado) throw new ErroHttp(400, 'Para encerrar, descreva o resultado (conclusão e solução aplicada).');
    }
    const chaves = Object.keys(campos);
    if (!chaves.length) throw new ErroHttp(400, 'Nada para alterar.');
    const sets = chaves.map((c, i) => `${c} = $${i + 2}`);
    if (campos.situacao) sets.push(ENCERRADAS.includes(campos.situacao) ? 'resolvida_em = coalesce(resolvida_em, now())' : 'resolvida_em = NULL');
    const { rows } = await query(`UPDATE sppl_ocorrencias SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $1 RETURNING id, situacao, prioridade, responsavel, proxima_acao, proxima_acao_ate, resolvida_em, resultado`,
      [req.params.id, ...chaves.map((c) => campos[c])]);
    if (!rows[0]) throw new ErroHttp(404, 'Ocorrência não encontrada.');
    return rows[0];
  });

  app.post('/api/rastreio/sppl/ocorrencias/:id/cobrancas', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — registra uma cobrança (não envia nada)', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  }, async (req) => {
    const b = req.body ?? {};
    if (!DESTINOS.includes(b.destino)) throw new ErroHttp(400, `Destino deve ser ${DESTINOS.join(', ')}.`);
    const dias = b.prazo_resposta_dias === undefined || b.prazo_resposta_dias === null || b.prazo_resposta_dias === '' ? 1 : Number(b.prazo_resposta_dias);
    if (!Number.isInteger(dias) || dias < 0 || dias > 30) throw new ErroHttp(400, 'Prazo de resposta: de 0 a 30 dias úteis.');
    const oc = (await query('SELECT id, situacao FROM sppl_ocorrencias WHERE id = $1', [req.params.id])).rows[0];
    if (!oc) throw new ErroHttp(404, 'Ocorrência não encontrada.');
    if (ENCERRADAS.includes(oc.situacao)) throw new ErroHttp(409, 'A ocorrência já foi encerrada.');
    const { rows } = await query(
      `INSERT INTO sppl_cobrancas (ocorrencia_id, destino, canal, mensagem, cobrado_por, prazo_resposta_ate)
       VALUES ($1, $2, $3, $4, $5, sppl_somar_dias_uteis(now(), $6)) RETURNING id, destino, canal, mensagem, cobrado_em, cobrado_por, prazo_resposta_ate`,
      [req.params.id, b.destino, texto(b.canal, 80) ?? null, texto(b.mensagem, 2000) ?? null, req.usuario?.email ?? null, dias]);
    await query(`UPDATE sppl_ocorrencias SET situacao = CASE WHEN situacao = 'aberta' THEN 'em_cobranca' ELSE situacao END, atualizado_em = now() WHERE id = $1`, [req.params.id]);
    return rows[0];
  });

  app.patch('/api/rastreio/sppl/cobrancas/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — registra a resposta de uma cobrança', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  }, async (req) => {
    const resposta = texto(req.body?.resposta, 2000);
    if (!resposta) throw new ErroHttp(400, 'Descreva a resposta recebida.');
    const { rows } = await query(`UPDATE sppl_cobrancas SET resposta = $2, respondida_em = coalesce(respondida_em, now()) WHERE id = $1 RETURNING id, respondida_em, resposta`, [req.params.id, resposta]);
    if (!rows[0]) throw new ErroHttp(404, 'Cobrança não encontrada.');
    return rows[0];
  });
}
