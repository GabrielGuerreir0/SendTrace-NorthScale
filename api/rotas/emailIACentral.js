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
 *   GET  /api/suporte-escalado                → kanban de suporte escalado (colunas + lista + KPIs) de UM board
 *   POST /api/suporte-escalado/status         → move um caso entre colunas do kanban
 *   POST /api/suporte-escalado/reativar       → tira o caso do kanban (a IA volta a responder)
 *   GET  /api/suporte-escalado/:id/notas      → notas internas de um caso escalado
 *   POST /api/suporte-escalado/:id/notas      → adiciona uma nota nova
 *   PUT  /api/suporte-escalado/notas/:notaId  → edita o texto de uma nota já salva
 *   POST /api/suporte-escalado/colunas        → cria uma coluna nova no kanban
 *   PUT  /api/suporte-escalado/colunas/:id    → renomeia uma coluna (a chave interna não muda)
 *   DELETE /api/suporte-escalado/colunas/:id  → apaga uma coluna (só se estiver vazia)
 *   GET  /api/suporte-escalado/boards         → lista boards (admin vê todos; não-admin só o próprio)
 *   POST /api/suporte-escalado/boards         → cria um board novo e vincula a um usuário (só admin)
 *   PATCH /api/suporte-escalado/boards/:id    → renomeia/revincula/ativa-desativa um board (só admin)
 *
 * As duas rotas que CHAMAM Claude (POST /api/chat e POST /api/resposta)
 * moram em emailIA.js — este arquivo é 100% leitura do banco, exceto
 * POST /api/ticket e as de suporte-escalado (status/reativar/notas/boards) abaixo.
 *
 * BOARDS (02/09/2026): cada responsável tem seu próprio kanban — colunas e
 * casos são isolados por `board_id`. Um caso novo escalado pelo fluxo n8n
 * entra sem board_id; um trigger no Postgres (email_ia.trg_suporte_escalado_rotear,
 * ver schema-email-ia.sql) escolhe o board automaticamente por sorteio
 * ponderado (mais rápido + menos casos hoje pesa mais). Aqui na API, toda
 * rota que lê/escreve um caso ou uma coluna precisa saber de QUAL board —
 * `board_id` na querystring/body para leitura, resolvido a partir do caso
 * para escrita — e aplicar a mesma regra de dono: só o usuário vinculado ao
 * board (usuario_id) ou um admin pode mexer nos cards/colunas dele.
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
 * não. mv_emails_x_pedidos tem uma linha por E-MAIL (não por pedido), então
 * juntar direto `emails` (reclamações) com `mv_emails_x_pedidos` por
 * remetente_email multiplica linhas (todo e-mail de reclamação × todo e-mail
 * com pedido daquele cliente) — em cliente com histórico longo isso passava
 * de 400 mil linhas intermediárias e estourava o `statement_timeout` do
 * Postgres. Agrega as reclamações por cliente ANTES do join, e reduz
 * mv_emails_x_pedidos a um pedido por linha (DISTINCT), pra o join nunca
 * multiplicar por e-mail — só por pedido de fato.
 */
async function reclamantes(qs) {
  const condicoesPedidos = [];
  const valores = [];
  let i = 1;
  if (qs.produto) { condicoesPedidos.push(`produto = $${i}`); valores.push(String(qs.produto)); i += 1; }
  if (qs.loja) { condicoesPedidos.push(`plataforma = $${i}`); valores.push(String(qs.loja)); i += 1; }
  const whereM = condicoesPedidos.length ? `WHERE ${condicoesPedidos.join(' AND ')}` : '';

  const { rows } = await query(
    `WITH reclamantes_emails AS (
       SELECT lower(remetente_email) AS remetente_email,
              max(remetente_nome) AS nome,
              string_agg(DISTINCT motivo_devolucao, ', ') AS motivos,
              count(*)::int AS emails,
              max(data_email) AS ultimo_email
       FROM email_ia.emails
       WHERE categoria IN ('devolucao', 'troca', 'reclamacao')
       GROUP BY lower(remetente_email)
     ),
     pedidos AS (
       SELECT DISTINCT lower(remetente_email) AS remetente_email, transacao_id, produto, plataforma, status_pedido
       FROM email_ia.mv_emails_x_pedidos
       ${whereM}
     )
     SELECT re.remetente_email, re.nome, p.transacao_id AS pedido,
            max(p.produto) AS produto, max(p.plataforma) AS plataforma,
            re.motivos, re.emails, re.ultimo_email,
            CASE
              WHEN p.transacao_id IS NULL THEN 'sem_pedido_vinculado'
              WHEN bool_or(p.status_pedido = 'cancelado') THEN 'ja_cancelado'
              ELSE 'nao_cancelado'
            END AS situacao
     FROM reclamantes_emails re
     JOIN pedidos p ON p.remetente_email = re.remetente_email
     GROUP BY re.remetente_email, re.nome, p.transacao_id, re.motivos, re.emails, re.ultimo_email
     ORDER BY CASE
       WHEN p.transacao_id IS NULL THEN 2
       WHEN bool_or(p.status_pedido = 'cancelado') THEN 3
       ELSE 1
     END, re.ultimo_email DESC
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

  /* ═══════════════════  boards do kanban de suporte escalado  ═════════════════
     Cada responsável tem o seu. Só admin cria/vincula/ativa-desativa (ver rotas
     abaixo); dono do board (+ admin) move cards, cria/edita/apaga colunas e
     escreve notas — as funções aqui embaixo aplicam essa regra em toda rota
     que precisa saber "de quem é este board/caso". */

  async function boardPorId(id) {
    const { rows } = await query(
      'SELECT id, nome, usuario_id, ativo FROM email_ia.suporte_escalado_boards WHERE id = $1', [id],
    );
    return rows[0] ?? null;
  }

  function podeGerenciarBoard(req, board) {
    return req.usuario.admin || (board && board.usuario_id === req.usuario.user_id);
  }

  /** Board do caso escalado `casoId` — usado pelas rotas que recebem o id do
   *  CASO (mover status, reativar, notas), não o id do board. */
  async function boardDoCaso(casoId) {
    const { rows } = await query(
      `SELECT b.id, b.nome, b.usuario_id, b.ativo
       FROM email_ia.suporte_escalado s
       JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
       WHERE s.id = $1`,
      [casoId],
    );
    return rows[0] ?? null;
  }

  app.get('/api/suporte-escalado/boards', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Lista os boards do kanban de suporte escalado',
      description: 'Administrador vê todos os boards (com o dono de cada um e quantos casos '
        + 'ainda não têm board — "órfãos", quando o roteamento automático não achou ninguém '
        + 'elegível). Quem não é administrador só vê o próprio board (lista vazia se ainda não '
        + 'tiver um vinculado).',
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    // `admin` vai na resposta pra a tela não depender de descobrir isso por
    // outro caminho — é o mesmo request que já sabe, via a sessão, se pode
    // gerenciar boards ou só ver/usar o próprio.
    if (req.usuario.admin) {
      const [{ rows: boards }, { rows: orfaosRows }] = await Promise.all([
        query(
          `SELECT b.id, b.nome, b.usuario_id, b.ativo, b.criado_em, u.email AS usuario_email, u.nome AS usuario_nome
           FROM email_ia.suporte_escalado_boards b
           LEFT JOIN public.painel_usuarios u ON u.id = b.usuario_id
           ORDER BY b.nome`,
        ),
        query('SELECT count(*)::int AS total FROM email_ia.suporte_escalado WHERE board_id IS NULL'),
      ]);
      return {
        admin: true, boards, orfaos: orfaosRows[0].total,
      };
    }
    const board = await boardPorUsuario(req.usuario.user_id);
    return { admin: false, boards: board ? [board] : [], orfaos: 0 };
  });

  async function boardPorUsuario(usuarioId) {
    if (!usuarioId) return null;
    const { rows } = await query(
      `SELECT b.id, b.nome, b.usuario_id, b.ativo, b.criado_em, u.email AS usuario_email, u.nome AS usuario_nome
       FROM email_ia.suporte_escalado_boards b
       LEFT JOIN public.painel_usuarios u ON u.id = b.usuario_id
       WHERE b.usuario_id = $1`,
      [usuarioId],
    );
    return rows[0] ?? null;
  }

  /** Cria as 5 colunas padrão de todo board novo (mesmo ponto de partida do
   *  board da Vitória) — inclusive a `pendente`, obrigatória: o trigger de
   *  roteamento automático (email_ia.trg_suporte_escalado_rotear) só elege
   *  um board se ele tiver alguém pra receber o caso, e o kanban em si exige
   *  que toda coluna 'pendente' exista e nunca seja apagável. */
  async function semearColunasPadrao(boardId) {
    const padrao = [
      ['pendente', 'Pendente', 'Caso acabou de ser escalado pela IA — ainda ninguém olhou.', 1],
      ['iniciado', 'Iniciado', 'Um humano já está atendendo este caso.', 2],
      ['esperando_resposta', 'Esperando resposta', 'A bola está com o cliente — aguardando ele responder.', 3],
      ['reembolsado', 'Reembolsado', 'O reembolso já foi processado.', 4],
      ['finalizado', 'Finalizado', 'Atendimento concluído.', 5],
    ];
    await Promise.all(padrao.map(([chave, rotulo, descricao, ordem]) => query(
      `INSERT INTO email_ia.suporte_escalado_colunas (board_id, chave, rotulo, descricao, ordem)
       VALUES ($1, $2, $3, $4, $5)`,
      [boardId, chave, rotulo, descricao, ordem],
    )));
  }

  app.post('/api/suporte-escalado/boards', {
    onRequest: [app.exigirAdmin],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Cria um board novo no kanban de suporte escalado',
      description: 'Só administradores. Nasce com as mesmas 5 colunas padrão (incluindo a '
        + '"Pendente", fixa) e pode já vir vinculado a um usuário — cada usuário só pode ter '
        + 'um board.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 120 },
          usuario_id: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req) => {
    const nome = req.body.nome.trim();
    if (!nome) throw new ErroHttp(400, 'Dê um nome para o board.');
    const usuarioId = req.body.usuario_id ?? null;
    let board;
    try {
      const { rows } = await query(
        `INSERT INTO email_ia.suporte_escalado_boards (nome, usuario_id, criado_por)
         VALUES ($1, $2, $3)
         RETURNING id, nome, usuario_id, ativo, criado_em`,
        [nome, usuarioId, req.usuario.user_id],
      );
      [board] = rows;
    } catch (err) {
      if (err.code === '23505') throw new ErroHttp(409, 'Este usuário já tem um board.');
      throw err;
    }
    await semearColunasPadrao(board.id);
    return board;
  });

  app.patch('/api/suporte-escalado/boards/:id', {
    onRequest: [app.exigirAdmin],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Renomeia, vincula a um usuário ou ativa/desativa um board',
      description: 'Só administradores. Desativar (`ativo: false`) só tira o board do '
        + 'roteamento automático de casos novos — nunca apaga colunas nem casos. Não existe '
        + 'endpoint para apagar um board.',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 120 },
          usuario_id: { type: ['integer', 'null'] },
          ativo: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const corpo = req.body ?? {};
    const campos = [];
    const valores = [];
    let i = 1;
    if (corpo.nome !== undefined) {
      const nome = corpo.nome.trim();
      if (!nome) throw new ErroHttp(400, 'Dê um nome para o board.');
      campos.push(`nome = $${i}`); valores.push(nome); i += 1;
    }
    if (corpo.usuario_id !== undefined) {
      campos.push(`usuario_id = $${i}`); valores.push(corpo.usuario_id); i += 1;
    }
    if (corpo.ativo !== undefined) {
      campos.push(`ativo = $${i}`); valores.push(corpo.ativo); i += 1;
    }
    if (!campos.length) throw new ErroHttp(400, 'Nada para alterar.');
    valores.push(req.params.id);
    let rows;
    try {
      ({ rows } = await query(
        `UPDATE email_ia.suporte_escalado_boards SET ${campos.join(', ')} WHERE id = $${i}
         RETURNING id, nome, usuario_id, ativo, criado_em`,
        valores,
      ));
    } catch (err) {
      if (err.code === '23505') throw new ErroHttp(409, 'Este usuário já tem um board.');
      throw err;
    }
    if (!rows[0]) throw new ErroHttp(404, 'Board não encontrado.');
    return rows[0];
  });

  /* ═══════════════════════════  GET /api/suporte-escalado  ═══════════════════ */

  /* Visão geral (só admin): mesmas 5 métricas de sempre, mas somando TODOS
     os boards — não existe drag-and-drop aqui (cada board tem suas próprias
     colunas, não dá pra misturar num board só), então em vez de `colunas`
     pensadas pra um kanban único, o extra `boards_resumo` dá um resumo por
     board (dono, pendentes, total) pra uma tabela. `colunas` ainda volta
     preenchida — 1 linha por `chave` distinta entre todos os boards — só
     pra alimentar os KPIs do topo (mesmo componente de sempre) e os rótulos
     da tabela de transições. */
  async function visaoGeralBoards(dias) {
    const [colunasRes, kpisRes, itensRes, transicoesRes, movimentosRes, resumoBoardsRes] = await Promise.all([
      query(
        `SELECT DISTINCT ON (chave) chave, rotulo, descricao
         FROM email_ia.suporte_escalado_colunas
         ORDER BY chave, ordem`,
      ),
      query('SELECT status, count(*)::int AS total FROM email_ia.suporte_escalado GROUP BY status'),
      query(
        `SELECT s.id, s.remetente_email, s.nome, s.resumo_conversa, s.motivo_escalonamento, s.status,
                s.email_id, s.criado_em, s.atualizado_em, s.iniciado_em, s.finalizado_em,
                s.board_id, b.nome AS board_nome
         FROM email_ia.suporte_escalado s
         LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = s.board_id
         ORDER BY s.criado_em DESC`,
      ),
      query(
        `WITH eventos AS (
           SELECT status_anterior, status_novo, mudou_em,
                  LAG(mudou_em) OVER (PARTITION BY suporte_escalado_id ORDER BY mudou_em) AS entrou_em
           FROM email_ia.suporte_escalado_historico
         )
         SELECT status_anterior, status_novo,
                avg(extract(epoch FROM (mudou_em - entrou_em)) / 3600.0) AS media_h,
                percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY extract(epoch FROM (mudou_em - entrou_em)) / 3600.0
                ) AS mediana_h,
                count(*)::int AS amostra
         FROM eventos
         WHERE entrou_em IS NOT NULL
         GROUP BY status_anterior, status_novo
         ORDER BY media_h DESC NULLS LAST`,
      ),
      query(
        `SELECT to_char(date_trunc('day', mudou_em), 'YYYY-MM-DD') AS dia, count(*)::int AS total
         FROM email_ia.suporte_escalado_historico
         WHERE status_anterior IS NOT NULL AND mudou_em > now() - ($1 || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [dias],
      ),
      query(
        `SELECT b.id, b.nome, b.ativo, u.nome AS usuario_nome, u.email AS usuario_email,
                count(s.id)::int AS total,
                count(s.id) FILTER (WHERE s.status = 'pendente')::int AS pendentes
         FROM email_ia.suporte_escalado_boards b
         LEFT JOIN public.painel_usuarios u ON u.id = b.usuario_id
         LEFT JOIN email_ia.suporte_escalado s ON s.board_id = b.id
         GROUP BY b.id, b.nome, b.ativo, u.nome, u.email
         ORDER BY b.nome`,
      ),
    ]);

    const totalMovimentos = movimentosRes.rows.reduce((soma, r) => soma + r.total, 0);

    return {
      board: null,
      geral: true,
      colunas: colunasRes.rows,
      kpis: Object.fromEntries(kpisRes.rows.map((r) => [r.status, r.total])),
      itens: itensRes.rows,
      transicoes: transicoesRes.rows,
      movimentos_diarios: movimentosRes.rows,
      resumo_movimentos: {
        janela_dias: dias,
        total: totalMovimentos,
        media_por_dia: Math.round((totalMovimentos / dias) * 10) / 10,
      },
      boards_resumo: resumoBoardsRes.rows,
    };
  }

  app.get('/api/suporte-escalado', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Kanban de suporte escalado — lista + KPIs por coluna, de UM board (ou geral)',
      description: 'Casos que a IA tirou de si (nunca mais responde este remetente até alguém '
        + 'reativar). `board_id` é obrigatório — o id de um board, ou o literal `todos` (só '
        + 'administrador) pra uma visão agregada de todos os boards, sem drag-and-drop (cada '
        + 'board tem colunas próprias — não dá pra misturar num board só). `q` busca em nome, '
        + 'e-mail, resumo da conversa e motivo do escalonamento — os KPIs refletem o mesmo '
        + 'recorte da busca (ignorado na visão geral).',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['board_id'],
        properties: {
          board_id: { type: 'string' },
          q: { type: 'string' },
          dias: { type: 'integer', description: 'Janela (em dias) das métricas de transição/movimentação — padrão 30.' },
        },
      },
    },
  }, async (req) => {
    const dias = Math.max(1, Number(req.query.dias) || 30);

    if (req.query.board_id === 'todos') {
      if (!req.usuario.admin) throw new ErroHttp(403, 'Só administradores veem a visão geral de todos os boards.');
      return visaoGeralBoards(dias);
    }

    const boardId = Number(req.query.board_id);
    if (!Number.isInteger(boardId)) throw new ErroHttp(400, 'board_id inválido.');
    const board = await boardPorId(boardId);
    if (!board) throw new ErroHttp(404, 'Board não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este board não é seu.');

    const condicoes = ['board_id = $1'];
    const valores = [boardId];
    let i = 2;
    if (req.query.q) {
      condicoes.push(`(nome ILIKE $${i} OR remetente_email ILIKE $${i}
        OR resumo_conversa ILIKE $${i} OR motivo_escalonamento ILIKE $${i})`);
      valores.push(`%${req.query.q}%`);
      i += 1;
    }
    const onde = condicoes.join(' AND ');

    const [colunasRes, kpisRes, itensRes, transicoesRes, movimentosRes] = await Promise.all([
      query(
        'SELECT id, chave, rotulo, descricao, ordem FROM email_ia.suporte_escalado_colunas WHERE board_id = $1 ORDER BY ordem, id',
        [boardId],
      ),
      query(
        `SELECT status, count(*)::int AS total
         FROM email_ia.suporte_escalado WHERE ${onde}
         GROUP BY status`,
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
      // Tempo médio/mediano gasto em CADA etapa, uma linha por par
      // (de onde saiu → pra onde foi), calculado a partir do histórico real
      // de transições (email_ia.suporte_escalado_historico, mantido por
      // trigger). status_anterior já vem certo em cada linha do histórico —
      // só falta saber HÁ QUANTO TEMPO essa etapa tinha começado, que é o
      // mudou_em da transição anterior do mesmo caso (LAG por suporte_escalado_id).
      // Filtrado por board via JOIN em suporte_escalado (a própria tabela de
      // histórico não sabe de qual board é cada linha).
      query(
        `WITH eventos AS (
           SELECT h.status_anterior, h.status_novo, h.mudou_em,
                  LAG(h.mudou_em) OVER (PARTITION BY h.suporte_escalado_id ORDER BY h.mudou_em) AS entrou_em
           FROM email_ia.suporte_escalado_historico h
           JOIN email_ia.suporte_escalado s ON s.id = h.suporte_escalado_id
           WHERE s.board_id = $1
         )
         SELECT status_anterior, status_novo,
                avg(extract(epoch FROM (mudou_em - entrou_em)) / 3600.0) AS media_h,
                percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY extract(epoch FROM (mudou_em - entrou_em)) / 3600.0
                ) AS mediana_h,
                count(*)::int AS amostra
         FROM eventos
         WHERE entrou_em IS NOT NULL
         GROUP BY status_anterior, status_novo
         ORDER BY media_h DESC NULLS LAST`,
        [boardId],
      ),
      // Quantos CASOS MUDARAM DE COLUNA por dia (não conta a criação em si) —
      // é o "quantos e-mails o suporte moveu hoje", útil pra ver ritmo de
      // atendimento independente de quantos casos novos chegaram.
      query(
        `SELECT to_char(date_trunc('day', h.mudou_em), 'YYYY-MM-DD') AS dia, count(*)::int AS total
         FROM email_ia.suporte_escalado_historico h
         JOIN email_ia.suporte_escalado s ON s.id = h.suporte_escalado_id
         WHERE s.board_id = $2 AND h.status_anterior IS NOT NULL
           AND h.mudou_em > now() - ($1 || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [dias, boardId],
      ),
    ]);

    const totalMovimentos = movimentosRes.rows.reduce((soma, r) => soma + r.total, 0);

    return {
      board,
      colunas: colunasRes.rows,
      kpis: Object.fromEntries(kpisRes.rows.map((r) => [r.status, r.total])),
      itens: itensRes.rows,
      transicoes: transicoesRes.rows,
      movimentos_diarios: movimentosRes.rows,
      resumo_movimentos: {
        janela_dias: dias,
        total: totalMovimentos,
        media_por_dia: Math.round((totalMovimentos / dias) * 10) / 10,
      },
    };
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
          status: { type: 'string', minLength: 1, maxLength: 60 },
        },
      },
    },
  }, async (req) => {
    const { id, status } = req.body;
    const board = await boardDoCaso(id);
    if (!board) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const { rows: colunaRows } = await query(
      'SELECT 1 FROM email_ia.suporte_escalado_colunas WHERE board_id = $1 AND chave = $2', [board.id, status],
    );
    if (!colunaRows[0]) throw new ErroHttp(400, 'Coluna inválida.');
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
    const board = await boardDoCaso(id);
    if (!board) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const r = await query('DELETE FROM email_ia.suporte_escalado WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    resposta.code(204);
    return null;
  });

  /* ═══════════════════  POST /api/suporte-escalado/colunas  ═══════════════════
     Cria uma coluna nova no kanban. `chave` (o que fica gravado em
     suporte_escalado.status) é derivada do rótulo — minúsculo, sem acento,
     espaço vira `_` — e nunca muda depois, mesmo que o rótulo seja editado
     depois (ver comentário da tabela em schema-email-ia.sql). */

  function chaveDaColuna(rotulo, jaUsadas) {
    const base = rotulo
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'coluna';
    let chave = base;
    let sufixo = 2;
    while (jaUsadas.has(chave)) {
      chave = `${base}_${sufixo}`;
      sufixo += 1;
    }
    return chave;
  }

  app.post('/api/suporte-escalado/colunas', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Cria uma coluna nova no kanban de suporte escalado',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['board_id', 'rotulo'],
        properties: {
          board_id: { type: 'integer' },
          rotulo: { type: 'string', minLength: 1, maxLength: 60 },
          descricao: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, async (req) => {
    const board = await boardPorId(req.body.board_id);
    if (!board) throw new ErroHttp(404, 'Board não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este board não é seu.');
    const rotulo = req.body.rotulo.trim();
    if (!rotulo) throw new ErroHttp(400, 'Dê um nome para a coluna.');
    const descricao = req.body.descricao === undefined ? null : req.body.descricao.trim() || null;
    const { rows: existentes } = await query(
      'SELECT chave FROM email_ia.suporte_escalado_colunas WHERE board_id = $1', [board.id],
    );
    const chave = chaveDaColuna(rotulo, new Set(existentes.map((r) => r.chave)));
    const { rows } = await query(
      `INSERT INTO email_ia.suporte_escalado_colunas (board_id, chave, rotulo, descricao, ordem)
       SELECT $1, $2, $3, $4, coalesce(max(ordem), 0) + 1 FROM email_ia.suporte_escalado_colunas WHERE board_id = $1
       RETURNING id, board_id, chave, rotulo, descricao, ordem`,
      [board.id, chave, rotulo, descricao],
    );
    return rows[0];
  });

  /* ═══════════════════  PUT/DELETE /api/suporte-escalado/colunas/:id  ═════════ */

  async function colunaPorId(id) {
    const { rows } = await query(
      'SELECT id, board_id, chave, rotulo, descricao, ordem FROM email_ia.suporte_escalado_colunas WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  app.put('/api/suporte-escalado/colunas/:id', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Renomeia/redescreve uma coluna do kanban de suporte escalado',
      description: 'Só troca rótulo/descrição exibidos — a chave interna (gravada em suporte_escalado.status) não muda.',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['rotulo'],
        properties: {
          rotulo: { type: 'string', minLength: 1, maxLength: 60 },
          descricao: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, async (req) => {
    const coluna = await colunaPorId(req.params.id);
    if (!coluna) throw new ErroHttp(404, 'Coluna não encontrada.');
    const board = await boardPorId(coluna.board_id);
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este board não é seu.');
    const rotulo = req.body.rotulo.trim();
    if (!rotulo) throw new ErroHttp(400, 'Dê um nome para a coluna.');
    const descricao = req.body.descricao === undefined ? null : req.body.descricao.trim() || null;
    const { rows } = await query(
      `UPDATE email_ia.suporte_escalado_colunas SET rotulo = $1, descricao = $2 WHERE id = $3
       RETURNING id, board_id, chave, rotulo, descricao, ordem`,
      [rotulo, descricao, req.params.id],
    );
    return rows[0];
  });

  app.delete('/api/suporte-escalado/colunas/:id', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Apaga uma coluna do kanban de suporte escalado',
      description: 'Recusa apagar se a coluna tiver algum caso nela, ou se for a coluna "pendente" '
        + '(é o destino padrão de todo caso escalado novo).',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req, resposta) => {
    const coluna = await colunaPorId(req.params.id);
    if (!coluna) throw new ErroHttp(404, 'Coluna não encontrada.');
    const board = await boardPorId(coluna.board_id);
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este board não é seu.');
    if (coluna.chave === 'pendente') {
      throw new ErroHttp(409, 'A coluna "Pendente" é a entrada padrão de todo caso novo — não pode ser apagada.');
    }
    const { rows: qtd } = await query(
      'SELECT count(*)::int AS total FROM email_ia.suporte_escalado WHERE board_id = $1 AND status = $2',
      [coluna.board_id, coluna.chave],
    );
    if (qtd[0].total > 0) {
      throw new ErroHttp(
        409,
        `Esta coluna tem ${qtd[0].total} caso${qtd[0].total === 1 ? '' : 's'} — mova ou reative antes de apagar.`,
      );
    }
    await query('DELETE FROM email_ia.suporte_escalado_colunas WHERE id = $1', [req.params.id]);
    resposta.code(204);
    return null;
  });

  /* ═══════════════════════  GET /api/suporte-escalado/:id/notas  ══════════════ */

  app.get('/api/suporte-escalado/:id/notas', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Notas internas de um caso escalado (ordem cronológica)',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
      },
    },
  }, async (req) => {
    const board = await boardDoCaso(req.params.id);
    if (!board) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const { rows } = await query(
      `SELECT id, suporte_escalado_id, autor, nota, criado_em, atualizado_em
       FROM email_ia.suporte_escalado_notas
       WHERE suporte_escalado_id = $1
       ORDER BY criado_em ASC`,
      [req.params.id],
    );
    return { notas: rows };
  });

  /* ═══════════════════════  POST /api/suporte-escalado/:id/notas  ═════════════ */

  app.post('/api/suporte-escalado/:id/notas', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Adiciona uma nota interna a um caso escalado',
      description: 'O autor vem da sessão de quem chama (não é campo do corpo) — não dá para '
        + 'assinar uma nota em nome de outra pessoa.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
      },
      body: {
        type: 'object',
        required: ['nota'],
        properties: { nota: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
    },
  }, async (req) => {
    const board = await boardDoCaso(req.params.id);
    if (!board) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const autor = req.usuario.nome || req.usuario.email || null;
    const { rows } = await query(
      `INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
       SELECT id, $2, $3 FROM email_ia.suporte_escalado WHERE id = $1
       RETURNING id, suporte_escalado_id, autor, nota, criado_em, atualizado_em`,
      [req.params.id, autor, req.body.nota.trim()],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Caso escalado não encontrado.');
    return rows[0];
  });

  /* ═══════════════════════  PUT /api/suporte-escalado/notas/:notaId  ══════════ */

  app.put('/api/suporte-escalado/notas/:notaId', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Edita o texto de uma nota interna já salva',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object', required: ['notaId'], properties: { notaId: { type: 'integer' } },
      },
      body: {
        type: 'object',
        required: ['nota'],
        properties: { nota: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
    },
  }, async (req) => {
    const { rows: notaRows } = await query(
      'SELECT suporte_escalado_id FROM email_ia.suporte_escalado_notas WHERE id = $1', [req.params.notaId],
    );
    if (!notaRows[0]) throw new ErroHttp(404, 'Nota não encontrada.');
    const board = await boardDoCaso(notaRows[0].suporte_escalado_id);
    if (!podeGerenciarBoard(req, board)) throw new ErroHttp(403, 'Este caso não é de um board seu.');
    const { rows } = await query(
      `UPDATE email_ia.suporte_escalado_notas SET nota = $1, atualizado_em = now()
       WHERE id = $2
       RETURNING id, suporte_escalado_id, autor, nota, criado_em, atualizado_em`,
      [req.body.nota.trim(), req.params.notaId],
    );
    return rows[0];
  });
}
