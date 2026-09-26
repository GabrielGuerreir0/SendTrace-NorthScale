/**
 * Integração com o dash (23/09/2026) — duas mãos, cada uma com a sua chave.
 *
 *  LER o dash (SendTrace → dash, só leitura, chave de parceiro `DASH_API_KEY`):
 *    GET  /api/dash/status/        saúde do sincronizador (última rodada, erro, quanto há de dado)
 *    POST /api/dash/sincronizar/   dispara uma rodada agora (admin); responde 202 e roda em segundo plano
 *    GET  /api/dash/metas/         metas de reembolso/chargeback como o dash as guarda
 *    GET  /api/dash/indicadores/   R2/R3/D30 sobre o espelho `dash_pedidos`, com a ressalva de cada plataforma
 *
 *  O dash LER o SendTrace (dash → SendTrace, chave que NÓS geramos: `RETENCAO_API_KEY`):
 *    GET  /api/retencao            ofertas de retenção (P10/R4): `?updated_since=<ISO>&limit=500`
 *  e o registro delas, para o painel/CS/n8n (admin):
 *    POST /api/retencao/ofertas/          cria
 *    PATCH /api/retencao/ofertas/:id/     atualiza (aceite, recusa, valor preservado)
 *
 * Tudo aqui fica dormente sem as chaves: sem `DASH_API_KEY` não há sincronização; sem
 * `RETENCAO_API_KEY`, /api/retencao responde 503.
 */
import crypto from 'node:crypto';

import { query } from '../../server/db.js';
import { dashConfigurado, sincronizarPedidos, lerEstado } from '../../server/dash.js';
import { ErroHttp } from '../comum.js';

const TZ = 'America/Sao_Paulo';

/* ─────────────────────────  ressalvas por plataforma  ─────────────────────────
 * Resposta do Mike (23/09/2026, RESPOSTA_SENDTRACE.md). `completo: false` quer dizer que o
 * reembolso/chargeback dessa plataforma NÃO é confiável no dash — `refundedUsd = 0` ali é
 * "dado ausente", não "não houve reembolso". Revisar quando o dash corrigir o IPN da BuyGoods. */
const QUALIDADE = {
  buygoods: {
    completo: false,
    aviso: 'O IPN de reembolso da BuyGoods não chega ao dash: de 24/08 a 22/09 ele registrou zero estorno sobre US$ 234 mil de vendas. Trate refundedUsd = 0 como dado ausente.',
  },
  digistore24: {
    completo: false,
    aviso: 'Cerca de 28% dos estornos nunca disparam IPN (os feitos por certas contas de suporte) e só entram na reconciliação manual com o CSV do painel, dias depois.',
  },
  salesbound: { completo: false, aviso: 'Reembolso só vem pelo export CSV, importado à mão.' },
  tauk: { completo: false, aviso: 'O Tauk não reporta estorno nenhum.' },
};
const VERIFICADO_EM = '2026-09-23';

/* ─────────────────────────────  chave da retenção  ───────────────────────────── */

const CHAVE_RETENCAO = (process.env.RETENCAO_API_KEY || '').trim();
const RETENCAO_LIGADA = CHAVE_RETENCAO.length >= 32;
if (CHAVE_RETENCAO && !RETENCAO_LIGADA) {
  console.warn('  ! RETENCAO_API_KEY curta demais (mínimo 32 caracteres) — /api/retencao ficará desligado.');
}

function chaveRetencaoValida(bruto) {
  if (!RETENCAO_LIGADA || !bruto) return false;
  const a = Buffer.from(String(bruto));
  const b = Buffer.from(CHAVE_RETENCAO);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Rate limit em memória por IP, janela de 1 min (mesmo desenho do rastreio público). */
const JANELA_MS = 60_000;
const LIMITE_JANELA = 60;
const contadores = new Map();
function excedeu(ip) {
  const agora = Date.now();
  const atual = contadores.get(ip);
  if (!atual || agora - atual.inicio >= JANELA_MS) { contadores.set(ip, { inicio: agora, n: 1 }); return false; }
  atual.n += 1;
  return atual.n > LIMITE_JANELA;
}
setInterval(() => {
  const corte = Date.now() - JANELA_MS;
  for (const [ip, v] of contadores) if (v.inicio < corte) contadores.delete(ip);
}, JANELA_MS).unref();

const iso = (v) => (v ? new Date(v).toISOString() : null);

function itemRetencao(r) {
  return {
    id: r.id,
    transacao_id: r.transacao_id,
    plataforma: r.plataforma,
    email: r.email,
    degrau_oferecido: r.degrau_oferecido,
    degrau_aceito: r.degrau_aceito,
    valor_preservado_usd: r.valor_preservado_usd === null ? null : Number(r.valor_preservado_usd),
    valor_concedido_usd: r.valor_concedido_usd === null || r.valor_concedido_usd === undefined ? null : Number(r.valor_concedido_usd),
    protecao: Boolean(r.protecao),
    status: r.status,
    ocorrido_em: iso(r.ocorrido_em),
    atualizado_em: iso(r.atualizado_em),
  };
}

/* ──────────────────────────────  indicadores  ────────────────────────────── */

/* Uma "venda" = uma linha de dash_vendas (visão materializada, migração 055). O estorno já vem ligado à venda:
   JVZoo/BuyGoods/etc. in-place; Digistore pela linha negativa que aponta para o ID do PEDIDO (session_id da venda,
   não o external_id — achado de 25/09). `reembolsada`/`chargeback` = houve estorno; reemb_em/cb_em = quando. */
const CTE_VENDAS = `
  vendas AS (
    SELECT * FROM dash_vendas WHERE ($2::text IS NULL OR plataforma = $2)
  )`;

async function coletarIndicadores({ dias, plataforma }) {
  const janela = `(date_trunc('day', now() AT TIME ZONE '${TZ}') - ($1::int - 1) * interval '1 day') AT TIME ZONE '${TZ}'`;

  const [periodo, coorte, sendtrace, cobertura] = await Promise.all([
    query(`
      WITH ${CTE_VENDAS}
      SELECT plataforma,
             count(*)::int AS vendas,
             count(*) FILTER (WHERE product_type = 'FRONTEND')::int AS vendas_front,
             coalesce(sum(valor), 0)::float AS vendas_usd,
             count(*) FILTER (WHERE reembolsada)::int AS reembolsos,
             count(*) FILTER (WHERE status = 'REFUNDED')::int AS reembolsos_por_status,
             coalesce(sum(reemb_usd), 0)::float AS reembolsado_usd,
             count(*) FILTER (WHERE chargeback)::int AS chargebacks,
             coalesce(sum(cb_usd), 0)::float AS chargeback_usd
      FROM vendas
      WHERE ordered_at >= ${janela} AND ordered_at < now()
      GROUP BY 1 ORDER BY 2 DESC`, [dias, plataforma]),

    // R1 · coorte D30: compras dos últimos `dias` dias que JÁ têm 30 dias de idade, e quantas
    // foram reembolsadas em até 30 dias da compra.
    query(`
      WITH ${CTE_VENDAS}
      SELECT plataforma,
             count(*)::int AS vendas,
             count(*) FILTER (WHERE reemb_em IS NOT NULL AND reemb_em <= ordered_at + interval '30 days')::int AS reembolsos_d30,
             coalesce(sum(valor), 0)::float AS vendas_usd,
             coalesce(sum(reemb_usd) FILTER (WHERE reemb_em IS NOT NULL AND reemb_em <= ordered_at + interval '30 days'), 0)::float AS reembolsado_d30_usd
      FROM vendas
      WHERE ordered_at >= now() - interval '30 days' - ($1::int * interval '1 day')
        AND ordered_at < now() - interval '30 days'
      GROUP BY 1`, [dias, plataforma]),

    // O que o SendTrace vê no mesmo período, pra conferência (a "diferença zero" do critério da Fase 2).
    query(`
      SELECT lower(btrim(plataforma)) AS plataforma, count(*)::int AS pedidos,
             count(*) FILTER (WHERE reembolsado_em IS NOT NULL)::int AS reembolsos,
             count(*) FILTER (WHERE chargeback_em IS NOT NULL)::int AS chargebacks
      FROM disparos_pos_venda
      WHERE criado_em >= ${janela} AND criado_em < now()
        AND ($2::text IS NULL OR lower(btrim(plataforma)) = $2)
      GROUP BY 1`, [dias, plataforma]),

    query(`SELECT count(*)::int AS linhas, min(ordered_at) AS de, max(ordered_at) AS ate, max(sincronizado_em) AS sincronizado_em FROM dash_pedidos`),
  ]);

  const coortePor = new Map(coorte.rows.map((r) => [r.plataforma, r]));
  const stPor = new Map(sendtrace.rows.map((r) => [r.plataforma, r]));
  const slugs = new Set([...periodo.rows.map((r) => r.plataforma), ...coortePor.keys(), ...stPor.keys()]);
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

  const porPlataforma = [...slugs].map((slug) => {
    const d = periodo.rows.find((r) => r.plataforma === slug) ?? null;
    const c = coortePor.get(slug) ?? null;
    const s = stPor.get(slug) ?? null;
    const q = QUALIDADE[slug] ?? { completo: true, aviso: null };
    return {
      plataforma: slug,
      completo: q.completo,
      aviso: q.aviso,
      dash: d && {
        ...d,
        taxa_reembolso_pct: pct(d.reembolsos, d.vendas),
        taxa_chargeback_pct: pct(d.chargebacks, d.vendas),
      },
      coorte_d30: c && { ...c, taxa_d30_pct: pct(c.reembolsos_d30, c.vendas) },
      sendtrace: s,
      // O SendTrace conta pedidos da régua (front); o dash conta toda venda. O comparável é o front.
      diferenca_pedidos_front: d && s ? d.vendas_front - s.pedidos : null,
    };
  }).sort((a, b) => (b.dash?.vendas ?? 0) - (a.dash?.vendas ?? 0));

  return {
    dias,
    verificado_em: VERIFICADO_EM,
    espelho: cobertura.rows[0],
    por_plataforma: porPlataforma,
    observacao: 'Prévia: as definições (venda, estorno extra-row, D30) seguem o RESPOSTA_SENDTRACE.md e ainda não foram conferidas contra o /resumo do dash nem contra dado real.',
  };
}

/* ═════════════════════════════════  rotas  ═════════════════════════════════ */

export default async function rotasDash(app) {
  /* ── leitura do dash ── */

  app.get('/api/dash/status/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Dash'],
      summary: 'Saúde da sincronização com o dash',
      description: 'Sem `DASH_API_KEY` no servidor devolve `configurado: false` e nada mais — a integração fica dormente.',
    },
  }, async () => {
    const [sync, erro, cursor, varredura, metas, catalogo, pedidos, porPlat] = await Promise.all([
      lerEstado('ultimo_sync'), lerEstado('ultimo_erro'), lerEstado('cursor_pedidos'), lerEstado('ultima_varredura'),
      lerEstado('metas'), lerEstado('catalogo'),
      query('SELECT count(*)::int AS n, min(ordered_at) AS de, max(ordered_at) AS ate, max(updated_at_dash) AS atualizado_ate FROM dash_pedidos').then((r) => r.rows[0]),
      query('SELECT plataforma, count(*)::int AS n FROM dash_pedidos GROUP BY 1 ORDER BY 2 DESC').then((r) => r.rows),
    ]);
    return {
      configurado: dashConfigurado(),
      retencao_ligada: RETENCAO_LIGADA,
      ultimo_sync: sync?.valor ?? null,
      ultimo_erro: erro?.valor ?? null,
      cursor: cursor?.valor?.desde ?? null,
      ultima_varredura: varredura?.valor?.em ?? null,
      metas_atualizadas_em: metas ? iso(metas.atualizado_em) : null,
      catalogo_atualizado_em: catalogo ? iso(catalogo.atualizado_em) : null,
      pedidos,
      por_plataforma: porPlat,
    };
  });

  app.post('/api/dash/sincronizar/', {
    onRequest: [app.exigirAdmin],
    schema: {
      tags: ['Dash'],
      summary: 'Roda uma sincronização com o dash agora',
      description: '`modo`: `incremental` (o que mudou desde o último cursor) ou `varredura` (refaz 90 dias). '
        + 'Responde 202 na hora e roda em segundo plano — acompanhe em `GET /api/dash/status/`.',
      body: {
        type: 'object',
        properties: { modo: { type: 'string', enum: ['incremental', 'varredura'], default: 'incremental' } },
      },
    },
  }, async (req, resposta) => {
    if (!dashConfigurado()) throw new ErroHttp(503, 'DASH_API_KEY não configurada no servidor.');
    const modo = req.body?.modo ?? 'incremental';
    sincronizarPedidos({ modo })
      .then((r) => { if (r.ocupado) req.log.warn('dash: já havia uma sincronização rodando'); else req.log.info({ dash: r }, 'dash: sincronizado sob demanda'); })
      .catch((err) => req.log.error({ err }, 'dash: falha na sincronização sob demanda'));
    return resposta.code(202).send({ iniciado: true, modo });
  });

  app.get('/api/dash/metas/', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Dash'], summary: 'Metas de reembolso/chargeback como o dash as guarda' },
  }, async () => {
    const est = await lerEstado('metas');
    if (!est) return { disponivel: false, motivo: dashConfigurado() ? 'ainda não sincronizado' : 'DASH_API_KEY não configurada' };
    return { disponivel: true, atualizado_em: iso(est.atualizado_em), ...est.valor };
  });

  app.get('/api/dash/indicadores/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Dash'],
      summary: 'Reembolso, chargeback e coorte D30 a partir do espelho do dash',
      querystring: {
        type: 'object',
        properties: {
          dias: { type: 'integer', minimum: 1, maximum: 180, default: 30 },
          plataforma: { type: 'string', description: 'slug do dash: jvzoo, buygoods, digistore24…' },
        },
      },
    },
  }, async (req) => coletarIndicadores({
    dias: req.query.dias ?? 30,
    plataforma: req.query.plataforma ? String(req.query.plataforma).toLowerCase() : null,
  }));

  /* ── o dash lê a retenção ── */

  const lerRetencao = async (req, resposta) => {
    if (!RETENCAO_LIGADA) throw new ErroHttp(503, 'Integração de retenção não configurada neste servidor.');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim();
    if (excedeu(ip)) throw new ErroHttp(429, 'Muitas requisições. Aguarde um minuto.');
    if (!chaveRetencaoValida(req.headers['x-api-key'])) throw new ErroHttp(401, 'Chave ausente ou inválida.');

    const desde = req.query.updated_since ? new Date(req.query.updated_since) : new Date(0);
    if (Number.isNaN(desde.getTime())) throw new ErroHttp(400, 'updated_since não é uma data ISO 8601 válida.');
    const limite = req.query.limit ?? 500;

    // `>=` de propósito: várias linhas podem ter o mesmo atualizado_em, e `>` pularia as que
    // sobram depois do corte. O consumidor deduplica pelo `id` (foi o combinado).
    const { rows } = await query(
      `SELECT * FROM retencao_ofertas WHERE atualizado_em >= $1 ORDER BY atualizado_em ASC, id ASC LIMIT $2`,
      [desde.toISOString(), limite],
    );
    const itens = rows.map(itemRetencao);
    return resposta.header('Cache-Control', 'no-store').send({
      itens,
      next_updated_since: itens.length ? itens[itens.length - 1].atualizado_em : desde.toISOString(),
    });
  };

  const SCHEMA_RETENCAO = {
    tags: ['Dash'],
    summary: 'Ofertas de retenção (P10/R4) — consumido pelo dash',
    description: 'Auth por `X-Api-Key` (a chave `RETENCAO_API_KEY`, que o SendTrace gera e entrega ao dash). '
      + 'Pull incremental: mande `updated_since` com o `next_updated_since` da resposta anterior e deduplique por `id`. '
      + '`transacao_id` é o `externalId` do dump do dash.',
    querystring: {
      type: 'object',
      properties: {
        updated_since: { type: 'string', description: 'ISO 8601; devolve o que mudou a partir daqui (inclusive).' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
      },
    },
    security: [],
  };
  app.get('/api/retencao', { schema: SCHEMA_RETENCAO }, lerRetencao);
  app.get('/api/retencao/', { schema: { ...SCHEMA_RETENCAO, hide: true } }, lerRetencao);

  /* ── registro das ofertas (painel / CS / n8n) ── */

  const CORPO_OFERTA = {
    transacao_id: { type: 'string', minLength: 1, maxLength: 80 },
    plataforma: { type: 'string', minLength: 1, maxLength: 40 },
    email: { type: 'string', maxLength: 200 },
    degrau_oferecido: { type: 'string', maxLength: 80 },
    degrau_aceito: { type: ['string', 'null'], maxLength: 80 },
    valor_preservado_usd: { type: ['number', 'null'], minimum: 0 },
    valor_concedido_usd: { type: ['number', 'null'], minimum: 0 },
    protecao: { type: 'boolean' },
    status: { type: 'string', enum: ['oferecido', 'aceito', 'recusado'] },
    ocorrido_em: { type: 'string', description: 'ISO 8601; padrão: agora.' },
  };

  app.post('/api/retencao/ofertas/', {
    onRequest: [app.exigirAdmin],
    schema: {
      tags: ['Dash'],
      summary: 'Registra uma oferta de retenção feita pelo CS',
      body: { type: 'object', required: ['transacao_id', 'plataforma'], additionalProperties: false, properties: CORPO_OFERTA },
    },
  }, async (req, resposta) => {
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO retencao_ofertas
         (transacao_id, plataforma, email, degrau_oferecido, degrau_aceito, valor_preservado_usd, status, ocorrido_em, criado_por,
          valor_concedido_usd, protecao)
       VALUES ($1, lower($2), lower($3), $4, $5, $6, coalesce($7, 'oferecido'), coalesce($8::timestamptz, now()), $9, $10, coalesce($11, false))
       RETURNING *`,
      [b.transacao_id, b.plataforma, b.email ?? null, b.degrau_oferecido ?? null, b.degrau_aceito ?? null,
        b.valor_preservado_usd ?? null, b.status ?? null, b.ocorrido_em ?? null, req.usuario.email ?? null,
        b.valor_concedido_usd ?? null, b.protecao ?? null],
    );
    return resposta.code(201).send(itemRetencao(rows[0]));
  });

  app.patch('/api/retencao/ofertas/:id/', {
    onRequest: [app.exigirAdmin],
    schema: {
      tags: ['Dash'],
      summary: 'Atualiza uma oferta (aceite, recusa, valor preservado)',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          degrau_aceito: CORPO_OFERTA.degrau_aceito,
          valor_preservado_usd: CORPO_OFERTA.valor_preservado_usd,
          valor_concedido_usd: CORPO_OFERTA.valor_concedido_usd,
          protecao: CORPO_OFERTA.protecao,
          status: CORPO_OFERTA.status,
          degrau_oferecido: CORPO_OFERTA.degrau_oferecido,
        },
      },
    },
  }, async (req) => {
    const campos = Object.keys(req.body);
    const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const { rows } = await query(
      `UPDATE retencao_ofertas SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...campos.map((c) => req.body[c])],
    );
    if (!rows.length) throw new ErroHttp(404, 'Oferta não encontrada.');
    return itemRetencao(rows[0]);
  });
}
