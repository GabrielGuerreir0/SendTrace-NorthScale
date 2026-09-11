/**
 * Visão Geral — a Home do SendTrace (9ª aba, primeira que abre).
 *
 * Junta num só lugar números que hoje já existem no banco mas estão
 * espalhados entre Suporte IA, Régua, Tickets, Detalhes e Suporte Escalado —
 * várias colunas (`area_problema`, `sentimento`, reincidência, erro de envio)
 * já são gravadas pela IA há semanas e nunca apareceram em nenhuma tela.
 *
 * UMA função (`coletarVisaoGeral`) alimenta a rota — mesmo padrão de
 * `coletarMetricas` em relatorio.js: todas as sub-consultas rodam em
 * paralelo (`Promise.all`) sobre a MESMA janela de dias, e o retorno é um
 * JSON só. Os "Insights automáticos" (a faixa "o que mudou nas últimas 24h")
 * NÃO nascem aqui: eles já existem prontos em 4 lugares (régua, suporte IA,
 * tickets, suporte escalado) e são escolhidos no painel (server/dados.js),
 * que pega só o de maior severidade entre os quatro — não faz sentido
 * inventar uma 5ª fonte de insight do zero.
 *
 * Todo número devolvido por esta rota é medido, nunca decorativo — as ÚNICAS
 * exceções são as metas (`meta: 0.90`/`0.50` em GET .../metas), que são alvo
 * de negócio, não dado medido, e ficam marcadas como tal no comentário.
 */
import { query } from '../../server/db.js';
import { PIXEL_ABERTURA_DESDE } from './relatorio.js';

/** Nome do dia da semana a partir do número que o Postgres devolve (0 = domingo). */
const NOME_DIA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function coletarVisaoGeral(dias) {
  const p = [dias];

  const [
    ticketsStatus, casosEscaladosPendentes, reembolsos24h, emailsPlataformaPeriodo,
    erroEnvioAutomatico, ticketsReabertos, anexosDefeito, reguaComErro,
    perguntasSemResposta,
    chatResolucao, ticketsResolucao,
    areaProblema, sentimentoBase,
    resolucaoPorArea, volumeDiaSemana,
    motivosReembolso, clientesPorPlataforma, reembolsoTipoPeriodo,
    produtosProblema,
    aberturaRegua, ondeGeraContato,
    reincidentes, sentimentoNegativoPeriodo,
    coberturaProduto,
  ] = await Promise.all([
    // ── números críticos ──
    query(`
      SELECT count(*) FILTER (WHERE status = 'nao_iniciado')::int AS nao_iniciado,
             count(*) FILTER (WHERE status = 'em_aberto')::int    AS em_aberto,
             count(*) FILTER (WHERE status = 'resolvido')::int    AS resolvido,
             count(*)::int                                        AS total
      FROM email_ia.tickets`),

    query(`SELECT count(*)::int AS total FROM email_ia.suporte_escalado WHERE status = 'pendente'`),

    // `reembolsado_em` é o FATO independente de refund/chargeback (ver
    // schema-email-ia.sql, achado do caso caroleguym@gmail.com em 02/09) —
    // a MESMA coluna que já alimenta o insight de maior severidade da régua.
    // `chargeback_em` (11/09) é um recorte A MAIS de `reembolsado_em`: só
    // vem preenchida quando o evento foi especificamente chargeback, então
    // "reembolso puro" é `reembolsado_em IS NOT NULL AND chargeback_em IS NULL`.
    query(`
      SELECT count(*) FILTER (WHERE reembolsado_em >= now() - interval '24 hours')::int AS atual,
             count(*) FILTER (WHERE reembolsado_em <  now() - interval '24 hours'
                                AND reembolsado_em >= now() - interval '48 hours')::int  AS anterior,
             count(*) FILTER (WHERE chargeback_em >= now() - interval '24 hours')::int AS chargeback_atual,
             count(*) FILTER (WHERE chargeback_em <  now() - interval '24 hours'
                                AND chargeback_em >= now() - interval '48 hours')::int  AS chargeback_anterior
      FROM disparos_pos_venda`),

    query(`
      SELECT count(*)::int AS total FROM email_ia.emails
      WHERE plataforma_origem IS NOT NULL AND data_email >= now() - make_interval(days => $1::int)`, p),

    // ── saúde técnica ──
    query(`
      SELECT count(*)::int AS total FROM email_ia.emails
      WHERE erro_resposta_automatica IS NOT NULL AND plataforma_origem IS NULL
        AND data_email >= now() - make_interval(days => $1::int)`, p),

    query(`
      SELECT count(*) FILTER (WHERE reaberturas > 0)::int AS tickets,
             coalesce(sum(reaberturas), 0)::int            AS total_reaberturas
      FROM email_ia.tickets`),

    // Acumulado, sem filtro de período: email_ia.anexos não tem data própria
    // — mesma decisão já tomada em relatorio.js (coletarMetricas/fotosResumo).
    query(`
      SELECT count(*) FILTER (WHERE defeito_visivel = true)::int AS com_defeito,
             count(*)::int                                       AS total_analisadas
      FROM email_ia.anexos WHERE tipo_conteudo IS NOT NULL`),

    // "Ativos" = mesma definição de VIVOS usada em server/dados.js (estadoDe):
    // status ativo ou processando — os únicos onde um erro de envio ainda
    // pesa sobre alguém esperando a próxima mensagem.
    query(`
      SELECT count(*) FILTER (WHERE ultimo_erro IS NOT NULL)::int AS com_erro,
             count(*)::int                                        AS total
      FROM disparos_pos_venda WHERE status IN ('ativo', 'processando')`),

    // ── ponto positivo ──
    query(`
      SELECT count(*)::int AS total FROM chat_perguntas_sem_resposta
      WHERE criado_em >= now() - make_interval(days => $1::int)`, p),

    // ── metas do time (termômetros) ──
    // Mesma definição de "classificada"/"resolvida" de /api/metricas/suporte/:
    // `resolvido` nulo é conversa sem classificação e não entra na taxa.
    query(`
      SELECT count(*) FILTER (WHERE resolvido IS NOT NULL)::int AS classificadas,
             count(*) FILTER (WHERE resolvido)::int              AS resolvidas
      FROM chat_atendimentos
      WHERE coalesce(iniciado_em, criado_em) >= now() - make_interval(days => $1::int)`, p),

    query(`
      SELECT count(*) FILTER (WHERE status = 'resolvido')::int AS resolvidos, count(*)::int AS total
      FROM email_ia.tickets`),

    // ── diagnóstico da base ──
    query(`
      SELECT area_problema, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - make_interval(days => $1::int)
        AND plataforma_origem IS NULL AND area_problema IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`, p),

    // Inclui quem NÃO tem sentimento classificado como fatia própria — sem
    // isso o total das fatias somaria menos que o total de e-mails do
    // período, sem nenhuma explicação na tela.
    query(`
      SELECT coalesce(sentimento, 'sem_classificacao') AS sentimento, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - make_interval(days => $1::int) AND plataforma_origem IS NULL
      GROUP BY 1`, p),

    // ── tempo médio de resolução por área ──
    // area_problema é uma coluna do E-MAIL, não do ticket — usa a
    // classificação mais RECENTE de cada cliente (DISTINCT ON) como a área
    // do ticket dele. Escolha defensável, não a única possível: um ticket
    // longo pode ter mudado de área no meio, mas é a aproximação mais
    // simples que não exige uma coluna nova em email_ia.tickets.
    query(`
      WITH area_cliente AS (
        SELECT DISTINCT ON (lower(remetente_email)) lower(remetente_email) AS email, area_problema
        FROM email_ia.emails
        WHERE area_problema IS NOT NULL AND plataforma_origem IS NULL
        ORDER BY lower(remetente_email), data_email DESC
      )
      SELECT ac.area_problema,
             count(*)::int AS tickets,
             round(avg(extract(epoch FROM (t.resolvido_em - t.primeiro_email_em)) / 3600.0))::int AS media_h
      FROM email_ia.tickets t
      JOIN area_cliente ac ON ac.email = lower(t.remetente_email)
      WHERE t.resolvido_em IS NOT NULL AND t.primeiro_email_em IS NOT NULL
        AND t.resolvido_em >= now() - make_interval(days => $1::int)
      GROUP BY ac.area_problema ORDER BY media_h DESC`, p),

    query(`
      SELECT extract(dow FROM data_email)::int AS dow, count(*)::int AS total
      FROM email_ia.emails
      WHERE data_email >= now() - make_interval(days => $1::int) AND plataforma_origem IS NULL
      GROUP BY 1 ORDER BY 1`, p),

    // ── reembolso: por quê e onde ──
    query(`
      SELECT motivo_devolucao, count(*)::int AS total
      FROM email_ia.emails
      WHERE categoria IN ('devolucao', 'troca') AND motivo_devolucao IS NOT NULL
        AND data_email >= now() - make_interval(days => $1::int) AND plataforma_origem IS NULL
      GROUP BY 1 ORDER BY 2 DESC`, p),

    // Todos os períodos, de propósito (mesma pergunta de "quantos clientes
    // cada plataforma trouxe", não "quantos neste mês").
    query(`
      SELECT plataforma_origem, count(*)::int AS total FROM email_ia.emails
      WHERE plataforma_origem IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),

    // Reembolso puro vs chargeback, no período — o evento de PAGAMENTO
    // reportado pela plataforma (não a razão que o cliente alega por e-mail,
    // que é `motivosReembolso` acima). `chargeback_em` só veio a existir em
    // 11/09/2026, então tudo antes disso só soma em "reembolso".
    query(`
      SELECT 'chargeback' AS tipo, count(*)::int AS total
      FROM disparos_pos_venda
      WHERE chargeback_em >= now() - make_interval(days => $1::int)
      UNION ALL
      SELECT 'reembolso' AS tipo, count(*)::int AS total
      FROM disparos_pos_venda
      WHERE reembolsado_em >= now() - make_interval(days => $1::int) AND chargeback_em IS NULL
      ORDER BY 2 DESC`, p),

    // ── concentração por produto (top 5, acumulado) ──
    // resolve_produto() normaliza grafias equivalentes da mesma oferta —
    // achado 04/09/2026, ver produtosComProblema() em emailIACentral.js.
    query(`
      SELECT coalesce(pr.nome, resolve_produto(e.produto_mencionado)) AS produto, count(*)::int AS total
      FROM email_ia.emails e
      LEFT JOIN produtos pr ON pr.slug = resolve_produto(e.produto_mencionado)
      WHERE e.categoria IN ('devolucao', 'reclamacao', 'troca') AND e.produto_mencionado IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`),

    // ── jornada do cliente (régua) ──
    // Mesma consulta de coletarMetricas() em relatorio.js: "enviados_aprox"
    // só conta pedidos criados depois que o pixel entrou no ar — comparar
    // com pedido de antes do pixel inflaria o denominador sem nunca poder
    // contar no numerador.
    query(`
      SELECT e.etapa, e.nome,
        (SELECT count(*)::int FROM disparos_pos_venda d
           WHERE d.etapa_atual > e.etapa AND d.criado_em >= $1::timestamptz) AS enviados_aprox,
        (SELECT count(DISTINCT ab.disparo_id)::int FROM aberturas_disparo ab
           JOIN disparos_pos_venda d2 ON d2.id = ab.disparo_id
           WHERE ab.etapa = e.etapa AND d2.criado_em >= $1::timestamptz) AS abertos
      FROM etapas_regua e
      WHERE e.etapa BETWEEN 0 AND 5
      ORDER BY e.etapa`, [PIXEL_ABERTURA_DESDE]),

    query(`
      SELECT coalesce(e.nome, 'Fora da régua') AS nome, count(*)::int AS total
      FROM chat_atendimentos a
      LEFT JOIN etapas_regua e ON e.etapa::text = a.etapa_regua::text
      WHERE coalesce(a.iniciado_em, a.criado_em) >= now() - make_interval(days => $1::int)
      GROUP BY coalesce(e.nome, 'Fora da régua') ORDER BY total DESC`, p),

    // ── clientes de risco ──
    // Mesmo limiar (2+) do card "reincidentes" de Mais Detalhes — todos os
    // períodos, de propósito: é sobre o HISTÓRICO do cliente, não sobre o mês.
    query(`
      SELECT count(*)::int AS total FROM (
        SELECT remetente_email FROM email_ia.emails
        WHERE categoria IN ('devolucao', 'troca')
        GROUP BY remetente_email HAVING count(*) >= 2
      ) x`),

    query(`
      SELECT count(DISTINCT lower(remetente_email))::int AS total
      FROM email_ia.emails
      WHERE sentimento IN ('negativo', 'muito_negativo')
        AND data_email >= now() - make_interval(days => $1::int)`, p),

    // ── cobertura de ficha de produto ──
    // produto_readmes é chave por NOME oficial do produto (não por slug) —
    // ver comentário em schema-email-ia.sql, seção "FICHA DO PRODUTO".
    query(`
      SELECT count(*)::int AS ativos,
             count(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM produto_readmes r WHERE r.produto = p.nome AND r.ativo = true
               ))::int AS com_ficha
      FROM produtos p WHERE p.ativo = true`),
  ]);

  const t = ticketsStatus.rows[0];
  const chat = chatResolucao.rows[0];
  const tkResol = ticketsResolucao.rows[0];
  const anexos = anexosDefeito.rows[0];
  const regua = reguaComErro.rows[0];
  const reab = ticketsReabertos.rows[0];
  const cobertura = coberturaProduto.rows[0];
  const taxa = (a, b) => (b > 0 ? a / b : null);

  return {
    periodo_dias: dias,
    criticos: {
      tickets_sem_resolucao: {
        nao_iniciado: t.nao_iniciado, em_aberto: t.em_aberto, resolvido: t.resolvido, total: t.total,
      },
      casos_escalados_pendentes: casosEscaladosPendentes.rows[0].total,
      reembolsos_24h: reembolsos24h.rows[0],
      emails_plataforma_periodo: emailsPlataformaPeriodo.rows[0].total,
    },
    saude: {
      erro_envio_automatico: erroEnvioAutomatico.rows[0].total,
      tickets_reabertos: reab,
      anexos_defeito: anexos,
      regua_com_erro: regua,
    },
    ponto_positivo: {
      perguntas_sem_resposta: perguntasSemResposta.rows[0].total,
    },
    // As metas (0.90/0.50) são ALVO de negócio, não dado medido — únicos
    // números fixos desta rota, por decisão explícita da tarefa (as barras
    // "termômetro" precisam de uma referência pra fazer sentido visualmente).
    metas: {
      chat: {
        resolvidas: chat.resolvidas, classificadas: chat.classificadas,
        taxa: taxa(chat.resolvidas, chat.classificadas), meta: 0.90,
      },
      tickets: {
        resolvidos: tkResol.resolvidos, total: tkResol.total,
        taxa: taxa(tkResol.resolvidos, tkResol.total), meta: 0.50,
      },
    },
    diagnostico: {
      area_problema: areaProblema.rows,
      sentimento: sentimentoBase.rows,
    },
    resolucao_por_area: resolucaoPorArea.rows,
    volume_dia_semana: volumeDiaSemana.rows.map((r) => ({ ...r, nome: NOME_DIA_SEMANA[r.dow] })),
    reembolso: {
      motivos: motivosReembolso.rows,
      plataformas: clientesPorPlataforma.rows,
      // Tipo do evento de pagamento (reembolso puro vs chargeback) — não
      // confundir com `motivos` acima, que é a razão que o CLIENTE alega
      // por e-mail. Ver comentário da query em reembolsoTipoPeriodo.
      tipos: reembolsoTipoPeriodo.rows,
    },
    produtos_problema: produtosProblema.rows,
    jornada: {
      abertura_regua: aberturaRegua.rows.map((r) => ({ ...r, taxa: taxa(r.abertos, r.enviados_aprox) })),
      onde_gera_contato: ondeGeraContato.rows,
    },
    risco: {
      reincidentes: reincidentes.rows[0].total,
      sentimento_negativo_periodo: sentimentoNegativoPeriodo.rows[0].total,
    },
    cobertura_produto: cobertura,
  };
}

function diasDaQuery(req) {
  const bruto = Number(req.query.dias);
  if (!Number.isFinite(bruto)) return 30;
  return Math.min(365, Math.max(1, Math.round(bruto)));
}

export default async function rotasVisaoGeral(app) {
  app.get('/api/visao-geral/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Números agregados da Home (Visão Geral) — 9ª aba, a primeira que abre',
      description: 'Não inclui os "Insights automáticos" da faixa do topo — esses já existem '
        + 'prontos em 4 rotas (régua, suporte IA, tickets, suporte escalado) e o painel escolhe '
        + 'só o de maior severidade entre os quatro (ver visaoGeralResumo em server/dados.js).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { dias: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      },
    },
  }, async (req) => coletarVisaoGeral(diasDaQuery(req)));
}
