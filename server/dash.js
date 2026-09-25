/**
 * Cliente e sincronizador do dash (dash.thenorthscales.com) — SÓ LEITURA (23/09/2026).
 *
 * O Mike respondeu às pendências da API (RESPOSTA_SENDTRACE.md): o SendTrace lê o dash com uma
 * chave de PARCEIRO (`X-Api-Key`), que vale só em três endpoints e nunca escreve nada:
 *
 *   GET /api/integrations/orders   ?platform=all&updated_since=<ISO>   → pedidos (teto de 50.000)
 *   GET /api/integrations/targets                                       → metas de reembolso/chargeback
 *   GET /api/integrations/catalog  ?verified=1                          → família de produto
 *
 * Nada aqui liga sem `DASH_API_KEY`: o sincronizador só sobe com a chave, e `dashConfigurado()`
 * é o portão de tudo. A chave vive no .env do servidor, nunca no repositório.
 *
 * Rotina recomendada pelo dash: pull incremental de hora em hora (`updated_since`) + uma
 * varredura de 90 dias por semana, que captura o que entrou por reconciliação manual (estornos
 * da Digistore24 que não disparam IPN, exports da SalesBound).
 *
 * O formato exato do envelope de `/integrations/orders` ainda NÃO foi visto (o guia da API que
 * temos só descreve `orders-dump`). Por isso `extrairLinhas`/`extrairProximo` aceitam os
 * nomes prováveis e o sincronizador GRAVA o erro (em `dash_estado.ultimo_erro`) em vez de
 * assumir, se o formato vier diferente. Conferir na primeira chamada real.
 */
import { pool } from './db.js';

const URL_BASE = (process.env.DASH_API_URL || 'https://dash.thenorthscales.com').replace(/\/+$/, '');
const CHAVE = (process.env.DASH_API_KEY || '').trim();
const TIMEOUT_MS = Number(process.env.DASH_TIMEOUT_MS) || 90_000;

/** Sobreposição no pull incremental: relógio do dash ≠ relógio daqui, e um pull pode cair no meio de um ingest. */
const SOBREPOSICAO_MIN = 10;
const DIAS_VARREDURA = 90;
const MAX_PAGINAS = 40;
const LOTE_GRAVACAO = 2000;
/** Chave do advisory lock: impede dois sincronismos ao mesmo tempo (agendado + botão). */
const LOCK_ID = 490_049_001;

export const dashConfigurado = () => CHAVE.length > 0;

export class ErroDash extends Error {
  constructor(mensagem, status = null) {
    super(mensagem);
    this.status = status;
  }
}

/* ───────────────────────────────  HTTP  ─────────────────────────────── */

async function pedir(caminho, params = {}, buscar = fetch) {
  if (!dashConfigurado()) throw new ErroDash('DASH_API_KEY não configurada no servidor.');
  const url = new URL(`${URL_BASE}${caminho}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  let resposta;
  try {
    resposta = await buscar(url, {
      headers: { 'X-Api-Key': CHAVE, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ErroDash(`dash inacessível (${caminho}): ${err.message}`);
  }
  if (resposta.status === 401) throw new ErroDash('dash recusou a chave (401) — chave errada, trocada ou sem escopo nesse endpoint.', 401);
  if (resposta.status === 503) throw new ErroDash('dash respondeu 503 (integração não configurada lá, ou banco fora).', 503);
  if (!resposta.ok) throw new ErroDash(`dash respondeu ${resposta.status} em ${caminho}.`, resposta.status);
  try {
    return await resposta.json();
  } catch {
    throw new ErroDash(`dash devolveu algo que não é JSON em ${caminho}.`);
  }
}

/* ───────────────────  envelope (formato ainda não visto)  ───────────────────
 * `orders-dump` devolve { orders, count, truncated }. O de `integrations/orders`
 * deve ser parecido, com `next_updated_since` quando bate o teto. */
export function extrairLinhas(corpo) {
  if (Array.isArray(corpo)) return corpo;
  for (const chave of ['orders', 'pedidos', 'data', 'items', 'itens']) {
    if (Array.isArray(corpo?.[chave])) return corpo[chave];
  }
  throw new ErroDash(`formato inesperado em /integrations/orders — chaves recebidas: ${Object.keys(corpo ?? {}).join(', ') || '(nenhuma)'}.`);
}

export const extrairProximo = (corpo) => corpo?.next_updated_since ?? corpo?.nextUpdatedSince ?? null;

/* ───────────────────────────  normalização  ─────────────────────────── */

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const dataIso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const texto = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/** Uma linha do dash → a forma que a tabela `dash_pedidos` guarda. Devolve null se faltar a chave. */
export function normalizarLinha(l, plataformaPadrao = null) {
  const externalId = texto(l.externalId ?? l.external_id);
  const plataforma = texto(l.platform ?? l.platformSlug ?? l.plataforma ?? plataformaPadrao);
  if (!externalId || !plataforma) return null;
  const refundedUsd = Math.abs(num(l.refundedUsd) ?? 0);
  const chargebackUsd = Math.abs(num(l.chargebackUsd) ?? 0);
  return {
    plataforma: plataforma.toLowerCase(),
    external_id: externalId,
    parent_external_id: texto(l.parentExternalId),
    session_id: texto(l.sessionId),
    status: texto(l.status),
    product_type: texto(l.productType),
    funnel_step: num(l.funnelStep),
    family: texto(l.family),
    product_id: texto(l.productId),
    product_name: texto(l.productName),
    affiliate_id: texto(l.affiliateId),
    mapped_affiliate_id: texto(l.mappedAffiliateId),
    customer_email: texto(l.customerEmail)?.toLowerCase() ?? null,
    country: texto(l.country),
    currency: texto(l.currency),
    bottles: num(l.bottles),
    gross: num(l.gross),
    original_gross: num(l.originalGross),
    net: num(l.net),
    cpa: num(l.cpa),
    refunded_usd: refundedUsd,
    chargeback_usd: chargebackUsd,
    refund_model: texto(l.refundModel),
    ordered_at: dataIso(l.orderedAt),
    approved_at: dataIso(l.approvedAt),
    refunded_at: dataIso(l.refundedAt),
    chargeback_at: dataIso(l.chargebackAt),
    updated_at_dash: dataIso(l.updatedAt),
    bruto: l,
  };
}

/* ────────────────────────────  gravação  ──────────────────────────── */

const COLUNAS = [
  ['plataforma', 'text'], ['external_id', 'text'], ['parent_external_id', 'text'], ['session_id', 'text'],
  ['status', 'text'], ['product_type', 'text'], ['funnel_step', 'integer'], ['family', 'text'],
  ['product_id', 'text'], ['product_name', 'text'], ['affiliate_id', 'text'], ['mapped_affiliate_id', 'text'],
  ['customer_email', 'text'], ['country', 'text'], ['currency', 'text'], ['bottles', 'integer'],
  ['gross', 'numeric'], ['original_gross', 'numeric'], ['net', 'numeric'], ['cpa', 'numeric'],
  ['refunded_usd', 'numeric'], ['chargeback_usd', 'numeric'], ['refund_model', 'text'],
  ['ordered_at', 'timestamptz'], ['approved_at', 'timestamptz'], ['refunded_at', 'timestamptz'],
  ['chargeback_at', 'timestamptz'], ['updated_at_dash', 'timestamptz'], ['bruto', 'jsonb'],
];

const SQL_UPSERT = `
  INSERT INTO dash_pedidos (${COLUNAS.map(([c]) => c).join(', ')}, sincronizado_em)
  SELECT ${COLUNAS.map(([c]) => `x.${c}`).join(', ')}, now()
  FROM jsonb_to_recordset($1::jsonb) AS x(${COLUNAS.map(([c, t]) => `${c} ${t}`).join(', ')})
  ON CONFLICT (plataforma, external_id) DO UPDATE SET
    ${COLUNAS.filter(([c]) => !['plataforma', 'external_id'].includes(c)).map(([c]) => `${c} = EXCLUDED.${c}`).join(',\n    ')},
    sincronizado_em = now()
  WHERE dash_pedidos.updated_at_dash IS NULL
     OR EXCLUDED.updated_at_dash IS NULL
     OR EXCLUDED.updated_at_dash >= dash_pedidos.updated_at_dash`;

export async function gravarPedidos(linhas, cliente = pool) {
  // Dentro do MESMO lote uma linha pode repetir (mesmo pedido em duas páginas): fica a mais nova.
  const porChave = new Map();
  for (const l of linhas) {
    const k = `${l.plataforma}|${l.external_id}`;
    const antiga = porChave.get(k);
    if (!antiga || (l.updated_at_dash ?? '') >= (antiga.updated_at_dash ?? '')) porChave.set(k, l);
  }
  const unicas = [...porChave.values()];
  for (let i = 0; i < unicas.length; i += LOTE_GRAVACAO) {
    await cliente.query(SQL_UPSERT, [JSON.stringify(unicas.slice(i, i + LOTE_GRAVACAO))]);
  }
  return unicas.length;
}

export async function salvarEstado(chave, valor, cliente = pool) {
  await cliente.query(
    `INSERT INTO dash_estado (chave, valor, atualizado_em) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
    [chave, JSON.stringify(valor)],
  );
}

export async function lerEstado(chave, cliente = pool) {
  const { rows } = await cliente.query('SELECT valor, atualizado_em FROM dash_estado WHERE chave = $1', [chave]);
  return rows[0] ?? null;
}

/* ──────────────────────  metas e catálogo (cópia local)  ────────────────────── */

export async function atualizarMetas(buscar = fetch) {
  const corpo = await pedir('/api/integrations/targets', {}, buscar);
  await salvarEstado('metas', corpo);
  return corpo;
}

export async function atualizarCatalogo(buscar = fetch) {
  const corpo = await pedir('/api/integrations/catalog', { verified: 1 }, buscar);
  await salvarEstado('catalogo', corpo);
  return corpo;
}

/* ───────────────────────────  sincronizador  ─────────────────────────── */

/**
 * @param {object} opcoes
 * @param {'incremental'|'varredura'} opcoes.modo
 *   incremental: pega o que mudou desde o último cursor (menos a sobreposição);
 *   varredura:   refaz os últimos 90 dias (captura o que entrou por reconciliação).
 *   Na primeira vez (sem cursor) o incremental também parte de 90 dias atrás.
 * @returns {Promise<object>} resumo; `{ ocupado: true }` se já havia outro sincronismo rodando.
 */
export async function sincronizarPedidos({ modo = 'incremental', buscar = fetch } = {}) {
  if (!dashConfigurado()) throw new ErroDash('DASH_API_KEY não configurada no servidor.');

  const con = await pool.connect();
  const inicio = new Date();
  let paginas = 0;
  let recebidas = 0;
  let gravadas = 0;
  let semChave = 0;
  try {
    const { rows } = await con.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return { ocupado: true };

    let desde;
    if (modo === 'varredura') {
      desde = new Date(inicio.getTime() - DIAS_VARREDURA * 86_400_000);
    } else {
      const cursor = (await lerEstado('cursor_pedidos', con))?.valor?.desde;
      desde = cursor
        ? new Date(new Date(cursor).getTime() - SOBREPOSICAO_MIN * 60_000)
        : new Date(inicio.getTime() - DIAS_VARREDURA * 86_400_000);
    }

    let atual = desde.toISOString();
    let terminou = false;
    while (paginas < MAX_PAGINAS) {
      const corpo = await pedir('/api/integrations/orders', { platform: 'all', updated_since: atual }, buscar);
      paginas += 1;
      const linhas = extrairLinhas(corpo);
      recebidas += linhas.length;

      const normalizadas = [];
      for (const l of linhas) {
        const n = normalizarLinha(l);
        if (n) normalizadas.push(n); else semChave += 1;
      }
      gravadas += await gravarPedidos(normalizadas, con);

      const proximo = extrairProximo(corpo);
      if (!proximo || proximo === atual) { terminou = true; break; } // sem próximo (ou sem avanço): acabou
      atual = proximo;
    }
    if (!terminou) throw new ErroDash(`passou de ${MAX_PAGINAS} páginas num só sincronismo — algo está errado com next_updated_since.`);
    if (recebidas > 0 && semChave === recebidas) {
      throw new ErroDash('nenhuma linha trouxe externalId + plataforma — o formato de /integrations/orders não é o esperado.');
    }

    // O cursor só anda se a rodada inteira deu certo: erro no meio = a próxima refaz o trecho.
    if (modo === 'incremental' || !(await lerEstado('cursor_pedidos', con))) {
      await salvarEstado('cursor_pedidos', { desde: inicio.toISOString() }, con);
    }
    if (modo === 'varredura') await salvarEstado('ultima_varredura', { em: inicio.toISOString() }, con);

    // Metas e catálogo mudam pouco: renovam a cada 12 h, ou em toda varredura.
    for (const [chave, atualizar] of [['metas', atualizarMetas], ['catalogo', atualizarCatalogo]]) {
      const est = await lerEstado(chave, con);
      const velho = !est || Date.now() - new Date(est.atualizado_em).getTime() > 12 * 3_600_000;
      if (velho || modo === 'varredura') {
        try { await atualizar(buscar); } catch (err) { await salvarEstado(`erro_${chave}`, { mensagem: err.message, em: new Date().toISOString() }, con); }
      }
    }

    const resumo = {
      modo, desde: desde.toISOString(), paginas, recebidas, gravadas, sem_chave: semChave,
      inicio: inicio.toISOString(), fim: new Date().toISOString(),
    };
    await salvarEstado('ultimo_sync', resumo, con);
    await con.query("DELETE FROM dash_estado WHERE chave = 'ultimo_erro'");
    return resumo;
  } catch (err) {
    await salvarEstado('ultimo_erro', { mensagem: err.message, status: err.status ?? null, modo, em: new Date().toISOString(), paginas, recebidas }, con)
      .catch(() => {});
    throw err;
  } finally {
    await con.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    con.release();
  }
}

/* ────────────────────────────  agendamento  ──────────────────────────── */

/**
 * Liga o pull de hora em hora e a varredura semanal. Só liga com a chave.
 * Devolve uma função que desliga (usada no shutdown). Erro vira log, nunca derruba a API.
 */
export function agendarSincronizacaoDash(log = console) {
  if (!dashConfigurado()) {
    log.info?.('dash: DASH_API_KEY ausente — sincronização desligada.');
    return () => {};
  }
  if (String(process.env.DASH_SYNC_ATIVO ?? 'true').toLowerCase() === 'false') {
    log.info?.('dash: DASH_SYNC_ATIVO=false — sincronização desligada.');
    return () => {};
  }
  const intervalo = Math.max(10, Number(process.env.DASH_SYNC_INTERVALO_MIN) || 60) * 60_000;

  const rodar = async () => {
    try {
      const ultima = await lerEstado('ultima_varredura');
      const semanaPassou = !ultima || Date.now() - new Date(ultima.valor.em).getTime() > 7 * 86_400_000;
      const r = await sincronizarPedidos({ modo: semanaPassou ? 'varredura' : 'incremental' });
      if (!r.ocupado) log.info?.({ dash: r }, 'dash: sincronizado');
    } catch (err) {
      log.error?.({ err }, 'dash: falha na sincronização');
    }
  };

  const primeiro = setTimeout(rodar, 45_000); // depois da subida, sem competir com o resto
  const laco = setInterval(rodar, intervalo);
  primeiro.unref?.();
  laco.unref?.();
  return () => { clearTimeout(primeiro); clearInterval(laco); };
}
