/**
 * MONIT-SPPL — Fase 3: TRATATIVAS ligadas ao Suporte Ativo (seção 10). Sem tabela paralela: uma tratativa é uma linha de `sppl_ativo_acoes`
 * (tipo = 'tratativa', colunas trat_* da migração 142) presa ao ticket do pedido. Pedido sem ticket aberto ganha um ticket só para guardá-las
 * (`criado_pelo_monit = true`); ticket normal ou avulso (`avulso:<pedido>`, migração 140) já aberto é reaproveitado. Remover = marcar `removida_em`.
 * Este módulo NÃO mexe em api/rotas/spplAtivo.js nem nos módulos do envio: só lê/grava as tabelas do Suporte Ativo no esquema atual.
 */
import { pool, query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { MOTIVO_PROBLEMA } from '../sppl/ativoConstantes.js';
import { TIPOS_TRATATIVA, CLASSE_POR_CHAVE } from './classes.js';
import { CTE_APOIO, TRATADO_SQL } from './consultas.js';
import { produtoPrincipal } from './emailPuro.js';

const MAX_PEDIDOS = 1000;

/**
 * Acha (ou cria) o ticket do Suporte Ativo de UM pedido, dentro da transação `cli`. Ticket normal ou avulso aberto é reaproveitado; pedido sem ticket ganha um
 * (`criado_pelo_monit = true`) com e-mail/nome/produto do Monitoramento (e-mail que o ticket já tinha vazio é completado). Devolve `{ d, tk, criado }` ou null
 * se o pedido não existe. Usado pelas tratativas e pelo "Preparar e-mail padrão" (o envio em si é do Suporte Ativo).
 */
export async function garantirTicket(cli, id, por) {
  const { rows: [d] } = await cli.query(
    `SELECT p.transacao_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido, p.provedor, p.carrier_code, p.tracking_number, p.tracking_url,
            coalesce(nullif(btrim(m.nome_cliente), ''), dv.nome) AS nome, coalesce(nullif(btrim(m.email_cliente), ''), dv.email) AS email, dv.produto, dv.plataforma, m.classe, m.transportadora, m.link_rastreio
       FROM rastreio_pedidos p LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id LEFT JOIN monit_pedidos m ON m.transacao_id = p.transacao_id
      WHERE p.transacao_id = $1`, [id]);
  if (!d) return null;
  let { rows: [tk] } = await cli.query(`SELECT id, email FROM sppl_ativo_tickets WHERE transacao_id IN ($1, 'avulso:' || $1) AND status_ticket <> 'fechado' ORDER BY id DESC LIMIT 1`, [id]);
  let criado = false;
  if (!tk) {
    const motivo = MOTIVO_PROBLEMA.includes(CLASSE_POR_CHAVE[d.classe]?.motivo) ? CLASSE_POR_CHAVE[d.classe].motivo : 'Caso novo — Analisar';
    ({ rows: [tk] } = await cli.query(
      `INSERT INTO sppl_ativo_tickets (transacao_id, numero_pedido, email, nome, produto, plataforma, fulfillment, transportadora, rastreio_original, link_rastreio, motivo_problema, selecionado_por, criado_pelo_monit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true) ON CONFLICT DO NOTHING RETURNING id`,
      [id, d.pedido, d.email, d.nome, produtoPrincipal(d.produto) || d.produto, d.plataforma, d.provedor, d.transportadora ?? d.carrier_code, d.tracking_number, d.link_rastreio ?? d.tracking_url, motivo, por]));
    if (!tk) ({ rows: [tk] } = await cli.query(`SELECT id, email FROM sppl_ativo_tickets WHERE transacao_id = $1 AND status_ticket <> 'fechado'`, [id]));
    else {
      criado = true;
      await cli.query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'selecionado', $2, $3)`, [tk.id, JSON.stringify({ origem: 'monit-sppl' }), por]);
    }
  } else if (!String(tk.email ?? '').trim() && d.email) {
    await cli.query(`UPDATE sppl_ativo_tickets SET email = $2, nome = coalesce(nullif(nome, ''), $3), atualizado_em = now() WHERE id = $1`, [tk.id, d.email, d.nome]);
  }
  return { d, tk, criado };
}

/**
 * Registra UMA tratativa em cada pedido (transação única: ou grava todas ou nenhuma). Devolve quantas gravou e quantos tickets criou.
 * `modelo`/`assunto` (ou `assuntos`: assunto de cada pedido, por id) só para `email_cliente` marcado como enviado (seção 8). `viaSistema` marca a tratativa de um
 * e-mail ENVIADO pelo sistema (Suporte Ativo): ela aparece na lista de tratativas, mas NÃO conta de novo em "E-mails enviados" (o envio já conta; ponto 9 do PDF).
 */
export async function registrar({ pedidos, tipo, nota, modelo, assunto, assuntos, viaSistema = false, lote, por }) {
  if (!TIPOS_TRATATIVA[tipo]) throw new ErroHttp(400, 'Tipo de tratativa inválido.');
  const ids = [...new Set((Array.isArray(pedidos) ? pedidos : []).map((x) => String(x ?? '').slice(0, 120)).filter(Boolean))];
  if (!ids.length) throw new ErroHttp(400, 'Selecione pelo menos um pedido.');
  if (ids.length > MAX_PEDIDOS) throw new ErroHttp(400, `No máximo ${MAX_PEDIDOS} pedidos por operação.`);
  const texto = nota ? String(nota).trim().slice(0, 1000) : null;
  const cli = await pool.connect();
  let gravadas = 0; let ticketsCriados = 0; const semPedido = [];
  try {
    await cli.query('BEGIN');
    for (const id of ids) {
      const g = await garantirTicket(cli, id, por);
      if (!g) { semPedido.push(id); continue; }
      const { d, tk } = g; if (g.criado) ticketsCriados += 1;
      const marcado = tipo === 'email_cliente';   // `assuntos` = assunto já personalizado de cada pedido (e-mail marcado como enviado ou enviado pelo sistema)
      await cli.query(
        `INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por, trat_tipo, trat_nota, trat_classe, trat_modelo, trat_assunto) VALUES ($1, 'tratativa', $2, $3, $4, $5, $6, $7, $8)`,
        [tk.id, JSON.stringify({ tipo, nota: texto, classe: d.classe ?? null, origem: 'monit-sppl', ...(viaSistema ? { via_sistema: true, lote: lote ?? null } : {}) }), por, tipo, texto, d.classe ?? null,
          marcado ? (modelo ?? null) : null, marcado ? (assuntos?.[id] ?? assunto ?? null) : null]);
      gravadas += 1;
    }
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
  return { gravadas, tickets_criados: ticketsCriados, sem_pedido: semPedido };
}

/** Marca a tratativa como removida (o histórico fica). */
export async function remover(id, por) {
  const { rowCount } = await query(`UPDATE sppl_ativo_acoes SET removida_em = now(), removida_por = $2 WHERE id = $1 AND trat_tipo IS NOT NULL AND removida_em IS NULL`, [Number(id), por]);
  if (!rowCount) throw new ErroHttp(404, 'Tratativa não encontrada (ou já removida).');
  return { removida: true };
}

/** Tratativas de um pedido (a ficha também as lê, em folha.js). */
export async function doPedido(pedidoId) {
  const { rows } = await query(
    `SELECT a.id, a.trat_tipo AS tipo, a.trat_nota AS nota, a.trat_classe AS classe, a.trat_modelo AS modelo, a.trat_assunto AS assunto, a.em, a.por
       FROM sppl_ativo_acoes a JOIN sppl_ativo_tickets t ON t.id = a.ticket_id
      WHERE (t.transacao_id = $1 OR t.transacao_id = 'avulso:' || $1) AND a.trat_tipo IS NOT NULL AND a.removida_em IS NULL ORDER BY a.em DESC`, [pedidoId]);
  return rows;
}

/**
 * Painel da aba "Tratativas": cinco números, "Status no Monitoramento Logístico" (classe → tratados / em aberto, com os filtros globais), "O que foi feito"
 * (pedidos distintos por tipo) e a tabela dos pedidos tratados com a situação ATUAL (10 situações, seção 10, na ordem da especificação).
 */
export async function painel({ desde, reemb }) {
  const filtro = [`m.data_pedido >= $1::date`]; if (reemb === 'sem') filtro.push('NOT m.reemb'); else if (reemb === 'com') filtro.push('m.reemb');
  const { rows: classes } = await query(
    `WITH ${CTE_APOIO}
     SELECT m.classe, m.grupo, count(*)::int AS em_aberto, count(*) FILTER (WHERE ${TRATADO_SQL})::int AS tratados
       FROM monit_pedidos m LEFT JOIN em ON em.pedido_id = m.transacao_id LEFT JOIN tr ON tr.pedido_id = m.transacao_id WHERE ${filtro.join(' AND ')} GROUP BY 1, 2`, [desde]);
  const { rows: tratados } = await query(
    `WITH ${CTE_APOIO}, ids AS (SELECT pedido_id FROM tr UNION SELECT pedido_id FROM em)
     SELECT p.transacao_id AS pedido_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido, dv.nome AS nome_cliente,
            tr.n AS tratativas, tr.tipos AS tratativas_tipos, tr.ultima_em, tr.ultima_por, floor(extract(epoch FROM (now() - tr.ultima_em)) / 86400)::int AS dias_desde_ultima,
            coalesce(em.n, 0) AS emails_enviados,
            CASE
              WHEN dv.chargeback_em IS NOT NULL THEN 'chargeback' WHEN dv.reembolsado_em IS NOT NULL THEN 'reembolsado' WHEN p.status_interno = 'cancelled' THEN 'cancelado'
              WHEN p.tracking_status ~* 'original sender|returned to sender' OR g.ultimo_substatus IN ('Exception_Returned', 'Exception_Returning') THEN 'devolvido'
              WHEN p.status_interno = 'delivered' OR g.ultimo_status = 'Delivered' THEN 'entregue' WHEN p.status_interno = 'nao_encontrado' THEN 'nao_encontrado'
              WHEN coalesce(p.tracking_number, '') = '' THEN 'sem_codigo'
              WHEN g.ultimo_status IN ('DeliveryFailure', 'Exception', 'AvailableForPickup', 'Expired') THEN 'problema_entrega'
              WHEN coalesce(g.ultimo_status, '') IN ('', 'InfoReceived', 'NotFound') THEN 'aguardando_coleta' ELSE 'em_transito' END AS situacao,
            m.classe, m.grupo, m.ultima_movimentacao, m.dias_sem_movimentacao, coalesce(nullif(btrim(dv.plataforma), ''), m.plataforma) AS plataforma, coalesce(p.provedor, 'sem fulfillment') AS fulfillment
       FROM ids JOIN rastreio_pedidos p ON p.transacao_id = ids.pedido_id
       LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
       LEFT JOIN monit_pedidos m ON m.transacao_id = p.transacao_id LEFT JOIN tr ON tr.pedido_id = p.transacao_id LEFT JOIN em ON em.pedido_id = p.transacao_id
      ORDER BY tr.ultima_em DESC NULLS LAST LIMIT 5000`);
  const { rows: [tot] } = await query(
    `WITH ${CTE_APOIO} SELECT (SELECT coalesce(sum(n), 0)::int FROM tr) AS tratativas, (SELECT count(*)::int FROM tr) AS pedidos_com_tratativa`);
  const feito = {}; for (const t of tratados) for (const k of t.tratativas_tipos ?? []) feito[k] = (feito[k] ?? 0) + 1;
  const situacoes = {}; for (const t of tratados) situacoes[t.situacao] = (situacoes[t.situacao] ?? 0) + 1;
  const abertas = ['em_transito', 'aguardando_coleta', 'problema_entrega', 'sem_codigo', 'nao_encontrado'];
  return {
    numeros: {
      pedidos_tratados: tratados.length, tratativas: tot.tratativas, ja_entregues: situacoes.entregue ?? 0,
      ainda_em_aberto: abertas.reduce((s, k) => s + (situacoes[k] ?? 0), 0), viraram_reembolso_etc: ['chargeback', 'reembolsado', 'devolvido', 'cancelado'].reduce((s, k) => s + (situacoes[k] ?? 0), 0),
    },
    classes, o_que_foi_feito: feito, situacoes, tratados,
  };
}
