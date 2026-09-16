/**
 * Rastreamento de pedidos (Red Rock) — leitura de `rastreio_pedidos`/
 * `rastreio_eventos`.
 *
 * Escrita é só do script `server/rastreio/consultar_redrock.py` (acesso
 * direto ao Postgres) — esta API nunca fala com a Red Rock. Ver o plano
 * completo em `arquivo/Rastreamento de Disparo (plano nao implementado)/PLANO.md`.
 *
 * Duas famílias de rota aqui: as internas (`/api/rastreio/...`, exigem
 * sessão, mesmo padrão do resto da API) e UMA pública (`/rastrear/:id`,
 * sem token — o lead consulta o próprio pedido). A pública nunca devolve
 * PII (endereço/e-mail/telefone) e é rate-limited por IP.
 */
import { query } from '../../server/db.js';
import { DO_PRODUTO, DA_PLATAFORMA } from '../sql.js';
import { fatiar, montarOrdem, ErroHttp } from '../comum.js';
import { paginado, paginacaoParams } from '../esquemas.js';
import { condicaoPeriodo } from '../filtrosEmailIA.js';

/** `dias`/`data_de`/`data_ate` documentados nas 3 rotas que os aceitam — ver condicaoPeriodo. */
const PERIODO_QS = {
  dias: { type: 'string', description: 'Janela relativa em dias (ex.: 7, 30, 60, 90). Tem prioridade sobre data_de/data_ate.' },
  data_de: { type: 'string', description: 'Pedidos comprados a partir desta data (formato YYYY-MM-DD).' },
  data_ate: { type: 'string', description: 'Pedidos comprados até esta data, incluída (formato YYYY-MM-DD).' },
};

/**
 * Produto/plataforma/período sobre `disparos_pos_venda d` — os 3 recortes
 * que a aba de Rastreio já mostra no filtro (produto e plataforma) mais o
 * período (07/09/2026, pedido do usuário) — usado igual nas 6 sub-consultas
 * de `/api/metricas/rastreio/saude/`, cada uma com sua própria contagem de
 * placeholders (por isso sempre começa em $1 e devolve um `valores` próprio).
 */
function filtroCompra(qs, colunaData = 'd.criado_em') {
  const condicoes = [];
  const valores = [];
  let i = 1;
  if (qs.produto) { condicoes.push(`d.produto = $${i}`); valores.push(String(qs.produto)); i += 1; }
  if (qs.plataforma) { condicoes.push(`btrim(d.plataforma) = $${i}`); valores.push(String(qs.plataforma)); i += 1; }
  condicaoPeriodo(qs, colunaData, condicoes, valores, i);
  return { sql: condicoes.length ? condicoes.join(' AND ') : '1=1', valores };
}

const COLUNAS_LISTA = `r.transacao_id, d.nome, d.produto, d.plataforma, r.provedor,
  r.status_interno, r.status_bruto, r.order_number, r.order_created_at, r.total,
  r.currency, r.fully_fulfilled, r.fully_fulfilled_at, r.tracking_number,
  r.carrier_code, r.tracking_url, r.tracking_status, r.shipped_at, r.delivered_at,
  r.ultima_consulta_em, r.ultimo_erro, r.criado_em, r.atualizado_em`;

/**
 * A Red Rock só dá 4 status simples (pending/shipped/delivered/cancelled) —
 * pra enriquecer sem depender de um provedor novo (ver PLANO.md seção 13,
 * a Parcels API v4 é a opção paga, com data/local por evento), usa dois
 * dados que já vêm de graça e ninguém expunha:
 *   · `tracking_delivery_exceptions` — histórico bruto da transportadora,
 *     quando ela manda (visto até agora só em remessas USPS; GOFO, o
 *     carrier mais comum nos nossos pedidos, não preenche isso);
 *   · quanto tempo faz sem NENHUMA mudança detectada — calculado sobre o
 *     próprio histórico de polling (`atualizado_em`), não precisa de API
 *     nova nenhuma.
 */
const LIMITE_PARADO_DIAS = { pending: 3, shipped: 7 };

function checkpointsTransportadora(trackingArr) {
  const lista = Array.isArray(trackingArr) ? trackingArr : [];
  const atual = lista.find((t) => t.is_current) ?? lista[lista.length - 1];
  const bruto = atual?.tracking_delivery_exceptions;
  if (!bruto) return null;
  // A Red Rock manda isso com aspas simples sobrando na ponta (artefato do
  // lado deles, não é JSON) — tira antes de partir pelo separador.
  return String(bruto).replace(/^'+|'+$/g, '').split('|').map((s) => s.trim()).filter(Boolean);
}

function montarParado(statusInterno, atualizadoEm) {
  const limite = LIMITE_PARADO_DIAS[statusInterno];
  if (!limite || !atualizadoEm) return { parado: false, dias_sem_mudanca: null };
  const dias = (Date.now() - new Date(atualizadoEm).getTime()) / 86_400_000;
  return { parado: dias >= limite, dias_sem_mudanca: Math.floor(dias) };
}

const ROTULO_STATUS = {
  pendente_consulta: 'Consultando fornecedor',
  nao_encontrado: 'Rastreio ainda não disponível',
  pending: 'Pedido recebido, preparando envio',
  shipped: 'A caminho',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  exception: 'Rastreio ainda não disponível',
  desconhecido: 'Rastreio ainda não disponível',
};

/* ───────────────────  rate limit hand-rolled da rota pública  ──────────────
 *
 * Sem dependência nova (@fastify/rate-limit não está no package.json) — janela
 * fixa em memória por IP, reiniciada a cada minuto. Não precisa sobreviver a
 * um restart nem ser exata: o objetivo é travar scraping em massa (o
 * transacao_id do DigiStore24 tem só 8 caracteres, entropia baixa), não
 * fechar contra um atacante sofisticado.
 */
const JANELA_MS = 60_000;
const LIMITE_JANELA = 20;
const contadores = new Map();

function excedeuLimite(ip) {
  const agora = Date.now();
  const atual = contadores.get(ip);
  if (!atual || agora - atual.inicio >= JANELA_MS) {
    contadores.set(ip, { inicio: agora, n: 1 });
    return false;
  }
  atual.n += 1;
  return atual.n > LIMITE_JANELA;
}

// Limpeza periódica — sem isto o Map cresceria pra sempre com um IP por
// visitante único, nunca liberando memória de quem não volta mais.
setInterval(() => {
  const corte = Date.now() - JANELA_MS;
  for (const [ip, v] of contadores) if (v.inicio < corte) contadores.delete(ip);
}, JANELA_MS).unref();

function extrairIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconhecido';
}

/**
 * As 4 formas de "duração de um pedido" que Saúde do rastreio conhece —
 * compartilhada entre o drill-down (`/saude/detalhe/`) e a série diária
 * (`/saude/serie/`), que precisam do MESMO cálculo, só que um devolve linha
 * a linha e o outro agrega por dia. `duracaoExpr` é a expressão crua em
 * horas (sem round/alias) — cada chamador decide o que fazer com ela.
 */
function resolverMetricaTempo(req, f) {
  const valores = [...f.valores];
  let i = valores.length + 1;
  const extra = [];
  let duracaoExpr;
  let de = `FROM rastreio_pedidos r JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id`;

  if (req.query.metrica === 'deteccao') {
    duracaoExpr = `extract(epoch FROM (pe.detectado_em - d.criado_em)) / 3600`;
    de = `FROM (
            SELECT DISTINCT ON (transacao_id) transacao_id, detectado_em, fonte
            FROM rastreio_eventos WHERE status_anterior IS NULL
            ORDER BY transacao_id, detectado_em ASC
          ) pe
          JOIN disparos_pos_venda d ON d.transacao_id = pe.transacao_id
          JOIN rastreio_pedidos r ON r.transacao_id = pe.transacao_id`;
    extra.push(`pe.fonte <> 'backfill-email'`);
  } else if (req.query.metrica === 'transporte') {
    duracaoExpr = `extract(epoch FROM (r.delivered_at - r.shipped_at)) / 3600`;
    extra.push(`r.status_interno = 'delivered'`, `r.shipped_at IS NOT NULL`, `r.delivered_at IS NOT NULL`);
  } else if (req.query.metrica === 'total') {
    duracaoExpr = `extract(epoch FROM (r.delivered_at - d.criado_em)) / 3600`;
    extra.push(`r.status_interno = 'delivered'`, `r.delivered_at IS NOT NULL`);
  } else if (req.query.metrica === 'transicao') {
    if (!req.query.status_novo) throw new ErroHttp(400, 'status_novo é obrigatório quando metrica=transicao.');
    duracaoExpr = `extract(epoch FROM (ev.detectado_em - ev.entrou_em)) / 3600`;
    de = `FROM (
            SELECT transacao_id, status_anterior, status_novo, detectado_em,
              LAG(detectado_em) OVER (PARTITION BY transacao_id ORDER BY detectado_em) AS entrou_em
            FROM rastreio_eventos WHERE fonte <> 'backfill-email'
          ) ev
          JOIN disparos_pos_venda d ON d.transacao_id = ev.transacao_id
          JOIN rastreio_pedidos r ON r.transacao_id = ev.transacao_id`;
    extra.push(`ev.entrou_em IS NOT NULL`, `coalesce(ev.status_anterior, '') = $${i}`, `ev.status_novo = $${i + 1}`);
    valores.push(String(req.query.status_anterior ?? ''), String(req.query.status_novo));
    i += 2;
  } else {
    duracaoExpr = null;
    de = `FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id`;
    if (req.query.status_interno) { extra.push(`r.status_interno = $${i}`); valores.push(String(req.query.status_interno)); i += 1; }
    if (req.query.provedor) { extra.push(`coalesce(r.provedor, 'nenhum') = $${i}`); valores.push(String(req.query.provedor)); i += 1; }
    // Espelha o WHERE extra da linha "sem_codigo_rastreio" em /saude/ — sem
    // isso o drill-down mostraria todo mundo naquele status/plataforma, não
    // só quem realmente está sem tracking_number (o que a linha representa).
    if (req.query.sem_codigo === '1') extra.push(`r.provedor IS NOT NULL`, `r.tracking_number IS NULL`);
  }

  // Clique num ponto do gráfico "Evolução no tempo": o dia do PONTO é o
  // mesmo dia de referência da série (`diaExpr` em /saude/serie/) — entrega
  // pra transporte/total, evento pras outras duas — NUNCA a data da compra.
  // Por isso é um parâmetro à parte (`dia`), não data_de/data_ate: aquele
  // passa por filtroCompra() e sempre filtra por `d.criado_em` (data da
  // COMPRA), que pra transporte/total é um dia completamente diferente do
  // que apareceu no gráfico — um pedido comprado em agosto pode ter sido
  // entregue em setembro, e é o dia de SETEMBRO que a pessoa clicou.
  if (req.query.dia) {
    const colunaDia = req.query.metrica === 'transporte' || req.query.metrica === 'total'
      ? 'r.delivered_at'
      : req.query.metrica === 'deteccao' ? 'pe.detectado_em'
        : req.query.metrica === 'transicao' ? 'ev.detectado_em'
          : 'r.criado_em';
    extra.push(`(${colunaDia})::date = $${i}::date`);
    valores.push(String(req.query.dia));
    i += 1;
  }

  // Clique numa faixa da tabela "Distribuição do tempo de entrega" — mesma
  // duracaoExpr que a métrica já calcula (transporte/total), só recorta por
  // intervalo em vez de igualar um dia. min/max em DIAS (a tabela mostra em
  // dias, não horas) — duracaoExpr já está em horas, por isso o *24.
  if (duracaoExpr && (req.query.duracao_dias_min || req.query.duracao_dias_max)) {
    if (req.query.duracao_dias_min) {
      extra.push(`(${duracaoExpr}) >= $${i}::numeric * 24`);
      valores.push(String(req.query.duracao_dias_min));
      i += 1;
    }
    if (req.query.duracao_dias_max) {
      extra.push(`(${duracaoExpr}) < $${i}::numeric * 24`);
      valores.push(String(req.query.duracao_dias_max));
      i += 1;
    }
  }

  return { de, extra, duracaoExpr, valores, i };
}

export default async function rotasRastreio(app) {
  /* ═══════════════════════════  internas (painel)  ═══════════════════════ */

  app.get('/api/rastreio/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Rastreio'],
      summary: 'Lista o rastreio dos pedidos',
      description: 'Junta com `disparos_pos_venda` pelo `transacao_id` pra trazer nome/produto/'
        + 'plataforma. Só existe linha aqui pro pedido que já foi consultado ao menos uma vez.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...paginacaoParams,
          status: {
            type: 'string',
            enum: [
              'pendente_consulta', 'nao_encontrado', 'pending', 'shipped', 'delivered', 'cancelled', 'exception', 'desconhecido',
              'sem_codigo_rastreio',
            ],
            description: "'sem_codigo_rastreio' não é um status_interno de verdade — é um atalho pra "
              + '"já encontrado num status (pending/shipped/delivered/cancelled) mas ainda sem tracking_number".',
          },
          provedor: { type: 'string' },
          produto: { type: 'string' },
          plataforma: { type: 'string' },
          search: { type: 'string', description: 'Procura em: transacao_id, nome, tracking_number.' },
          ordering: { type: 'string', description: 'Aceita: atualizado_em, criado_em, order_created_at.' },
          ...PERIODO_QS,
        },
      },
      response: { 200: paginado('RastreioPedido') },
    },
  }, async (req) => {
    const valores = [];
    const partes = ['1=1'];

    if (req.query.status === 'sem_codigo_rastreio') {
      partes.push(`r.tracking_number IS NULL AND r.status_interno IN ('pending', 'shipped', 'delivered', 'cancelled')`);
    } else if (req.query.status) {
      valores.push(req.query.status); partes.push(`r.status_interno = $${valores.length}`);
    }
    if (req.query.provedor) { valores.push(req.query.provedor); partes.push(`r.provedor = $${valores.length}`); }
    if (req.query.produto) { valores.push(req.query.produto); partes.push(`d.produto = $${valores.length}`); }
    if (req.query.plataforma) { valores.push(req.query.plataforma); partes.push(`btrim(d.plataforma) = $${valores.length}`); }
    if (req.query.search) {
      valores.push(`%${req.query.search}%`);
      const i = valores.length;
      partes.push(`(r.transacao_id ILIKE $${i} OR d.nome ILIKE $${i} OR r.tracking_number ILIKE $${i})`);
    }
    condicaoPeriodo(req.query, 'd.criado_em', partes, valores, valores.length + 1);
    const onde = `WHERE ${partes.join(' AND ')}`;
    const base = `FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id ${onde}`;

    const cont = await query(`SELECT count(*)::int AS n ${base}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const ordem = montarOrdem(req.query.ordering, ['atualizado_em', 'criado_em', 'order_created_at'], 'r.atualizado_em DESC');
    const { rows } = await query(
      `SELECT ${COLUNAS_LISTA} ${base} ORDER BY ${ordem}
       LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  app.get('/api/rastreio/:transacao_id/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Rastreio'],
      summary: 'Detalhe de um pedido + a linha do tempo (últimos 100 eventos)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { transacao_id: { type: 'string' } }, required: ['transacao_id'] },
      response: { 200: { $ref: 'RastreioDetalhe#' }, 404: { $ref: 'Erro#' } },
    },
  }, async (req) => {
    const { rows } = await query(
      `SELECT ${COLUNAS_LISTA}, r.tracking, r.cancellation
       FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
       WHERE r.transacao_id = $1`,
      [req.params.transacao_id],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Nenhum rastreio para este transacao_id ainda.');

    const eventos = await query(
      `SELECT id, status_anterior, status_novo, fonte, detectado_em
       FROM rastreio_eventos WHERE transacao_id = $1
       ORDER BY detectado_em DESC LIMIT 100`,
      [req.params.transacao_id],
    );
    return {
      ...rows[0],
      eventos: eventos.rows,
      marcos: {
        criado_em: rows[0].order_created_at,
        enviado_em: rows[0].shipped_at,
        entregue_em: rows[0].delivered_at,
      },
      checkpoints_transportadora: checkpointsTransportadora(rows[0].tracking),
      ...montarParado(rows[0].status_interno, rows[0].atualizado_em),
    };
  });

  app.get('/api/metricas/rastreio/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Métricas'],
      summary: 'Contagem por status de rastreio + taxa de entrega',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { produto: { type: 'string' }, plataforma: { type: 'string' }, ...PERIODO_QS },
      },
      response: { 200: { $ref: 'ResumoRastreio#' } },
    },
  }, async (req) => {
    const condicoes = [];
    const valores = [null, null];
    condicaoPeriodo(req.query, 'd.criado_em', condicoes, valores, 3);
    const filtroPeriodo = condicoes.length ? `AND ${condicoes.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT
         count(*)::int                                                    AS total,
         count(*) FILTER (WHERE r.status_interno = 'pendente_consulta')::int AS pendente_consulta,
         count(*) FILTER (WHERE r.status_interno = 'nao_encontrado')::int    AS nao_encontrado,
         count(*) FILTER (WHERE r.status_interno = 'pending')::int           AS pending,
         count(*) FILTER (WHERE r.status_interno = 'shipped')::int           AS shipped,
         count(*) FILTER (WHERE r.status_interno = 'delivered')::int         AS delivered,
         count(*) FILTER (WHERE r.status_interno = 'cancelled')::int         AS cancelled,
         count(*) FILTER (WHERE r.status_interno = 'exception')::int         AS exception,
         count(*) FILTER (WHERE r.status_interno = 'desconhecido')::int      AS desconhecido,
         count(*) FILTER (
           WHERE r.tracking_number IS NULL AND r.status_interno IN ('pending', 'shipped', 'delivered', 'cancelled')
         )::int AS sem_codigo_rastreio
       FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
       WHERE ${DO_PRODUTO(1, 'd.')} AND ${DA_PLATAFORMA(2, 'd.')} ${filtroPeriodo}`,
      [req.query.produto ?? null, req.query.plataforma ?? null, ...valores.slice(2)],
    );
    const t = rows[0];
    const base = t.shipped + t.delivered;
    return { ...t, taxa_entrega: base > 0 ? Math.round((t.delivered / base) * 1000) / 10 : null };
  });

  app.get('/api/metricas/rastreio/saude/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Métricas'],
      summary: 'Saúde do rastreio: velocidade de detecção, cobertura e transições de status',
      description: 'Todas as médias/medianas excluem `fonte = \'backfill-email\'` (o backfill '
        + 'retroativo por e-mail, rodado uma vez em 15/09/2026) — sem isso, um pedido antigo '
        + '"achado" só hoje entraria como se tivesse levado meses pra ser detectado. Aceita os '
        + 'mesmos recortes de produto/plataforma/período da lista de pedidos.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { produto: { type: 'string' }, plataforma: { type: 'string' }, ...PERIODO_QS },
      },
      response: { 200: { $ref: 'SaudeRastreio#' } },
    },
  }, async (req) => {
    // Mesmo filtro (produto/plataforma/período), reaproveitado nas 6
    // sub-consultas — cada `query()` é independente, então os placeholders
    // $1/$2/... recomeçam certos em cada uma sem precisar recalcular nada.
    const f = filtroCompra(req.query);
    const [
      tempoParaEncontrar, naoEncontrados, transicoesStatus, semCodigoRastreio, funilPorPlataforma, provedores,
      tempoTransporte, tempoTotal, distribuicaoEntrega,
    ] = await Promise.all([
      query(`
        WITH primeiro_evento AS (
          SELECT DISTINCT ON (transacao_id) transacao_id, detectado_em, fonte
          FROM rastreio_eventos WHERE status_anterior IS NULL
          ORDER BY transacao_id, detectado_em ASC
        )
        SELECT btrim(d.plataforma) AS plataforma,
          count(*)::int AS amostras,
          round(avg(extract(epoch FROM (pe.detectado_em - d.criado_em)) / 3600)::numeric, 1)::float8 AS media_horas,
          round(percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (pe.detectado_em - d.criado_em)) / 3600
          )::numeric, 1)::float8 AS mediana_horas
        FROM primeiro_evento pe
        JOIN disparos_pos_venda d ON d.transacao_id = pe.transacao_id
        WHERE pe.fonte <> 'backfill-email' AND ${f.sql}
        GROUP BY 1 ORDER BY amostras DESC
      `, f.valores),
      query(`
        SELECT btrim(d.plataforma) AS plataforma,
          count(*)::int AS total,
          round(avg(extract(epoch FROM (now() - d.criado_em)) / 86400)::numeric, 1)::float8 AS media_dias_desde_compra,
          min(d.criado_em) AS compra_mais_antiga,
          max(d.criado_em) AS compra_mais_recente
        FROM rastreio_pedidos r JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.status_interno = 'nao_encontrado' AND ${f.sql}
        GROUP BY 1 ORDER BY total DESC
      `, f.valores),
      query(`
        WITH eventos AS (
          SELECT transacao_id, status_anterior, status_novo, detectado_em,
            LAG(detectado_em) OVER (PARTITION BY transacao_id ORDER BY detectado_em) AS entrou_em
          FROM rastreio_eventos WHERE fonte <> 'backfill-email'
        )
        SELECT status_anterior, status_novo,
          count(*)::int AS amostras,
          round(avg(extract(epoch FROM (detectado_em - entrou_em)) / 3600)::numeric, 1)::float8 AS media_horas,
          round(percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (detectado_em - entrou_em)) / 3600
          )::numeric, 1)::float8 AS mediana_horas
        FROM eventos ev JOIN disparos_pos_venda d ON d.transacao_id = ev.transacao_id
        WHERE ev.entrou_em IS NOT NULL AND ${f.sql}
        GROUP BY 1, 2 ORDER BY amostras DESC
      `, f.valores),
      query(`
        SELECT r.status_interno, btrim(d.plataforma) AS plataforma, count(*)::int AS total
        FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.provedor IS NOT NULL AND r.tracking_number IS NULL
          AND r.status_interno IN ('pending', 'shipped', 'delivered', 'cancelled')
          AND ${f.sql}
        GROUP BY 1, 2 ORDER BY total DESC
      `, f.valores),
      query(`
        SELECT btrim(d.plataforma) AS plataforma,
          count(*)::int AS total,
          count(*) FILTER (WHERE r.status_interno = 'pendente_consulta')::int AS pendente_consulta,
          count(*) FILTER (WHERE r.status_interno = 'nao_encontrado')::int AS nao_encontrado,
          count(*) FILTER (WHERE r.status_interno = 'pending')::int AS pending,
          count(*) FILTER (WHERE r.status_interno = 'shipped')::int AS shipped,
          count(*) FILTER (WHERE r.status_interno = 'delivered')::int AS delivered,
          count(*) FILTER (WHERE r.status_interno = 'cancelled')::int AS cancelled
        FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE ${f.sql}
        GROUP BY 1 ORDER BY total DESC
      `, f.valores),
      query(`
        SELECT coalesce(r.provedor, 'nenhum') AS provedor, count(*)::int AS total
        FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE ${f.sql}
        GROUP BY 1 ORDER BY total DESC
      `, f.valores),
      // tempo_transporte/tempo_total: calculados direto de shipped_at/delivered_at/
      // d.criado_em (timestamps que a própria Red Rock devolve), não de
      // rastreio_eventos — por isso já têm massa de dado agora (pedidos antigos
      // "achados" só hoje já chegam com essas colunas preenchidas), diferente de
      // transicoes_status (que só ganha amostra quando o polling PEGA a mudança
      // acontecendo ao vivo). Não precisa excluir fonte='backfill-email' porque
      // não depende de rastreio_eventos nenhum.
      query(`
        SELECT btrim(d.plataforma) AS plataforma,
          count(*)::int AS amostras,
          round(avg(extract(epoch FROM (r.delivered_at - r.shipped_at)) / 3600)::numeric, 1)::float8 AS media_horas,
          round(percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (r.delivered_at - r.shipped_at)) / 3600
          )::numeric, 1)::float8 AS mediana_horas
        FROM rastreio_pedidos r JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.status_interno = 'delivered' AND r.shipped_at IS NOT NULL AND r.delivered_at IS NOT NULL AND ${f.sql}
        GROUP BY 1 ORDER BY amostras DESC
      `, f.valores),
      query(`
        SELECT btrim(d.plataforma) AS plataforma,
          count(*)::int AS amostras,
          round(avg(extract(epoch FROM (r.delivered_at - d.criado_em)) / 3600)::numeric, 1)::float8 AS media_horas,
          round(percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (r.delivered_at - d.criado_em)) / 3600
          )::numeric, 1)::float8 AS mediana_horas
        FROM rastreio_pedidos r JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.status_interno = 'delivered' AND r.delivered_at IS NOT NULL AND ${f.sql}
        GROUP BY 1 ORDER BY amostras DESC
      `, f.valores),
      // Distribuição do tempo total (compra → entrega) em faixas de dias, por
      // plataforma — pergunta que os números médios/medianos de tempo_total
      // não respondem sozinhos: "quantos pedidos demoraram MUITO", não só
      // "qual a média". Faixas fixas (não configuráveis) de propósito: é um
      // quadro pra escanear rápido, não mais um filtro pra configurar.
      query(`
        SELECT btrim(d.plataforma) AS plataforma,
          CASE
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 3 THEN 1
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 7 THEN 2
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 15 THEN 3
            ELSE 4
          END AS ordem,
          CASE
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 3 THEN 'Até 3 dias'
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 7 THEN '3 a 7 dias'
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 15 THEN '7 a 15 dias'
            ELSE '15 dias ou mais'
          END AS faixa,
          CASE
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 3 THEN 0
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 7 THEN 3
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 15 THEN 7
            ELSE 15
          END AS faixa_min_dias,
          CASE
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 3 THEN 3
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 7 THEN 7
            WHEN extract(epoch FROM (r.delivered_at - d.criado_em)) / 86400 < 15 THEN 15
            ELSE NULL
          END AS faixa_max_dias,
          count(*)::int AS total
        FROM rastreio_pedidos r JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
        WHERE r.status_interno = 'delivered' AND r.delivered_at IS NOT NULL AND ${f.sql}
        GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2
      `, f.valores),
    ]);

    return {
      tempo_para_encontrar: tempoParaEncontrar.rows,
      nao_encontrados: naoEncontrados.rows,
      transicoes_status: transicoesStatus.rows,
      sem_codigo_rastreio: semCodigoRastreio.rows,
      funil_por_plataforma: funilPorPlataforma.rows,
      provedores: provedores.rows,
      tempo_transporte: tempoTransporte.rows,
      tempo_total: tempoTotal.rows,
      distribuicao_entrega: distribuicaoEntrega.rows,
    };
  });

  /**
   * Drill-down: os pedidos por trás de UMA linha de qualquer tabela de
   * Saúde do rastreio (mesmo filtro produto/plataforma/período da linha,
   * mais a dimensão específica que a linha representa). `metrica` decide
   * qual duração (se alguma) calcular por pedido — os nomes espelham as 4
   * consultas de tempo de `/saude/` mais um modo `lista` sem duração, pras
   * tabelas que são só contagem (nao_encontrados, sem_codigo_rastreio,
   * funil_por_plataforma, provedores).
   */
  app.get('/api/metricas/rastreio/saude/detalhe/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Métricas'],
      summary: 'Drill-down: pedidos por trás de uma linha de Saúde do rastreio',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['metrica'],
        properties: {
          ...paginacaoParams,
          produto: { type: 'string' },
          plataforma: { type: 'string' },
          metrica: { type: 'string', enum: ['deteccao', 'transporte', 'total', 'transicao', 'lista'] },
          status_anterior: { type: 'string', description: 'Obrigatório quando metrica=transicao (vazio representa null, primeiro evento).' },
          status_novo: { type: 'string', description: 'Obrigatório quando metrica=transicao.' },
          status_interno: { type: 'string', description: 'Filtro extra pra metrica=lista (ex.: linha de funil_por_plataforma ou sem_codigo_rastreio).' },
          provedor: { type: 'string', description: 'Filtro extra pra metrica=lista (linha de provedores).' },
          sem_codigo: { type: 'string', enum: ['1'], description: "Filtro extra pra metrica=lista (linha de sem_codigo_rastreio) — restringe a 'provedor IS NOT NULL AND tracking_number IS NULL'." },
          dia: {
            type: 'string',
            description: 'Clique num ponto do gráfico de linha (YYYY-MM-DD) — filtra pelo dia de '
              + 'REFERÊNCIA da métrica (entrega pra transporte/total, evento pras outras), não pela '
              + 'data da compra. Independente de dias/data_de/data_ate (não usar os dois juntos).',
          },
          duracao_dias_min: { type: 'string', description: 'Clique numa faixa de "Distribuição do tempo de entrega" — só com metrica=transporte ou metrica=total.' },
          duracao_dias_max: { type: 'string', description: 'Exclusivo (< , não <=) — junto com duracao_dias_min forma a faixa clicada.' },
          ...PERIODO_QS,
        },
      },
      response: { 200: paginado('RastreioDetalheLinha') },
    },
  }, async (req) => {
    const f = filtroCompra(req.query);
    const { de, extra, duracaoExpr, valores } = resolverMetricaTempo(req, f);

    const COLUNAS_BASE = `r.transacao_id, d.nome, d.produto, btrim(d.plataforma) AS plataforma,
      r.status_interno, r.tracking_number, d.criado_em, r.shipped_at, r.delivered_at`;
    const duracaoSql = duracaoExpr ? `round((${duracaoExpr})::numeric, 1)::float8` : 'NULL::float8';
    const ordem = duracaoExpr ? 'duracao_horas DESC' : 'r.atualizado_em DESC';

    const onde = [f.sql, ...extra].join(' AND ');
    const base = `${de} WHERE ${onde}`;

    const cont = await query(`SELECT count(*)::int AS n ${base}`, valores);
    const { limit, offset, envelope } = fatiar(req, cont.rows[0].n);
    const { rows } = await query(
      `SELECT ${COLUNAS_BASE}, ${duracaoSql} AS duracao_horas ${base}
       ORDER BY ${ordem} LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, limit, offset],
    );
    return envelope(rows);
  });

  /**
   * Série diária (por plataforma) da mesma duração que `/saude/detalhe/`
   * calcula pedido a pedido — insumo do gráfico de linha "Evolução no
   * tempo". Não aceita metrica=lista (não tem duração pra agregar por dia).
   */
  app.get('/api/metricas/rastreio/saude/serie/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Métricas'],
      summary: 'Série diária de tempo de Saúde do rastreio, por plataforma',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['metrica'],
        properties: {
          produto: { type: 'string' },
          plataforma: { type: 'string' },
          metrica: { type: 'string', enum: ['deteccao', 'transporte', 'total', 'transicao'] },
          status_anterior: { type: 'string', description: 'Obrigatório quando metrica=transicao (vazio representa null, primeiro evento).' },
          status_novo: { type: 'string', description: 'Obrigatório quando metrica=transicao.' },
          ...PERIODO_QS,
        },
      },
      response: { 200: { $ref: 'SerieSaudeRastreio#' } },
    },
  }, async (req) => {
    const f = filtroCompra(req.query);
    const { de, extra, duracaoExpr, valores } = resolverMetricaTempo(req, f);
    if (!duracaoExpr) throw new ErroHttp(400, 'metrica precisa ser deteccao, transporte, total ou transicao.');

    // Dia de referência do ponto: quando a duração "aconteceu" — a data de
    // entrega pra transporte/total (não a da compra), o dia do evento pras
    // outras duas. Mesmo raciocínio de agrupar por status_anterior/novo em
    // vez de por compra: queremos achar QUANDO a operação ficou lenta, não
    // quando o pedido entrou.
    const diaExpr = req.query.metrica === 'transporte' || req.query.metrica === 'total'
      ? 'r.delivered_at' : req.query.metrica === 'deteccao' ? 'pe.detectado_em' : 'ev.detectado_em';

    const onde = [f.sql, ...extra].join(' AND ');
    const { rows } = await query(`
      SELECT (${diaExpr})::date AS dia, btrim(d.plataforma) AS plataforma,
        count(*)::int AS amostras,
        round(avg(${duracaoExpr})::numeric, 1)::float8 AS media_horas,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${duracaoExpr})::numeric, 1)::float8 AS mediana_horas
      ${de} WHERE ${onde}
      GROUP BY 1, 2 ORDER BY 1, 2
    `, valores);

    return { pontos: rows };
  });

  /* ═══════════════════════════  pública (lead)  ═══════════════════════ */

  app.get('/rastrear/:transacao_id', {
    schema: {
      tags: ['Rastreio'],
      summary: 'Rastreio público de um pedido (sem login)',
      description: 'Pro lead consultar o próprio pedido pelo transacao_id. Nunca devolve '
        + 'endereço, e-mail ou telefone. `encontrado: false` cobre 3 situações diferentes '
        + '(pedido inexistente, ainda não consultado, ou não encontrado na Red Rock) de '
        + 'propósito — a resposta não diz qual, pra não virar oráculo de que IDs existem.',
      params: { type: 'object', properties: { transacao_id: { type: 'string' } }, required: ['transacao_id'] },
      response: { 200: { $ref: 'RastreioPublico#' }, 429: { $ref: 'Erro#' } },
    },
  }, async (req, resposta) => {
    if (excedeuLimite(extrairIp(req.raw))) {
      throw new ErroHttp(429, 'Muitas consultas em pouco tempo. Tente de novo em 1 minuto.');
    }
    // Sem cache no navegador: um "ainda não chegou" guardado não deve
    // esconder um "chegou" real na próxima vez que o lead checar.
    resposta.header('Cache-Control', 'no-store');

    const { rows } = await query(
      `SELECT r.status_interno, r.carrier_code, r.tracking_number, r.tracking_url,
              r.tracking_status, r.order_created_at, r.shipped_at, r.delivered_at,
              r.tracking, r.atualizado_em, d.produto
       FROM rastreio_pedidos r LEFT JOIN disparos_pos_venda d ON d.transacao_id = r.transacao_id
       WHERE r.transacao_id = $1`,
      [req.params.transacao_id],
    );
    const MOSTRAVEL = new Set(['pending', 'shipped', 'delivered', 'cancelled']);
    if (!rows[0] || !MOSTRAVEL.has(rows[0].status_interno)) {
      return { encontrado: false };
    }

    const eventos = await query(
      `SELECT status_novo, detectado_em FROM rastreio_eventos
       WHERE transacao_id = $1 ORDER BY detectado_em DESC LIMIT 20`,
      [req.params.transacao_id],
    );
    const r = rows[0];
    return {
      encontrado: true,
      produto: r.produto,
      status_interno: r.status_interno,
      status_rotulo: ROTULO_STATUS[r.status_interno] ?? 'Rastreio ainda não disponível',
      carrier_code: r.carrier_code,
      tracking_number: r.tracking_number,
      tracking_url: r.tracking_url,
      tracking_status: r.tracking_status,
      shipped_at: r.shipped_at,
      delivered_at: r.delivered_at,
      eventos: eventos.rows.map((e) => ({ status: e.status_novo, em: e.detectado_em })),
      marcos: { criado_em: r.order_created_at, enviado_em: r.shipped_at, entregue_em: r.delivered_at },
      checkpoints_transportadora: checkpointsTransportadora(r.tracking),
      ...montarParado(r.status_interno, r.atualizado_em),
    };
  });
}
