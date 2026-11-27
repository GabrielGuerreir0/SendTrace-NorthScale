/**
 * SPPL — Suporte Ativo (2º momento da Késsia, 14/10/2026). Contato ATIVO com clientes de pedidos com problema logístico, SEMPRE por seleção da equipe:
 * nada é enviado nem encaminhado sozinho (alertas continuam sem card e sem responsável — decisão de 13/10).
 *
 *   selecionar  pedidos do relatório viram tickets (propriedades iniciais "Caso novo - Analisar", ticket Aberto)
 *   tickets     lista com filtros, seleção individual/vários/todos do filtro, propriedades em massa (com conferência: `simular`)
 *   enviar      e-mail em massa INDIVIDUAL (um e-mail por cliente, sem expor os outros), com conferência antes (`simular`), fila e registro
 *   respostas   respostas dos clientes numa fila PRÓPRIA, separada da fila normal do suporte
 *   criar       "Novo ticket": ticket AVULSO iniciado pela equipe (e-mail e/ou pedido), com alerta de contato duplicado (migração 140)
 *   modelos     biblioteca de modelos de e-mail PT/EN + assinatura padrão (migração 141); o cliente recebe o texto em inglês
 *
 * Enviar e-mail NÃO fecha nem resolve o ticket: o status só muda por ação da equipe. Ticket FECHADO sai do Monitoramento Logístico.
 */
import { randomUUID } from 'node:crypto';
import { query, pool } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { PROPRIEDADES, STATUS_LOGISTICO, MOTIVO_PROBLEMA, STATUS_SUPORTE, STATUS_TICKET, MARCADORES, MAX_POR_LOTE, MAX_SELECIONAR, MAX_AVULSOS, DIAS_ALERTA_CONTATO, ASSINATURA_PADRAO, ORIGENS } from '../sppl/ativoConstantes.js';
import { acionarEnvioAtivo } from '../sppl/ativoEnvios.js';
import { personalizar, marcadorInvalido, slugModelo, validarModelo, validarAssinatura, modeloEditado } from '../sppl/ativoModelos.js';
import { separarEntradas, classificarEntrada, resolverEntradas, contatosAnteriores, rotuloChave } from '../sppl/ativoAvulso.js';

export { personalizar };

const quem = (req) => String(req.usuario?.nome || req.usuario?.email || 'desconhecido').slice(0, 120);
const ids = (v, max = MAX_SELECIONAR) => {
  if (!Array.isArray(v) || !v.length) throw new ErroHttp(400, 'Selecione pelo menos um ticket.');
  const n = [...new Set(v.map(Number))];
  if (n.some((x) => !Number.isInteger(x) || x <= 0)) throw new ErroHttp(400, 'Lista de tickets inválida.');
  if (n.length > max) throw new ErroHttp(400, `No máximo ${max} tickets por operação.`);
  return n;
};
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

/** Valida e normaliza as propriedades pedidas (individual ou em massa). */
export function validarPropriedades(p) {
  const out = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    const def = PROPRIEDADES[k];
    if (!def) throw new ErroHttp(400, `Propriedade desconhecida: ${k}.`);
    if (def.lista) { if (!def.lista.includes(v)) throw new ErroHttp(400, `Valor inválido para ${k}.`); out[k] = v; }
    else { const t = v === null || v === '' ? null : String(v).trim().slice(0, def.texto); out[k] = t || null; }
  }
  if (!Object.keys(out).length) throw new ErroHttp(400, 'Nenhuma propriedade para atualizar.');
  return out;
}

/** Aplica propriedades a vários tickets numa transação, registrando cada ação. Devolve quantos mudaram. */
export async function aplicarPropriedades(idsTickets, props, por) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: atuais } = await cli.query('SELECT * FROM sppl_ativo_tickets WHERE id = ANY($1::bigint[]) FOR UPDATE', [idsTickets]);
    let mudou = 0;
    for (const t of atuais) {
      const diff = {}; for (const [k, v] of Object.entries(props)) if ((t[k] ?? null) !== (v ?? null)) diff[k] = { de: t[k] ?? null, para: v };
      if (!Object.keys(diff).length) continue;
      const sets = Object.keys(diff).map((k, i) => `${k} = $${i + 2}`);
      const vals = Object.values(diff).map((d) => d.para);
      let extra = '';
      if (diff.status_ticket) extra = diff.status_ticket.para === 'fechado' ? ', fechado_em = now()' : ', fechado_em = NULL';
      await cli.query(`UPDATE sppl_ativo_tickets SET ${sets.join(', ')}${extra}, atualizado_em = now() WHERE id = $1`, [t.id, ...vals]);
      const tipo = diff.status_ticket?.para === 'fechado' ? 'fechado' : (diff.status_ticket && t.status_ticket === 'fechado' ? 'reaberto' : 'propriedades');
      await cli.query('INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, $2, $3, $4)', [t.id, tipo, JSON.stringify(diff), por]);
      mudou += 1;
    }
    await cli.query('COMMIT');
    return { selecionados: atuais.length, alterados: mudou };
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
}

const COLUNAS_TICKET = `t.id, t.transacao_id, t.numero_pedido, t.email, t.nome, t.produto, t.plataforma, t.fulfillment, t.transportadora,
  t.rastreio_original, t.link_rastreio, t.rastreio_reenvio, t.link_reenvio, t.status_logistico, t.motivo_problema, t.status_suporte, t.status_ticket,
  t.quadro_origem, t.origem, t.motivo_contato, t.pedido_transacao_id, t.selecionado_por, t.selecionado_em, t.atendida_em, t.fechado_em, t.atualizado_em,
  ev.ultimo_envio_em, ev.enviados, rp.ultima_resposta_em, rp.respostas,
  (rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity'))) AS resposta_pendente`;
const JOINS_TICKET = `FROM sppl_ativo_tickets t
  LEFT JOIN LATERAL (SELECT max(enviado_em) AS ultimo_envio_em, count(*)::int AS enviados FROM sppl_ativo_envios WHERE ticket_id = t.id AND status = 'enviado') ev ON true
  LEFT JOIN LATERAL (SELECT max(data_email) AS ultima_resposta_em, count(*)::int AS respostas FROM sppl_ativo_respostas WHERE ticket_id = t.id) rp ON true`;

function filtrosTickets(q) {
  const where = []; const valores = [];
  const add = (sql, v) => { valores.push(v); where.push(sql.replace('?', `$${valores.length}`)); };
  where.push('t.criado_pelo_monit IS NOT TRUE'); // ticket criado só para guardar tratativa do Monitoramento Logístico (142) não é ticket de envio
  if (q.status_ticket === 'abertos') where.push(`t.status_ticket <> 'fechado'`);
  else if (q.status_ticket) { if (!STATUS_TICKET.includes(q.status_ticket)) throw new ErroHttp(400, 'Status do ticket inválido.'); add('t.status_ticket = ?', q.status_ticket); }
  if (q.status_logistico) { if (!STATUS_LOGISTICO.includes(q.status_logistico)) throw new ErroHttp(400, 'Status logístico inválido.'); add('t.status_logistico = ?', q.status_logistico); }
  if (q.motivo_problema) { if (!MOTIVO_PROBLEMA.includes(q.motivo_problema)) throw new ErroHttp(400, 'Motivo inválido.'); add('t.motivo_problema = ?', q.motivo_problema); }
  if (q.status_suporte) { if (!STATUS_SUPORTE.includes(q.status_suporte)) throw new ErroHttp(400, 'Status do suporte inválido.'); add('t.status_suporte = ?', q.status_suporte); }
  if (q.resposta === 'pendente') where.push(`(rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity')))`);
  if (q.origem) { if (!ORIGENS.includes(q.origem)) throw new ErroHttp(400, 'Origem inválida.'); add('t.origem = ?', q.origem); }
  if (q.contato === 'sem') where.push('coalesce(ev.enviados, 0) = 0');
  if (q.contato === 'com') where.push('coalesce(ev.enviados, 0) > 0');
  if (q.busca) {
    const b = `%${String(q.busca).slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; valores.push(b);
    where.push(`(t.transacao_id ILIKE $${valores.length} OR t.numero_pedido ILIKE $${valores.length} OR t.nome ILIKE $${valores.length} OR t.email ILIKE $${valores.length} OR t.rastreio_original ILIKE $${valores.length})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', valores };
}

/** Recusa (400) marcador desconhecido: nunca sai "{xyz}" para o cliente. */
function checarMarcadores(...textos) { const m = marcadorInvalido(...textos); if (m) throw new ErroHttp(400, m); }

/** Assinatura padrão do e-mail ({assinatura}); configurável na tela (config_disparos.sppl_ativo_assinatura). */
async function assinaturaAtual() {
  const { rows } = await query(`SELECT valor FROM config_disparos WHERE chave = 'sppl_ativo_assinatura'`);
  return String(rows[0]?.valor ?? '').trim() || ASSINATURA_PADRAO;
}

/**
 * Alerta de CONTATO DUPLICADO (não bloqueia; a equipe decide): envios já feitos/na fila e tickets criados nos últimos DIAS_ALERTA_CONTATO dias para o mesmo
 * e-mail ou pedido. Devolve linhas cruas; `contatosAnteriores` (função pura) filtra por cliente.
 */
async function buscarContatos(emails, transacoes) {
  const em = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const tr = [...new Set(transacoes.filter(Boolean))];
  if (!em.length && !tr.length) return [];
  const dias = String(DIAS_ALERTA_CONTATO);
  const envios = await query(
    `SELECT lower(v.para_email) AS email, t.transacao_id, t.pedido_transacao_id, 'envio' AS tipo, v.criado_por AS por, coalesce(v.enviado_em, v.criado_em) AS quando,
            v.modelo_nome, v.assunto, v.status, t.id AS ticket_id
       FROM sppl_ativo_envios v JOIN sppl_ativo_tickets t ON t.id = v.ticket_id
      WHERE v.status IN ('enviado', 'fila', 'enviando') AND coalesce(v.enviado_em, v.criado_em) > now() - ($3 || ' days')::interval
        AND (lower(v.para_email) = ANY($1::text[]) OR t.transacao_id = ANY($2::text[]) OR t.pedido_transacao_id = ANY($2::text[]))
      ORDER BY 6 DESC LIMIT 500`, [em, tr, dias]);
  const tickets = await query(
    `SELECT lower(email) AS email, transacao_id, pedido_transacao_id, 'ticket' AS tipo, selecionado_por AS por, selecionado_em AS quando, NULL::text AS modelo_nome, NULL::text AS assunto,
            status_ticket AS status, id AS ticket_id, origem
       FROM sppl_ativo_tickets
      WHERE selecionado_em > now() - ($3 || ' days')::interval
        AND (lower(email) = ANY($1::text[]) OR transacao_id = ANY($2::text[]) OR pedido_transacao_id = ANY($2::text[]))
      ORDER BY selecionado_em DESC LIMIT 500`, [em, tr, dias]);
  return [...envios.rows, ...tickets.rows];
}
/** Só o que a tela precisa de cada contato anterior (sem repetir dados do cliente). */
const enxutos = (lista) => lista.map((c) => ({ tipo: c.tipo, por: c.por, quando: c.quando, modelo_nome: c.modelo_nome ?? null, assunto: c.assunto ?? null, status: c.status, ticket_id: c.ticket_id, origem: c.origem ?? null }));

/** Pedidos candidatos para as entradas do "Novo ticket": rastreio_pedidos (+ cadastro do cliente em disparos_pos_venda), depois disparos e compras de upsell/downsell sem rastreio. */
async function buscarPedidosParaAvulso(pedidos, emails) {
  if (!pedidos.length && !emails.length) return [];
  const { rows } = await query(
    `SELECT * FROM (
       SELECT p.transacao_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS numero_pedido, d.nome, d.email, d.produto, d.plataforma, p.provedor AS fulfillment,
              p.carrier_code, p.tracking_number, p.tracking_url, coalesce(p.order_created_at, d.criado_em, p.criado_em) AS data
         FROM rastreio_pedidos p LEFT JOIN disparos_pos_venda d ON d.transacao_id = p.transacao_id
        WHERE p.transacao_id = ANY($1::text[]) OR p.order_number = ANY($1::text[]) OR lower(d.email) = ANY($2::text[])
       UNION ALL
       SELECT d.transacao_id, d.transacao_id, d.nome, d.email, d.produto, d.plataforma, NULL::text, NULL::text, NULL::text, NULL::text, d.criado_em
         FROM disparos_pos_venda d
        WHERE (d.transacao_id = ANY($1::text[]) OR lower(d.email) = ANY($2::text[])) AND NOT EXISTS (SELECT 1 FROM rastreio_pedidos p WHERE p.transacao_id = d.transacao_id)
       UNION ALL
       SELECT c.transacao_id, c.transacao_id, c.nome, c.email, c.produto, c.plataforma, NULL::text, NULL::text, NULL::text, NULL::text, c.criado_em
         FROM compras_upsell_downsell c
        WHERE (c.transacao_id = ANY($1::text[]) OR lower(c.email) = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM rastreio_pedidos p WHERE p.transacao_id = c.transacao_id) AND NOT EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE d.transacao_id = c.transacao_id)
     ) u ORDER BY data DESC NULLS LAST LIMIT 3000`, [pedidos, emails]);
  return rows;
}

export default async function rotasSpplAtivo(app) {
  const auth = { onRequest: [app.exigirSessao] };
  const seg = [{ bearerAuth: [] }];

  app.get('/api/rastreio/sppl/ativo/constantes', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — listas das propriedades', security: seg } }, async () => ({
    status_logistico: STATUS_LOGISTICO, motivo_problema: MOTIVO_PROBLEMA, status_suporte: STATUS_SUPORTE, status_ticket: STATUS_TICKET, marcadores: MARCADORES, max_por_lote: MAX_POR_LOTE, max_avulsos: MAX_AVULSOS, origens: ORIGENS,
  }));

  // ── selecionar pedidos (do relatório) para o Suporte Ativo ──
  app.post('/api/rastreio/sppl/ativo/selecionar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL — "Selecionar para Suporte Ativo": cria um ticket por pedido (idempotente)', security: seg } }, async (req) => {
    const lista = req.body?.transacao_ids;
    if (!Array.isArray(lista) || !lista.length) throw new ErroHttp(400, 'Selecione pelo menos um pedido.');
    const trans = [...new Set(lista.map((x) => String(x).slice(0, 120)))];
    if (trans.length > MAX_SELECIONAR) throw new ErroHttp(400, `No máximo ${MAX_SELECIONAR} pedidos por vez.`);
    const por = quem(req);
    const { rows: pedidos } = await query(
      `SELECT l.transacao_id, l.numero_pedido, l.email, l.nome, l.produto, l.plataforma, l.fulfillment, coalesce(t17.provedor, l.carrier_code) AS transportadora, l.tracking_number,
              coalesce(nullif(l.tracking_url, ''), CASE WHEN coalesce(l.tracking_number, '') <> '' THEN 'https://t.17track.net/pt#nums=' || l.tracking_number END) AS link, l.quadro
         FROM sppl_logistica l
         LEFT JOIN LATERAL (SELECT e.provedor_17t AS provedor FROM rastreio_17t_eventos e WHERE e.numero = l.numero_17t AND e.provedor_17t IS NOT NULL ORDER BY e.ocorreu_em DESC LIMIT 1) t17 ON true
        WHERE l.transacao_id = ANY($1::text[])`, [trans]);
    const achados = new Set(pedidos.map((p) => p.transacao_id));
    let criados = 0; let jaExistiam = 0;
    for (const p of pedidos) {
      const { rows } = await query(
        `INSERT INTO sppl_ativo_tickets (transacao_id, numero_pedido, email, nome, produto, plataforma, fulfillment, transportadora, rastreio_original, link_rastreio, quadro_origem, selecionado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (transacao_id) WHERE status_ticket <> 'fechado' DO NOTHING RETURNING id`,
        [p.transacao_id, p.numero_pedido, p.email, p.nome, p.produto, p.plataforma, p.fulfillment, p.transportadora, p.tracking_number, p.link, p.quadro, por]);
      if (rows[0]) { criados += 1; await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'selecionado', $2, $3)`, [rows[0].id, JSON.stringify({ quadro: p.quadro }), por]); }
      else jaExistiam += 1;
    }
    return { selecionados: trans.length, criados, ja_existiam: jaExistiam, nao_encontrados: trans.filter((x) => !achados.has(x)) };
  });

  // ── lista de tickets ──
  app.get('/api/rastreio/sppl/ativo/tickets', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — tickets com filtros; `so_ids=1` devolve só os ids do filtro (seleção "todos do filtro")', security: seg } }, async (req) => {
    const f = filtrosTickets(req.query ?? {});
    if (req.query?.so_ids === '1') {
      const { rows } = await query(`SELECT t.id ${JOINS_TICKET} ${f.sql} ORDER BY t.id LIMIT ${MAX_SELECIONAR + 1}`, f.valores);
      return { ids: rows.slice(0, MAX_SELECIONAR).map((r) => r.id), cortado: rows.length > MAX_SELECIONAR };
    }
    const tamanho = Math.min(200, Math.max(1, Number(req.query?.tamanho) || 50)); const pagina = Math.max(1, Number(req.query?.pagina) || 1);
    const total = (await query(`SELECT count(*)::int AS n ${JOINS_TICKET} ${f.sql}`, f.valores)).rows[0].n;
    const { rows } = await query(`SELECT ${COLUNAS_TICKET} ${JOINS_TICKET} ${f.sql} ORDER BY (rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity'))) DESC, t.selecionado_em DESC LIMIT ${tamanho} OFFSET ${(pagina - 1) * tamanho}`, f.valores);
    const kpis = (await query(`SELECT count(*) FILTER (WHERE status_ticket = 'aberto')::int AS abertos, count(*) FILTER (WHERE status_ticket = 'resolvido')::int AS resolvidos,
                                      count(*) FILTER (WHERE status_ticket = 'fechado')::int AS fechados FROM sppl_ativo_tickets WHERE ($1::text IS NULL OR origem = $1)`, [req.query?.origem || null])).rows[0];
    const pend = (await query(`SELECT count(*)::int AS n ${JOINS_TICKET} WHERE t.status_ticket <> 'fechado' AND ($1::text IS NULL OR t.origem = $1) AND rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity'))`, [req.query?.origem || null])).rows[0].n;
    return { total, pagina, tamanho, itens: rows, kpis: { ...kpis, respostas_pendentes: pend } };
  });

  app.get('/api/rastreio/sppl/ativo/tickets/:id', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — um ticket com ações, envios e respostas', security: seg } }, async (req) => {
    const { rows } = await query(`SELECT ${COLUNAS_TICKET} ${JOINS_TICKET} WHERE t.id = $1`, [Number(req.params.id) || 0]);
    if (!rows[0]) throw new ErroHttp(404, 'Ticket não encontrado.');
    const acoes = (await query('SELECT tipo, detalhe, por, em FROM sppl_ativo_acoes WHERE ticket_id = $1 ORDER BY em DESC LIMIT 100', [rows[0].id])).rows;
    const envios = (await query('SELECT id, lote, assunto, texto, status, erro, criado_por, criado_em, enviado_em, modelo_id, modelo_nome FROM sppl_ativo_envios WHERE ticket_id = $1 ORDER BY id DESC LIMIT 50', [rows[0].id])).rows;
    const respostas = (await query('SELECT email_id, data_email, assunto, left(corpo_texto, 4000) AS corpo FROM sppl_ativo_respostas WHERE ticket_id = $1 ORDER BY data_email DESC LIMIT 30', [rows[0].id])).rows;
    return { ...rows[0], acoes, envios, respostas };
  });

  // ── propriedades (um ticket) ──
  app.patch('/api/rastreio/sppl/ativo/tickets/:id', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — altera propriedades de um ticket', security: seg } }, async (req) => {
    const r = await aplicarPropriedades([Number(req.params.id) || 0], validarPropriedades(req.body?.propriedades ?? req.body), quem(req));
    if (!r.selecionados) throw new ErroHttp(404, 'Ticket não encontrado.');
    return r;
  });

  // ── propriedades em massa (com conferência) ──
  app.post('/api/rastreio/sppl/ativo/propriedades', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — atualização em massa de propriedades; `simular: true` só mostra o que mudaria', security: seg } }, async (req) => {
    const lista = ids(req.body?.ids); const props = validarPropriedades(req.body?.propriedades);
    if (req.body?.simular) {
      const { rows } = await query('SELECT id, status_logistico, motivo_problema, status_suporte, status_ticket, rastreio_reenvio, link_reenvio FROM sppl_ativo_tickets WHERE id = ANY($1::bigint[])', [lista]);
      const mudancas = {}; let alterariam = 0;
      for (const t of rows) { let m = false; for (const [k, v] of Object.entries(props)) if ((t[k] ?? null) !== (v ?? null)) { mudancas[k] = (mudancas[k] || 0) + 1; m = true; } if (m) alterariam += 1; }
      return { simulacao: true, selecionados: rows.length, alterariam, por_propriedade: mudancas, propriedades: props };
    }
    if (req.body?.confirmar !== true) throw new ErroHttp(400, 'Confirme a operação (confirmar: true) depois de conferir.');
    return aplicarPropriedades(lista, props, quem(req));
  });

  // ── e-mail em massa individual ──
  // O cliente recebe INGLÊS: `assunto`/`texto` são o texto em inglês (preenchido pelo modelo, editável). `modelo_id` (opcional) registra o modelo usado;
  // se vierem vazios, usa assunto_en/corpo_en do modelo.
  app.post('/api/rastreio/sppl/ativo/enviar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — e-mail em massa INDIVIDUAL; `simular: true` devolve a conferência (destinatários, mensagem, contatos anteriores e propriedades)', security: seg } }, async (req) => {
    const lista = ids(req.body?.ids, MAX_POR_LOTE);
    let modeloRow = null;
    if (req.body?.modelo_id) {
      modeloRow = (await query('SELECT id, nome, assunto_en, corpo_en FROM sppl_ativo_modelos WHERE id = $1', [String(req.body.modelo_id).slice(0, 60)])).rows[0];
      if (!modeloRow) throw new ErroHttp(400, 'Modelo de e-mail não encontrado.');
    }
    const assunto = String(req.body?.assunto || modeloRow?.assunto_en || '').trim(); const modelo = String(req.body?.texto || modeloRow?.corpo_en || '').trim();
    if (!assunto || assunto.length > 200) throw new ErroHttp(400, 'Informe o assunto (até 200 caracteres).');
    if (modelo.length < 5 || modelo.length > 8000) throw new ErroHttp(400, 'A mensagem precisa ter entre 5 e 8000 caracteres.');
    checarMarcadores(assunto, modelo);
    const props = req.body?.propriedades && Object.keys(req.body.propriedades).length ? validarPropriedades(req.body.propriedades) : null;
    const { rows } = await query(
      `SELECT t.*, nullif(p.endereco_entrega, '') AS endereco_entrega FROM sppl_ativo_tickets t
         LEFT JOIN rastreio_pedidos p ON p.transacao_id = coalesce(t.pedido_transacao_id, t.transacao_id)
        WHERE t.id = ANY($1::bigint[]) ORDER BY t.id`, [lista]);
    const assinatura = await assinaturaAtual();
    const fechados = rows.filter((t) => t.status_ticket === 'fechado').map((t) => t.id);
    const semEmail = rows.filter((t) => !emailValido(t.email)).map((t) => ({ id: t.id, pedido: t.numero_pedido || rotuloChave(t.transacao_id) }));
    const envios = rows.filter((t) => t.status_ticket !== 'fechado' && emailValido(t.email)).map((t) => ({ ticket: { ...t, assinatura }, para: String(t.email).trim().toLowerCase(),
      assunto: personalizar(assunto, { ...t, assinatura }), texto: personalizar(modelo, { ...t, assinatura }) }));
    if (req.body?.simular) {
      // dados que os marcadores usados precisam e o ticket não tem (a mensagem sairia com lacuna): aviso, não bloqueio
      const usados = new Set([...`${assunto} ${modelo}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
      const semDados = [];
      for (const e of envios) {
        const falta = ['pedido', 'rastreio', 'link_rastreio', 'endereco'].filter((k) => usados.has(k) && (k === 'endereco' ? !e.ticket.endereco_entrega : !personalizar(`{${k}}`, e.ticket)));
        if (falta.length) semDados.push({ ticket_id: e.ticket.id, email: e.para, faltando: falta });
      }
      const contatos = await buscarContatos(envios.map((e) => e.para), envios.flatMap((e) => [e.ticket.transacao_id, e.ticket.pedido_transacao_id]));
      const destinatarios = envios.map((e) => ({ ticket_id: e.ticket.id, pedido: e.ticket.numero_pedido || rotuloChave(e.ticket.transacao_id), nome: e.ticket.nome, email: e.para,
        contatos_anteriores: enxutos(contatosAnteriores({ email: e.para, transacoes: [e.ticket.transacao_id, e.ticket.pedido_transacao_id] }, contatos, 5, e.ticket.id)) }));
      return { simulacao: true, total: envios.length, destinatarios, ja_contatados: destinatarios.filter((d) => d.contatos_anteriores.length).length, sem_dados: semDados,
               modelo: modeloRow ? { id: modeloRow.id, nome: modeloRow.nome } : null, idioma: 'en',
               exemplo: envios[0] ? { para: envios[0].para, assunto: envios[0].assunto, texto: envios[0].texto } : null, sem_email: semEmail, ignorados_fechados: fechados,
               propriedades: props, aviso: 'Cada cliente recebe o PRÓPRIO e-mail (em inglês), sem ver os demais destinatários. O envio não fecha nem resolve o ticket.' };
    }
    if (req.body?.confirmar !== true) throw new ErroHttp(400, 'Confirme o envio (confirmar: true) depois de conferir os destinatários e a mensagem.');
    if (!envios.length) throw new ErroHttp(400, 'Nenhum ticket com e-mail válido para enviar.');
    const lote = randomUUID(); const por = quem(req);
    for (const e of envios) {
      await query(`INSERT INTO sppl_ativo_envios (ticket_id, lote, para_email, assunto, texto, criado_por, modelo_id, modelo_nome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.ticket.id, lote, e.para, e.assunto, e.texto, por, modeloRow?.id ?? null, modeloRow?.nome ?? null]);
      await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'email_enfileirado', $2, $3)`, [e.ticket.id, JSON.stringify({ lote, assunto: e.assunto, modelo: modeloRow?.nome ?? null }), por]);
    }
    let propsResultado = null;
    if (props) propsResultado = await aplicarPropriedades(envios.map((e) => e.ticket.id), props, por);
    acionarEnvioAtivo();
    return { lote, enfileirados: envios.length, sem_email: semEmail, ignorados_fechados: fechados, propriedades: propsResultado };
  });

  app.get('/api/rastreio/sppl/ativo/envios', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — andamento dos envios de um lote', security: seg } }, async (req) => {
    const lote = String(req.query?.lote ?? '').slice(0, 60);
    if (!lote) throw new ErroHttp(400, 'Informe o lote.');
    const { rows } = await query(`SELECT status, count(*)::int AS n FROM sppl_ativo_envios WHERE lote = $1 GROUP BY 1`, [lote]);
    const erros = (await query(`SELECT ticket_id, para_email, erro FROM sppl_ativo_envios WHERE lote = $1 AND status = 'falhou' ORDER BY id LIMIT 50`, [lote])).rows;
    return { lote, por_status: Object.fromEntries(rows.map((r) => [r.status, r.n])), falhas: erros };
  });

  app.post('/api/rastreio/sppl/ativo/envios/reenviar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — tenta de novo os envios que falharam de um lote', security: seg } }, async (req) => {
    const lote = String(req.body?.lote ?? '').slice(0, 60);
    const { rowCount } = await query(`UPDATE sppl_ativo_envios SET status = 'fila', tentativas = 0, erro = NULL, proxima_tentativa_em = now() WHERE lote = $1 AND status = 'falhou'`, [lote]);
    acionarEnvioAtivo();
    return { reenfileirados: rowCount };
  });

  // ── fila de respostas (separada da fila normal) ──
  app.get('/api/rastreio/sppl/ativo/respostas', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — respostas dos clientes (fila própria)', security: seg } }, async (req) => {
    const f = filtrosTickets({ ...(req.query ?? {}), resposta: req.query?.situacao === 'todas' ? undefined : 'pendente', status_ticket: req.query?.situacao === 'todas' ? undefined : 'abertos' });
    const where = f.sql ? `${f.sql} AND rp.respostas > 0` : 'WHERE rp.respostas > 0';
    const { rows } = await query(`SELECT ${COLUNAS_TICKET}, (SELECT left(corpo_texto, 600) FROM sppl_ativo_respostas r WHERE r.ticket_id = t.id ORDER BY data_email DESC LIMIT 1) AS ultima_resposta_texto,
                                         (SELECT assunto FROM sppl_ativo_respostas r WHERE r.ticket_id = t.id ORDER BY data_email DESC LIMIT 1) AS ultima_resposta_assunto
                                    ${JOINS_TICKET} ${where} ORDER BY rp.ultima_resposta_em DESC LIMIT 200`, f.valores);
    return { total: rows.length, itens: rows };
  });

  app.post('/api/rastreio/sppl/ativo/tickets/:id/atender', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — marca a resposta do cliente como tratada', security: seg } }, async (req) => {
    const { rows } = await query('UPDATE sppl_ativo_tickets SET atendida_em = now(), atualizado_em = now() WHERE id = $1 RETURNING id', [Number(req.params.id) || 0]);
    if (!rows[0]) throw new ErroHttp(404, 'Ticket não encontrado.');
    await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'atendida', NULL, $2)`, [rows[0].id, quem(req)]);
    return { ok: true };
  });

  // ── "Novo ticket": ticket AVULSO iniciado pela equipe (migração 140) ──
  // Entradas: e-mail e/ou número/ID do pedido (um ou vários, separados por linha/vírgula/espaço). Um ticket por CLIENTE. Nasce com origem 'equipe', sem SLA
  // (o Suporte Ativo é fila separada do Suporte Escalado) e fora das métricas da logística (filtro `origem`). Idempotente: ticket aberto do mesmo pedido/cliente é reaproveitado.
  app.post('/api/rastreio/sppl/ativo/criar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — "Novo ticket": cria tickets avulsos a partir de e-mails e/ou pedidos; `simular: true` só mostra quem foi encontrado e os avisos de contato duplicado', security: seg } }, async (req) => {
    const entradas = separarEntradas(req.body?.entradas ?? req.body?.texto);
    if (!entradas.length) throw new ErroHttp(400, 'Informe pelo menos um e-mail ou número de pedido.');
    if (entradas.length > MAX_AVULSOS) throw new ErroHttp(400, `No máximo ${MAX_AVULSOS} clientes por vez.`);
    const motivo = String(req.body?.motivo_contato ?? '').trim().slice(0, 200) || null;
    const cls = entradas.map(classificarEntrada);
    const pedidosTok = cls.filter((c) => c.tipo === 'pedido').map((c) => c.valor);
    const emailsTok = cls.filter((c) => c.tipo === 'email').map((c) => c.valor);
    const linhas = await buscarPedidosParaAvulso(pedidosTok, emailsTok);
    const trs = [...new Set([...linhas.map((l) => l.transacao_id), ...pedidosTok])];
    const emails = [...new Set([...emailsTok, ...linhas.map((l) => String(l.email || '').toLowerCase()).filter(Boolean)])];
    const chaves = [...new Set([...trs, ...trs.map((x) => `avulso:${x}`), ...emailsTok.map((x) => `avulso:${x}`)])];
    const { rows: abertos } = await query(
      `SELECT id, transacao_id, pedido_transacao_id, email, origem FROM sppl_ativo_tickets
        WHERE status_ticket <> 'fechado' AND (transacao_id = ANY($1::text[]) OR pedido_transacao_id = ANY($2::text[]) OR (origem = 'equipe' AND lower(email) = ANY($3::text[])))`, [chaves, trs, emails]);
    const itens = resolverEntradas(entradas, linhas, abertos);
    const contatos = await buscarContatos(itens.map((i) => i.email), itens.map((i) => i.pedido_transacao_id));
    for (const i of itens) i.contatos_anteriores = i.email ? enxutos(contatosAnteriores({ email: i.email, transacoes: [i.pedido_transacao_id] }, contatos, 5, i.ticket_id)) : [];
    const conta = (s) => itens.filter((i) => i.situacao === s).length;
    const resumo = { entradas: entradas.length, novos: conta('novo'), ja_existem: conta('ja_existe'), nao_encontrados: conta('nao_encontrado'), invalidos: conta('invalido'), sem_email: conta('sem_email'), repetidos: conta('repetido'),
                     com_contato_anterior: itens.filter((i) => ['novo', 'ja_existe'].includes(i.situacao) && i.contatos_anteriores.length).length, sem_pedido: itens.filter((i) => i.situacao === 'novo' && !i.pedido_transacao_id).length };
    const saida = (extra = {}) => ({ ...extra, resumo, itens: itens.map(({ chave, ...r }) => ({ ...r, chave_ticket: chave ? rotuloChave(chave) : null })) });
    if (req.body?.simular) return saida({ simulacao: true });
    if (req.body?.confirmar !== true) throw new ErroHttp(400, 'Confirme a criação (confirmar: true) depois de conferir quem foi encontrado.');
    const por = quem(req);
    for (const i of itens.filter((x) => x.situacao === 'novo')) {
      const link = i.link_rastreio || (i.rastreio ? `https://t.17track.net/pt#nums=${i.rastreio}` : null);
      const { rows } = await query(
        `INSERT INTO sppl_ativo_tickets (transacao_id, numero_pedido, email, nome, produto, plataforma, fulfillment, transportadora, rastreio_original, link_rastreio, selecionado_por, origem, motivo_contato, pedido_transacao_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'equipe',$12,$13) ON CONFLICT (transacao_id) WHERE status_ticket <> 'fechado' DO NOTHING RETURNING id`,
        [i.chave, i.numero_pedido, i.email, i.nome, i.produto, i.plataforma, i.fulfillment, i.transportadora, i.rastreio, link, por, motivo, i.pedido_transacao_id]);
      if (rows[0]) {
        i.ticket_id = rows[0].id;
        await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'criado_avulso', $2, $3)`,
          [rows[0].id, JSON.stringify({ chave: i.chave, motivo_contato: motivo, pedido_localizado: Boolean(i.pedido_transacao_id), contato_anterior: i.contatos_anteriores.length }), por]);
      } else {   // outro usuário criou no mesmo instante: reaproveita o ticket aberto
        i.situacao = 'ja_existe';
        i.ticket_id = (await query(`SELECT id FROM sppl_ativo_tickets WHERE transacao_id = $1 AND status_ticket <> 'fechado'`, [i.chave])).rows[0]?.id ?? null;
      }
    }
    const criados = itens.filter((i) => i.situacao === 'novo').length;
    return saida({ criados, ja_existiam: itens.filter((i) => i.situacao === 'ja_existe').length, ticket_ids: [...new Set(itens.filter((i) => i.ticket_id).map((i) => i.ticket_id))] });
  });

  // ── modelos de e-mail PT/EN (migração 141) e assinatura padrão ──
  const COLUNAS_MODELO = 'id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en, ativo, ordem, fabrica, atualizado_em, atualizado_por';
  const comEdicao = (m) => { const { fabrica, ...resto } = m; return { ...resto, de_fabrica: Boolean(fabrica), editado: modeloEditado(m) }; };

  app.get('/api/rastreio/sppl/ativo/modelos', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — biblioteca de modelos de e-mail (PT para a equipe, EN para o cliente) e assinatura padrão', security: seg } }, async () => {
    const { rows } = await query(`SELECT ${COLUNAS_MODELO} FROM sppl_ativo_modelos ORDER BY ordem, nome`);
    return { modelos: rows.map(comEdicao), assinatura: await assinaturaAtual(), assinatura_padrao: ASSINATURA_PADRAO, marcadores: MARCADORES };
  });

  app.post('/api/rastreio/sppl/ativo/modelos', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — cria um modelo de e-mail (exige assunto e texto em inglês)', security: seg } }, async (req) => {
    const v = validarModelo(req.body); if (v.erro) throw new ErroHttp(400, v.erro);
    const id = slugModelo(req.body?.id || v.valor.nome); if (!id) throw new ErroHttp(400, 'Nome inválido para gerar o código do modelo.');
    const { rows } = await query(
      `INSERT INTO sppl_ativo_modelos (id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en, ordem, atualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT coalesce(max(ordem), 0) + 10 FROM sppl_ativo_modelos),$8) ON CONFLICT (id) DO NOTHING RETURNING ${COLUNAS_MODELO}`,
      [id, v.valor.nome, v.valor.descricao_pt, v.valor.assunto_pt, v.valor.corpo_pt, v.valor.assunto_en, v.valor.corpo_en, quem(req)]);
    if (!rows[0]) throw new ErroHttp(409, `Já existe um modelo com o código "${id}". Edite o existente ou mude o nome.`);
    return comEdicao(rows[0]);
  });

  app.put('/api/rastreio/sppl/ativo/modelos/:id', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — salva um modelo (exige assunto e texto em inglês; marcadores validados)', security: seg } }, async (req) => {
    const v = validarModelo(req.body); if (v.erro) throw new ErroHttp(400, v.erro);
    const { rows } = await query(
      `UPDATE sppl_ativo_modelos SET nome = $2, descricao_pt = $3, assunto_pt = $4, corpo_pt = $5, assunto_en = $6, corpo_en = $7, atualizado_em = now(), atualizado_por = $8
        WHERE id = $1 RETURNING ${COLUNAS_MODELO}`, [String(req.params.id).slice(0, 60), v.valor.nome, v.valor.descricao_pt, v.valor.assunto_pt, v.valor.corpo_pt, v.valor.assunto_en, v.valor.corpo_en, quem(req)]);
    if (!rows[0]) throw new ErroHttp(404, 'Modelo não encontrado.');
    return comEdicao(rows[0]);
  });

  app.post('/api/rastreio/sppl/ativo/modelos/:id/restaurar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — "Voltar ao texto original": restaura um modelo de fábrica', security: seg } }, async (req) => {
    const { rows } = await query(
      `UPDATE sppl_ativo_modelos SET nome = fabrica->>'nome', descricao_pt = fabrica->>'descricao_pt', assunto_pt = fabrica->>'assunto_pt', corpo_pt = fabrica->>'corpo_pt',
              assunto_en = fabrica->>'assunto_en', corpo_en = fabrica->>'corpo_en', atualizado_em = now(), atualizado_por = $2
        WHERE id = $1 AND fabrica IS NOT NULL RETURNING ${COLUNAS_MODELO}`, [String(req.params.id).slice(0, 60), quem(req)]);
    if (!rows[0]) throw new ErroHttp(404, 'Modelo não encontrado ou sem texto de fábrica (modelos criados pela equipe não têm versão original).');
    return comEdicao(rows[0]);
  });

  app.post('/api/rastreio/sppl/ativo/modelos/:id/ativo', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — ativa ou desativa um modelo (`ativo: true|false`)', security: seg } }, async (req) => {
    if (typeof req.body?.ativo !== 'boolean') throw new ErroHttp(400, 'Informe ativo: true ou false.');
    const { rows } = await query(`UPDATE sppl_ativo_modelos SET ativo = $2, atualizado_em = now(), atualizado_por = $3 WHERE id = $1 RETURNING ${COLUNAS_MODELO}`, [String(req.params.id).slice(0, 60), req.body.ativo, quem(req)]);
    if (!rows[0]) throw new ErroHttp(404, 'Modelo não encontrado.');
    return comEdicao(rows[0]);
  });

  app.put('/api/rastreio/sppl/ativo/assinatura', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — define a assinatura padrão dos e-mails ({assinatura})', security: seg } }, async (req) => {
    const v = validarAssinatura(req.body?.assinatura); if (v.erro) throw new ErroHttp(400, v.erro);
    await query(`INSERT INTO config_disparos (chave, valor) VALUES ('sppl_ativo_assinatura', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [v.valor]);
    return { assinatura: v.valor };
  });
}
