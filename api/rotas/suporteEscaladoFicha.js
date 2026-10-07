/**
 * Suporte Escalado — campos do agente (pedido da Késsia, PDF de 05/10/2026; migração 066).
 *
 *   GET  /api/suporte-escalado/opcoes                    → listas suspensas (Propriedades/Logística) + equipe (quem pode receber ajuda)
 *   GET  /api/suporte-escalado/:id/ficha                 → Propriedades + Logística + pedidos de ajuda do caso
 *   POST /api/suporte-escalado/:id/responder             → o agente responde o cliente pelo SendTrace (SMTP da Hostinger, como support@) — PDF de 07/10, item 2
 *   GET  /api/suporte-escalado/buscar?q=                 → procura outro ticket por e-mail, nome ou nº (para mesclar)
 *   POST /api/suporte-escalado/:id/mesclar               → junta este ticket a outro (ticket-mãe = o mais antigo; migração 086)
 *   GET  /api/suporte-escalado/:id/atividades            → linha do tempo do ticket (chegada, coluna, propriedades, notas, ajuda, respostas) — PDF de 07/10, item 6
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
import { pedidoDoCliente } from '../pedidoDoCliente.js';
import { respostaConfigurada, dominioDeEnvio } from '../../server/emailSuporte.js';
import { acionarEnvio } from '../respostasFila.js';
import { invalidar } from '../cacheCurto.js';
import { randomUUID } from 'node:crypto';

export const OPCOES = {
  motivo_contato: ['Reembolso', 'Chargeback', 'Logística', 'Dúvidas'],
  detalhamento_motivo: [
    'Verificando - Ag. Cliente', 'Insatisfação após uso do produto', 'Dúvida - Esclarecimento', 'Alergia - Doença - Médico',
    'Comprou muito - Upsell', 'Problemas Financeiros', 'Acha que é fraude/golpe', 'Rótulo ou Ingredientes', 'Pessoa incapaz comprou',
    'Arrepen. pós compra - pedido não entregue', 'Arrepen. pós compra - pedido entregue', 'Logística - pedido não entregue',
    'Logística - pedido incompleto', 'Logística - pedido quebrado', 'Logística - divergência no produto', 'Cliente não retornou',
  ],
  tipo_resolucao: [
    'Verificando - Ag. Cliente', 'Reversão total do reembolso', 'Reembolso parcial', 'Reembolsado pela plataforma', 'Não revertido', 'Não respondido - Autorizado pelo líder',
    'Virou chargeback', 'Cliente não retornou',
  ],
  // Aparece ao lado quando o tipo de resolução é "Reembolso parcial" (15% a 90%, de 5 em 5).
  percentual_reembolso: Array.from({ length: 16 }, (_, i) => 15 + i * 5),
  status_ticket: ['Aberto', 'Pendente', 'Resolvido', 'Fechado'],
  motivo_reenvio: ['Itens quebrados', 'Pedido incompleto', 'Pedido não entregue', 'Cortesia'],
  status_logistica: ['Solicitar', 'Solicitado', 'Responder cliente', 'Resolvido'],
  status_ajuda: ['Preciso de ajuda', 'Orientado - seguir atendimento', 'Resolvido'],
};

const CAMPOS_FICHA = [
  'motivo_contato', 'detalhamento_motivo', 'tipo_resolucao', 'percentual_reembolso', 'status_ticket',
  'motivo_reenvio', 'quantidade_reenvio', 'produto_reenvio', 'observacao_reenvio',
  'endereco_divergencia', 'novo_rastreio', 'responsavel_board_id',
  'status_logistica', 'status_ajuda', 'valor_compra_usd', 'deducao_frascos_usd', 'chargeback_em',
];
// Colunas só lidas (calculadas/guardadas pela API): valor a reembolsar e a data/autor da última alteração de cada bloco.
const CAMPOS_LEITURA = [
  'valor_a_reembolsar_usd', 'atualizado_por', 'atualizado_em',
  'propriedades_atualizado_por', 'propriedades_atualizado_em', 'logistica_atualizado_por', 'logistica_atualizado_em',
  'ajuda_atualizado_por', 'ajuda_atualizado_em', 'ticket_reaberto_em',
];
const BLOCO_PROPRIEDADES = ['motivo_contato', 'detalhamento_motivo', 'tipo_resolucao', 'percentual_reembolso', 'status_ticket', 'valor_compra_usd', 'deducao_frascos_usd', 'chargeback_em'];
const BLOCO_LOGISTICA = ['motivo_reenvio', 'quantidade_reenvio', 'produto_reenvio', 'observacao_reenvio', 'endereco_divergencia', 'novo_rastreio', 'responsavel_board_id', 'status_logistica'];
const BLOCO_AJUDA = ['status_ajuda'];
// Item 17 do PDF (07/10): ao salvar Propriedades, estes quatro campos são obrigatórios.
const PROPRIEDADES_OBRIGATORIAS = ['motivo_contato', 'detalhamento_motivo', 'tipo_resolucao', 'status_ticket'];

const lista = (valores) => ({ type: ['string', 'null'], enum: [...valores, null] });
const texto = (max) => ({ type: ['string', 'null'], maxLength: max });

/**
 * A Home (R4, G2, G3, G4) e o dash leem a retenção de `retencao_ofertas`. Desde 07/10/2026 a fonte é a ficha (Propriedades): cada vez que o
 * tipo de resolução é salvo, a linha do caso (origem = 'ficha', uma por caso) é criada/atualizada.
 *   Reembolso parcial            → oferta ACEITA; concedido = valor a reembolsar; preservado = compra − reembolso
 *   Reversão total do reembolso  → oferta ACEITA; concedido 0; preservado = valor da compra
 *   Não revertido / Virou chargeback → oferta RECUSADA
 *   qualquer outro (verificando, cliente não retornou…) → se já havia linha, volta a "oferecido" sem valores (nunca apaga: o dash já pode tê-la lido)
 * Sem pedido do cliente ligado ao dash não há o que gravar.
 */
async function sincronizarRetencao(casoId, ficha) {
  const { rows: [caso] } = await query('SELECT remetente_email FROM email_ia.suporte_escalado WHERE id = $1', [casoId]);
  if (!caso?.remetente_email) return;
  const pedido = await pedidoDoCliente(caso.remetente_email);
  if (!pedido) return;
  const tipo = ficha.tipo_resolucao;
  const valorCompra = Number(ficha.valor_compra_usd ?? pedido.valor_usd ?? 0) || null;
  let oferta = null;
  if (tipo === 'Reembolso parcial' && ficha.valor_a_reembolsar_usd != null) {
    const reembolso = Number(ficha.valor_a_reembolsar_usd);
    oferta = { degrau: 'Reembolso parcial', status: 'aceito', preservado: valorCompra == null ? null : Math.max(0, valorCompra - reembolso), concedido: reembolso };
  } else if (tipo === 'Reversão total do reembolso') {
    oferta = { degrau: 'Reversão total do reembolso', status: 'aceito', preservado: valorCompra, concedido: 0 };
  } else if (tipo === 'Não revertido' || tipo === 'Virou chargeback') {
    oferta = { degrau: 'Tentativa de retenção', status: 'recusado', preservado: null, concedido: null };
  }
  if (!oferta) {
    await query(
      `UPDATE retencao_ofertas SET status = 'oferecido', degrau_aceito = NULL, valor_preservado_usd = NULL, valor_concedido_usd = NULL
        WHERE caso_id = $1 AND origem = 'ficha' AND status <> 'oferecido'`, [casoId],
    );
    return;
  }
  await query(
    `INSERT INTO retencao_ofertas (transacao_id, plataforma, email, degrau_oferecido, degrau_aceito, status,
                                   valor_preservado_usd, valor_concedido_usd, protecao, criado_por, caso_id, origem)
     VALUES ($1, $2, lower($3), $4, $5, $6, $7, $8, false, 'ficha', $9, 'ficha')
     ON CONFLICT (caso_id) WHERE origem = 'ficha' DO UPDATE SET
       transacao_id = EXCLUDED.transacao_id, plataforma = EXCLUDED.plataforma, degrau_oferecido = EXCLUDED.degrau_oferecido,
       degrau_aceito = EXCLUDED.degrau_aceito, status = EXCLUDED.status,
       valor_preservado_usd = EXCLUDED.valor_preservado_usd, valor_concedido_usd = EXCLUDED.valor_concedido_usd`,
    [pedido.externo_id ?? pedido.transacao_id, pedido.plataforma, caso.remetente_email, oferta.degrau,
      oferta.status === 'aceito' ? oferta.degrau : null, oferta.status, oferta.preservado, oferta.concedido, casoId],
  );
}

/** Textos longos do caso (resumo da IA e motivo do escalonamento): a fila não os carrega mais — vêm junto com a ficha ao abrir o ticket. */
async function textosDoCaso(id) {
  const { rows: [c] } = await query('SELECT resumo_conversa, motivo_escalonamento FROM email_ia.suporte_escalado WHERE id = $1', [id]);
  return c ?? { resumo_conversa: null, motivo_escalonamento: null };
}

/** Ticket-mãe e tickets-filhos de um caso (mesclagem, migração 086). */
async function mesclagemDe(id) {
  const { rows } = await query(
    `SELECT 'mae' AS papel, m.id, m.remetente_email, m.nome FROM email_ia.suporte_escalado s
       JOIN email_ia.suporte_escalado m ON m.id = s.ticket_mae_id WHERE s.id = $1
     UNION ALL
     SELECT 'filho', f.id, f.remetente_email, f.nome FROM email_ia.suporte_escalado f WHERE f.ticket_mae_id = $1 ORDER BY 1, 2`,
    [id],
  );
  return { mae: rows.find((r) => r.papel === 'mae') ?? null, filhos: rows.filter((r) => r.papel === 'filho') };
}

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

  // Dono do board, administrador ou gestor do Suporte Escalado (papel 072): lê e edita o caso.
  const ehDono = (req, caso) => !!req.usuario.admin || !!req.usuario.gestorEscalado || !!req.usuario.gestorHumano || (caso.dono_id != null && caso.dono_id === req.usuario.user_id);

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

  // Responsável da logística do caso (pendência interna): lê o caso e edita só o bloco Logística.
  async function ehResponsavelLogistica(req, casoId) {
    if (req.usuario.user_id == null) return false;
    const { rows } = await query(
      `SELECT 1 FROM email_ia.suporte_escalado_ficha fi
         JOIN email_ia.suporte_escalado_boards b ON b.id = fi.responsavel_board_id
        WHERE fi.suporte_escalado_id = $1 AND b.usuario_id = $2 LIMIT 1`,
      [casoId, req.usuario.user_id],
    );
    return rows.length > 0;
  }

  async function exigirLeitura(req, id) {
    const caso = await casoComBoard(id);
    if (!caso) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!ehDono(req, caso) && !(await recebeuAjuda(req, id)) && !(await ehResponsavelLogistica(req, id))) throw new ErroHttp(403, 'Este caso não é de um board seu.');
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
        `SELECT ${[...CAMPOS_FICHA, ...CAMPOS_LEITURA].join(', ')}
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
    // Pedido do cliente: sugere o valor da compra e acusa chargeback já registrado no dash (item 11).
    const { rows: [c] } = await query('SELECT remetente_email FROM email_ia.suporte_escalado WHERE id = $1', [req.params.id]);
    const pedido = c?.remetente_email ? await pedidoDoCliente(c.remetente_email) : null;
    return {
      pode_editar: ehDono(req, caso),
      pode_editar_logistica: ehDono(req, caso) || (await ehResponsavelLogistica(req, req.params.id)),
      mesclagem: await mesclagemDe(req.params.id),
      caso: await textosDoCaso(req.params.id),
      pedido_sugerido: pedido ? { valor_usd: pedido.valor_usd ?? null, plataforma: pedido.plataforma } : null,
      chargeback_pedido_em: pedido?.chargeback ? (pedido.chargeback_em ?? true) : null,
      ficha: { ...Object.fromEntries(CAMPOS_FICHA.map((c) => [c, null])), status_ticket: 'Aberto', ...ficha },
      ajudas: ajudaRes.rows.map(({ destino_id: destinoId, ...a }) => ({
        ...a,
        pode_responder: !a.respondido_em && (!!req.usuario.admin || (destinoId != null && destinoId === req.usuario.user_id)),
      })),
    };
  });

  /* ═══════════════════  POST /api/suporte-escalado/:id/responder  ═══════════════════
     O agente responde o cliente sem sair do SendTrace. A rota só valida e grava na fila de saída (087) e devolve NA HORA (202): o envio por SMTP
     (como support@, na mesma conversa do e-mail do cliente), a cópia em Enviados e o registro em `respostas_agente` — que move o card e fecha o SLA —
     acontecem em segundo plano, em poucos segundos (api/respostasFila.js). Se falhar 3 vezes, a ficha mostra o aviso com "Tentar de novo".
     Dono do board, admin ou gestor. Sem login de SMTP no servidor, responde 503 e nada é gravado. */
  app.post('/api/suporte-escalado/:id/responder', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Responde o cliente do ticket por e-mail (como support@) — o envio segue em segundo plano',
      security: [{ bearerAuth: [] }],
      params: idCaso,
      body: {
        type: 'object', required: ['texto'], additionalProperties: false,
        properties: {
          texto: { type: 'string', minLength: 1, maxLength: 8000 },
          assunto: { type: 'string', maxLength: 300 },
          para_email: { type: 'string', maxLength: 320 },
        },
      },
    },
  }, async (req, resposta) => {
    if (!respostaConfigurada) throw new ErroHttp(503, 'O envio de respostas pelo SendTrace ainda não está configurado neste servidor (falta o login SMTP do suporte).');
    const texto = req.body.texto.trim();
    if (!texto) throw new ErroHttp(400, 'Escreva a resposta.');
    // Uma consulta só: o caso, o dono do board, os e-mails dos tickets-filhos e se a mesma resposta acabou de entrar (clique duplo).
    const { rows: [c] } = await query(
      `SELECT s.id, s.remetente_email, s.board_id, bd.usuario_id AS dono_id,
              coalesce((SELECT array_agg(f.remetente_email) FROM email_ia.suporte_escalado f WHERE f.ticket_mae_id = s.id), '{}') AS filhos
         FROM email_ia.suporte_escalado s LEFT JOIN email_ia.suporte_escalado_boards bd ON bd.id = s.board_id
        WHERE s.id = $1`,
      [req.params.id],
    );
    if (!c) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!ehDono(req, { dono_id: c.dono_id })) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const permitidos = [c.remetente_email, ...c.filhos].filter(Boolean).map((e) => e.toLowerCase());
    const para = (req.body.para_email ?? c.remetente_email).trim().toLowerCase();
    if (!permitidos.includes(para)) throw new ErroHttp(400, 'Este e-mail não pertence ao ticket.');
    const { rows: dup } = await query(
      `SELECT 1 FROM email_ia.respostas_fila WHERE caso_id = $1 AND para_email = $2 AND texto = $3 AND criado_em > now() - interval '60 seconds' AND status <> 'falhou' LIMIT 1`,
      [c.id, para, texto],
    );
    if (dup.length) throw new ErroHttp(409, 'Esta mesma resposta acabou de ser enviada.');
    const messageId = `<${randomUUID()}@${dominioDeEnvio()}>`;
    const { rows: [novo] } = await query(
      `INSERT INTO email_ia.respostas_fila (caso_id, board_id, para_email, assunto, texto, message_id, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, criado_em`,
      [c.id, c.board_id, para, req.body.assunto?.trim() || null, texto, messageId, nomeDe(req)],
    );
    invalidar();
    acionarEnvio(req.log);
    return resposta.code(202).send({ id: novo.id, message_id: messageId, enviado_em: novo.criado_em });
  });

  /* ═══════════════════  GET /api/suporte-escalado/:id/envios  ═══════════════════
     O que ainda está saindo (fila/enviando — a tela mostra como enviado) e o que FALHOU nas últimas 48 h (a tela mostra o aviso e o botão de tentar de novo). */
  app.get('/api/suporte-escalado/:id/envios', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Central de E-mail IA'], summary: 'Respostas em saída e envios que falharam no ticket', security: [{ bearerAuth: [] }], params: idCaso },
  }, async (req) => {
    await exigirLeitura(req, req.params.id);
    const { rows } = await query(
      `SELECT id, para_email, assunto, texto, status, erro, criado_em, criado_por
         FROM email_ia.respostas_fila
        WHERE caso_id = $1 AND (status IN ('fila', 'enviando') OR (status = 'falhou' AND criado_em > now() - interval '48 hours'))
        ORDER BY criado_em`,
      [req.params.id],
    );
    return { envios: rows };
  });

  app.post('/api/suporte-escalado/:id/envios/:envioId/reenviar', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'], summary: 'Tenta de novo um envio que falhou', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id', 'envioId'], properties: { id: { type: 'integer' }, envioId: { type: 'integer' } } },
    },
  }, async (req) => {
    await exigirEscrita(req, req.params.id);
    const { rowCount } = await query(
      `UPDATE email_ia.respostas_fila SET status = 'fila', tentativas = 0, erro = NULL, proxima_tentativa_em = now()
        WHERE id = $1 AND caso_id = $2 AND status = 'falhou'`,
      [req.params.envioId, req.params.id],
    );
    if (!rowCount) throw new ErroHttp(404, 'Não há envio com falha para tentar de novo.');
    acionarEnvio(req.log);
    return { ok: true };
  });

  /* ═══════════════════  GET /api/suporte-escalado/buscar  ═══════════════════
     Acha outro ticket (e-mail, nome ou nº) para mesclar. Devolve só identificação e situação — nada do conteúdo. */
  app.get('/api/suporte-escalado/buscar', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Procura tickets por e-mail, nome ou número (para mesclar)',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 120 } } },
    },
  }, async (req) => {
    const q = req.query.q.trim();
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const porId = /^#?\d{1,12}$/.test(q) ? Number(q.replace('#', '')) : null;
    const { rows } = await query(
      `SELECT s.id, s.remetente_email, s.nome, s.status, s.criado_em, s.ticket_mae_id, b.nome AS agente
         FROM email_ia.suporte_escalado s LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
        WHERE s.remetente_email ILIKE $1 OR s.nome ILIKE $1 OR s.id = $2
        ORDER BY s.criado_em DESC LIMIT 15`,
      [like, porId],
    );
    return { tickets: rows };
  });

  /* ═══════════════════  POST /api/suporte-escalado/:id/mesclar  ═══════════════════
     Junta este ticket e outro. O ticket-mãe é o MAIS ANTIGO entre os dois (sempre a raiz, se algum já é filho); o outro vira filho, vai para o
     board da mãe e o agente da mãe passa a tratar os dois (PDF de 07/10, item 9). Dono do board de qualquer um dos dois, admin ou gestor. */
  app.post('/api/suporte-escalado/:id/mesclar', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Mescla dois tickets (ticket-mãe e ticket-filho)',
      security: [{ bearerAuth: [] }],
      params: idCaso,
      body: { type: 'object', required: ['outro_id'], additionalProperties: false, properties: { outro_id: { type: 'integer' } } },
    },
  }, async (req) => {
    const a = Number(req.params.id);
    const b = req.body.outro_id;
    if (a === b) throw new ErroHttp(400, 'Escolha outro ticket: não dá para mesclar um ticket com ele mesmo.');
    const { rows } = await query(
      `SELECT s.id, s.criado_em, s.ticket_mae_id, bd.usuario_id AS dono_id
         FROM email_ia.suporte_escalado s LEFT JOIN email_ia.suporte_escalado_boards bd ON bd.id = s.board_id
        WHERE s.id = ANY($1::bigint[])`,
      [[a, b]],
    );
    if (rows.length !== 2) throw new ErroHttp(404, 'Ticket não encontrado.');
    const podeAlgum = rows.some((r) => ehDono(req, { dono_id: r.dono_id }));
    if (!podeAlgum) throw new ErroHttp(403, 'Nenhum dos dois tickets é de um board seu.');
    // raízes (se um já é filho, a mãe dele entra no lugar)
    const raiz = (r) => r.ticket_mae_id ?? r.id;
    const { rows: raizes } = await query(
      'SELECT id, criado_em FROM email_ia.suporte_escalado WHERE id = ANY($1::bigint[]) ORDER BY criado_em, id',
      [[...new Set(rows.map(raiz))]],
    );
    if (raizes.length < 2) throw new ErroHttp(409, 'Estes tickets já estão mesclados.');
    const [mae, filho] = raizes;
    await query('SELECT email_ia.mesclar_tickets($1, $2, $3)', [mae.id, filho.id, nomeDe(req) || 'Sistema']);
    invalidar();
    return { mae_id: Number(mae.id), filho_id: Number(filho.id) };
  });

  /* ═══════════════════  GET /api/suporte-escalado/:id/atividades  ═════════════════
     Linha do tempo do ticket, mais recente primeiro. Junta o que já existe (sem copiar): chegada do caso, mudanças de coluna e de agente
     (suporte_escalado_historico), alterações da ficha (suporte_escalado_eventos, 085), notas, pedidos de ajuda e respostas, respostas do
     agente (respostas_agente) e e-mails do cliente. Só metadados e trechos curtos — o texto completo dos e-mails fica na conversa. */
  app.get('/api/suporte-escalado/:id/atividades', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Histórico de atividades do ticket (data, hora, quem e o quê)',
      security: [{ bearerAuth: [] }],
      params: idCaso,
    },
  }, async (req) => {
    await exigirLeitura(req, req.params.id);
    const { rows } = await query(
      `SELECT * FROM (
         SELECT s.criado_em AS quando, 'Sistema' AS ator, 'chegada' AS tipo, 'Ticket chegou' AS titulo,
                concat_ws(' · ', 'Tag: ' || s.tag_motivo, 'Prioridade: ' || s.prioridade_nivel) AS detalhe
           FROM email_ia.suporte_escalado s WHERE s.id = $1
         UNION ALL
         SELECT h.mudou_em, coalesce(h.movido_por, 'Sistema'), 'coluna', 'Coluna do Kanban alterada',
                coalesce(h.status_anterior, '—') || ' → ' || h.status_novo
           FROM email_ia.suporte_escalado_historico h WHERE h.suporte_escalado_id = $1
         UNION ALL
         SELECT x.mudou_em, coalesce(x.movido_por, 'Sistema'), 'atribuicao', 'Atribuído ao agente', x.nome
           FROM (SELECT h.mudou_em, h.id, h.movido_por, h.board_id, b.nome,
                        lag(h.board_id) OVER (ORDER BY h.mudou_em, h.id) AS anterior
                   FROM email_ia.suporte_escalado_historico h
                   LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = h.board_id
                  WHERE h.suporte_escalado_id = $1) x
          WHERE x.board_id IS NOT NULL AND x.board_id IS DISTINCT FROM x.anterior
         UNION ALL
         SELECT ev.ocorrido_em, coalesce(ev.ator, 'Sistema'), 'propriedade:' || ev.bloco || ':' || ev.campo, ev.campo,
                concat_ws(' → ', coalesce(ev.de, '—'), coalesce(ev.para, '—')) || coalesce(' (' || ev.detalhe || ')', '')
           FROM email_ia.suporte_escalado_eventos ev WHERE ev.caso_id = $1
         UNION ALL
         SELECT n.criado_em, coalesce(n.autor, 'Sem autor'), 'nota', 'Nota interna adicionada', left(n.nota, 240)
           FROM email_ia.suporte_escalado_notas n WHERE n.suporte_escalado_id IN (SELECT id FROM email_ia.suporte_escalado WHERE id = $1 OR ticket_mae_id = $1)
         UNION ALL
         SELECT a.criado_em, a.pedido_por, 'ajuda', 'Pediu ajuda a ' || b.nome, left(a.nota, 240)
           FROM email_ia.suporte_escalado_ajuda a JOIN email_ia.suporte_escalado_boards b ON b.id = a.para_board_id
          WHERE a.suporte_escalado_id = $1
         UNION ALL
         SELECT a.respondido_em, a.respondido_por, 'ajuda', 'Respondeu ao pedido de ajuda', left(a.resposta, 240)
           FROM email_ia.suporte_escalado_ajuda a WHERE a.suporte_escalado_id = $1 AND a.respondido_em IS NOT NULL
         UNION ALL
         SELECT r.enviado_em, coalesce(b.nome, 'Agente'), 'resposta_agente', 'Agente respondeu ao cliente', r.assunto
           FROM email_ia.respostas_agente r LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = r.board_id
          WHERE r.caso_id IN (SELECT id FROM email_ia.suporte_escalado WHERE id = $1 OR ticket_mae_id = $1)
         UNION ALL
         (SELECT e.data_email, coalesce(s.nome, s.remetente_email), 'cliente', 'Cliente enviou um e-mail', e.assunto
            FROM email_ia.suporte_escalado s
            JOIN email_ia.emails e ON lower(e.remetente_email) = lower(s.remetente_email) AND e.plataforma_origem IS NULL
           WHERE s.id = $1 OR s.ticket_mae_id = $1 ORDER BY e.data_email DESC LIMIT 150)
       ) t
       WHERE t.quando IS NOT NULL
       ORDER BY t.quando DESC LIMIT 400`,
      [req.params.id],
    );
    return { atividades: rows };
  });

  /* ═══════════════════════  PUT /api/suporte-escalado/:id/ficha  ══════════════ */
  app.put('/api/suporte-escalado/:id/ficha', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Salva os campos do agente enviados no corpo (os ausentes não mudam; null limpa)',
      description: 'Dono do board, administrador ou gestor. Listas fechadas: ver GET /api/suporte-escalado/opcoes.',
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
          status_logistica: lista(OPCOES.status_logistica),
          status_ajuda: lista(OPCOES.status_ajuda),
          valor_compra_usd: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
          deducao_frascos_usd: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
          chargeback_em: { type: ['string', 'null'], format: 'date' },
        },
      },
    },
  }, async (req) => {
    const casoPut = await casoComBoard(req.params.id);
    if (!casoPut) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!ehDono(req, casoPut)) {
      // O responsável da logística só mexe no bloco Logística (ex.: trocar o status para "Responder cliente" e passar a vez).
      const soLogistica = Object.keys(req.body).every((c) => BLOCO_LOGISTICA.includes(c));
      if (!(soLogistica && await ehResponsavelLogistica(req, req.params.id))) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    }
    const tem = (o, c) => Object.prototype.hasOwnProperty.call(o, c);
    const limpa = (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null));
    const toca = (bloco) => bloco.some((c) => tem(req.body, c));
    const tocaProp = toca(BLOCO_PROPRIEDADES);
    const { rows: atualRows } = await query(
      `SELECT ${CAMPOS_FICHA.join(', ')} FROM email_ia.suporte_escalado_ficha WHERE suporte_escalado_id = $1`, [req.params.id],
    );
    const atual = atualRows[0] ?? {};
    const corpo = { ...req.body };
    const final = (c) => (tem(corpo, c) ? limpa(corpo[c]) : (atual[c] ?? null));

    const extras = {};   // colunas calculadas pela API (não vêm do corpo)
    if (tocaProp) {
      const tipo = final('tipo_resolucao');
      const parcial = tipo === 'Reembolso parcial';
      // O percentual, o valor da compra e a dedução só existem com "Reembolso parcial": o percentual enviado sem esse tipo é erro; os demais são zerados.
      if (!parcial) {
        if (corpo.percentual_reembolso != null) throw new ErroHttp(400, 'O percentual só vale para o tipo de resolução "Reembolso parcial".');
        corpo.percentual_reembolso = null; corpo.valor_compra_usd = null; corpo.deducao_frascos_usd = null;
      }
      // Item 17 do PDF: Propriedades não salva incompleto.
      const faltam = PROPRIEDADES_OBRIGATORIAS.filter((c) => final(c) == null);
      if (parcial) {
        if (final('percentual_reembolso') == null) faltam.push('percentual_reembolso');
        if (final('valor_compra_usd') == null) faltam.push('valor_compra_usd');
      }
      if (faltam.length) throw new ErroHttp(422, `Preencha todos os campos de Propriedades antes de salvar (faltam: ${faltam.join(', ')}).`);
      // Chargeback: a data nasce com hoje se o agente não informar; some se o tipo deixa de ser "Virou chargeback".
      if (tipo === 'Virou chargeback') {
        if (!final('chargeback_em')) corpo.chargeback_em = new Date().toISOString().slice(0, 10);
      } else corpo.chargeback_em = null;
      // MÁX(0; valor × % − dedução), a fórmula da planilha da JVZoo.
      extras.valor_a_reembolsar_usd = parcial
        ? Math.round(Math.max(0, final('valor_compra_usd') * (final('percentual_reembolso') / 100) - (final('deducao_frascos_usd') ?? 0)) * 100) / 100
        : null;
    }
    const campos2 = CAMPOS_FICHA.filter((c) => tem(corpo, c));
    if (!campos2.length) throw new ErroHttp(400, 'Nenhum campo reconhecido no corpo.');
    if (req.body.responsavel_board_id != null) {
      const { rows } = await query(
        'SELECT 1 FROM email_ia.suporte_escalado_boards WHERE id = $1 AND usuario_id IS NOT NULL', [req.body.responsavel_board_id],
      );
      if (!rows.length) throw new ErroHttp(400, 'Responsável inválido.');
    }
    const quem = nomeDe(req);
    const cols = Object.fromEntries(campos2.map((c) => [c, limpa(corpo[c])]));
    Object.assign(cols, extras);
    // Data e autor da última alteração de cada bloco (item 5): só o bloco tocado muda.
    for (const [bloco, prefixo] of [[BLOCO_PROPRIEDADES, 'propriedades'], [BLOCO_LOGISTICA, 'logistica'], [BLOCO_AJUDA, 'ajuda']]) {
      if (toca(bloco)) { cols[`${prefixo}_atualizado_por`] = quem; cols[`${prefixo}_atualizado_em`] = new Date(); }
    }
    cols.atualizado_por = quem;
    const nomes = Object.keys(cols);
    const marcas = nomes.map((_, i) => `$${i + 2}`).join(', ');
    const atualiza = nomes.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const { rows } = await query(
      `INSERT INTO email_ia.suporte_escalado_ficha (suporte_escalado_id, ${nomes.join(', ')})
       VALUES ($1, ${marcas})
       ON CONFLICT (suporte_escalado_id) DO UPDATE SET ${atualiza}, atualizado_em = now()
       RETURNING ${[...CAMPOS_FICHA, ...CAMPOS_LEITURA].join(', ')}`,
      [req.params.id, ...nomes.map((c) => cols[c])],
    );
    // Mexer na ficha é atendimento humano: mesmo marco de "primeiro toque" que mover de coluna, anotar ou datar a entrega.
    await query(
      `UPDATE email_ia.suporte_escalado SET primeiro_toque_humano_em = coalesce(primeiro_toque_humano_em, now()), atualizado_em = now()
        WHERE id = $1`,
      [req.params.id],
    );
    if (tocaProp) await sincronizarRetencao(req.params.id, rows[0]);
    invalidar();
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
