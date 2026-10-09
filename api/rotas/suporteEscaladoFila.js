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
import { memo } from '../cacheCurto.js';
import { lerPeriodo, descreverPeriodo } from '../periodo.js';

const ABERTOS = "('pendente', 'iniciado', 'lead_respondeu', 'esperando_resposta', 'em_analise', 'pendente_consulta')";
const ENCERRADO_NA_FICHA = "coalesce(fi.status_ticket, '') NOT IN ('Resolvido', 'Fechado')";   // ticket resolvido/fechado na ficha sai da fila
const LIMITE = 1000;

// Filtros por lista suspensa (item 1 do 3º momento): rodam no servidor, sobre TODOS os tickets do board (inclusive Resolvido/Fechado e já finalizados).
const FILTROS_SQL = {
  tag_motivo: { col: 's.tag_motivo' }, motivo_contato: { col: 'fi.motivo_contato' }, detalhamento_motivo: { col: 'fi.detalhamento_motivo' },
  tipo_resolucao: { col: 'fi.tipo_resolucao' }, status_ticket: { col: "coalesce(fi.status_ticket, 'Aberto')" }, motivo_reenvio: { col: 'fi.motivo_reenvio' },
  status_logistica: { col: 'fi.status_logistica' }, status_ajuda: { col: 'fi.status_ajuda' },
  responsavel_logistica_id: { col: 'fi.responsavel_board_id', num: true }, quantidade_reenvio: { col: 'fi.quantidade_reenvio', num: true },
  percentual_reembolso: { col: 'fi.percentual_reembolso', num: true },
  ajuda_para_id: { sql: (ph) => `EXISTS (SELECT 1 FROM email_ia.suporte_escalado_ajuda a WHERE a.suporte_escalado_id = s.id AND a.para_board_id = ${ph})`, num: true },
};
const ABERTO_SQL = `(s.status IN ${ABERTOS} AND ${ENCERRADO_NA_FICHA})`;

export default async function rotasSuporteEscaladoFila(app) {
  app.get('/api/suporte-escalado/fila', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Fila do agente em lista: o que está pendente de resposta (1ª, 2ª em diante) e todos os atribuídos, com o SLA dentro do turno',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', required: ['board_id'],
        properties: {
          board_id: { type: 'string' }, q: { type: 'string', maxLength: 120 }, dias: { type: 'integer', enum: [0, 7, 30, 90] }, de: { type: 'string' }, ate: { type: 'string' },
          ...Object.fromEntries(Object.keys(FILTROS_SQL).map((k) => [k, { type: 'string', maxLength: 80 }])),
        },
      },
    },
  }, async (req) => {
    const periodo = lerPeriodo(req.query);   // período do SLA médio do resumo (padrão: 7 dias)
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

    // Busca (itens 2 e 11 do 3º momento): e-mail, nome, assunto, nº do ticket (id do caso) ou nº do pedido — em TODOS os tickets do banco
    // (qualquer agente, qualquer fila, abertos ou encerrados), não só nos do agente que busca.
    const q = (req.query.q ?? '').trim();
    const valoresCasos = q ? [] : [...valores];          // com busca o escopo é o banco inteiro: o $1 do board não entra
    const condicoes = [];
    if (q) {
      valoresCasos.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      const ph = `$${valoresCasos.length}`;
      const porId = /^#?\d{1,12}$/.test(q) ? ` OR s.id = ${Number(q.replace('#', ''))}` : '';
      condicoes.push(`(s.remetente_email ILIKE ${ph} OR s.nome ILIKE ${ph} OR e.assunto ILIKE ${ph}${porId}
        OR EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE lower(d.email) = lower(s.remetente_email) AND d.transacao_id ILIKE ${ph}))`);
    } else if (!todos) {
      condicoes.push('s.board_id = $1');
    }
    let filtrando = false;
    for (const [chave, def] of Object.entries(FILTROS_SQL)) {
      const v = req.query[chave];
      if (v === undefined || v === '') continue;
      if (def.num && !/^\d{1,9}(\.\d+)?$/.test(v)) throw new ErroHttp(400, `Filtro inválido: ${chave}.`);
      valoresCasos.push(def.num ? Number(v) : v);
      const ph = `$${valoresCasos.length}`;
      condicoes.push(def.sql ? def.sql(ph) : `${def.col} = ${ph}`);
      filtrando = true;
    }
    // Sem busca nem filtro: só o que está em aberto (as filas de resposta). Com busca ou filtro: todos, inclusive resolvidos/fechados.
    const consulta = Boolean(q) || filtrando;
    if (!consulta) condicoes.push(ABERTO_SQL);
    const filtroCasos = condicoes.length ? condicoes.join(' AND ') : 'TRUE';

    // Cache de 10 s (a lista) e de 60 s (a média do SLA, que quase não muda): vários agentes e a recarga automática dividem a mesma consulta.
    const chave = `fila:${todos ? 'todos' : boardId}`;
    const chaveCasos = `${chave}:${q}:${JSON.stringify(Object.keys(FILTROS_SQL).map((k) => req.query[k] ?? ''))}`;
    const [casosRes, resumoRes, hojeRes, slaRes, falhasRes, rankingRes, slaEquipeRes] = await Promise.all([
      memo(`${chaveCasos}:casos`, 10_000, () => query(
        `SELECT s.id, s.remetente_email, s.nome, e.assunto, s.status, s.tag_motivo, s.prioridade_nivel, s.prioridade, s.board_id,
                b.nome AS agente, s.email_id, s.iniciado_em, s.finalizado_em, s.alerta_ameaca, s.criado_em, s.ultimo_email_cliente_em, s.primeira_resposta_agente_em, s.ultima_resposta_agente_em,
                fi.motivo_contato, fi.detalhamento_motivo, fi.tipo_resolucao, fi.status_ticket, fi.motivo_reenvio, fi.status_logistica,
                fi.responsavel_board_id AS responsavel_logistica_id, fi.status_ajuda, fi.quantidade_reenvio, fi.percentual_reembolso,
                fi.chargeback_em, fi.ticket_reaberto_em,
                (SELECT a.para_board_id FROM email_ia.suporte_escalado_ajuda a WHERE a.suporte_escalado_id = s.id ORDER BY a.criado_em DESC LIMIT 1) AS ajuda_para_id,
                CASE WHEN NOT ${ABERTO_SQL} THEN 'outros' WHEN s.primeira_resposta_agente_em IS NULL THEN 'primeiro' WHEN v.vez_do_agente THEN 'segundo' ELSE 'outros' END AS fila,
                ${ABERTO_SQL} AS em_aberto,
                v.meta_min, v.pausado,
                CASE WHEN NOT ${ABERTO_SQL} THEN NULL WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END AS espera_min
           FROM email_ia.suporte_escalado s
           LEFT JOIN email_ia.v_sla_suporte_escalado v ON v.caso_id = s.id
           LEFT JOIN email_ia.emails e ON e.id = s.email_id
           LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
           LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
          WHERE ${filtroCasos}
          ORDER BY ${ABERTO_SQL} DESC,
                   (CASE WHEN v.meta_min IS NULL THEN 1 ELSE 0 END),
                   (v.meta_min - coalesce(CASE WHEN s.primeira_resposta_agente_em IS NULL THEN v.primeira_resposta_min WHEN v.vez_do_agente THEN v.vez_agente_min END, 0)) ASC,
                   s.criado_em ASC
          LIMIT ${LIMITE + 1}`,
        valoresCasos,
      )),
      // Contagens dos cartões: sempre do board inteiro em aberto, não mudam com busca/filtro.
      memo(`${chave}:resumo`, 10_000, () => query(
        `SELECT count(*) FILTER (WHERE s.primeira_resposta_agente_em IS NULL)::int AS primeira,
                count(*) FILTER (WHERE s.primeira_resposta_agente_em IS NOT NULL AND v.vez_do_agente)::int AS segunda
           FROM email_ia.suporte_escalado s
           LEFT JOIN email_ia.v_sla_suporte_escalado v ON v.caso_id = s.id
           LEFT JOIN email_ia.suporte_escalado_ficha fi ON fi.suporte_escalado_id = s.id
          WHERE ${escopo} AND ${ABERTO_SQL}`,
        valores,
      )),
      // "Respondidos" = E-MAILS enviados no período (1ª e 2ª resposta em diante); `tickets` = quantos tickets distintos (item 3 do 3º momento).
      memo(`${chave}:hoje:${periodo.chave}`, 10_000, () => query(
        `SELECT count(*)::int AS emails, count(DISTINCT r.caso_id)::int AS tickets
           FROM email_ia.respostas_agente r
          WHERE ${escopoResp} AND r.caso_id IS NOT NULL AND r.enviado_em >= ${periodo.ini} AND r.enviado_em < ${periodo.fim}`,
        valores,
      )),
      memo(`${chave}:sla:${periodo.chave}`, 60_000, () => query(
        `SELECT r.primeira, count(r.minutos)::int AS medidas, avg(r.minutos) AS media_min,
                count(*) FILTER (WHERE r.dentro_da_meta)::int AS dentro
           FROM email_ia.v_sla_respostas_agente r
          WHERE ${escopoResp} AND r.enviado_em >= ${periodo.ini} AND r.enviado_em < ${periodo.fim}
          GROUP BY r.primeira`,
        valores,
      )),
      // Respostas que não saíram (3 tentativas) nas últimas 48 h: a tela avisa o agente.
      memo(`${chave}:falhas`, 10_000, () => query(
        `SELECT count(*)::int AS n FROM email_ia.respostas_fila r WHERE ${escopoResp} AND r.status = 'falhou' AND r.criado_em > now() - interval '48 hours'`,
        valores,
      )),
      // Ranking anônimo do time (item 5): e-mails respondidos por agente no período, sem nomes, ATIVO OU NÃO (pedido da Késsia, 09/10). Só para quem vê o próprio board.
      todos ? { rows: [] } : memo(`ranking:${periodo.chave}`, 30_000, () => query(
        `SELECT b.id AS board_id, count(r.id)::int AS respostas
           FROM email_ia.suporte_escalado_boards b
           LEFT JOIN email_ia.respostas_agente r ON r.board_id = b.id AND r.caso_id IS NOT NULL AND r.enviado_em >= ${periodo.ini} AND r.enviado_em < ${periodo.fim}
          WHERE b.usuario_id IS NOT NULL
          GROUP BY b.id, b.ativo
         HAVING b.ativo OR count(r.id) > 0`,   // entra quem respondeu no período, esteja ativo ou não; inativo sem resposta não conta como concorrente
      )),
      // SLA médio de cada agente (para dizer se o agente está acima ou abaixo da média do time), também sem nomes.
      todos ? { rows: [] } : memo(`slaequipe:${periodo.chave}`, 60_000, () => query(
        `SELECT r.board_id, r.primeira, avg(r.minutos) AS media_min, count(r.minutos)::int AS medidas
           FROM email_ia.v_sla_respostas_agente r
          WHERE r.enviado_em >= ${periodo.ini} AND r.enviado_em < ${periodo.fim}
          GROUP BY r.board_id, r.primeira`,
      )),
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
    // Ranking anônimo (item 5): posição do agente entre os ativos pelo nº de e-mails respondidos no período, e SLA dele × média do time.
    let ranking = null;
    if (!todos) {
      const linhas = [...rankingRes.rows].sort((a, b) => b.respostas - a.respostas);
      const pos = linhas.findIndex((l) => String(l.board_id) === String(boardId));
      const media = (primeira) => {
        const ls = slaEquipeRes.rows.filter((x) => x.primeira === primeira && x.medidas > 0);
        const medidas = ls.reduce((t, x) => t + x.medidas, 0);
        return medidas ? Math.round(ls.reduce((t, x) => t + Number(x.media_min) * x.medidas, 0) / medidas) : null;
      };
      ranking = {
        posicao: pos >= 0 ? pos + 1 : null,
        total_agentes: linhas.length,
        barras: linhas.map((l, i) => ({ posicao: i + 1, respostas: l.respostas, voce: String(l.board_id) === String(boardId) })),
        sla_equipe_primeira_min: media(true),
        sla_equipe_segunda_min: media(false),
      };
    }
    return {
      truncado,
      consulta,
      resumo: {
        pendentes_primeira: resumoRes.rows[0]?.primeira ?? 0,
        pendentes_segunda: resumoRes.rows[0]?.segunda ?? 0,
        respondidos_hoje: hojeRes.rows[0]?.emails ?? 0,          // e-mails respondidos no período (nome antigo, mantido)
        respondidos_tickets: hojeRes.rows[0]?.tickets ?? 0,
        envios_falhos: falhasRes.rows[0]?.n ?? 0,
        sla_primeira: sla(true),
        sla_segunda: sla(false),
        ranking,
        janela_dias: periodo.dias ?? null,
        periodo: descreverPeriodo(periodo),
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
