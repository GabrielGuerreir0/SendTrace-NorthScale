/**
 * As perguntas AGREGADAS sobre a fila.
 *
 * Esta é a diferença entre um CRUD e um backend que serve um painel: sem estas
 * rotas, contar 100 mil pedidos significa trafegar 100 mil pedidos para exibir
 * seis números. O banco responde isso numa passada, e o que sai daqui são
 * dezenas de bytes.
 *
 * Todas aceitam `?produto=` (pelo NOME, com as ofertas somadas) e
 * `?plataforma=` (DigiStore24, JVZoo, BuyGoods…) — os dois se combinam — e,
 * onde faz sentido, `?etapa=`.
 */
import { query } from '../../server/db.js';
import { LOCK_TIMEOUT_MIN } from '../../server/config.js';
import {
  ESTADO, NOME_PRODUTO, DO_PRODUTO, DA_PLATAFORMA, CANAL_DO_ERRO, STATUS_CANCELADO,
} from '../sql.js';

/** $1 é sempre o lock; $2, o produto; $3, a plataforma. A ordem evita confusão. */
const base = (produto, plataforma) => [LOCK_TIMEOUT_MIN, produto ?? null, plataforma ?? null];

const filtroProduto = {
  produto: { type: 'string', description: 'Nome do produto (as ofertas contam juntas). Vazio = todos.' },
  plataforma: { type: 'string', description: "Plataforma de venda exata: 'DigiStore24', 'JVZoo', 'BuyGoods'… Vazio = todas." },
};

export default async function rotasMetricas(app) {
  /* ────────────────────────  visão geral  ──────────────────────── */

  app.get('/api/metricas/estados/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Quantos pedidos em cada estado',
      description: 'Os seis estados são mutuamente exclusivos e somam o total. '
        + '**Cancelado nunca é somado a finalizado**: os dois saíram da régua, mas '
        + 'por motivos opostos.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { ...filtroProduto, etapa: { type: 'integer' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            na_regua: { type: 'integer', description: 'Ainda circulando: os quatro estados vivos.' },
            em_dia: { type: 'integer' },
            atrasado: { type: 'integer' },
            processando: { type: 'integer' },
            travado: { type: 'integer' },
            finalizado: { type: 'integer' },
            cancelado: { type: 'integer' },
            com_erro: { type: 'integer' },
            com_retry: { type: 'integer' },
            novos_24h: { type: 'integer' },
            prestes: { type: 'integer', description: 'Dispara na próxima hora e ainda não venceu.' },
            novos_24h_anterior: { type: 'integer', description: 'Entradas nas 24h ANTERIORES às últimas 24h — alimenta os insights.' },
            reembolsos_24h: { type: 'integer' },
            reembolsos_24h_anterior: { type: 'integer' },
            aberturas_24h: { type: 'integer' },
            aberturas_24h_anterior: { type: 'integer' },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const valores = base(req.query.produto, req.query.plataforma);
    let etapaSql = '';
    if (req.query.etapa !== undefined) {
      valores.push(Number(req.query.etapa));
      etapaSql = ` AND etapa_atual = $${valores.length}::int`;
    }

    const { rows } = await query(
      `SELECT
         count(*)::int                                            AS total,
         count(*) FILTER (WHERE ${ESTADO} = 'em_dia')::int         AS em_dia,
         count(*) FILTER (WHERE ${ESTADO} = 'atrasado')::int       AS atrasado,
         count(*) FILTER (WHERE ${ESTADO} = 'processando')::int    AS processando,
         count(*) FILTER (WHERE ${ESTADO} = 'travado')::int        AS travado,
         count(*) FILTER (WHERE ${ESTADO} = 'finalizado')::int     AS finalizado,
         count(*) FILTER (WHERE ${ESTADO} = 'cancelado')::int      AS cancelado,
         count(*) FILTER (WHERE ultimo_erro IS NOT NULL)::int      AS com_erro,
         count(*) FILTER (WHERE tentativas > 0)::int               AS com_retry,
         count(*) FILTER (WHERE criado_em >= now() - interval '24 hours')::int AS novos_24h,
         count(*) FILTER (
           WHERE status = 'ativo' AND proximo_disparo > now()
             AND proximo_disparo <= now() + interval '1 hour')::int AS prestes,
         -- As duas colunas abaixo alimentam os "Insights automáticos" da aba de
         -- régua: 24h × as 24h ANTERIORES, mesmo formato usado pelo suporte IA.
         count(*) FILTER (
           WHERE criado_em <  now() - interval '24 hours'
             AND criado_em >= now() - interval '48 hours')::int    AS novos_24h_anterior,
         count(*) FILTER (WHERE reembolsado_em >= now() - interval '24 hours')::int AS reembolsos_24h,
         count(*) FILTER (
           WHERE reembolsado_em <  now() - interval '24 hours'
             AND reembolsado_em >= now() - interval '48 hours')::int AS reembolsos_24h_anterior,
         -- Abertura de e-mail (pixel de rastreio, aberturas_disparo) — junta com
         -- a MESMA disparos_pos_venda pra herdar o recorte de produto/plataforma
         -- da consulta de fora, em vez de um recorte próprio.
         (SELECT count(*)::int FROM aberturas_disparo ab
          JOIN disparos_pos_venda d ON d.id = ab.disparo_id
          WHERE ab.aberto_em >= now() - interval '24 hours'
            AND ${DO_PRODUTO(2, 'd.')} AND ${DA_PLATAFORMA(3, 'd.')}) AS aberturas_24h,
         (SELECT count(*)::int FROM aberturas_disparo ab
          JOIN disparos_pos_venda d ON d.id = ab.disparo_id
          WHERE ab.aberto_em <  now() - interval '24 hours'
            AND ab.aberto_em >= now() - interval '48 hours'
            AND ${DO_PRODUTO(2, 'd.')} AND ${DA_PLATAFORMA(3, 'd.')}) AS aberturas_24h_anterior
       FROM disparos_pos_venda
       WHERE ${DO_PRODUTO(2)} AND ${DA_PLATAFORMA(3)}${etapaSql}`,
      valores,
    );
    const t = rows[0];
    return { ...t, na_regua: t.em_dia + t.atrasado + t.processando + t.travado };
  });

  app.get('/api/metricas/etapas/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Consolidado por etapa',
      description: 'Uma linha por etapa, com os seis estados e os sinais de problema. '
        + '`na_etapa` é quem AINDA circula ali — um pedido finalizado continua '
        + 'carregando a etapa em que parou, e somá-lo contaria como "nesta etapa" '
        + 'alguém que já saiu.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: filtroProduto },
      response: { 200: { type: 'array', items: { $ref: 'ResumoEtapa#' } } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT
         etapa_atual::int                                          AS etapa,
         count(*)::int                                             AS total,
         count(*) FILTER (WHERE ${ESTADO} = 'em_dia')::int          AS em_dia,
         count(*) FILTER (WHERE ${ESTADO} = 'atrasado')::int        AS atrasado,
         count(*) FILTER (WHERE ${ESTADO} = 'processando')::int     AS processando,
         count(*) FILTER (WHERE ${ESTADO} = 'travado')::int         AS travado,
         count(*) FILTER (WHERE ${ESTADO} = 'finalizado')::int      AS finalizado,
         count(*) FILTER (WHERE ${ESTADO} = 'cancelado')::int       AS cancelado,
         count(*) FILTER (WHERE ${ESTADO} IN ('em_dia','atrasado','processando','travado'))::int AS na_etapa,
         count(*) FILTER (WHERE ultimo_erro IS NOT NULL)::int       AS com_erro,
         count(*) FILTER (WHERE tentativas > 0)::int                AS com_retry,
         count(*) FILTER (WHERE criado_em >= now() - interval '24 hours')::int AS novos_24h,
         count(*) FILTER (
           WHERE status = 'ativo' AND proximo_disparo > now()
             AND proximo_disparo <= now() + interval '1 hour')::int  AS prestes,
         min(proximo_disparo) FILTER (WHERE status = 'ativo')       AS proximo_em,
         coalesce(max(tentativas), 0)::int                          AS max_tentativas
       FROM disparos_pos_venda
       WHERE ${DO_PRODUTO(2)} AND ${DA_PLATAFORMA(3)}
       GROUP BY etapa_atual
       ORDER BY etapa_atual`,
      base(req.query.produto, req.query.plataforma),
    );
    return rows;
  });

  /* ──────────────────────────  produtos  ────────────────────────── */

  app.get('/api/metricas/produtos/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Catálogo de produtos da fila',
      description: 'Agrupado pelo NOME: as quatro ofertas de NeuroMind Pro viram uma '
        + 'linha só, com os pedidos somados. É a lista de onde se escolhe um filtro, '
        + 'então NÃO respeita o filtro de produto — mas aceita `?plataforma=`, para '
        + 'oferecer só os produtos que aquela plataforma vende.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limite: { type: 'integer', default: 300, maximum: 1000 },
          plataforma: { type: 'string', description: "Só os produtos desta plataforma: 'DigiStore24', 'JVZoo', 'BuyGoods'… Vazio = todas." },
        },
      },
      response: { 200: { type: 'array', items: { $ref: 'Produto#' } } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT nome AS produto, count(*)::int AS total
       FROM (SELECT ${NOME_PRODUTO()} AS nome FROM disparos_pos_venda
             WHERE produto IS NOT NULL AND btrim(produto) <> ''
               AND ${DA_PLATAFORMA(2)}) t
       GROUP BY nome ORDER BY count(*) DESC, nome LIMIT $1`,
      [Math.min(1000, Number(req.query.limite) || 300), req.query.plataforma ?? null],
    );
    return rows;
  });

  app.get('/api/metricas/plataformas/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Catálogo de plataformas de venda da fila',
      description: 'As plataformas presentes na fila (DigiStore24, JVZoo, BuyGoods…), '
        + 'com o total de pedidos de cada uma. É a lista de onde se escolhe um filtro, '
        + 'então NÃO respeita os filtros de recorte. Pedidos sem plataforma não viram opção.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { limite: { type: 'integer', default: 50, maximum: 200 } } },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              plataforma: { type: 'string' },
              total: { type: 'integer' },
            },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT btrim(plataforma) AS plataforma, count(*)::int AS total
       FROM disparos_pos_venda
       WHERE plataforma IS NOT NULL AND btrim(plataforma) <> ''
       GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT $1`,
      [Math.min(200, Number(req.query.limite) || 50)],
    );
    return rows;
  });

  app.get('/api/metricas/status/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Distribuição crua da coluna status',
      description: 'Sem interpretação nenhuma — serve para descobrir valores que o '
        + 'painel ainda não conhece, como um status novo que o n8n passou a gravar.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: filtroProduto },
      response: { 200: { type: 'array', items: { $ref: 'ContagemStatus#' } } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT status, count(*)::int AS total FROM disparos_pos_venda
       WHERE ${DO_PRODUTO(1)} AND ${DA_PLATAFORMA(2)}
       GROUP BY status ORDER BY total DESC, status`,
      [req.query.produto ?? null, req.query.plataforma ?? null],
    );
    return rows;
  });

  /* ────────────────────────────  tempo  ─────────────────────────── */

  app.get('/api/metricas/onda/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Disparos agendados hora a hora',
      description: 'Quantos disparos caem em cada hora das próximas N horas. É a onda '
        + 'que vem — serve para ver pico antes de ele acontecer.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...filtroProduto,
          horas: { type: 'integer', default: 48, minimum: 1, maximum: 336 },
          etapa: { type: 'integer' },
        },
      },
      response: { 200: { type: 'array', items: { $ref: 'Balde#' } } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    /*
     * Esta consulta não classifica estado, então NÃO recebe o parâmetro do
     * lock. Passá-lo sem usar faz o Postgres recusar a consulta inteira com
     * "could not determine data type of parameter $1" — um parâmetro sobrando
     * é erro, não algo ignorado.
     */
    const valores = [req.query.produto ?? null, Number(req.query.horas) || 48,
      req.query.plataforma ?? null];
    let etapaSql = '';
    if (req.query.etapa !== undefined) {
      valores.push(Number(req.query.etapa));
      etapaSql = ` AND etapa_atual = $${valores.length}::int`;
    }
    const { rows } = await query(
      `SELECT date_trunc('hour', proximo_disparo) AS inicio, count(*)::int AS total
       FROM disparos_pos_venda
       WHERE status = 'ativo'
         AND proximo_disparo >= date_trunc('hour', now())
         AND proximo_disparo <  now() + make_interval(hours => $2::int)
         AND ${DO_PRODUTO(1)} AND ${DA_PLATAFORMA(3)}${etapaSql}
       GROUP BY 1 ORDER BY 1`,
      valores,
    );
    return rows;
  });

  app.get('/api/metricas/entradas/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Pedidos novos por dia',
      description: 'O corte do dia usa o fuso do painel (`TZ_PAINEL`), não o do banco: '
        + 'em UTC, tudo que entra entre 21h e meia-noite no Brasil cairia no dia seguinte.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { ...filtroProduto, dias: { type: 'integer', default: 14, minimum: 1, maximum: 365 } },
      },
      response: { 200: { type: 'array', items: { $ref: 'EntradaDia#' } } },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const tz = process.env.TZ_PAINEL || 'America/Sao_Paulo';
    const dias = Number(req.query.dias) || 14;
    const { rows } = await query(
      `SELECT to_char(date_trunc('day', criado_em AT TIME ZONE $1), 'YYYY-MM-DD') AS dia,
              count(*)::int AS total
       FROM disparos_pos_venda
       WHERE criado_em >= date_trunc('day', (now() AT TIME ZONE $1) - make_interval(days => $3::int)) AT TIME ZONE $1
         AND ${DO_PRODUTO(2)} AND ${DA_PLATAFORMA(4)}
       GROUP BY 1 ORDER BY 1`,
      [tz, req.query.produto ?? null, dias - 1, req.query.plataforma ?? null],
    );
    return rows;
  });

  /* ──────────────────────────  problemas  ───────────────────────── */

  app.get('/api/metricas/canais/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Alcance por canal',
      description: 'Toda etapa dispara e-mail E SMS ao mesmo tempo, então a pergunta '
        + 'não é "qual o canal desta etapa" e sim quantos cada canal ALCANÇA. Duas '
        + 'perdas contadas à parte: `sem_contato` é falta de dado do comprador; '
        + '`sem_mensagem` é falta de copy cadastrada.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...filtroProduto,
          linha: { type: 'string', default: '1', description: 'Qual linha de copy considerar.' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            canais: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  canal: { type: 'string' },
                  total: { type: 'integer' },
                  alcancavel: { type: 'integer' },
                  sem_contato: { type: 'integer' },
                  com_erro: { type: 'integer' },
                },
              },
            },
            sem_mensagem: { type: 'integer' },
            erro_sem_canal: { type: 'integer', description: 'Erros cujo texto não diz o canal.' },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const linha = String(req.query.linha ?? '1');
    const produto = req.query.produto ?? null;
    const plataforma = req.query.plataforma ?? null;
    const TEM_CONTATO = `CASE c.canal
        WHEN 'email' THEN d.email    IS NOT NULL AND d.email    <> ''
        ELSE              d.telefone IS NOT NULL AND d.telefone <> ''
      END`;

    // CROSS JOIN com a lista fixa de canais + EXISTS, em vez de JOIN direto na
    // mensagens_regua: com três linhas por (etapa, canal), o JOIN multiplicaria
    // cada pedido por três e TODAS as contagens sairiam infladas.
    //
    // O EXISTS casa só com `produto = '*'`: "a régua está completa" é uma
    // pergunta sobre o PADRÃO — a cascata garante que todo produto tem para
    // onde cair, então copy por produto não muda a cobertura.
    const canais = await query(
      `SELECT c.canal,
              count(*)::int                                   AS total,
              count(*) FILTER (WHERE ${TEM_CONTATO})::int      AS alcancavel,
              count(*) FILTER (WHERE NOT ${TEM_CONTATO})::int  AS sem_contato,
              count(*) FILTER (WHERE ${CANAL_DO_ERRO('d')} = c.canal)::int AS com_erro
       FROM disparos_pos_venda d
       CROSS JOIN (VALUES ('email'), ('sms')) AS c(canal)
       WHERE d.status IN ('ativo', 'processando')
         AND ${DO_PRODUTO(1, 'd.')} AND ${DA_PLATAFORMA(3, 'd.')}
         AND EXISTS (SELECT 1 FROM mensagens_regua m
                      WHERE m.etapa = d.etapa_atual AND m.canal = c.canal
                        AND m.ativo AND m.linha = $2::text AND m.produto = '*')
       GROUP BY c.canal ORDER BY total DESC, c.canal`,
      [produto, linha, plataforma],
    );

    const orfaos = await query(
      `SELECT
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM mensagens_regua m
            WHERE m.etapa = d.etapa_atual AND m.ativo AND m.linha = $2::text
              AND m.produto = '*'))::int AS sem_mensagem,
         count(*) FILTER (WHERE d.ultimo_erro IS NOT NULL
                            AND ${CANAL_DO_ERRO('d')} IS NULL)::int AS erro_sem_canal
       FROM disparos_pos_venda d
       WHERE d.status IN ('ativo', 'processando')
         AND ${DO_PRODUTO(1, 'd.')} AND ${DA_PLATAFORMA(3, 'd.')}`,
      [produto, linha, plataforma],
    );

    return { canais: canais.rows, ...orfaos.rows[0] };
  });

  app.get('/api/metricas/alertas/', {
    schema: {
      tags: ['Métricas'],
      summary: 'O que precisa de atenção',
      description: 'Erros registrados, itens presos no worker e disparos vencidos há '
        + 'mais de uma hora — os três casos em que alguém precisa olhar.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { ...filtroProduto, limite: { type: 'integer', default: 25, maximum: 200 } },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              transacao_id: { type: 'string' },
              nome: { type: ['string', 'null'] },
              produto: { type: ['string', 'null'] },
              etapa: { type: 'integer' },
              status: { type: 'string' },
              estado: { type: 'string' },
              tentativas: { type: 'integer' },
              ultimo_erro: { type: ['string', 'null'] },
              canal_erro: { type: ['string', 'null'] },
              proximo_disparo: { type: ['string', 'null'], format: 'date-time' },
              claimed_at: { type: ['string', 'null'], format: 'date-time' },
              criado_em: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT id, transacao_id, nome, produto, etapa_atual::int AS etapa, status,
              tentativas, ultimo_erro, proximo_disparo, claimed_at, criado_em,
              ${ESTADO} AS estado,
              ${CANAL_DO_ERRO('disparos_pos_venda')} AS canal_erro
       FROM disparos_pos_venda
       WHERE ${DO_PRODUTO(2)} AND ${DA_PLATAFORMA(3)}
         AND (ultimo_erro IS NOT NULL
           OR (status = 'processando'
               AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1::int)))
           OR (status = 'ativo' AND proximo_disparo <= now() - interval '1 hour'))
       ORDER BY tentativas DESC, proximo_disparo ASC
       LIMIT $4`,
      [...base(req.query.produto, req.query.plataforma),
        Math.min(200, Number(req.query.limite) || 25)],
    );
    return rows;
  });

  /* ──────────────────────  suporte IA (dashboard)  ───────────────────── */

  app.get('/api/metricas/suporte/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Tudo que o dashboard do suporte IA mostra, numa resposta só',
      description: 'KPIs (resolution rate, refund save rate, CSAT, tempo médio, '
        + 'utilização do chat), ranking de motivos de contato, perguntas sem '
        + 'resposta, contatos por etapa da régua e as comparações 24h × 24h '
        + 'anteriores que alimentam os insights. `dias` recorta a janela dos '
        + 'KPIs e rankings (padrão 30). `produto` e `plataforma` recortam '
        + 'TUDO: a conversa entra quando o pedido dela (via transacao_id) '
        + 'pertence ao recorte.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          dias: { type: 'integer', default: 30, minimum: 1, maximum: 365 },
          ...filtroProduto,
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 30));
    const produto = req.query.produto ?? null;
    const plataforma = req.query.plataforma ?? null;

    /*
     * O recorte do topo, aplicado a uma tabela de CONVERSAS: a conversa
     * pertence ao recorte quando o pedido dela (achado pelo transacao_id)
     * pertence. EXISTS, não JOIN — um transacao_id repetido na fila não pode
     * duplicar a conversa na contagem.
     *
     * Sem recorte a condição é literalmente verdadeira e nada muda; COM
     * recorte, conversas sem transação (só e-mail, sem pedido casado) ficam
     * de fora — não há como saber de que produto elas falam.
     *
     * `np`/`nq` são as POSIÇÕES dos parâmetros produto/plataforma em cada
     * consulta — elas variam, e um número errado casaria com outro valor.
     */
    const recorte = (np, nq) => `($${np}::text IS NULL AND $${nq}::text IS NULL
      OR EXISTS (SELECT 1 FROM disparos_pos_venda d
                 WHERE d.transacao_id = a.transacao_id
                   AND ${DO_PRODUTO(np, 'd.')} AND ${DA_PLATAFORMA(nq, 'd.')}))`;

    /*
     * KPIs da janela. As taxas são calculadas SÓ sobre quem tem o dado:
     * `resolvido` nulo é conversa de antes das colunas (ou bot antigo) e não
     * entra no resolution rate — contá-la como "não resolvida" afundaria a
     * taxa com dado que não existe.
     */
    const kpis = await query(
      `SELECT
         count(*)::int                                                AS conversas,
         count(*) FILTER (WHERE resolvido IS NOT NULL)::int           AS classificadas,
         count(*) FILTER (WHERE resolvido)::int                       AS resolvidas,
         count(*) FILTER (WHERE resolvido = false)::int               AS nao_resolvidas,
         count(*) FILTER (WHERE reembolso_pedido)::int                AS reembolso_pedidos,
         count(*) FILTER (WHERE reembolso_evitado)::int               AS reembolso_evitados,
         count(*) FILTER (WHERE reembolso_pedido
                            AND NOT coalesce(reembolso_evitado, false))::int AS reembolsos_consumados,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM disparos_pos_venda d
           WHERE d.transacao_id = a.transacao_id
             AND lower(btrim(d.status)) IN ${STATUS_CANCELADO}))::int AS pedidos_cancelados,
         round(avg(duracao_s) FILTER (WHERE duracao_s IS NOT NULL))::int AS tempo_medio_s,
         round(avg(csat) FILTER (WHERE csat IS NOT NULL)::numeric, 2)::float8 AS csat_media,
         count(csat)::int                                             AS csat_respostas,
         count(DISTINCT coalesce(transacao_id, lower(email)))::int    AS clientes_chat
       FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - make_interval(days => $1::int)
         AND ${recorte(2, 3)}`,
      [dias, produto, plataforma],
    );

    // O denominador da taxa de utilização: quantos pedidos existem na fila —
    // DO RECORTE, para a taxa comparar chat e fila do mesmo universo. É a
    // fila inteira, não a janela: o cliente de um pedido antigo ainda pode
    // abrir o chat hoje.
    const fila = await query(
      `SELECT count(DISTINCT transacao_id)::int AS pedidos FROM disparos_pos_venda
       WHERE ${DO_PRODUTO(1)} AND ${DA_PLATAFORMA(2)}`,
      [produto, plataforma],
    );

    // Ranking por TÓPICO: nome e descrição vêm de chat_topicos; o slug
    // (motivo) segue como chave. Atendimento com motivo mas sem tópico
    // (registro de antes da tabela) ainda aparece, pelo slug. Conversa sem
    // motivo nenhum fica de fora do ranking mas é contada à parte.
    const motivos = await query(
      `SELECT coalesce(t.slug, a.motivo)             AS motivo,
              coalesce(t.nome, a.motivo)             AS nome,
              max(t.descricao)                       AS descricao,
              count(*)::int                          AS total,
              count(*) FILTER (WHERE resolvido)::int AS resolvidos
       FROM chat_atendimentos a
       LEFT JOIN chat_topicos t ON t.id = a.topico_id
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - make_interval(days => $1::int)
         AND (a.motivo IS NOT NULL OR a.topico_id IS NOT NULL)
         AND ${recorte(2, 3)}
       GROUP BY 1, 2 ORDER BY total DESC, 1 LIMIT 15`,
      [dias, produto, plataforma],
    );
    const semMotivo = await query(
      `SELECT count(*)::int AS n FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - make_interval(days => $1::int)
         AND motivo IS NULL
         AND ${recorte(2, 3)}`,
      [dias, produto, plataforma],
    );

    // Perguntas sem resposta, agrupadas pelo texto normalizado. O exemplo
    // exibido é a ocorrência mais recente — a frase real de um cliente real.
    const perguntas = await query(
      `SELECT (array_agg(pergunta ORDER BY criado_em DESC))[1] AS pergunta,
              count(*)::int                                    AS total,
              max(criado_em)                                   AS ultima_em
       FROM chat_perguntas_sem_resposta a
       WHERE criado_em >= now() - make_interval(days => $1::int)
         AND ${recorte(2, 3)}
       GROUP BY lower(pergunta)
       ORDER BY total DESC, max(criado_em) DESC LIMIT 20`,
      [dias, produto, plataforma],
    );

    // Onde na jornada nascem os contatos — a performance da régua.
    const regua = await query(
      `SELECT etapa_regua::int AS etapa, count(*)::int AS total,
              count(*) FILTER (WHERE reembolso_pedido)::int AS reembolsos
       FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - make_interval(days => $1::int)
         AND etapa_regua IS NOT NULL
         AND ${recorte(2, 3)}
       GROUP BY etapa_regua ORDER BY etapa_regua`,
      [dias, produto, plataforma],
    );

    /*
     * As comparações que viram insights: últimas 24h × as 24h ANTERIORES.
     * Vêm cruas — quem escreve as frases é o painel; a API entrega números
     * auditáveis.
     */
    const motivos24 = await query(
      `SELECT motivo,
              count(*) FILTER (WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - interval '24 hours')::int AS atual,
              count(*) FILTER (WHERE coalesce(a.iniciado_em, a.criado_em) <  now() - interval '24 hours')::int AS anterior
       FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - interval '48 hours' AND motivo IS NOT NULL
         AND ${recorte(1, 2)}
       GROUP BY motivo ORDER BY atual DESC`,
      [produto, plataforma],
    );
    const gerais24 = await query(
      `SELECT
         count(*) FILTER (WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - interval '24 hours')::int AS conversas_atual,
         count(*) FILTER (WHERE coalesce(a.iniciado_em, a.criado_em) <  now() - interval '24 hours')::int AS conversas_anterior,
         count(*) FILTER (WHERE reembolso_pedido AND coalesce(a.iniciado_em, a.criado_em) >= now() - interval '24 hours')::int AS reembolsos_atual,
         count(*) FILTER (WHERE reembolso_pedido AND coalesce(a.iniciado_em, a.criado_em) <  now() - interval '24 hours')::int AS reembolsos_anterior,
         count(*) FILTER (WHERE resolvido = false AND coalesce(a.iniciado_em, a.criado_em) >= now() - interval '24 hours')::int AS nao_resolvidas_atual
       FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - interval '48 hours'
         AND ${recorte(1, 2)}`,
      [produto, plataforma],
    );
    const perguntas24 = await query(
      `SELECT
         count(*) FILTER (WHERE criado_em >= now() - interval '24 hours')::int AS atual,
         count(*) FILTER (WHERE criado_em <  now() - interval '24 hours')::int AS anterior
       FROM chat_perguntas_sem_resposta a
       WHERE criado_em >= now() - interval '48 hours'
         AND ${recorte(1, 2)}`,
      [produto, plataforma],
    );
    // Um motivo que apareceu nas últimas 24h sem NENHUMA ocorrência nos 7
    // dias anteriores é padrão novo — o tipo de coisa que vira ação imediata.
    // O "sem ocorrência" olha a operação INTEIRA de propósito: um motivo
    // corriqueiro noutro produto não é padrão novo só porque o recorte mudou.
    const motivosNovos = await query(
      `SELECT motivo, count(*)::int AS total
       FROM chat_atendimentos a
       WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - interval '24 hours'
         AND motivo IS NOT NULL
         AND ${recorte(1, 2)}
         AND NOT EXISTS (
           SELECT 1 FROM chat_atendimentos b
           WHERE b.motivo = a.motivo
             AND coalesce(b.iniciado_em, b.criado_em) >= now() - interval '8 days'
             AND coalesce(b.iniciado_em, b.criado_em) <  now() - interval '24 hours')
       GROUP BY motivo ORDER BY total DESC LIMIT 5`,
      [produto, plataforma],
    );

    const k = kpis.rows[0];
    const taxa = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
    return {
      janela_dias: dias,
      recorte: { produto, plataforma },
      kpis: {
        ...k,
        resolution_rate: taxa(k.resolvidas, k.classificadas),
        refund_save_rate: taxa(k.reembolso_evitados, k.reembolso_pedidos),
        // A taxa da tela: de TODAS as conversas com a IA, quantas têm o
        // PEDIDO de fato cancelado NA FILA (verificado pelo status em
        // disparos_pos_venda, não pelo que a conversa registrou). O
        // complemento é quem conversou e não cancelou. Conversa sem pedido
        // casado conta como não cancelada — não há o que verificar.
        taxa_reembolso: taxa(k.pedidos_cancelados, k.conversas),
        pedidos_fila: fila.rows[0].pedidos,
        taxa_utilizacao: taxa(k.clientes_chat, fila.rows[0].pedidos),
      },
      motivos: motivos.rows,
      sem_motivo: semMotivo.rows[0].n,
      perguntas: perguntas.rows,
      regua: regua.rows,
      tendencias: {
        motivos_24h: motivos24.rows,
        gerais_24h: gerais24.rows[0],
        perguntas_24h: perguntas24.rows[0],
        motivos_novos_24h: motivosNovos.rows,
      },
    };
  });

  app.get('/api/metricas/cadencia/', {
    schema: {
      tags: ['Métricas'],
      summary: 'Cadência observada × configurada',
      description: 'Mediana real de (próximo disparo − entrada) por etapa, em horas. '
        + 'Comparada com o `offset_h` da régua, revela deriva entre o que está '
        + 'escrito e o que está rodando.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: filtroProduto },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              etapa: { type: 'integer' },
              amostra: { type: 'integer' },
              mediana_h: { type: ['number', 'null'] },
              configurado_h: { type: ['number', 'null'] },
            },
          },
        },
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      `SELECT d.etapa_atual::int AS etapa,
              count(*)::int      AS amostra,
              round(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (d.proximo_disparo - d.criado_em)) / 3600.0
              )::numeric, 1)::float8 AS mediana_h,
              max(e.offset_h)::float8 AS configurado_h
       FROM disparos_pos_venda d
       LEFT JOIN etapas_regua e ON e.etapa = d.etapa_atual
       WHERE d.status = 'ativo' AND ${DO_PRODUTO(1, 'd.')} AND ${DA_PLATAFORMA(2, 'd.')}
       GROUP BY 1 ORDER BY 1`,
      [req.query.produto ?? null, req.query.plataforma ?? null],
    );
    return rows;
  });
}
