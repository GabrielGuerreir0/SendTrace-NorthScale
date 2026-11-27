/**
 * MONIT-SPPL — consultas de LEITURA sobre `monit_pedidos` (lista, resumo): os filtros da seção 3 (desde, reemb, fulfillment, plataforma, grupo, classe,
 * causa, tratado, multi, q) montados UMA vez e usados pela lista, pelo resumo, pela planilha e pela aba de tratativas, para os números baterem entre si.
 * Tudo parametrizado; nada do que vem da URL entra no SQL como texto, exceto a coluna de ordenação (lista fixa).
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { CLASSE_POR_CHAVE, GRUPOS, CAUSAS_FILTRO, traduzirTexto } from './classes.js';

export const DESDE_PADRAO = '2026-10-01';
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Apoio por pedido vindo do Suporte Ativo: `em` = e-mails já enviados (SendTrace + os marcados como enviados nas tratativas; "tratado" = tem algum) e
 * `tr` = tratativas mantidas. O tipo do e-mail é o `motivo_problema` do ticket, ou o assunto quando não há motivo (seção 8). Um pedido pode ter
 * ticket normal (`transacao_id`) ou avulso (`avulso:<transacao_id>`, migração 140): a chave do pedido sai das duas formas.
 */
export const CTE_APOIO = `
  tk AS (SELECT t.id, CASE WHEN t.transacao_id LIKE 'avulso:%' THEN substr(t.transacao_id, 8) ELSE t.transacao_id END AS pedido_id, t.motivo_problema, t.status_ticket FROM sppl_ativo_tickets t),
  em AS (
    SELECT x.pedido_id, count(*)::int AS n, string_agg(DISTINCT x.tipo, ' · ') AS tipos, max(x.quando) AS ultimo FROM (
      SELECT tk.pedido_id, coalesce(nullif(btrim(tk.motivo_problema), ''), v.assunto) AS tipo, v.enviado_em AS quando
        FROM sppl_ativo_envios v JOIN tk ON tk.id = v.ticket_id WHERE v.enviado_em IS NOT NULL
      UNION ALL
      SELECT tk.pedido_id, coalesce(nullif(btrim(a.trat_modelo), ''), a.trat_assunto, 'E-mail enviado ao cliente'), a.em
        FROM sppl_ativo_acoes a JOIN tk ON tk.id = a.ticket_id WHERE a.trat_tipo = 'email_cliente' AND a.removida_em IS NULL) x
     GROUP BY 1),
  tr AS (
    SELECT tk.pedido_id, count(*)::int AS n, max(a.em) AS ultima_em, (array_agg(a.por ORDER BY a.em DESC))[1] AS ultima_por, array_agg(DISTINCT a.trat_tipo) AS tipos
      FROM sppl_ativo_acoes a JOIN tk ON tk.id = a.ticket_id WHERE a.trat_tipo IS NOT NULL AND a.removida_em IS NULL GROUP BY 1)`;

/** "Tratado" = já recebeu e-mail (SendTrace ou marcado nas tratativas, seção 8) OU tem alguma tratativa registrada (seção 10). */
export const TRATADO_SQL = '(coalesce(em.n, 0) > 0 OR coalesce(tr.n, 0) > 0)';

/** Colunas que o cliente pode pedir como ordenação (nome → expressão). */
const ORDENS = {
  dias_desde_evento: 'm.dias_desde_evento', evento_em: 'm.evento_em', data_pedido: 'm.data_pedido', idade_dias: 'm.idade_dias', dias_sem_movimentacao: 'm.dias_sem_movimentacao',
  valor: 'm.valor', classe: 'm.classe', pedido: 'm.pedido', fulfillment: 'm.fulfillment', plataforma: 'm.plataforma', emails_enviados: 'coalesce(em.n, 0)',
  nome_cliente: 'm.nome_cliente', rastreio: 'm.rastreio', ultima_movimentacao: 'm.ultima_movimentacao',
};

/** Lê os filtros de `req.query`. `incluirClasse: false` ignora grupo/classe/causa (o resumo conta TODOS os grupos). */
export function lerFiltros(q = {}, { incluirClasse = true } = {}) {
  const f = { desde: DESDE_PADRAO, reemb: 'sem' };
  if (q.desde) { if (!SO_DATA.test(String(q.desde))) throw new ErroHttp(400, 'Data inválida (use AAAA-MM-DD).'); f.desde = String(q.desde); }
  if (q.reemb) { if (!['sem', 'com', 'todos'].includes(q.reemb)) throw new ErroHttp(400, 'Filtro de reembolso inválido (sem, com ou todos).'); f.reemb = q.reemb; }
  if (q.fulfillment) f.fulfillment = String(q.fulfillment).toLowerCase().slice(0, 40);
  if (q.plataforma) f.plataforma = String(q.plataforma).toLowerCase().slice(0, 40);
  if (incluirClasse) {
    if (q.grupo) { if (![...GRUPOS.map((g) => g.id)].includes(q.grupo)) throw new ErroHttp(400, 'Grupo inválido.'); f.grupo = q.grupo; }
    if (q.classe) { if (!CLASSE_POR_CHAVE[q.classe]) throw new ErroHttp(400, 'Classe inválida.'); f.classe = q.classe; }
    if (q.causa) { if (!CAUSAS_FILTRO.includes(q.causa)) throw new ErroHttp(400, 'Causa inválida.'); f.causa = q.causa; }
    if (q.multi === '1' || q.multi === 'true') f.multi = true;
  }
  if (q.tratado === 'sim' || q.tratado === 'nao') f.tratado = q.tratado;
  if (q.sem_ok === '1') f.sem_ok = true;   // "Pedidos para tratar": tudo menos o grupo "Não é problema"
  if (q.q) f.q = String(q.q).trim().slice(0, 80);
  return f;
}

/** WHERE (alias `m` = monit_pedidos, `em` = e-mails) + valores. */
export function montarWhere(f, valores = []) {
  const w = [];
  const add = (sql, v) => { valores.push(v); w.push(sql.replace('?', `$${valores.length}`)); };
  add('m.data_pedido >= ?::date', f.desde);
  if (f.reemb === 'sem') w.push('NOT m.reemb'); else if (f.reemb === 'com') w.push('m.reemb');
  if (f.fulfillment) add('lower(m.fulfillment) = ?', f.fulfillment);
  if (f.plataforma === '__sem') w.push("nullif(btrim(m.plataforma), '') IS NULL"); else if (f.plataforma) add('lower(btrim(m.plataforma)) = ?', f.plataforma);
  if (f.grupo) add('m.grupo = ?', f.grupo);
  if (f.classe) add('m.classe = ?', f.classe);
  if (f.causa) add('m.causa = ?', f.causa);
  if (f.multi) w.push('m.qtd_rastreios > 1');
  if (f.sem_ok) w.push("m.grupo <> 'ok'");
  if (f.tratado === 'sim') w.push(TRATADO_SQL); else if (f.tratado === 'nao') w.push(`NOT ${TRATADO_SQL}`);
  if (f.q) {
    valores.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${valores.length}`;
    w.push(`(m.transacao_id ILIKE ${p} OR m.pedido ILIKE ${p} OR m.nome_cliente ILIKE ${p} OR m.email_cliente ILIKE ${p} OR m.rastreio ILIKE ${p})`);
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', valores };
}

/** Colunas devolvidas na lista (as 30 do contrato, mais o apoio do Suporte Ativo). */
const COLUNAS_LISTA = `
  m.transacao_id AS pedido_id, m.pedido, m.email_cliente, m.nome_cliente, m.classe, m.grupo, m.causa, m.texto_transportadora, m.evento_em, m.dias_desde_evento,
  m.fulfillment, m.transportadora, m.rastreio, m.qtd_rastreios, m.outros_rastreios, m.transferido, m.link_rastreio, m.endereco, m.produtos, m.quantidade, m.valor, m.moeda,
  m.data_pedido, m.idade_dias, m.ultima_movimentacao, m.dias_sem_movimentacao, m.plataforma, m.reembolso_cb,
  coalesce(em.n, 0) AS emails_enviados, em.tipos AS emails_tipos, em.ultimo AS email_ultimo,
  coalesce(tr.n, 0) AS tratativas, tr.ultima_em AS tratativa_ultima_em, tr.ultima_por AS tratativa_ultima_por, tr.tipos AS tratativas_tipos,
  m.tem_17t, m.ultimo_status, m.dias_uteis`;

/** Enriquece a linha com o que a tela mostra: classe/grupo traduzidos, "como tratar", motivo e o texto da transportadora em português. */
export function enriquecer(l) {
  const c = CLASSE_POR_CHAVE[l.classe];
  return {
    ...l,
    classe_nome: c?.nome ?? l.classe, urgencia: c?.urgencia ?? '', motivo_suporte_ativo: c?.motivo ?? '', como_tratar: c?.comoTratar ?? '',
    texto_pt: l.texto_transportadora ? traduzirTexto(l.texto_transportadora) : '',
    link_rastreio: l.link_rastreio || (l.rastreio ? `https://t.17track.net/pt#nums=${l.rastreio}` : null),
  };
}

/** Lista paginada (ou inteira, com `limite` grande, para a planilha). */
export async function listar(f, { ordem = 'dias_desde_evento', dir = 'desc', limite = 100, offset = 0 } = {}) {
  const col = ORDENS[ordem] ?? ORDENS.dias_desde_evento;
  const sentido = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const { sql: where, valores } = montarWhere(f);
  const { rows } = await query(
    `WITH ${CTE_APOIO}
     SELECT ${COLUNAS_LISTA}, count(*) OVER ()::int AS total_filtro
       FROM monit_pedidos m LEFT JOIN em ON em.pedido_id = m.transacao_id LEFT JOIN tr ON tr.pedido_id = m.transacao_id
       ${where}
      ORDER BY ${col} ${sentido} NULLS LAST, m.data_pedido ASC, m.transacao_id
      LIMIT ${Math.min(50_000, Math.max(1, Number(limite) || 100))} OFFSET ${Math.max(0, Number(offset) || 0)}`,
    valores,
  );
  const total = rows[0]?.total_filtro ?? (offset > 0 ? (await contar(f)) : 0);
  for (const r of rows) delete r.total_filtro;
  return { total, itens: rows.map(enriquecer) };
}

async function contar(f) {
  const { sql: where, valores } = montarWhere(f);
  const { rows: [r] } = await query(`WITH ${CTE_APOIO} SELECT count(*)::int AS n FROM monit_pedidos m LEFT JOIN em ON em.pedido_id = m.transacao_id LEFT JOIN tr ON tr.pedido_id = m.transacao_id ${where}`, valores);
  return r.n;
}

/**
 * Resumo (barras por grupo e classe, aviso de vários rastreios, "A verificar com o dev"). Respeita desde/reemb/fulfillment/plataforma e NÃO o grupo/classe
 * (a barra mostra todos). A porcentagem de cada grupo usa o total dos 5 grupos; `nao_encontrado` continua dentro de Sem rastreio e também vira aviso.
 */
export async function resumir(f) {
  const { sql: where, valores } = montarWhere({ ...f, grupo: undefined, classe: undefined, causa: undefined, multi: undefined, tratado: undefined, q: undefined });
  const { rows } = await query(`SELECT m.grupo, m.classe, count(*)::int AS n, count(*) FILTER (WHERE m.qtd_rastreios > 1)::int AS multi FROM monit_pedidos m ${where} GROUP BY 1, 2`, valores);
  const porClasse = {}; const porGrupo = Object.fromEntries(GRUPOS.map((g) => [g.id, 0])); let multi = 0;
  for (const r of rows) { porClasse[r.classe] = r.n; porGrupo[r.grupo] = (porGrupo[r.grupo] ?? 0) + r.n; multi += r.multi; }
  const total = Object.values(porGrupo).reduce((s, v) => s + v, 0);
  return { total, por_grupo: porGrupo, por_classe: porClasse, multi_rastreios: multi, verificar: porClasse.nao_encontrado ?? 0 };
}
