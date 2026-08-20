/**
 * Central de E-mail IA — tudo que é LEITURA pura do schema email_ia (+ as
 * escritas que não chamam IA: mudar status de ticket, mover/reativar um
 * caso do kanban de suporte escalado).
 *
 *   GET  /api/dados                     → o dataset único das telas Tickets e Detalhes
 *   GET  /api/emails                    → só a lista de e-mails, mesmos filtros de /api/dados
 *   GET  /api/automacao                 → execuções do fluxo n8n de resposta automática (ao vivo)
 *   POST /api/ticket                    → muda o status de um ticket
 *   GET  /api/galeria                   → grade paginada de anexos analisados por IA
 *   GET  /api/anexo/:id                 → ficha de um anexo: e-mail vinculado, pedido vinculado
 *                                          e os OUTROS anexos do mesmo e-mail (usado pelo modal
 *                                          de detalhe da galeria)
 *   GET  /api/imagem/:id                → serve o binário de uma imagem (bytea → bytes)
 *   GET  /api/emails/:id/webmail        → acha o e-mail na caixa real (IMAP) e devolve a URL do webmail
 *   GET  /api/suporte-escalado          → kanban de suporte escalado (lista + KPIs)
 *   POST /api/suporte-escalado/status   → move um caso entre colunas do kanban
 *   POST /api/suporte-escalado/reativar → tira o caso do kanban (a IA volta a responder)
 *
 * As duas rotas que CHAMAM Claude (POST /api/chat e POST /api/resposta)
 * moram em emailIA.js — este arquivo é 100% leitura do banco, exceto
 * POST /api/ticket e as duas de suporte-escalado abaixo.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import {
  filtroEmails, filtroTickets, condicaoProdutoLoja, condicaoPeriodo, resolverEmailsProdutoLoja,
} from '../filtrosEmailIA.js';
import { acharNoWebmail, urlWebmail, webmailConfigurado } from '../webmail.js';

/* ═══════════════════════════════  GET /api/dados  ═══════════════════════════ */

async function ticketsKpis(qs) {
  const f = filtroTickets(qs, 1);
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE status = 'nao_iniciado')::int AS nao_iniciado,
            count(*) FILTER (WHERE status = 'em_aberto')::int    AS em_aberto,
            count(*) FILTER (WHERE status = 'resolvido')::int    AS resolvido
     FROM email_ia.tickets WHERE ${f.sql}`,
    f.valores,
  );
  return rows[0];
}

async function listaTickets(qs) {
  const f = filtroTickets(qs, 1, 'tk'); // FROM email_ia.tickets TK — o alias explícito
  const limite = f.temBusca ? '' : 'LIMIT 800';
  const { rows } = await query(
    `WITH ped AS (
       SELECT lower(remetente_email) AS em, count(DISTINCT transacao_id) AS pedidos
       FROM email_ia.mv_emails_x_pedidos WHERE transacao_id IS NOT NULL GROUP BY 1
     )
     SELECT tk.remetente_email, tk.nome, tk.status, tk.qtd_emails,
            tk.reaberturas, tk.primeiro_email_em, tk.ultimo_email_em,
            tk.iniciado_em, tk.resolvido_em,
            tk.resumo_conversa, tk.resumo_conversa_em,
            coalesce(ped.pedidos, 0)::int AS pedidos_unicos
     FROM email_ia.tickets tk
     LEFT JOIN ped ON ped.em = tk.remetente_email
     WHERE ${f.sql}
     ORDER BY tk.ultimo_email_em DESC NULLS LAST
     ${limite}`,
    f.valores,
  );
  return rows;
}

async function ticketsEvolucao() {
  const { rows } = await query(
    `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, coalesce(i.n, 0)::int AS iniciados, coalesce(r.n, 0)::int AS resolvidos
     FROM (SELECT date_trunc('day', iniciado_em)::date AS dia, count(*) AS n
           FROM email_ia.tickets WHERE iniciado_em IS NOT NULL GROUP BY 1) i
     FULL JOIN (SELECT date_trunc('day', resolvido_em)::date AS dia, count(*) AS n
                FROM email_ia.tickets WHERE resolvido_em IS NOT NULL GROUP BY 1) r
     USING (dia)
     ORDER BY 1`,
  );
  return rows;
}

async function plataformas(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT plataforma_origem, count(*)::int AS total FROM email_ia.emails
     WHERE plataforma_origem IS NOT NULL AND ${f.sql} GROUP BY 1 ORDER BY 2 DESC`,
    f.valores,
  );
  return rows;
}

async function kpisPrincipais(qs) {
  const f = filtroEmails(qs, 1);
  const [principais, gerais, fotos] = await Promise.all([
    query(
      `SELECT
         count(*) FILTER (WHERE ${f.sql})::int AS total_emails,
         count(*) FILTER (WHERE pede_resposta AND ${f.sql})::int AS pendentes,
         count(*) FILTER (WHERE pede_resposta AND urgencia = 'alta' AND ${f.sql})::int AS urgencia_alta,
         count(*) FILTER (WHERE categoria IN ('devolucao','troca') AND ${f.sql})::int AS devolucoes,
         round(100.0 * count(*) FILTER (WHERE sentimento IN ('negativo','muito_negativo') AND ${f.sql})
           / NULLIF(count(*) FILTER (WHERE ${f.sql}), 0)) AS pct_negativo,
         count(*) FILTER (WHERE problema_pagamento IN ('compra_nao_reconhecida','cobranca_duplicada','cobranca_valor_maior') AND ${f.sql})::int AS cobranca_indevida,
         count(*) FILTER (WHERE problema_pagamento = 'pede_cancelamento_reembolso' AND ${f.sql})::int AS pede_reembolso,
         count(DISTINCT lower(remetente_email)) FILTER (WHERE ${f.sql})::int AS clientes_unicos,
         count(DISTINCT lower(remetente_email)) FILTER (WHERE categoria IN ('devolucao','troca') AND ${f.sql})::int AS clientes_devolucao
       FROM email_ia.emails`,
      f.valores,
    ),
    query(
      `SELECT (SELECT count(*) FROM email_ia.anexos)::int AS anexos,
              (SELECT count(*) FROM email_ia.emails WHERE erro_analise IS NOT NULL)::int AS com_erro`,
    ),
    query(
      `SELECT count(*)::int AS fotos_defeito FROM email_ia.anexos a
       JOIN email_ia.emails e USING (message_id) WHERE a.defeito_visivel AND ${filtroEmails(qs, 1, 'e').sql}`,
      filtroEmails(qs, 1, 'e').valores,
    ),
  ]);
  return { ...principais.rows[0], ...gerais.rows[0], ...fotos.rows[0] };
}

/** Quem já pediu devolução/troca e o pedido correspondente já foi cancelado na fila. */
async function devolucaoConfirmada() {
  const { rows } = await query(
    `WITH pedidos AS (
       SELECT lower(remetente_email) AS email,
              bool_or(status_pedido = 'cancelado') AS tem_cancelado,
              bool_or(transacao_id IS NOT NULL) AS tem_vinculo
       FROM email_ia.mv_emails_x_pedidos GROUP BY 1
     )
     SELECT
       count(DISTINCT lower(e.remetente_email))::int AS pediram,
       count(DISTINCT lower(e.remetente_email)) FILTER (WHERE p.tem_cancelado)::int AS cancelados,
       count(DISTINCT lower(e.remetente_email)) FILTER (WHERE p.tem_vinculo IS NOT TRUE)::int AS sem_vinculo
     FROM email_ia.emails e
     LEFT JOIN pedidos p ON p.email = lower(e.remetente_email)
     WHERE e.categoria IN ('devolucao','troca')`,
  );
  return rows[0];
}

async function barrasEnum(qs, coluna, extra = '') {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT ${coluna}, count(*)::int AS total FROM email_ia.emails
     WHERE ${coluna} IS NOT NULL ${extra} AND ${f.sql} GROUP BY 1 ORDER BY 2 DESC`,
    f.valores,
  );
  return rows;
}

async function sentimentos(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT sentimento, count(*)::int AS total FROM email_ia.emails
     WHERE sentimento IS NOT NULL AND ${f.sql}
     GROUP BY 1 ORDER BY array_position(ARRAY['positivo','neutro','negativo','muito_negativo'], sentimento)`,
    f.valores,
  );
  return rows;
}

async function evolucaoDiaria(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT to_char(date_trunc('day', data_email), 'YYYY-MM-DD') AS dia, count(*)::int AS total,
            count(*) FILTER (WHERE categoria IN ('devolucao','troca'))::int AS devolucoes
     FROM email_ia.emails WHERE data_email IS NOT NULL AND ${f.sql}
     GROUP BY 1 ORDER BY 1`,
    f.valores,
  );
  return rows;
}

async function taxaMensal(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', data_email), 'YYYY-MM') AS mes, count(*)::int AS total,
            count(*) FILTER (WHERE categoria IN ('devolucao','troca'))::int AS devolucoes,
            round(100.0 * count(*) FILTER (WHERE categoria IN ('devolucao','troca')) / NULLIF(count(*), 0), 1) AS pct
     FROM email_ia.emails
     WHERE data_email IS NOT NULL AND data_email >= now() - interval '12 months' AND ${f.sql}
     GROUP BY 1 ORDER BY 1`,
    f.valores,
  );
  return rows;
}

async function motivosPorMes(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', data_email), 'YYYY-MM') AS mes, motivo_devolucao, count(*)::int AS total
     FROM email_ia.emails
     WHERE categoria IN ('devolucao','troca') AND motivo_devolucao IS NOT NULL
       AND data_email >= now() - interval '12 months' AND ${f.sql}
     GROUP BY 1, 2 ORDER BY 1`,
    f.valores,
  );
  return rows;
}

async function defeitoTags(qs) {
  const f = filtroEmails(qs, 1, 'e'); // LEFT JOIN email_ia.emails E abaixo
  const { rows } = await query(
    `SELECT tag, count(*)::int AS total FROM (
       SELECT unnest(a.tags) AS tag FROM email_ia.anexos a
       LEFT JOIN email_ia.emails e USING (message_id)
       WHERE a.defeito_visivel AND ${f.sql}
     ) x GROUP BY 1 ORDER BY 2 DESC LIMIT 14`,
    f.valores,
  );
  return rows;
}

async function produtoMotivo(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT produto_mencionado, motivo_devolucao, count(*)::int AS total FROM email_ia.emails
     WHERE categoria IN ('devolucao','troca') AND produto_mencionado IS NOT NULL
       AND motivo_devolucao IS NOT NULL AND ${f.sql}
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 400`,
    f.valores,
  );
  return rows;
}

async function reincidentes(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT remetente_email, max(remetente_nome) AS nome, count(*)::int AS devolucoes,
            string_agg(DISTINCT motivo_devolucao, ', ') AS motivos,
            string_agg(DISTINCT produto_mencionado, ', ') AS produtos, max(data_email) AS ultimo
     FROM email_ia.emails WHERE categoria IN ('devolucao','troca') AND ${f.sql}
     GROUP BY 1 HAVING count(*) >= 2 ORDER BY 3 DESC LIMIT 100`,
    f.valores,
  );
  return rows;
}

async function pendentes(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT id, data_email, remetente_nome, remetente_email, assunto, categoria, urgencia,
            resumo, numero_pedido, produto_mencionado, motivo_devolucao, resposta_sugerida
     FROM email_ia.emails WHERE pede_resposta AND ${f.sql}
     ORDER BY CASE urgencia WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, data_email
     LIMIT 500`,
    f.valores,
  );
  return rows;
}

/**
 * Quem já reclamou/pediu devolução e o pedido correspondente — cancelado ou
 * não. Já junta mv_emails_x_pedidos por conta própria, então produto/loja
 * entram direto no WHERE (via o `m` já disponível) em vez de chamar
 * condicaoProdutoLoja, que criaria um segundo EXISTS redundante.
 */
async function reclamantes(qs) {
  const condicoes = ["e.categoria IN ('devolucao', 'troca', 'reclamacao')"];
  const valores = [];
  let i = 1;
  if (qs.produto) { condicoes.push(`m.produto = $${i}`); valores.push(String(qs.produto)); i += 1; }
  if (qs.loja) { condicoes.push(`m.plataforma = $${i}`); valores.push(String(qs.loja)); i += 1; }

  const { rows } = await query(
    `SELECT lower(m.remetente_email) AS remetente_email, max(e.remetente_nome) AS nome,
            m.transacao_id AS pedido, max(m.produto) AS produto, max(m.plataforma) AS plataforma,
            string_agg(DISTINCT e.motivo_devolucao, ', ') AS motivos,
            count(*)::int AS emails, max(e.data_email) AS ultimo_email,
            CASE
              WHEN m.transacao_id IS NULL THEN 'sem_pedido_vinculado'
              WHEN bool_or(m.status_pedido = 'cancelado') THEN 'ja_cancelado'
              ELSE 'nao_cancelado'
            END AS situacao
     FROM email_ia.emails e
     JOIN email_ia.mv_emails_x_pedidos m ON lower(m.remetente_email) = lower(e.remetente_email)
     WHERE ${condicoes.join(' AND ')}
     GROUP BY lower(m.remetente_email), m.transacao_id
     ORDER BY CASE
       WHEN m.transacao_id IS NULL THEN 2
       WHEN bool_or(m.status_pedido = 'cancelado') THEN 3
       ELSE 1
     END, max(e.data_email) DESC
     LIMIT 300`,
    valores,
  );
  return rows;
}

async function produtosComProblema(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT produto_mencionado, count(*)::int AS total,
            count(*) FILTER (WHERE categoria IN ('devolucao','troca'))::int AS devolucoes,
            count(*) FILTER (WHERE categoria = 'reclamacao')::int AS reclamacoes
     FROM email_ia.emails
     WHERE categoria IN ('devolucao','reclamacao','troca') AND produto_mencionado IS NOT NULL AND ${f.sql}
     GROUP BY produto_mencionado ORDER BY total DESC LIMIT 100`,
    f.valores,
  );
  return rows;
}

async function clientesRisco(qs) {
  const condicoes = ["sentimento IN ('negativo','muito_negativo')", "data_email >= now() - interval '30 days'"];
  const valores = [];
  condicaoProdutoLoja(qs, 'emails.remetente_email', condicoes, valores, 1); // FROM email_ia.emails sem alias

  const { rows } = await query(
    `SELECT remetente_email, max(remetente_nome) AS nome, count(*)::int AS emails_negativos, max(data_email) AS ultimo_contato
     FROM email_ia.emails
     WHERE ${condicoes.join(' AND ')}
     GROUP BY remetente_email HAVING count(*) >= 2 ORDER BY emails_negativos DESC LIMIT 100`,
    valores,
  );
  return rows;
}

async function miniGaleria(qs) {
  const f = filtroEmails(qs, 1, 'e'); // LEFT JOIN email_ia.emails E abaixo
  const { rows } = await query(
    `SELECT a.id, a.nome_arquivo, a.mime_type, a.tamanho_bytes, a.tipo_conteudo,
            a.descricao_ia, a.defeito_visivel, a.tags, a.criado_em,
            e.remetente_nome, e.remetente_email, e.assunto
     FROM email_ia.anexos a LEFT JOIN email_ia.emails e USING (message_id)
     WHERE ${f.sql} ORDER BY a.criado_em DESC LIMIT 60`,
    f.valores,
  );
  return rows;
}

async function ultimosEmails(qs) {
  const f = filtroEmails(qs, 1);
  const { rows } = await query(
    `SELECT id, data_email, remetente_nome, remetente_email, assunto, categoria, sentimento, urgencia,
            pede_resposta, tem_anexo, resumo, erro_analise, numero_pedido, produto_mencionado, motivo_devolucao
     FROM email_ia.emails WHERE ${f.sql} ORDER BY data_email DESC NULLS LAST LIMIT 400`,
    f.valores,
  );
  return rows;
}

export default async function rotasEmailIACentral(app) {
  app.get('/api/dados', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'O dataset único das telas Tickets e Detalhes',
      description: 'Todos os cartões, barras e tabelas das duas telas saem daqui — os mesmos '
        + 'parâmetros de período/filtro/busca (dias OU data_de/data_ate, q, tq, cat, sent, urg, '
        + 'pede, area, resp, pgto, plat, motivo, produto, loja), aplicados no servidor a cada consulta. '
        + '`produto`/`loja` cruzam com o pedido do cliente (mv_emails_x_pedidos) — diferente de '
        + '`plat`, que olha só o e-mail em si. `dias` tem prioridade sobre `data_de`/`data_ate` '
        + 'se os dois vierem juntos.',
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    const qs = await resolverEmailsProdutoLoja(req.query, query);
    const [
      ticketsKpisRes, ticketsRes, ticketsEvolucaoRes, evolucaoRes, plataformasRes,
      kpisRes, devolucaoConfRes, motivos, categorias, sentimentosRes, areas, responsaveis,
      pagamento, taxaMensalRes, motivosMes, defeitoTagsRes, produtoMotivoRes, reincidentesRes,
      pendentesRes, reclamantesRes, produtosRes, clientesRiscoRes, imagens, ultimos,
    ] = await Promise.all([
      ticketsKpis(qs),
      listaTickets(qs),
      ticketsEvolucao(),
      evolucaoDiaria(qs),
      plataformas(qs),
      kpisPrincipais(qs),
      devolucaoConfirmada(),
      barrasEnum({ ...qs }, 'motivo_devolucao', " AND categoria IN ('devolucao','troca')"),
      barrasEnum(qs, 'categoria'),
      sentimentos(qs),
      barrasEnum(qs, 'area_problema'),
      barrasEnum(qs, 'responsavel'),
      barrasEnum(qs, 'problema_pagamento', " AND problema_pagamento <> 'sem_problema_pagamento'"),
      taxaMensal(qs),
      motivosPorMes(qs),
      defeitoTags(qs),
      produtoMotivo(qs),
      reincidentes(qs),
      pendentes(qs),
      reclamantes(qs),
      produtosComProblema(qs),
      clientesRisco(qs),
      miniGaleria(qs),
      ultimosEmails(qs),
    ]);

    return {
      tickets_kpis: ticketsKpisRes,
      tickets: ticketsRes,
      tickets_evolucao: ticketsEvolucaoRes,
      evolucao: evolucaoRes,
      plataformas: plataformasRes,
      kpis: kpisRes,
      devolucao_conf: devolucaoConfRes,
      motivos,
      categorias,
      sentimentos: sentimentosRes,
      areas,
      responsaveis,
      pagamento,
      taxa_mensal: taxaMensalRes,
      motivos_mes: motivosMes,
      defeito_tags: defeitoTagsRes,
      produto_motivo: produtoMotivoRes,
      reincidentes: reincidentesRes,
      pendentes: pendentesRes,
      reclamantes: reclamantesRes,
      produtos: produtosRes,
      clientes_risco: clientesRiscoRes,
      imagens,
      ultimos,
    };
  });

  /* ═══════════════════════════════  GET /api/emails  ═════════════════════════════ */

  app.get('/api/emails', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Só a lista de e-mails — mesmos filtros de /api/dados, sem os ~15 agregados',
      description: 'Usada pelo modal "ver e-mails" que abre ao clicar num filtro em Mais '
        + 'Detalhes (motivo, categoria, sentimento, área, responsável, pagamento, plataforma) ou '
        + 'numa linha (ticket, reincidente, reclamante, cliente de risco) — neste caso com '
        + '`email` (recorte exato, diferente do `q` por substring) para trazer o histórico '
        + 'completo daquele cliente. Pedir só a lista é bem mais leve que recarregar o dataset '
        + 'inteiro de /api/dados só para mostrar quem caiu no filtro. Mesmos parâmetros de '
        + 'período/filtro/busca.',
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    const qs = await resolverEmailsProdutoLoja(req.query, query);
    return { itens: await ultimosEmails(qs) };
  });

  /* ═══════════════════════════════  GET /api/automacao  ═════════════════════════ */

  app.get('/api/automacao', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Execuções recentes do fluxo n8n de resposta automática (ao vivo)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { rows } = await query(
      `SELECT email_id, remetente_email, remetente_nome, assunto, etapa, detalhe,
              iniciado_em, atualizado_em
       FROM email_ia.execucoes_resposta_automatica
       ORDER BY atualizado_em DESC LIMIT 40`,
    );
    return { itens: rows, agora: new Date().toISOString() };
  });

  /* ═══════════════════════════════  POST /api/ticket  ════════════════════════════ */

  app.post('/api/ticket', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Muda o status de um ticket (Iniciar / Resolver / Reabrir)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['email', 'status'],
        properties: {
          email: { type: 'string' },
          status: { type: 'string', enum: ['nao_iniciado', 'em_aberto', 'resolvido'] },
        },
      },
    },
  }, async (req) => {
    const { email, status } = req.body;
    const { rows } = await query(
      `UPDATE email_ia.tickets SET status = $1,
         iniciado_em = CASE WHEN $1 = 'em_aberto' THEN coalesce(iniciado_em, now()) ELSE iniciado_em END,
         resolvido_em = CASE WHEN $1 = 'resolvido' THEN now() ELSE resolvido_em END,
         atualizado_em = now()
       WHERE remetente_email = lower($2)
       RETURNING remetente_email, status`,
      [status, email],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Ticket não encontrado para este e-mail.');
    return rows[0];
  });

  /* ═══════════════════════════════  GET /api/galeria  ════════════════════════════ */

  app.get('/api/galeria', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Grade paginada de anexos analisados por IA',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          pagina: { type: 'integer', default: 1, minimum: 1 },
          por_pagina: { type: 'integer', default: 24, minimum: 6, maximum: 96 },
          tipo: { type: 'string' },
          q: { type: 'string' },
          dias: { type: 'integer', minimum: 1 },
          data_de: { type: 'string' },
          data_ate: { type: 'string' },
          produto: { type: 'string' },
          loja: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const porPagina = Math.min(96, Math.max(6, Number(req.query.por_pagina) || 24));
    const offset = (pagina - 1) * porPagina;
    const qs = await resolverEmailsProdutoLoja(req.query, query);

    const condicoes = [];
    const valores = [];
    let i = 1;

    if (qs.tipo === 'sem_analise') {
      condicoes.push('a.tipo_conteudo IS NULL');
    } else if (qs.tipo) {
      condicoes.push(`a.tipo_conteudo = $${i}`);
      valores.push(qs.tipo);
      i += 1;
    }
    if (qs.q) {
      condicoes.push(`(a.nome_arquivo ILIKE $${i} OR a.descricao_ia ILIKE $${i}
        OR array_to_string(a.tags, ' ') ILIKE $${i} OR e.remetente_nome ILIKE $${i}
        OR e.remetente_email ILIKE $${i} OR e.assunto ILIKE $${i})`);
      valores.push(`%${qs.q}%`);
      i += 1;
    }
    // Anexo sem e-mail vinculado (e IS NULL, do LEFT JOIN abaixo) fica de
    // fora sempre que um destes três estiver ativo — não tem como saber a
    // data, o produto ou a loja de um anexo sem remetente.
    i = condicaoPeriodo(qs, 'e.data_email', condicoes, valores, i);
    i = condicaoProdutoLoja(qs, 'e.remetente_email', condicoes, valores, i);
    const onde = condicoes.length ? condicoes.join(' AND ') : 'true';

    const { rows } = await query(
      `SELECT json_build_object(
         'total', (SELECT count(*) FROM email_ia.anexos a
           LEFT JOIN email_ia.emails e USING (message_id) WHERE ${onde}),
         'tipos', (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT coalesce(tipo_conteudo, 'sem_analise') AS tipo, count(*)::int AS total
           FROM email_ia.anexos GROUP BY 1 ORDER BY 2 DESC) t),
         'itens', (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT a.id, a.nome_arquivo, a.mime_type, a.tamanho_bytes, a.tipo_conteudo,
                  a.descricao_ia, a.defeito_visivel, a.tags, a.criado_em,
                  e.data_email, e.remetente_nome, e.remetente_email, e.assunto
           FROM email_ia.anexos a LEFT JOIN email_ia.emails e USING (message_id)
           WHERE ${onde}
           ORDER BY coalesce(e.data_email, a.criado_em) DESC, a.id DESC
           LIMIT $${i} OFFSET $${i + 1}) t)
       ) AS resultado`,
      [...valores, porPagina, offset],
    );
    return rows[0].resultado;
  });

  /* ═══════════════════════════════  GET /api/anexo/:id  ══════════════════════════ */

  app.get('/api/anexo/:id', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Ficha de um anexo — e-mail, pedido e os outros anexos do mesmo e-mail',
      description: 'Alimenta o modal de detalhe da galeria: o anexo em si, o e-mail que o '
        + 'trouxe (por message_id, sem FK), o pedido vinculado a esse e-mail (via '
        + 'mv_emails_x_pedidos, se houver) e os DEMAIS anexos do mesmo e-mail — para quando '
        + 'chegou mais de uma imagem junto.',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  }, async (req) => {
    const { rows } = await query(
      `SELECT json_build_object(
         'anexo', (SELECT row_to_json(x) FROM (
           SELECT id, nome_arquivo, mime_type, tamanho_bytes, tipo_conteudo, descricao_ia,
                  defeito_visivel, tags, hash_md5, criado_em
           FROM email_ia.anexos WHERE id = $1
         ) x),
         'email', (SELECT row_to_json(x) FROM (
           SELECT em.id, em.remetente_nome, em.remetente_email, em.assunto, em.data_email,
                  em.categoria, em.motivo_devolucao, em.produto_mencionado, em.numero_pedido,
                  em.sentimento, em.urgencia, em.resumo, em.area_problema, em.responsavel,
                  em.problema_pagamento, em.plataforma_origem, em.corpo_texto
           FROM email_ia.emails em
           JOIN email_ia.anexos a ON a.message_id = em.message_id
           WHERE a.id = $1
           LIMIT 1
         ) x),
         'pedido', (SELECT row_to_json(x) FROM (
           SELECT mv.transacao_id, mv.cliente_pedido, mv.produto, mv.plataforma,
                  mv.status_pedido, mv.vinculo, mv.pedido_em
           FROM email_ia.mv_emails_x_pedidos mv
           JOIN email_ia.emails em ON em.id = mv.email_id
           JOIN email_ia.anexos a ON a.message_id = em.message_id
           WHERE a.id = $1
           LIMIT 1
         ) x),
         'outros_anexos', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
           SELECT o.id, o.nome_arquivo, o.mime_type, o.tipo_conteudo
           FROM email_ia.anexos o
           JOIN email_ia.anexos a ON a.message_id = o.message_id
           WHERE a.id = $1 AND o.id <> a.id
           ORDER BY o.id
         ) x)
       ) AS resultado`,
      [req.params.id],
    );
    const resultado = rows[0].resultado;
    if (!resultado.anexo) throw new ErroHttp(404, 'Anexo não encontrado.');
    return resultado;
  });

  /* ═══════════════════════════════  GET /api/imagem/:id  ═════════════════════════ */

  app.get('/api/imagem/:id', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Serve o binário de uma imagem anexada a um e-mail',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  }, async (req, resposta) => {
    const { rows } = await query(
      `SELECT mime_type, conteudo FROM email_ia.anexos
       WHERE id = $1 AND mime_type LIKE 'image/%'`,
      [req.params.id],
    );
    const anexo = rows[0];
    if (!anexo) throw new ErroHttp(404, 'Imagem não encontrada.');
    resposta.header('Content-Type', anexo.mime_type);
    return resposta.send(anexo.conteudo);
  });

  /* ═══════════════════════════  GET /api/emails/:id/webmail  ═══════════════════ */

  app.get('/api/emails/:id/webmail', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Acha este e-mail na caixa real (IMAP) e devolve a URL do webmail',
      description: 'Conecta na caixa (Hostinger, IMAP, somente leitura), procura pelo '
        + '`message_id` deste e-mail e devolve `{ url }` pronta para abrir no webmail — '
        + 'usado pelo botão ✉ do kanban de Suporte Escalado. Pode levar alguns segundos '
        + '(é uma conexão IMAP ao vivo, não uma consulta ao Postgres).',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  }, async (req) => {
    if (!webmailConfigurado) {
      throw new ErroHttp(503, 'IMAP não configurado no servidor — falta SMTP_USUARIO/SMTP_SENHA (ou IMAP_USUARIO/IMAP_SENHA) no .env.');
    }
    const { rows } = await query(
      'SELECT message_id, pasta_imap FROM email_ia.emails WHERE id = $1', [req.params.id],
    );
    const email = rows[0];
    if (!email) throw new ErroHttp(404, 'E-mail não encontrado.');

    let achado;
    try {
      achado = await acharNoWebmail(email.message_id, email.pasta_imap);
    } catch (err) {
      throw new ErroHttp(502, `Não consegui falar com a caixa de e-mail: ${err.message}`);
    }
    if (!achado) throw new ErroHttp(404, 'Não encontrei este e-mail na caixa (pode ter sido movido ou apagado por lá).');

    return { url: urlWebmail(achado.pasta, achado.uid), pasta: achado.pasta };
  });

  /* ═══════════════════════════  GET /api/suporte-escalado  ═══════════════════ */

  const STATUS_ESCALADO = ['pendente', 'iniciado', 'esperando_resposta', 'finalizado'];

  app.get('/api/suporte-escalado', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Kanban de suporte escalado — lista + KPIs por coluna',
      description: 'Casos que a IA tirou de si (nunca mais responde este remetente até alguém '
        + 'reativar). `q` busca em nome, e-mail, resumo da conversa e motivo do escalonamento — '
        + 'os KPIs refletem o mesmo recorte da busca.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { q: { type: 'string' } },
      },
    },
  }, async (req) => {
    const condicoes = [];
    const valores = [];
    let i = 1;
    if (req.query.q) {
      condicoes.push(`(nome ILIKE $${i} OR remetente_email ILIKE $${i}
        OR resumo_conversa ILIKE $${i} OR motivo_escalonamento ILIKE $${i})`);
      valores.push(`%${req.query.q}%`);
      i += 1;
    }
    const onde = condicoes.length ? condicoes.join(' AND ') : 'true';

    const [kpisRes, itensRes] = await Promise.all([
      query(
        `SELECT count(*) FILTER (WHERE status = 'pendente')::int            AS pendente,
                count(*) FILTER (WHERE status = 'iniciado')::int            AS iniciado,
                count(*) FILTER (WHERE status = 'esperando_resposta')::int  AS esperando_resposta,
                count(*) FILTER (WHERE status = 'finalizado')::int          AS finalizado
         FROM email_ia.suporte_escalado WHERE ${onde}`,
        valores,
      ),
      query(
        `SELECT id, remetente_email, nome, resumo_conversa, motivo_escalonamento, status,
                email_id, criado_em, atualizado_em, iniciado_em, finalizado_em
         FROM email_ia.suporte_escalado
         WHERE ${onde}
         ORDER BY criado_em DESC`,
        valores,
      ),
    ]);

    return { kpis: kpisRes.rows[0], itens: itensRes.rows };
  });

  /* ═══════════════════════  POST /api/suporte-escalado/status  ═══════════════ */

  app.post('/api/suporte-escalado/status', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Move um caso escalado entre colunas do kanban',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: STATUS_ESCALADO },
        },
      },
    },
  }, async (req) => {
    const { id, status } = req.body;
    const { rows } = await query(
      `UPDATE email_ia.suporte_escalado SET status = $1,
         iniciado_em = CASE WHEN $1 <> 'pendente' THEN coalesce(iniciado_em, now()) ELSE iniciado_em END,
         finalizado_em = CASE WHEN $1 = 'finalizado' THEN now() ELSE finalizado_em END,
         atualizado_em = now()
       WHERE id = $2
       RETURNING id, remetente_email, nome, resumo_conversa, motivo_escalonamento, status,
                 email_id, criado_em, atualizado_em, iniciado_em, finalizado_em`,
      [status, id],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    return rows[0];
  });

  /* ═══════════════════════  POST /api/suporte-escalado/reativar  ══════════════ */

  app.post('/api/suporte-escalado/reativar', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Reativa o atendimento automático: tira o caso do kanban de suporte escalado',
      description: 'Remove a linha de email_ia.suporte_escalado — o cliente volta a receber '
        + 'resposta automática da IA no próximo e-mail dele.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (req, resposta) => {
    const { id } = req.body;
    const r = await query('DELETE FROM email_ia.suporte_escalado WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    resposta.code(204);
    return null;
  });
}
