/**
 * Respostas dos agentes (lidas da pasta Enviados de support@; migração 069).
 *
 *   GET /api/respostas-agente?email=…   → as respostas humanas enviadas a esse cliente, em ordem cronológica + a boas-vindas automática (hora e texto padrão)
 *
 * `agente` = dono do board do caso na hora da resposta (a caixa é única, não dá para saber de quem foi o clique no webmail).
 * Alimenta a "conversa completa" da ficha do caso (balões do agente ao lado dos do cliente e da IA). O corpo já vem sem a parte citada.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { ASSUNTO_BOAS_VINDAS, textoBoasVindas } from '../boasVindas.js';

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
    // Boas-vindas automática: só a hora vem do banco; o texto é o padrão (ver api/boasVindas.js).
    const { rows: tk } = await query(
      'SELECT boas_vindas_enviada_em AS enviada_em, nome FROM email_ia.tickets WHERE lower(remetente_email) = $1 AND boas_vindas_enviada_em IS NOT NULL LIMIT 1', [email]);
    const boasVindas = tk[0] ? { enviada_em: tk[0].enviada_em, assunto: ASSUNTO_BOAS_VINDAS, texto: textoBoasVindas(tk[0].nome, tk[0].enviada_em) } : null;
    // E-mails automáticos do sistema (079, ex.: regra dos 30 dias): o texto EXATO enviado + hora. Antes da migração 079 a tabela não existe: lista vazia.
    let mensagensSistema = [];
    try {
      ({ rows: mensagensSistema } = await query(
        `SELECT id, tipo, assunto, corpo_texto AS texto, enviado_em FROM email_ia.mensagens_sistema WHERE email = $1 ORDER BY enviado_em ASC LIMIT 20`, [email]));
    } catch (err) { if (err.code !== '42P01') throw err; }
    return { respostas: rows, boas_vindas: boasVindas, mensagens_sistema: mensagensSistema };
  });
}
