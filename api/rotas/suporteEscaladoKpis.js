/**
 * Suporte Escalado — painel de KPIs da equipe (pedido da Késsia, PDF de 05/10/2026, item 7; usa o SLA das migrações 073–075).
 *
 *   GET /api/suporte-escalado/kpis-equipe?dias=<0|7|30>   (só admin ou gestor)
 *
 * `dias` vale só para os SLAs (itens 1–4): 0 = hoje (horário de Brasília), 7 ou 30 = últimos N dias. Os contadores "no dia" (itens 5, 7, 8)
 * são sempre de hoje e os de fila (itens 6, 9, 10) são o retrato de agora. Tempos em MINUTOS DE TURNO (seg–sex, horário de Brasília).
 *   · Tickets "respondidos pelos clientes" no dia = tickets com e-mail do cliente recebido hoje DEPOIS da criação do ticket.
 *   · "Respondidos pelos agentes" = tickets com resposta enviada por support@ hoje.
 *   · Fila sem atendimento = ticket aberto sem nenhuma resposta do agente; aguardando 2ª em diante = o cliente escreveu depois da última resposta.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { memo } from '../cacheCurto.js';
import { lerPeriodo, descreverPeriodo } from '../periodo.js';

const ABERTOS = "('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')";
const ENCERRADO_NA_FICHA = "coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')";
const HOJE = "(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";

export default async function rotasSuporteEscaladoKpis(app) {
  app.get('/api/suporte-escalado/kpis-equipe', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Painel da equipe do Suporte Escalado: SLA por agente e geral, tickets do dia e filas por agente (só admin ou gestor)',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { dias: { type: 'integer', enum: [0, 7, 30, 90] }, de: { type: 'string' }, ate: { type: 'string' } } },
    },
  }, async (req) => {
    if (!req.usuario.admin && !req.usuario.gestorHumano) throw new ErroHttp(403, 'Só administradores e gestores veem o painel da equipe.');
    const periodo = lerPeriodo(req.query);   // hoje, últimos N dias ou datas personalizadas (só vale para os SLAs)

    // Cache de 30 s por período: o painel recarrega sozinho e os gestores abrem a mesma tela (a conta de SLA por agente é a parte pesada).
    return memo(`kpis:${periodo.chave}`, 30_000, async () => {
    const [agentesRes, filasRes, hojeRes, slaRes, equipeHojeRes] = await Promise.all([
      query(`SELECT id AS board_id, nome, ativo AS disponivel FROM email_ia.suporte_escalado_boards WHERE usuario_id IS NOT NULL ORDER BY nome`),
      query(
        `SELECT s.board_id,
                count(*)::int AS atribuidos,
                count(*) FILTER (WHERE s.primeira_resposta_agente_em IS NULL)::int AS sem_atendimento,
                count(*) FILTER (WHERE s.primeira_resposta_agente_em IS NOT NULL
                                   AND s.ultimo_email_cliente_em > coalesce(s.ultima_resposta_agente_em, '-infinity'::timestamptz))::int AS aguardando_segunda
           FROM email_ia.suporte_escalado s
           LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
          WHERE s.status IN ${ABERTOS} AND ${ENCERRADO_NA_FICHA}
          GROUP BY s.board_id`,
      ),
      query(
        `SELECT r.board_id, count(DISTINCT r.caso_id)::int AS respondidos_hoje
           FROM email_ia.respostas_agente r
          WHERE r.caso_id IS NOT NULL AND r.enviado_em >= ${HOJE}
          GROUP BY r.board_id`,
      ),
      query(
        `SELECT r.board_id, r.primeira, count(r.minutos)::int AS medidas, avg(r.minutos) AS media_min,
                count(*) FILTER (WHERE r.dentro_da_meta)::int AS dentro
           FROM email_ia.v_sla_respostas_agente r
          WHERE r.enviado_em >= ${periodo.ini} AND r.enviado_em < ${periodo.fim}
          GROUP BY r.board_id, r.primeira`,
      ),
      query(
        `SELECT (SELECT count(*)::int FROM email_ia.suporte_escalado WHERE criado_em >= ${HOJE}) AS novos_hoje,
                (SELECT count(DISTINCT s.id)::int
                   FROM email_ia.suporte_escalado s
                   JOIN email_ia.emails e ON lower(e.remetente_email) = lower(s.remetente_email)
                  WHERE e.data_email >= ${HOJE} AND e.data_email > s.criado_em) AS clientes_responderam_hoje,
                (SELECT count(DISTINCT caso_id)::int FROM email_ia.respostas_agente WHERE caso_id IS NOT NULL AND enviado_em >= ${HOJE}) AS agentes_responderam_hoje`,
      ),
    ]);

    const arred = (v) => (v == null ? null : Math.round(Number(v)));
    const sla = (linhas) => {
      const medidas = linhas.reduce((a, l) => a + l.medidas, 0);
      const soma = linhas.reduce((a, l) => a + Number(l.media_min ?? 0) * l.medidas, 0);
      return { media_min: medidas ? arred(soma / medidas) : null, medidas, dentro: linhas.reduce((a, l) => a + l.dentro, 0) };
    };
    const doBoard = (id, primeira) => slaRes.rows.filter((l) => l.board_id === id && l.primeira === primeira);

    const agentes = agentesRes.rows.map((a) => {
      const f = filasRes.rows.find((x) => x.board_id === a.board_id) ?? {};
      return {
        ...a,
        atribuidos: f.atribuidos ?? 0,
        sem_atendimento: f.sem_atendimento ?? 0,
        aguardando_segunda: f.aguardando_segunda ?? 0,
        respondidos_hoje: hojeRes.rows.find((x) => x.board_id === a.board_id)?.respondidos_hoje ?? 0,
        sla_primeira: sla(doBoard(a.board_id, true)),
        sla_segunda: sla(doBoard(a.board_id, false)),
      };
    }).filter((a) => a.disponivel || a.atribuidos || a.respondidos_hoje || a.sla_primeira.medidas || a.sla_segunda.medidas);

    const eh = equipeHojeRes.rows[0];
    const soma = (campo) => filasRes.rows.reduce((t, x) => t + (x[campo] ?? 0), 0);
    return {
      dias: periodo.dias ?? null,
      periodo: descreverPeriodo(periodo),
      equipe: {
        novos_hoje: eh.novos_hoje,
        clientes_responderam_hoje: eh.clientes_responderam_hoje,
        agentes_responderam_hoje: eh.agentes_responderam_hoje,
        sem_atendimento: soma('sem_atendimento'),
        aguardando_segunda: soma('aguardando_segunda'),
        sla_primeira: sla(slaRes.rows.filter((l) => l.primeira === true)),
        sla_segunda: sla(slaRes.rows.filter((l) => l.primeira === false)),
      },
      agentes,
    };
    });
  });
}
