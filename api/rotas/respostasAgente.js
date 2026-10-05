/**
 * Respostas dos agentes (lidas da pasta Enviados de support@; migração 069).
 *
 *   GET /api/respostas-agente?email=…   → as respostas humanas enviadas a esse cliente, em ordem cronológica
 *
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
      `SELECT id, enviado_em, assunto, corpo_texto
         FROM email_ia.respostas_agente
        WHERE lower(para_email) = $1
        ORDER BY enviado_em ASC LIMIT 200`,
      [email],
    );
    return { respostas: rows };
  });
}
