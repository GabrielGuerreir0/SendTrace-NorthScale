/**
 * SPPL — saúde (cartão com semáforo) e relatório de logística (7/14/30 dias). Só leitura, qualquer conta com a página Rastreio.
 * Sem dado pessoal: contagens, nomes de agente (equipe interna) e categorias. A saúde vem da função SQL sppl_saude_problemas() (migração 093),
 * a MESMA que alimenta o alerta por e-mail `sppl_saude`.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const ABERTA = `o.situacao NOT IN ('resolvida','cancelada')`;
const VENCIDA = `(${ABERTA} AND o.prazo_ate IS NOT NULL AND o.prazo_ate < now())`;

export default async function rotasSpplRelatorio(app) {
  app.get('/api/rastreio/sppl/saude', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — saúde (cota do 17TRACK, webhook, defasagem da Red Rock)', security: [{ bearerAuth: [] }] },
  }, async () => {
    const problemas = (await query('SELECT codigo, gravidade, titulo, detalhe FROM sppl_saude_problemas()')).rows;
    const cfg = Object.fromEntries((await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'sppl_%'`)).rows.map((r) => [r.chave, r.valor]));
    const registros = Object.fromEntries((await query(`SELECT situacao_registro AS s, count(*)::int AS n FROM rastreio_17t_registros GROUP BY 1`)).rows.map((r) => [r.s, r.n]));
    const m = (await query(
      `SELECT (SELECT max(recebido_em) FROM rastreio_17t_payloads WHERE origem = 'webhook') AS ultimo_webhook_em,
              (SELECT max(recebido_em) FROM rastreio_17t_payloads WHERE origem = 'consulta') AS ultima_reconciliacao_em,
              (SELECT count(*)::int FROM rastreio_17t_registros WHERE situacao_registro = 'aceito' AND coalesce(ultimo_status,'') NOT IN ('Delivered','Expired')) AS em_acompanhamento,
              (SELECT max(ultima_consulta_em) FROM rastreio_pedidos WHERE provedor = 'redrock' AND status_interno IN ('pending','shipped')) AS ultima_consulta_redrock,
              (SELECT count(*)::int FROM sppl_ocorrencias WHERE situacao NOT IN ('resolvida','cancelada')) AS ocorrencias_abertas`)).rows[0];
    return {
      ok: problemas.length === 0, problemas,
      interruptores: {
        motor: cfg.sppl_motor_ativo === 'true', registro_17track: cfg.sppl_17track_ativo === 'true', reconciliacao_17track: cfg.sppl_17track_reconciliar_ativo === 'true',
        sorteio: cfg.sppl_sorteio_ativo === 'true', cards: cfg.sppl_cards_ativo === 'true',
      },
      cota_restante: cfg.sppl_17track_cota_restante === '' || cfg.sppl_17track_cota_restante === undefined ? null : Number(cfg.sppl_17track_cota_restante),
      cota_lida_em: cfg.sppl_17track_cota_restante_em || null,
      registros_17track: { aceito: registros.aceito ?? 0, recusado: registros.recusado ?? 0, sem_dado: registros.sem_dado ?? 0, pendente: registros.pendente ?? 0 },
      ...m,
    };
  });

  app.get('/api/rastreio/sppl/relatorio', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — relatório de logística do período (7, 14 ou 30 dias)', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const dias = Number(req.query?.dias ?? 7);
    if (![7, 14, 30].includes(dias)) throw new ErroHttp(400, 'Período: 7, 14 ou 30 dias.');
    const de = `now() - make_interval(days => ${dias})`;
    const abertasPeriodo = (await query(`SELECT categoria, count(*)::int AS n FROM sppl_ocorrencias WHERE aberta_em >= ${de} GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const fechamento = (await query(
      `SELECT count(*) FILTER (WHERE situacao = 'resolvida' AND resolvida_em >= ${de})::int AS resolvidas,
              count(*) FILTER (WHERE situacao = 'cancelada' AND resolvida_em >= ${de})::int AS canceladas,
              round((avg(extract(epoch FROM (resolvida_em - aberta_em)) / 3600.0) FILTER (WHERE situacao = 'resolvida' AND resolvida_em >= ${de}))::numeric, 1) AS horas_ate_resolver
         FROM sppl_ocorrencias`)).rows[0];
    const backlog = (await query(
      `SELECT count(*) FILTER (WHERE ${ABERTA})::int AS abertas, count(*) FILTER (WHERE ${VENCIDA})::int AS vencidas,
              count(*) FILTER (WHERE ${ABERTA} AND o.prioridade = 'P0')::int AS p0, count(*) FILTER (WHERE ${ABERTA} AND o.prioridade = 'P1')::int AS p1,
              count(*) FILTER (WHERE ${ABERTA} AND o.prioridade = 'P2')::int AS p2, count(*) FILTER (WHERE ${ABERTA} AND o.prioridade = 'P3')::int AS p3
         FROM sppl_ocorrencias o`)).rows[0];
    const porAgente = (await query(
      `SELECT coalesce(b.nome, '(sem responsável)') AS agente, count(*) FILTER (WHERE ${ABERTA})::int AS abertas, count(*) FILTER (WHERE ${VENCIDA})::int AS vencidas,
              count(*) FILTER (WHERE o.situacao = 'resolvida' AND o.resolvida_em >= ${de})::int AS resolvidas
         FROM sppl_ocorrencias o LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = o.board_id
        GROUP BY 1 HAVING count(*) FILTER (WHERE ${ABERTA}) > 0 OR count(*) FILTER (WHERE o.situacao = 'resolvida' AND o.resolvida_em >= ${de}) > 0
        ORDER BY 2 DESC, 1`)).rows;
    const porFulfillment = (await query(
      `SELECT coalesce(r.provedor, '(sem provedor)') AS provedor, coalesce(nullif(r.carrier_code, ''), '(sem transportadora)') AS transportadora, count(*)::int AS abertas
         FROM sppl_ocorrencias o LEFT JOIN rastreio_pedidos r ON r.transacao_id = o.transacao_id WHERE ${ABERTA} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15`)).rows;
    const cobrancas = (await query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE respondida_em IS NOT NULL)::int AS respondidas,
              count(*) FILTER (WHERE respondida_em IS NULL AND prazo_resposta_ate < now())::int AS sem_resposta_no_prazo,
              round((avg(extract(epoch FROM (respondida_em - cobrado_em)) / 3600.0) FILTER (WHERE respondida_em IS NOT NULL))::numeric, 1) AS horas_ate_responder
         FROM sppl_cobrancas WHERE cobrado_em >= ${de}`)).rows[0];
    const cobPorDestino = (await query(`SELECT destino, count(*)::int AS n FROM sppl_cobrancas WHERE cobrado_em >= ${de} GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const t17 = (await query(
      `SELECT count(*) FILTER (WHERE ultimo_status = 'Delivered' AND ultimo_evento_em >= ${de})::int AS entregas_confirmadas,
              count(*) FILTER (WHERE situacao_registro = 'recusado')::int AS recusados, count(*) FILTER (WHERE situacao_registro = 'sem_dado')::int AS sem_dado
         FROM rastreio_17t_registros`)).rows[0];
    return { dias, abertas_no_periodo: abertasPeriodo, total_abertas_no_periodo: abertasPeriodo.reduce((a, b) => a + b.n, 0), ...fechamento, backlog, por_agente: porAgente,
      por_fulfillment: porFulfillment, cobrancas: { ...cobrancas, por_destino: cobPorDestino }, track17: t17 };
  });
}
