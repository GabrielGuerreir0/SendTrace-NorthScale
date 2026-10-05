/**
 * Respostas dos agentes (lidas da pasta Enviados de support@; migração 069).
 *
 *   GET /api/respostas-agente?email=…   → as respostas humanas enviadas a esse cliente, em ordem cronológica
 *
 * `agente` = dono do board do caso na hora da resposta (a caixa é única, não dá para saber de quem foi o clique no webmail).
 * Alimenta a "conversa completa" da ficha do caso (balões do agente ao lado dos do cliente e da IA). O corpo já vem sem a parte citada.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

export default async function rotasRespostasAgente(app) {
  app.get('/api/respostas-agente', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Respostas humanas (agentes) enviadas a um cliente, em ordem cronológica',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', required: ['email'],
        properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
      },
    },
  }, async (req) => {
    const email = String(req.query.email).trim().toLowerCase();
    if (!email.includes('@')) throw new ErroHttp(400, 'E-mail inválido.');
    const { rows } = await query(
      `SELECT r.id, r.enviado_em, r.assunto, r.corpo_texto, b.nome AS agente
         FROM email_ia.respostas_agente r
         LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = r.board_id
        WHERE lower(r.para_email) = $1
        ORDER BY r.enviado_em ASC LIMIT 200`,
      [email],
    );
    return { respostas: rows };
  });
}
