/**
 * Consulta de rastreio para a Recoverly (atendimento 0800) — 01/10/2026.
 *
 * O agente recebe a ligação do lead e consulta o pedido por e-mail ou ID do pedido. Só leitura: a
 * Recoverly não abre ticket nem altera nada por aqui. Cobertura: Red Rock (a FullStack ficou de fora
 * por decisão do Lucas; pedido de outro provedor volta como `indisponivel`).
 *
 * Auth: header `X-Api-Key`. O token é exclusivo da Recoverly e só o HASH (SHA-256) fica no código —
 * não precisa de variável de ambiente nem de migração, e revogar é trocar o hash. Sem limite de
 * chamadas e sem lista de IPs (decisão do Lucas); cada consulta é registrada no log com o parâmetro
 * mascarado (nunca o e-mail inteiro).
 */
import crypto from 'node:crypto';
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const HASH_TOKEN = (process.env.RECOVERLY_API_KEY_SHA256
  || 'b733f8123bf2bba7d82f0d0f7362bad60f32dfdccf2fbd94e9bdd4921a9d00a3').trim();

function tokenValido(bruto) {
  if (!bruto) return false;
  const a = crypto.createHash('sha256').update(String(bruto)).digest();
  const b = Buffer.from(HASH_TOKEN, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const LIMITE_PEDIDOS = 50;
const NAO_ENCONTRADO = { erro: 'nao_encontrado', mensagem: 'Nenhum pedido encontrado.' };

function mascarar(texto) {
  const t = String(texto);
  const arroba = t.indexOf('@');
  if (arroba > 0) return `${t.slice(0, Math.min(2, arroba))}***${t.slice(arroba)}`;
  return t.length > 4 ? `${t.slice(0, 2)}***${t.slice(-2)}` : '***';
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function etapa(nome, data) {
  return { etapa: nome, concluida: Boolean(data), data: iso(data) };
}

/** Um pedido no formato da resposta. Reembolso/chargeback saem sem rastreio e sem etapas. */
function montarPedido(r) {
  const base = { order_id: r.transacao_id, produto: r.produto, comprado_em: iso(r.criado_em) };

  const reembolsoEm = r.reembolsado_em ?? r.chargeback_em;
  if (reembolsoEm) {
    return { ...base, status: 'reembolsado', etapa_atual: 'reembolsado', data_status: iso(reembolsoEm) };
  }

  const redrock = r.provedor === 'redrock';
  const SEM_RASTREIO = new Set(['pendente_consulta', 'nao_encontrado', 'exception', 'desconhecido']);
  if (!redrock || !r.status_interno || SEM_RASTREIO.has(r.status_interno)) {
    return {
      ...base, status: 'indisponivel', etapa_atual: 'pedido_recebido',
      id_rastreio: null, transportadora: null, link_rastreio: null,
      etapas: [etapa('pedido_recebido', r.criado_em), etapa('enviado', null), etapa('entregue', null)],
    };
  }

  const STATUS = { pending: 'aguardando_envio', shipped: 'enviado', delivered: 'entregue', cancelled: 'cancelado' };
  const status = STATUS[r.status_interno] ?? 'indisponivel';
  const enviadoEm = r.shipped_at ?? (status === 'entregue' ? r.delivered_at : null);
  const etapas = [
    etapa('pedido_recebido', r.order_created_at ?? r.criado_em),
    etapa('enviado', status === 'cancelado' ? null : enviadoEm),
    etapa('entregue', status === 'cancelado' ? null : r.delivered_at),
  ];
  const concluidas = etapas.filter((e) => e.concluida);
  return {
    ...base,
    status,
    etapa_atual: status === 'cancelado' ? 'cancelado' : concluidas[concluidas.length - 1].etapa,
    id_rastreio: r.tracking_number ?? null,
    transportadora: r.carrier_code ?? null,
    link_rastreio: r.tracking_url ?? null,
    status_transportadora: r.tracking_status ?? null,
    etapas,
  };
}

const COLUNAS = `t.transacao_id, t.grupo, t.produto, t.criado_em, t.reembolsado_em, t.chargeback_em,
  r.provedor, r.status_interno, r.tracking_number, r.carrier_code, r.tracking_url, r.tracking_status,
  r.order_created_at, r.shipped_at, r.delivered_at`;

const PEDIDOS_DO_EMAIL = `
  SELECT ${COLUNAS} FROM (
    SELECT transacao_id, 'front' AS grupo, produto, criado_em, reembolsado_em, chargeback_em
      FROM disparos_pos_venda WHERE lower(email) = lower($1)
    UNION ALL
    SELECT transacao_id,
           CASE etapa_funil WHEN 'upsell' THEN 'upsell' WHEN 'downsell' THEN 'downsell' ELSE 'outros' END,
           produto, criado_em, reembolsado_em, chargeback_em
      FROM compras_upsell_downsell WHERE lower(email) = lower($1)
  ) t LEFT JOIN rastreio_pedidos r ON r.transacao_id = t.transacao_id
  ORDER BY t.criado_em ASC LIMIT ${LIMITE_PEDIDOS}`;

async function emailDoPedido(orderId) {
  const { rows } = await query(
    `SELECT email FROM disparos_pos_venda WHERE transacao_id = $1 AND email IS NOT NULL
     UNION ALL
     SELECT email FROM compras_upsell_downsell WHERE transacao_id = $1 AND email IS NOT NULL
     LIMIT 1`,
    [orderId],
  );
  return rows[0]?.email ?? null;
}

export default async function rotasRecoverly(app) {
  app.get('/api/v1/recoverly/rastreio', {
    schema: {
      tags: ['Recoverly'],
      summary: 'Status e rastreio dos pedidos de um cliente (atendimento 0800)',
      description: 'Auth por `X-Api-Key` (token exclusivo da Recoverly). Informe `email` OU `order_id`. '
        + 'Devolve todos os pedidos do cliente agrupados em front, upsell, downsell e outros, cada um com '
        + 'status, etapas e código de rastreio. Reembolso/chargeback saem como `reembolsado`, sem rastreio. '
        + 'Pedido sem rastreio na Red Rock sai como `indisponivel`. Não devolve endereço, telefone nem valores.',
      querystring: {
        type: 'object',
        properties: {
          email: { type: 'string', maxLength: 320 },
          order_id: { type: 'string', maxLength: 80 },
        },
      },
      security: [],
    },
  }, async (req, resposta) => {
    resposta.header('Cache-Control', 'no-store');
    if (!tokenValido(req.headers['x-api-key'])) throw new ErroHttp(401, 'Chave ausente ou inválida.');

    const email = req.query.email ? String(req.query.email).trim() : '';
    const orderId = req.query.order_id ? String(req.query.order_id).trim() : '';
    if ((email && orderId) || (!email && !orderId)) {
      throw new ErroHttp(400, 'Informe somente um parâmetro: email ou order_id.');
    }
    if (email && !EMAIL_RE.test(email)) throw new ErroHttp(400, 'E-mail inválido.');

    const tipo = email ? 'email' : 'order_id';
    const valor = email || orderId;
    console.log(`[recoverly] consulta ${tipo}=${mascarar(valor)}`);

    const emailAlvo = email || await emailDoPedido(orderId);
    if (!emailAlvo) return resposta.code(404).send(NAO_ENCONTRADO);

    const { rows } = await query(PEDIDOS_DO_EMAIL, [emailAlvo]);
    if (!rows.length) return resposta.code(404).send(NAO_ENCONTRADO);

    const pedidos = { front: [], upsell: [], downsell: [], outros: [] };
    for (const r of rows) {
      const pedido = montarPedido(r);
      if (orderId && r.transacao_id === orderId) pedido.consultado = true;
      pedidos[r.grupo].push(pedido);
    }
    return { consulta: { tipo, valor }, total_pedidos: rows.length, pedidos };
  });
}
