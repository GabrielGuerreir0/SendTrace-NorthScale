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
const LIMITE = 1000;

export default async function rotasSuporteEscaladoFila(app) {
  app.get('/api/suporte-escalado/fila', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Fila do agente em lista: o que está pendente de resposta (1ª, 2ª em diante) e todos os atribuídos, com o SLA dentro do turno',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', required: ['board_id'], properties: { board_id: { type: 'string' } } },
    },
  }, async (req) => {
    const todos = req.query.board_id === 'todos';
    const gestor = !!req.usuario.admin || !!req.usuario.gestorEscalado;
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

    const [casosRes, hojeRes, slaRes] = await Promise.all([
      query(
        `SELECT s.id, s.remetente_email, s.nome, e.assunto, s.status, s.tag_motivo, s.prioridade_nivel, s.prioridade, s.board_id,
                b.nome AS agente, s.resumo_conversa, s.motivo_escalonamento, s.email_id, s.iniciado_em, s.finalizado_em, s.alerta_ameaca, s.criado_em, s.ultimo_email_cliente_em, s.primeira_resposta_agente_em, s.ultima_resposta_agente_em,
                CASE WHEN s.primeira_resposta_agente_em IS NULL THEN 'primeiro' WHEN v.vez_do_agente THEN 'segundo' ELSE 'outros' END AS fila,
                v.meta_min,
                CASE WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END AS espera_min
           FROM email_ia.suporte_escalado s
           LEFT JOIN email_ia.v_sla_suporte_escalado v ON v.caso_id = s.id
           LEFT JOIN email_ia.emails e ON e.id = s.email_id
           LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
          WHERE ${escopo} AND s.status IN ${ABERTOS}
          ORDER BY (CASE WHEN v.meta_min IS NULL THEN 1 ELSE 0 END),
                   (v.meta_min - coalesce(CASE WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END, 0)) ASC,
                   s.criado_em ASC
          LIMIT ${LIMITE + 1}`,
        valores,
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
}
