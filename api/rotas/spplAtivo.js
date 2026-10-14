/**
 * SPPL — Suporte Ativo (2º momento da Késsia, 14/10/2026). Contato ATIVO com clientes de pedidos com problema logístico, SEMPRE por seleção da equipe:
 * nada é enviado nem encaminhado sozinho (alertas continuam sem card e sem responsável — decisão de 13/10).
 *
 *   selecionar  pedidos do relatório viram tickets (propriedades iniciais "Caso novo - Analisar", ticket Aberto)
 *   tickets     lista com filtros, seleção individual/vários/todos do filtro, propriedades em massa (com conferência: `simular`)
 *   enviar      e-mail em massa INDIVIDUAL (um e-mail por cliente, sem expor os outros), com conferência antes (`simular`), fila e registro
 *   respostas   respostas dos clientes numa fila PRÓPRIA, separada da fila normal do suporte
 *
 * Enviar e-mail NÃO fecha nem resolve o ticket: o status só muda por ação da equipe. Ticket FECHADO sai do Monitoramento Logístico.
 */
import { randomUUID } from 'node:crypto';
import { query, pool } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { PROPRIEDADES, STATUS_LOGISTICO, MOTIVO_PROBLEMA, STATUS_SUPORTE, STATUS_TICKET, MARCADORES, MAX_POR_LOTE, MAX_SELECIONAR } from '../sppl/ativoConstantes.js';
import { acionarEnvioAtivo } from '../sppl/ativoEnvios.js';

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
  t.quadro_origem, t.selecionado_por, t.selecionado_em, t.atendida_em, t.fechado_em, t.atualizado_em,
  ev.ultimo_envio_em, ev.enviados, rp.ultima_resposta_em, rp.respostas,
  (rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity'))) AS resposta_pendente`;
const JOINS_TICKET = `FROM sppl_ativo_tickets t
  LEFT JOIN LATERAL (SELECT max(enviado_em) AS ultimo_envio_em, count(*)::int AS enviados FROM sppl_ativo_envios WHERE ticket_id = t.id AND status = 'enviado') ev ON true
  LEFT JOIN LATERAL (SELECT max(data_email) AS ultima_resposta_em, count(*)::int AS respostas FROM sppl_ativo_respostas WHERE ticket_id = t.id) rp ON true`;

function filtrosTickets(q) {
  const where = []; const valores = [];
  const add = (sql, v) => { valores.push(v); where.push(sql.replace('?', `$${valores.length}`)); };
  if (q.status_ticket === 'abertos') where.push(`t.status_ticket <> 'fechado'`);
  else if (q.status_ticket) { if (!STATUS_TICKET.includes(q.status_ticket)) throw new ErroHttp(400, 'Status do ticket inválido.'); add('t.status_ticket = ?', q.status_ticket); }
  if (q.status_logistico) { if (!STATUS_LOGISTICO.includes(q.status_logistico)) throw new ErroHttp(400, 'Status logístico inválido.'); add('t.status_logistico = ?', q.status_logistico); }
  if (q.motivo_problema) { if (!MOTIVO_PROBLEMA.includes(q.motivo_problema)) throw new ErroHttp(400, 'Motivo inválido.'); add('t.motivo_problema = ?', q.motivo_problema); }
  if (q.status_suporte) { if (!STATUS_SUPORTE.includes(q.status_suporte)) throw new ErroHttp(400, 'Status do suporte inválido.'); add('t.status_suporte = ?', q.status_suporte); }
  if (q.resposta === 'pendente') where.push(`(rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity')))`);
  if (q.contato === 'sem') where.push('coalesce(ev.enviados, 0) = 0');
  if (q.contato === 'com') where.push('coalesce(ev.enviados, 0) > 0');
  if (q.busca) {
    const b = `%${String(q.busca).slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; valores.push(b);
    where.push(`(t.transacao_id ILIKE $${valores.length} OR t.numero_pedido ILIKE $${valores.length} OR t.nome ILIKE $${valores.length} OR t.email ILIKE $${valores.length} OR t.rastreio_original ILIKE $${valores.length})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', valores };
}

/** Substitui os marcadores pelos dados de UM ticket. Marcador desconhecido é recusado antes (nunca sai "{xyz}" para o cliente). */
export function personalizar(modelo, t) {
  const primeiro = String(t.nome || '').trim().split(/\s+/)[0] || 'there';
  const v = { nome: primeiro, pedido: t.numero_pedido || t.transacao_id, produto: t.produto || 'your order', rastreio: t.rastreio_reenvio || t.rastreio_original || '', link_rastreio: t.link_reenvio || t.link_rastreio || '' };
  return String(modelo).replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));
}
function checarMarcadores(...textos) {
  for (const tx of textos) for (const m of String(tx).matchAll(/\{(\w+)\}/g)) if (!MARCADORES.includes(m[1])) throw new ErroHttp(400, `Marcador desconhecido: {${m[1]}}. Use: ${MARCADORES.map((x) => `{${x}}`).join(', ')}.`);
}

export default async function rotasSpplAtivo(app) {
  const auth = { onRequest: [app.exigirSessao] };
  const seg = [{ bearerAuth: [] }];

  app.get('/api/rastreio/sppl/ativo/constantes', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — listas das propriedades', security: seg } }, async () => ({
    status_logistico: STATUS_LOGISTICO, motivo_problema: MOTIVO_PROBLEMA, status_suporte: STATUS_SUPORTE, status_ticket: STATUS_TICKET, marcadores: MARCADORES, max_por_lote: MAX_POR_LOTE,
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
                                      count(*) FILTER (WHERE status_ticket = 'fechado')::int AS fechados FROM sppl_ativo_tickets`)).rows[0];
    const pend = (await query(`SELECT count(*)::int AS n ${JOINS_TICKET} WHERE t.status_ticket <> 'fechado' AND rp.ultima_resposta_em IS NOT NULL AND rp.ultima_resposta_em > greatest(coalesce(t.atendida_em, '-infinity'), coalesce(ev.ultimo_envio_em, '-infinity'))`)).rows[0].n;
    return { total, pagina, tamanho, itens: rows, kpis: { ...kpis, respostas_pendentes: pend } };
  });

  app.get('/api/rastreio/sppl/ativo/tickets/:id', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — um ticket com ações, envios e respostas', security: seg } }, async (req) => {
    const { rows } = await query(`SELECT ${COLUNAS_TICKET} ${JOINS_TICKET} WHERE t.id = $1`, [Number(req.params.id) || 0]);
    if (!rows[0]) throw new ErroHttp(404, 'Ticket não encontrado.');
    const acoes = (await query('SELECT tipo, detalhe, por, em FROM sppl_ativo_acoes WHERE ticket_id = $1 ORDER BY em DESC LIMIT 100', [rows[0].id])).rows;
    const envios = (await query('SELECT id, lote, assunto, texto, status, erro, criado_por, criado_em, enviado_em FROM sppl_ativo_envios WHERE ticket_id = $1 ORDER BY id DESC LIMIT 50', [rows[0].id])).rows;
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
  app.post('/api/rastreio/sppl/ativo/enviar', { ...auth, schema: { tags: ['Rastreio'], summary: 'SPPL Suporte Ativo — e-mail em massa INDIVIDUAL; `simular: true` devolve a conferência (destinatários, mensagem e propriedades)', security: seg } }, async (req) => {
    const lista = ids(req.body?.ids, MAX_POR_LOTE);
    const assunto = String(req.body?.assunto ?? '').trim(); const modelo = String(req.body?.texto ?? '').trim();
    if (!assunto || assunto.length > 200) throw new ErroHttp(400, 'Informe o assunto (até 200 caracteres).');
    if (modelo.length < 5 || modelo.length > 8000) throw new ErroHttp(400, 'A mensagem precisa ter entre 5 e 8000 caracteres.');
    checarMarcadores(assunto, modelo);
    const props = req.body?.propriedades && Object.keys(req.body.propriedades).length ? validarPropriedades(req.body.propriedades) : null;
    const { rows } = await query('SELECT * FROM sppl_ativo_tickets WHERE id = ANY($1::bigint[]) ORDER BY id', [lista]);
    const fechados = rows.filter((t) => t.status_ticket === 'fechado').map((t) => t.id);
    const semEmail = rows.filter((t) => !emailValido(t.email)).map((t) => ({ id: t.id, pedido: t.numero_pedido }));
    const envios = rows.filter((t) => t.status_ticket !== 'fechado' && emailValido(t.email)).map((t) => ({ ticket: t, para: String(t.email).trim().toLowerCase(), assunto: personalizar(assunto, t), texto: personalizar(modelo, t) }));
    if (req.body?.simular) {
      return { simulacao: true, total: envios.length, destinatarios: envios.map((e) => ({ ticket_id: e.ticket.id, pedido: e.ticket.numero_pedido, nome: e.ticket.nome, email: e.para })),
               exemplo: envios[0] ? { para: envios[0].para, assunto: envios[0].assunto, texto: envios[0].texto } : null, sem_email: semEmail, ignorados_fechados: fechados,
               propriedades: props, aviso: 'Cada cliente recebe o PRÓPRIO e-mail, sem ver os demais destinatários. O envio não fecha nem resolve o ticket.' };
    }
    if (req.body?.confirmar !== true) throw new ErroHttp(400, 'Confirme o envio (confirmar: true) depois de conferir os destinatários e a mensagem.');
    if (!envios.length) throw new ErroHttp(400, 'Nenhum ticket com e-mail válido para enviar.');
    const lote = randomUUID(); const por = quem(req);
    for (const e of envios) {
      await query(`INSERT INTO sppl_ativo_envios (ticket_id, lote, para_email, assunto, texto, criado_por) VALUES ($1,$2,$3,$4,$5,$6)`, [e.ticket.id, lote, e.para, e.assunto, e.texto, por]);
      await query(`INSERT INTO sppl_ativo_acoes (ticket_id, tipo, detalhe, por) VALUES ($1, 'email_enfileirado', $2, $3)`, [e.ticket.id, JSON.stringify({ lote, assunto: e.assunto }), por]);
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
}
