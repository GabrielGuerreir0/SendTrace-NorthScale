/**
 * Suporte Escalado — fila do agente em lista (pedido da Késsia, PDF de 05/10/2026, item 8; usa o SLA das migrações 073 e 074).
 *
 *   GET /api/suporte-escalado/fila?board_id=<id|todos>
 *     → { resumo, casos[] }  — casos em aberto do board (ou de todos, só admin/gestor), cada um com `fila`:
 *        'primeiro' (ainda sem resposta do agente), 'segundo' (o cliente escreveu depois da última resposta) ou 'outros' (esperando o cliente etc.).
 *
 * Para o agente não importa o status do card: importa o que está pendente de resposta dele. O tempo restante vem do SLA dentro do turno
 * (meta 3 h Alta / 4 h Média); negativo = estourado. O `resumo` traz as contagens, o total respondido hoje e o SLA médio dos últimos 7 dias.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const ABERTOS = "('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')";
const ENCERRADO_NA_FICHA = "coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')";   // ticket resolvido/fechado na ficha sai da fila
const LIMITE = 1000;

export default async function rotasSuporteEscaladoFila(app) {
  app.get('/api/suporte-escalado/fila', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Fila do agente em lista: o que está pendente de resposta (1ª, 2ª em diante) e todos os atribuídos, com o SLA dentro do turno',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', required: ['board_id'],
        properties: { board_id: { type: 'string' }, q: { type: 'string', maxLength: 120 } },
      },
    },
  }, async (req) => {
    const todos = req.query.board_id === 'todos';
    const gestor = !!req.usuario.admin || !!req.usuario.gestorHumano;
    let boardId = null;
    if (todos) {
      if (!gestor) throw new ErroHttp(403, 'Só administradores e gestores veem a fila de todos os boards.');
    } else {
      boardId = Number(req.query.board_id);
      if (!Number.isInteger(boardId)) throw new ErroHttp(400, 'board_id inválido.');
      const { rows } = await query('SELECT id, usuario_id FROM email_ia.suporte_escalado_boards WHERE id = $1', [boardId]);
      if (!rows[0]) throw new ErroHttp(404, 'Board não encontrado.');
      if (!gestor && rows[0].usuario_id !== req.usuario.user_id) throw new ErroHttp(403, 'Este board não é seu.');
    }
    const escopo = todos ? 'TRUE' : 's.board_id = $1';
    const valores = todos ? [] : [boardId];
    const escopoResp = todos ? 'TRUE' : 'r.board_id = $1';

    // Busca (item 13): e-mail, nome, assunto, nº do ticket (id do caso) ou nº do pedido do cliente.
    const q = (req.query.q ?? '').trim();
    const valoresCasos = [...valores];
    let filtroBusca = 'TRUE';
    if (q) {
      valoresCasos.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      const ph = `$${valoresCasos.length}`;
      const porId = /^#?\d{1,12}$/.test(q) ? ` OR s.id = ${Number(q.replace('#', ''))}` : '';
      filtroBusca = `(s.remetente_email ILIKE ${ph} OR s.nome ILIKE ${ph} OR e.assunto ILIKE ${ph}${porId}
        OR EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE lower(d.email) = lower(s.remetente_email) AND d.transacao_id ILIKE ${ph}))`;
    }

    const [casosRes, hojeRes, slaRes] = await Promise.all([
      query(
        `SELECT s.id, s.remetente_email, s.nome, e.assunto, s.status, s.tag_motivo, s.prioridade_nivel, s.prioridade, s.board_id,
                b.nome AS agente, s.resumo_conversa, s.motivo_escalonamento, s.email_id, s.iniciado_em, s.finalizado_em, s.alerta_ameaca, s.criado_em, s.ultimo_email_cliente_em, s.primeira_resposta_agente_em, s.ultima_resposta_agente_em,
                fi.motivo_contato, fi.detalhamento_motivo, fi.tipo_resolucao, fi.status_ticket, fi.motivo_reenvio, fi.status_logistica,
                fi.responsavel_board_id AS responsavel_logistica_id, fi.status_ajuda, fi.quantidade_reenvio, fi.percentual_reembolso,
                fi.chargeback_em, fi.ticket_reaberto_em,
                (SELECT a.para_board_id FROM email_ia.suporte_escalado_ajuda a WHERE a.suporte_escalado_id = s.id ORDER BY a.criado_em DESC LIMIT 1) AS ajuda_para_id,
                CASE WHEN s.primeira_resposta_agente_em IS NULL THEN 'primeiro' WHEN v.vez_do_agente THEN 'segundo' ELSE 'outros' END AS fila,
                v.meta_min, v.pausado,
                CASE WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END AS espera_min
           FROM email_ia.suporte_escalado s
           LEFT JOIN email_ia.v_sla_suporte_escalado v ON v.caso_id = s.id
           LEFT JOIN email_ia.emails e ON e.id = s.email_id
           LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
           LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
          WHERE ${escopo} AND s.status IN ${ABERTOS} AND ${ENCERRADO_NA_FICHA} AND ${filtroBusca}
          ORDER BY (CASE WHEN v.meta_min IS NULL THEN 1 ELSE 0 END),
                   (v.meta_min - coalesce(CASE WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END, 0)) ASC,
                   s.criado_em ASC
          LIMIT ${LIMITE + 1}`,
        valoresCasos,
      ),
      query(
        `SELECT count(DISTINCT r.caso_id)::int AS casos
           FROM email_ia.respostas_agente r
          WHERE ${escopoResp} AND r.caso_id IS NOT NULL
            AND r.enviado_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')) AT TIME ZONE 'America/Sao_Paulo'`,
        valores,
      ),
      query(
        `SELECT r.primeira, count(r.minutos)::int AS medidas, avg(r.minutos) AS media_min,
                count(*) FILTER (WHERE r.dentro_da_meta)::int AS dentro
           FROM email_ia.v_sla_respostas_agente r
          WHERE ${escopoResp} AND r.enviado_em >= now() - interval '7 days'
          GROUP BY r.primeira`,
        valores,
      ),
    ]);

    const truncado = casosRes.rows.length > LIMITE;
    const casos = casosRes.rows.slice(0, LIMITE).map((c) => ({
      ...c,
      restante_min: c.meta_min != null && c.espera_min != null ? Math.round(Number(c.meta_min) - Number(c.espera_min)) : null,
      espera_min: c.espera_min != null ? Math.round(Number(c.espera_min)) : null,
    }));
    const sla = (primeira) => {
      const l = slaRes.rows.find((x) => x.primeira === primeira);
      return { media_min: l && l.media_min != null ? Math.round(Number(l.media_min)) : null, medidas: l?.medidas ?? 0, dentro: l?.dentro ?? 0 };
    };
    return {
      truncado,
      resumo: {
        pendentes_primeira: casos.filter((c) => c.fila === 'primeiro').length,
        pendentes_segunda: casos.filter((c) => c.fila === 'segundo').length,
        respondidos_hoje: hojeRes.rows[0]?.casos ?? 0,
        sla_primeira: sla(true),
        sla_segunda: sla(false),
        janela_dias: 7,
      },
      casos,
    };
  });

  /**
   * GET /api/suporte-escalado/pendencias-internas?board_id=<id|todos>
   * Fila separada das de 1º/2º e-mail (PDF de 07/10, item 27): o que OUTRA pessoa pediu a este board e ainda não foi feito.
   *   logística — status Solicitar / Solicitado / Responder cliente com este board como responsável;
   *   ajuda     — pedido de ajuda endereçado a este board e ainda sem resposta (e não marcado como Resolvido).
   */
  app.get('/api/suporte-escalado/pendencias-internas', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Pendências internas do board: ações pedidas por outros agentes (logística e ajuda)',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', required: ['board_id'], properties: { board_id: { type: 'string' } } },
    },
  }, async (req) => {
    const todos = req.query.board_id === 'todos';
    const gestor = !!req.usuario.admin || !!req.usuario.gestorHumano;
    let boardId = null;
    if (todos) {
      if (!gestor) throw new ErroHttp(403, 'Só administradores e gestores veem as pendências de todos os boards.');
    } else {
      boardId = Number(req.query.board_id);
      if (!Number.isInteger(boardId)) throw new ErroHttp(400, 'board_id inválido.');
      const { rows } = await query('SELECT id, usuario_id FROM email_ia.suporte_escalado_boards WHERE id = $1', [boardId]);
      if (!rows[0]) throw new ErroHttp(404, 'Board não encontrado.');
      if (!gestor && rows[0].usuario_id !== req.usuario.user_id) throw new ErroHttp(403, 'Este board não é seu.');
    }
    const valores = todos ? [] : [boardId];
    const logistica = todos ? 'fi.responsavel_board_id IS NOT NULL' : 'fi.responsavel_board_id = $1';
    const ajuda = todos ? 'TRUE' : 'a.para_board_id = $1';
    const colunasCaso = `s.id AS caso_id, s.remetente_email, s.nome, e.assunto, s.tag_motivo, s.prioridade_nivel, s.board_id,
                         b.nome AS agente, s.resumo_conversa, s.motivo_escalonamento, s.email_id, s.status, s.criado_em AS caso_criado_em`;
    const [log, aj] = await Promise.all([
      query(
        `SELECT 'logistica' AS tipo, fi.status_logistica AS detalhe, fi.logistica_atualizado_por AS pedido_por, fi.logistica_atualizado_em AS desde,
                rb.nome AS para_nome, fi.produto_reenvio AS nota, ${colunasCaso}
           FROM email_ia.suporte_escalado_ficha fi
           JOIN email_ia.suporte_escalado s ON s.id = fi.suporte_escalado_id
           LEFT JOIN email_ia.emails e ON e.id = s.email_id
           LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
           LEFT JOIN email_ia.suporte_escalado_boards rb ON rb.id = fi.responsavel_board_id
          WHERE ${logistica} AND fi.status_logistica IN ('Solicitar', 'Solicitado', 'Responder cliente')
          ORDER BY fi.logistica_atualizado_em NULLS LAST
          LIMIT 500`, valores),
      query(
        `SELECT 'ajuda' AS tipo, 'Preciso de ajuda' AS detalhe, a.pedido_por, a.criado_em AS desde, ab.nome AS para_nome, a.nota, ${colunasCaso}
           FROM email_ia.suporte_escalado_ajuda a
           JOIN email_ia.suporte_escalado s ON s.id = a.suporte_escalado_id
           LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
           LEFT JOIN email_ia.emails e ON e.id = s.email_id
           LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
           LEFT JOIN email_ia.suporte_escalado_boards ab ON ab.id = a.para_board_id
          WHERE ${ajuda} AND a.respondido_em IS NULL AND coalesce(fi.status_ajuda, '') <> 'Resolvido'
          ORDER BY a.criado_em
          LIMIT 500`, valores),
    ]);
    const pendencias = [...log.rows, ...aj.rows].sort((x, y) => new Date(x.desde ?? 0) - new Date(y.desde ?? 0));
    return { pendencias };
  });
}
