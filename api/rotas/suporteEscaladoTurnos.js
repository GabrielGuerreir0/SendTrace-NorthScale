/**
 * Suporte Escalado — turnos e disponibilidade dos agentes (pedido da Késsia, PDF de 05/10/2026; migração 067).
 *
 *   GET    /api/suporte-escalado/turnos                → turnos (com quem está em cada um) + agentes (com "disponível")
 *   POST   /api/suporte-escalado/turnos                → cria um turno (só admin ou gestor)
 *   PUT    /api/suporte-escalado/turnos/:id            → renomeia / muda horário (só admin ou gestor)
 *   DELETE /api/suporte-escalado/turnos/:id            → apaga um turno (só admin ou gestor)
 *   PUT    /api/suporte-escalado/turnos/:id/agentes    → define quem trabalha no turno (só admin; substitui a lista)
 *
 * "Disponível para receber tickets" é o `ativo` do board (PATCH /api/suporte-escalado/boards/:id, só admin, já existente).
 * Os turnos NÃO mudam o sorteio de board: só vão definir quando o SLA conta. Horário de Brasília, segunda a sexta.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const HORA = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

export default async function rotasSuporteEscaladoTurnos(app) {
  // Administrador ou gestor do Suporte Escalado (papel 072).
  const soAdmin = (req) => { if (!req.usuario.admin && !req.usuario.gestorEscalado) throw new ErroHttp(403, 'Só administradores e gestores alteram turnos.'); };
  const idTurno = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };

  const dadosTurnos = async () => {
    const [t, a, m] = await Promise.all([
      query(`SELECT id, nome, to_char(inicio, 'HH24:MI') AS inicio, to_char(fim, 'HH24:MI') AS fim, dias_semana
               FROM email_ia.suporte_escalado_turnos ORDER BY inicio, id`),
      query(`SELECT id AS board_id, nome, ativo AS disponivel FROM email_ia.suporte_escalado_boards
              WHERE usuario_id IS NOT NULL ORDER BY nome`),
      query('SELECT turno_id, board_id FROM email_ia.suporte_escalado_turno_agentes'),
    ]);
    return {
      fuso: 'America/Sao_Paulo',
      turnos: t.rows.map((x) => ({ ...x, board_ids: m.rows.filter((r) => r.turno_id === x.id).map((r) => r.board_id) })),
      agentes: a.rows,
    };
  };

  app.get('/api/suporte-escalado/turnos', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Central de E-mail IA'], summary: 'Turnos e agentes (com disponibilidade)', security: [{ bearerAuth: [] }] },
  }, async () => dadosTurnos());

  app.post('/api/suporte-escalado/turnos', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'], summary: 'Cria um turno (só admin ou gestor)', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['nome', 'inicio', 'fim'], additionalProperties: false,
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 60 },
          inicio: { type: 'string', pattern: HORA }, fim: { type: 'string', pattern: HORA },
        },
      },
    },
  }, async (req) => {
    soAdmin(req);
    if (req.body.fim <= req.body.inicio) throw new ErroHttp(400, 'O fim do turno precisa ser depois do início.');
    await query('INSERT INTO email_ia.suporte_escalado_turnos (nome, inicio, fim) VALUES ($1, $2::time, $3::time)',
      [req.body.nome.trim(), req.body.inicio, req.body.fim]);
    return dadosTurnos();
  });

  app.put('/api/suporte-escalado/turnos/:id', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'], summary: 'Muda nome/horário de um turno (só admin ou gestor)', security: [{ bearerAuth: [] }], params: idTurno,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 60 },
          inicio: { type: 'string', pattern: HORA }, fim: { type: 'string', pattern: HORA },
        },
      },
    },
  }, async (req) => {
    soAdmin(req);
    const { rows } = await query(
      `SELECT nome, to_char(inicio, 'HH24:MI') AS inicio, to_char(fim, 'HH24:MI') AS fim FROM email_ia.suporte_escalado_turnos WHERE id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Turno não encontrado.');
    const novo = { ...rows[0], ...req.body };
    if (novo.fim <= novo.inicio) throw new ErroHttp(400, 'O fim do turno precisa ser depois do início.');
    await query('UPDATE email_ia.suporte_escalado_turnos SET nome = $2, inicio = $3::time, fim = $4::time WHERE id = $1',
      [req.params.id, String(novo.nome).trim(), novo.inicio, novo.fim]);
    return dadosTurnos();
  });

  app.delete('/api/suporte-escalado/turnos/:id', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Central de E-mail IA'], summary: 'Apaga um turno (só admin ou gestor)', security: [{ bearerAuth: [] }], params: idTurno },
  }, async (req) => {
    soAdmin(req);
    const { rowCount } = await query('DELETE FROM email_ia.suporte_escalado_turnos WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new ErroHttp(404, 'Turno não encontrado.');
    return dadosTurnos();
  });

  app.put('/api/suporte-escalado/turnos/:id/agentes', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'], summary: 'Define quem trabalha neste turno (substitui a lista; só admin)', security: [{ bearerAuth: [] }],
      params: idTurno,
      body: {
        type: 'object', required: ['board_ids'], additionalProperties: false,
        properties: { board_ids: { type: 'array', items: { type: 'integer' }, maxItems: 100 } },
      },
    },
  }, async (req) => {
    soAdmin(req);
    const { rows } = await query('SELECT 1 FROM email_ia.suporte_escalado_turnos WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new ErroHttp(404, 'Turno não encontrado.');
    // Uma instrução só (atômica): tira quem saiu e põe quem entrou — só boards que têm uma pessoa vinculada.
    await query(
      `WITH tirar AS (
         DELETE FROM email_ia.suporte_escalado_turno_agentes WHERE turno_id = $1 AND NOT (board_id = ANY($2::bigint[]))
       )
       INSERT INTO email_ia.suporte_escalado_turno_agentes (turno_id, board_id)
       SELECT $1, b.id FROM email_ia.suporte_escalado_boards b WHERE b.id = ANY($2::bigint[]) AND b.usuario_id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.body.board_ids],
    );
    return dadosTurnos();
  });
}
