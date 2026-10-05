/**
 * Suporte Escalado — campos do agente (pedido da Késsia, PDF de 05/10/2026; migração 066).
 *
 *   GET  /api/suporte-escalado/opcoes                    → listas suspensas (Propriedades/Logística) + equipe (quem pode receber ajuda)
 *   GET  /api/suporte-escalado/:id/ficha                 → Propriedades + Logística + pedidos de ajuda do caso
 *   PUT  /api/suporte-escalado/:id/ficha                 → salva os campos enviados (dono do board ou admin)
 *   POST /api/suporte-escalado/:id/ajuda                 → o agente escala o caso a alguém da equipe, com uma nota (dono do board ou admin)
 *   POST /api/suporte-escalado/ajuda/:ajudaId/responder  → quem recebeu o pedido responde (a pessoa do board de destino ou admin)
 *   GET  /api/suporte-escalado/ajuda/para-mim            → pedidos de ajuda ainda sem resposta endereçados a mim (só a quem tem board; admin sem board não vê os dos outros)
 *
 * Quem recebe um pedido de ajuda enxerga SÓ aquele caso (leitura da ficha, contexto e notas) — não ganha acesso ao board do colega.
 * A tag automática do motivo (065) não tem relação com o "Motivo do contato" daqui, que o agente escolhe.
 */

import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

export const OPCOES = {
  motivo_contato: ['Reembolso', 'Chargeback', 'Logística', 'Dúvidas'],
  detalhamento_motivo: [
    'Verificando - Ag. Cliente', 'Insatisfação após uso do produto', 'Dúvida - Esclarecimento', 'Alergia - Doença - Médico',
    'Comprou muito - Upsell', 'Problemas Financeiros', 'Rótulo ou Ingredientes', 'Pessoa incapaz comprou',
    'Arrepen. pós compra - pedido não entregue', 'Arrepen. pós compra - pedido entregue', 'Logística - pedido não entregue',
    'Logística - pedido incompleto', 'Logística - pedido quebrado', 'Logística - divergência no produto', 'Cliente não retornou',
  ],
  tipo_resolucao: [
    'Verificando - Ag. Cliente', 'Reversão total do reembolso', 'Reembolso parcial', 'Não revertido',
    'Virou chargeback', 'Cliente não retornou',
  ],
  // Aparece ao lado quando o tipo de resolução é "Reembolso parcial" (15% a 90%, de 5 em 5).
  percentual_reembolso: Array.from({ length: 16 }, (_, i) => 15 + i * 5),
  status_ticket: ['Aberto', 'Pendente', 'Resolvido', 'Fechado'],
  motivo_reenvio: ['Itens quebrados', 'Pedido incompleto', 'Pedido não entregue', 'Cortesia'],
};

const CAMPOS_FICHA = [
  'motivo_contato', 'detalhamento_motivo', 'tipo_resolucao', 'percentual_reembolso', 'status_ticket',
  'motivo_reenvio', 'quantidade_reenvio', 'produto_reenvio', 'observacao_reenvio',
  'endereco_divergencia', 'novo_rastreio', 'responsavel_board_id',
];

const lista = (valores) => ({ type: ['string', 'null'], enum: [...valores, null] });
const texto = (max) => ({ type: ['string', 'null'], maxLength: max });

export default async function rotasSuporteEscaladoFicha(app) {
  const idCaso = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };

  /** Caso + dono do board atual (null se o caso ainda não tem board). */
  async function casoComBoard(id) {
    const { rows } = await query(
      `SELECT s.id, s.board_id, b.usuario_id AS dono_id
         FROM email_ia.suporte_escalado s
         LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
        WHERE s.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  const ehDono = (req, caso) => !!req.usuario.admin || (caso.dono_id != null && caso.dono_id === req.usuario.user_id);

  async function recebeuAjuda(req, casoId) {
    if (req.usuario.user_id == null) return false;
    const { rows } = await query(
      `SELECT 1 FROM email_ia.suporte_escalado_ajuda a
         JOIN email_ia.suporte_escalado_boards b ON b.id = a.para_board_id
        WHERE a.suporte_escalado_id = $1 AND b.usuario_id = $2 LIMIT 1`,
      [casoId, req.usuario.user_id],
    );
    return rows.length > 0;
  }

  async function exigirLeitura(req, id) {
    const caso = await casoComBoard(id);
    if (!caso) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!ehDono(req, caso) && !(await recebeuAjuda(req, id))) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    return caso;
  }

  async function exigirEscrita(req, id) {
    const caso = await casoComBoard(id);
    if (!caso) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!ehDono(req, caso)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    return caso;
  }

  const nomeDe = (req) => req.usuario.nome || req.usuario.email || null;

  /* ═══════════════════════  GET /api/suporte-escalado/opcoes  ═════════════════ */
  app.get('/api/suporte-escalado/opcoes', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Listas suspensas dos campos do agente e a equipe (quem pode receber um pedido de ajuda ou ser responsável)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { rows } = await query(
      `SELECT id, nome FROM email_ia.suporte_escalado_boards WHERE usuario_id IS NOT NULL ORDER BY nome`,
    );
    return { ...OPCOES, equipe: rows };
  });

  /* ═══════════════════════  GET /api/suporte-escalado/:id/ficha  ══════════════ */
  app.get('/api/suporte-escalado/:id/ficha', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Campos do agente (Propriedades e Logística) e pedidos de ajuda de um caso escalado',
      security: [{ bearerAuth: [] }],
      params: idCaso,
    },
  }, async (req) => {
    const caso = await exigirLeitura(req, req.params.id);
    const [fichaRes, ajudaRes] = await Promise.all([
      query(
        `SELECT ${CAMPOS_FICHA.join(', ')}, atualizado_por, atualizado_em
           FROM email_ia.suporte_escalado_ficha WHERE suporte_escalado_id = $1`,
        [req.params.id],
      ),
      query(
        `SELECT a.id, a.pedido_por, a.para_board_id, b.nome AS para_nome, b.usuario_id AS destino_id, a.nota, a.criado_em,
                a.resposta, a.respondido_por, a.respondido_em
           FROM email_ia.suporte_escalado_ajuda a
           JOIN email_ia.suporte_escalado_boards b ON b.id = a.para_board_id
          WHERE a.suporte_escalado_id = $1 ORDER BY a.criado_em`,
        [req.params.id],
      ),
    ]);
    const ficha = fichaRes.rows[0] ?? {};
    return {
      pode_editar: ehDono(req, caso),
      ficha: { ...Object.fromEntries(CAMPOS_FICHA.map((c) => [c, null])), status_ticket: 'Aberto', ...ficha },
      ajudas: ajudaRes.rows.map(({ destino_id: destinoId, ...a }) => ({
        ...a,
        pode_responder: !a.respondido_em && (!!req.usuario.admin || (destinoId != null && destinoId === req.usuario.user_id)),
      })),
    };
  });

  /* ═══════════════════════  PUT /api/suporte-escalado/:id/ficha  ══════════════ */
  app.put('/api/suporte-escalado/:id/ficha', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Salva os campos do agente enviados no corpo (os ausentes não mudam; null limpa)',
      description: 'Dono do board ou admin. Listas fechadas: ver GET /api/suporte-escalado/opcoes.',
      security: [{ bearerAuth: [] }],
      params: idCaso,
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          motivo_contato: lista(OPCOES.motivo_contato),
          detalhamento_motivo: lista(OPCOES.detalhamento_motivo),
          tipo_resolucao: lista(OPCOES.tipo_resolucao),
          percentual_reembolso: { type: ['integer', 'null'], enum: [...OPCOES.percentual_reembolso, null] },
          status_ticket: lista(OPCOES.status_ticket),
          motivo_reenvio: lista(OPCOES.motivo_reenvio),
          quantidade_reenvio: { type: ['integer', 'null'], minimum: 1, maximum: 30 },
          produto_reenvio: texto(200),
          observacao_reenvio: texto(2000),
          endereco_divergencia: texto(500),
          novo_rastreio: texto(120),
          responsavel_board_id: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req) => {
    await exigirEscrita(req, req.params.id);
    const campos = CAMPOS_FICHA.filter((c) => Object.prototype.hasOwnProperty.call(req.body, c));
    if (!campos.length) throw new ErroHttp(400, 'Nenhum campo reconhecido no corpo.');
    // O percentual só existe com "Reembolso parcial": se o tipo muda para outro, o percentual é zerado; sem esse tipo, não aceita percentual.
    const corpo = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(corpo, 'tipo_resolucao') || corpo.percentual_reembolso != null) {
      const { rows: atual } = await query('SELECT tipo_resolucao FROM email_ia.suporte_escalado_ficha WHERE suporte_escalado_id = $1', [req.params.id]);
      const tipo = Object.prototype.hasOwnProperty.call(corpo, 'tipo_resolucao') ? corpo.tipo_resolucao : (atual[0]?.tipo_resolucao ?? null);
      if (tipo !== 'Reembolso parcial') {
        if (corpo.percentual_reembolso != null) throw new ErroHttp(400, 'O percentual só vale para o tipo de resolução "Reembolso parcial".');
        corpo.percentual_reembolso = null;
      }
    }
    const campos2 = CAMPOS_FICHA.filter((c) => Object.prototype.hasOwnProperty.call(corpo, c));
    if (req.body.responsavel_board_id != null) {
      const { rows } = await query(
        'SELECT 1 FROM email_ia.suporte_escalado_boards WHERE id = $1 AND usuario_id IS NOT NULL', [req.body.responsavel_board_id],
      );
      if (!rows.length) throw new ErroHttp(400, 'Responsável inválido.');
    }
    const valores = campos2.map((c) => {
      const v = corpo[c];
      return typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;
    });
    const colunas = campos2.join(', ');
    const marcas = campos2.map((_, i) => `$${i + 3}`).join(', ');
    const atualiza = campos2.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const { rows } = await query(
      `INSERT INTO email_ia.suporte_escalado_ficha (suporte_escalado_id, atualizado_por, ${colunas})
       VALUES ($1, $2, ${marcas})
       ON CONFLICT (suporte_escalado_id) DO UPDATE SET ${atualiza}, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()
       RETURNING ${CAMPOS_FICHA.join(', ')}, atualizado_por, atualizado_em`,
      [req.params.id, nomeDe(req), ...valores],
    );
    // Mexer na ficha é atendimento humano: mesmo marco de "primeiro toque" que mover de coluna, anotar ou datar a entrega.
    await query(
      `UPDATE email_ia.suporte_escalado SET primeiro_toque_humano_em = coalesce(primeiro_toque_humano_em, now()), atualizado_em = now()
        WHERE id = $1`,
      [req.params.id],
    );
    return rows[0];
  });

  /* ═══════════════════════  POST /api/suporte-escalado/:id/ajuda  ═════════════ */
  app.post('/api/suporte-escalado/:id/ajuda', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Escala o caso a alguém da equipe com uma nota (dúvida, links de prints…)',
      description: 'Quem pediu e quando vêm da sessão (não são campos do corpo).',
      security: [{ bearerAuth: [] }],
      params: idCaso,
      body: {
        type: 'object',
        required: ['para_board_id', 'nota'],
        additionalProperties: false,
        properties: {
          para_board_id: { type: 'integer' },
          nota: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  }, async (req) => {
    await exigirEscrita(req, req.params.id);
    const { rows: destino } = await query(
      'SELECT id, nome FROM email_ia.suporte_escalado_boards WHERE id = $1 AND usuario_id IS NOT NULL', [req.body.para_board_id],
    );
    if (!destino[0]) throw new ErroHttp(400, 'Escolha uma pessoa da equipe.');
    const { rows } = await query(
      `INSERT INTO email_ia.suporte_escalado_ajuda (suporte_escalado_id, pedido_por, para_board_id, nota)
       VALUES ($1, $2, $3, $4)
       RETURNING id, pedido_por, para_board_id, nota, criado_em`,
      [req.params.id, nomeDe(req) || 'Sem nome', req.body.para_board_id, req.body.nota.trim()],
    );
    await query(
      `UPDATE email_ia.suporte_escalado SET primeiro_toque_humano_em = coalesce(primeiro_toque_humano_em, now()), atualizado_em = now()
        WHERE id = $1`,
      [req.params.id],
    );
    return { ...rows[0], para_nome: destino[0].nome };
  });

  /* ═══════════════  POST /api/suporte-escalado/ajuda/:ajudaId/responder  ══════ */
  app.post('/api/suporte-escalado/ajuda/:ajudaId/responder', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Responde um pedido de ajuda endereçado a mim (ou qualquer um, se admin)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['ajudaId'], properties: { ajudaId: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['resposta'],
        additionalProperties: false,
        properties: { resposta: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
    },
  }, async (req) => {
    const { rows: pedido } = await query(
      `SELECT a.id, a.respondido_em, b.usuario_id AS destino_id
         FROM email_ia.suporte_escalado_ajuda a
         JOIN email_ia.suporte_escalado_boards b ON b.id = a.para_board_id
        WHERE a.id = $1`,
      [req.params.ajudaId],
    );
    if (!pedido[0]) throw new ErroHttp(404, 'Pedido de ajuda não encontrado.');
    if (!req.usuario.admin && (pedido[0].destino_id == null || pedido[0].destino_id !== req.usuario.user_id)) {
      throw new ErroHttp(403, 'Este pedido de ajuda não é para você.');
    }
    if (pedido[0].respondido_em) throw new ErroHttp(409, 'Este pedido já foi respondido.');
    const { rows } = await query(
      `UPDATE email_ia.suporte_escalado_ajuda
          SET resposta = $2, respondido_por = $3, respondido_em = now()
        WHERE id = $1 AND respondido_em IS NULL
        RETURNING id, resposta, respondido_por, respondido_em`,
      [req.params.ajudaId, req.body.resposta.trim(), nomeDe(req) || 'Sem nome'],
    );
    if (!rows[0]) throw new ErroHttp(409, 'Este pedido já foi respondido.');
    return rows[0];
  });

  /* ═══════════════════════  GET /api/suporte-escalado/ajuda/para-mim  ═════════ */
  app.get('/api/suporte-escalado/ajuda/para-mim', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Pedidos de ajuda sem resposta endereçados a mim (só os meus, mesmo para admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    const { rows } = await query(
      `SELECT a.id, a.suporte_escalado_id AS caso_id, a.pedido_por, a.nota, a.criado_em, bd.nome AS para_nome,
              s.nome AS cliente_nome, s.remetente_email, s.status, s.resumo_conversa, s.tag_motivo, s.prioridade_nivel, bo.nome AS board_nome
         FROM email_ia.suporte_escalado_ajuda a
         JOIN email_ia.suporte_escalado_boards bd ON bd.id = a.para_board_id
         JOIN email_ia.suporte_escalado s ON s.id = a.suporte_escalado_id
         LEFT JOIN email_ia.suporte_escalado_boards bo ON bo.id = s.board_id
        WHERE a.respondido_em IS NULL AND bd.usuario_id = $1
        ORDER BY a.criado_em`,
      [req.usuario.user_id],
    );
    return { pedidos: rows };
  });
}
