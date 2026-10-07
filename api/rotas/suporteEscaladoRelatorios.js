/**
 * Suporte Humano — relatório dos tickets e dashboards de Propriedades (PDF da Késsia de 07/10/2026, itens 21, 22 e 23).
 *
 *   GET /api/suporte-escalado/relatorio?board_id=<id|todos>&de=AAAA-MM-DD&ate=AAAA-MM-DD
 *     → { linhas[] } com TODAS as informações da tela do ticket (resumo, pedido, propriedades, logística, ajuda e SLA), exceto
 *       e-mails trocados e notas. O período é o da chegada do ticket (dia inteiro, horário de Brasília). Até 20.000 tickets.
 *   GET /api/suporte-escalado/dashboard-propriedades?dias=<0|7|30|90>   (só admin ou gestor, todos os boards)
 *     → { total, por_tag[], status[], propriedades{ motivo_contato, detalhamento_motivo, tipo_resolucao, status_ticket } } com quantidade
 *       e percentual. Tickets mesclados (filhos) não contam; ticket sem status na ficha conta como "Aberto".
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const HOJE = "(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";
const LIMITE = 20000;
const STATUS_TICKET = ['Aberto', 'Pendente', 'Resolvido', 'Fechado'];

export default async function rotasSuporteEscaladoRelatorios(app) {
  app.get('/api/suporte-escalado/relatorio', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Relatório dos tickets do Suporte Humano (todas as informações da tela do ticket, exceto e-mails e notas) em um período',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', required: ['board_id', 'de', 'ate'],
        properties: {
          board_id: { type: 'string' },
          de: { type: 'string', format: 'date' },
          ate: { type: 'string', format: 'date' },
        },
      },
    },
  }, async (req) => {
    const { de, ate } = req.query;
    if (de > ate) throw new ErroHttp(400, 'A data inicial é depois da final.');
    const gestor = !!req.usuario.admin || !!req.usuario.gestorHumano;
    const todos = req.query.board_id === 'todos';
    const valores = [de, ate];
    let escopo = 'TRUE';
    if (todos) {
      if (!gestor) throw new ErroHttp(403, 'Só administradores e gestores baixam o relatório de todos os boards.');
    } else {
      const boardId = Number(req.query.board_id);
      if (!Number.isInteger(boardId)) throw new ErroHttp(400, 'board_id inválido.');
      const { rows } = await query('SELECT id, usuario_id FROM email_ia.suporte_escalado_boards WHERE id = $1', [boardId]);
      if (!rows[0]) throw new ErroHttp(404, 'Board não encontrado.');
      if (!gestor && rows[0].usuario_id !== req.usuario.user_id) throw new ErroHttp(403, 'Este board não é seu.');
      valores.push(boardId);
      escopo = 's.board_id = $3';
    }
    const { rows } = await query(
      `SELECT s.id AS numero, s.remetente_email, s.nome, e.assunto, s.status AS status_kanban, s.criado_em, s.iniciado_em, s.finalizado_em,
              s.data_entrega, s.resumo_conversa, s.motivo_escalonamento,
              s.tag_motivo, s.prioridade_nivel, s.alerta_ameaca, s.ticket_mae_id, b.nome AS agente,
              mv.movido_por, mv.mudou_em AS movido_em, mv.status_anterior AS movido_de,
              ped.produto, ped.plataforma, ped.status_pedido, ped.pedido_em, ped.valor AS valor_pedido, ped.rastreio_status, ped.carrier_code,
              ped.tracking_number, t.primeiro_email_em,
              fi.motivo_contato, fi.detalhamento_motivo, fi.tipo_resolucao, fi.percentual_reembolso, fi.valor_compra_usd, fi.deducao_frascos_usd,
              fi.valor_a_reembolsar_usd, coalesce(fi.status_ticket, 'Aberto') AS status_ticket, fi.chargeback_em, fi.ticket_reaberto_em,
              fi.propriedades_atualizado_por, fi.propriedades_atualizado_em,
              fi.status_logistica, fi.motivo_reenvio, fi.quantidade_reenvio, fi.produto_reenvio, fi.observacao_reenvio, fi.endereco_divergencia,
              fi.novo_rastreio, rb.nome AS responsavel_logistica, fi.logistica_atualizado_por, fi.logistica_atualizado_em,
              fi.status_ajuda, fi.ajuda_atualizado_por, fi.ajuda_atualizado_em,
              (SELECT count(*) FROM email_ia.suporte_escalado_ajuda a WHERE a.suporte_escalado_id = s.id)::int AS pedidos_ajuda,
              s.primeira_resposta_agente_em, s.ultima_resposta_agente_em, v.meta_min, v.primeira_resposta_min, v.primeira_resposta_sla, v.pausado
         FROM email_ia.suporte_escalado s
         LEFT JOIN email_ia.emails e ON e.id = s.email_id
         LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
         LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
         LEFT JOIN email_ia.suporte_escalado_boards rb ON rb.id = fi.responsavel_board_id
         LEFT JOIN email_ia.v_sla_suporte_escalado v ON v.caso_id = s.id
         LEFT JOIN email_ia.tickets t ON lower(t.remetente_email) = lower(s.remetente_email)
         LEFT JOIN LATERAL (
           SELECT h.movido_por, h.mudou_em, h.status_anterior FROM email_ia.suporte_escalado_historico h
            WHERE h.suporte_escalado_id = s.id ORDER BY h.mudou_em DESC, h.id DESC LIMIT 1
         ) mv ON true
         LEFT JOIN LATERAL (
           SELECT d.produto, d.plataforma, d.status AS status_pedido, d.criado_em AS pedido_em,
                  coalesce((SELECT abs(ev.valor) FROM eventos_plataforma ev
                             WHERE ev.transacao_id = d.transacao_id AND btrim(ev.plataforma) = d.plataforma
                               AND ev.evento IN ('SALE', 'payment', 'neworder') AND ev.valor IS NOT NULL
                             ORDER BY ev.recebido_em ASC LIMIT 1), r.total) AS valor,
                  r.status_interno AS rastreio_status, r.carrier_code, r.tracking_number
             FROM disparos_pos_venda d LEFT JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
            WHERE lower(d.email) = lower(s.remetente_email) ORDER BY d.criado_em DESC LIMIT 1
         ) ped ON true
        WHERE ${escopo}
          AND s.criado_em >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND s.criado_em <  (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        ORDER BY s.criado_em DESC
        LIMIT ${LIMITE + 1}`,
      valores,
    );
    return { truncado: rows.length > LIMITE, linhas: rows.slice(0, LIMITE) };
  });

  app.get('/api/suporte-escalado/dashboard-propriedades', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Dashboards do painel da equipe: tickets por tag de motivo × status e por campos de Propriedades (quantidade e %)',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { dias: { type: 'integer', enum: [0, 7, 30, 90], default: 30 } } },
    },
  }, async (req) => {
    if (!req.usuario.admin && !req.usuario.gestorHumano) throw new ErroHttp(403, 'Só administradores e gestores veem o painel da equipe.');
    const dias = req.query.dias ?? 30;
    const desde = dias === 0 ? HOJE : `(now() - interval '${dias} days')`;
    const { rows } = await query(
      `SELECT s.tag_motivo, coalesce(fi.status_ticket, 'Aberto') AS status_ticket, fi.motivo_contato, fi.detalhamento_motivo, fi.tipo_resolucao,
              count(*)::int AS n
         FROM email_ia.suporte_escalado s
         LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
        WHERE s.ticket_mae_id IS NULL AND s.criado_em >= ${desde}
        GROUP BY 1, 2, 3, 4, 5`,
    );
    const total = rows.reduce((a, r) => a + r.n, 0);
    const soma = (chave, rotuloVazio) => {
      const m = new Map();
      for (const r of rows) {
        const k = r[chave] ?? rotuloVazio;
        m.set(k, (m.get(k) ?? 0) + r.n);
      }
      return [...m.entries()].map(([valor, n]) => ({ valor, n, pct: total ? Math.round((n / total) * 1000) / 10 : 0 })).sort((a, b) => b.n - a.n);
    };
    // tag × status do ticket
    const matriz = new Map();
    for (const r of rows) {
      const tag = r.tag_motivo ?? 'sem_tag';
      const l = matriz.get(tag) ?? { tag, total: 0, status: Object.fromEntries(STATUS_TICKET.map((s) => [s, 0])) };
      l.total += r.n;
      l.status[r.status_ticket] = (l.status[r.status_ticket] ?? 0) + r.n;
      matriz.set(tag, l);
    }
    return {
      dias, total,
      por_tag: [...matriz.values()].sort((a, b) => b.total - a.total).map((l) => ({ ...l, pct: total ? Math.round((l.total / total) * 1000) / 10 : 0 })),
      status_ordem: STATUS_TICKET,
      propriedades: {
        motivo_contato: soma('motivo_contato', 'Não preenchido'),
        detalhamento_motivo: soma('detalhamento_motivo', 'Não preenchido'),
        tipo_resolucao: soma('tipo_resolucao', 'Não preenchido'),
        status_ticket: soma('status_ticket', 'Aberto'),
      },
    };
  });
}
