/**
 * MONIT-SPPL — "Preparar e-mail padrão", "Marcar como enviados" e envio individual (spec seção 8). Sem duplicar o Suporte Ativo:
 *   · modelos e personalização: api/sppl/ativoModelos.js (`personalizar`, 9 modelos de fábrica da migração 141, assinatura `{assinatura}`);
 *   · conferência de contato duplicado: api/sppl/ativoBusca.js + ativoAvulso.js;
 *   · ENVIO: o próprio endpoint do Suporte Ativo (`POST /api/rastreio/sppl/ativo/enviar`, chamado por dentro com a sessão de quem pediu) — um e-mail por cliente,
 *     fila espaçada, teto por hora, sem nunca expor os outros destinatários. Aqui só se garante o ticket de cada pedido (api/monit/tratativas.js `garantirTicket`)
 *     e se registra a tratativa.
 * Fluxo: preparar (lê, não grava) → simular (lê, não grava) → confirmar (cria/atualiza o ticket, enfileira, registra a tratativa). Nada sai sem `confirmar: true`.
 * Dado pessoal só para quem já tem a página Rastreio (mesma regra das outras rotas do MONIT-SPPL).
 */
import { pool, query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { MAX_POR_LOTE, MAX_SELECIONAR } from '../sppl/ativoConstantes.js';
import { marcadorInvalido } from '../sppl/ativoModelos.js';
import { contatosAnteriores } from '../sppl/ativoAvulso.js';
import { assinaturaAtual, buscarContatos, enxutos } from '../sppl/ativoBusca.js';
import { CLASSE_POR_CHAVE } from './classes.js';
import { garantirTicket, registrar } from './tratativas.js';
import { MODELOS_ORDEM, modeloDaSelecao, produtoPrincipal, renderizar } from './emailPuro.js';

const LINK17 = (n) => `https://t.17track.net/pt#nums=${n}`;
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

/** Lê e valida a lista de pedidos do corpo (únicos, texto curto, no máximo `max`). */
function lerPedidos(v, max) {
  const ids = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? '').slice(0, 120)).filter(Boolean))];
  if (!ids.length) throw new ErroHttp(400, 'Selecione pelo menos um pedido.');
  if (ids.length > max) throw new ErroHttp(400, `No máximo ${max} pedidos por operação${max === MAX_POR_LOTE ? ' de envio: envie em lotes menores' : ''}.`);
  return ids;
}

/** Assunto e texto: tamanhos do Suporte Ativo e campos entre chaves conhecidos (nunca sai "{xyz}"). */
function validarTextos(assunto, texto, { exigir = true } = {}) {
  const a = String(assunto ?? '').trim(); const t = String(texto ?? '').replace(/\r\n/g, '\n').trim();
  if (exigir) {
    if (!a || a.length > 200) throw new ErroHttp(400, 'Informe o assunto (até 200 caracteres).');
    if (t.length < 5 || t.length > 8000) throw new ErroHttp(400, 'A mensagem precisa ter entre 5 e 8000 caracteres.');
  }
  const m = marcadorInvalido(a, t); if (m) throw new ErroHttp(400, m);
  return { assunto: a, texto: t };
}

/** Dados de cada pedido, NA ORDEM pedida: cliente (e-mail/nome já resolvidos pelo Monitoramento), classe e o que os campos do modelo precisam. */
export async function carregarPedidos(ids) {
  const { rows } = await query(
    `SELECT p.transacao_id AS pedido_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido,
            coalesce(nullif(btrim(m.nome_cliente), ''), dv.nome) AS nome, coalesce(nullif(btrim(m.email_cliente), ''), dv.email) AS email,
            coalesce(nullif(dv.produto, ''), m.produtos) AS produto_bruto, m.classe,
            coalesce(nullif(m.rastreio, ''), nullif(p.tracking_number, '')) AS rastreio, coalesce(nullif(m.link_rastreio, ''), nullif(p.tracking_url, '')) AS link_rastreio,
            coalesce(nullif(m.transportadora, ''), nullif(p.carrier_code, '')) AS transportadora, coalesce(nullif(m.endereco, ''), nullif(p.endereco_entrega, '')) AS endereco_entrega
       FROM rastreio_pedidos p LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id LEFT JOIN monit_pedidos m ON m.transacao_id = p.transacao_id
      WHERE p.transacao_id = ANY($1::text[])`, [ids]);
  const por = new Map(rows.map((r) => [r.pedido_id, r]));
  return ids.map((id) => por.get(id)).filter(Boolean).map((r) => ({
    ...r, email: String(r.email ?? '').trim().toLowerCase() || null, produto: produtoPrincipal(r.produto_bruto) || null,
    link_rastreio: r.link_rastreio ?? (r.rastreio ? LINK17(r.rastreio) : null), classe_nome: CLASSE_POR_CHAVE[r.classe]?.nome ?? null,
  }));
}

/** Linha no formato que `renderizar`/`personalizar` esperam (a mesma de um ticket do Suporte Ativo). */
const comoTicket = (r, assinatura) => ({ transacao_id: r.pedido_id, numero_pedido: r.pedido, nome: r.nome, email: r.email, produto: r.produto, rastreio_original: r.rastreio,
  link_rastreio: r.link_rastreio, transportadora: r.transportadora, endereco_entrega: r.endereco_entrega, assinatura });

/** Os 9 modelos ativos (nome, o que diz, textos PT e EN). */
export async function listarModelos() {
  const { rows } = await query(`SELECT id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en FROM sppl_ativo_modelos WHERE ativo ORDER BY ordem, id`);
  return rows;
}

/**
 * "Preparar e-mail padrão": lê os pedidos, sugere o modelo pela classe mais frequente e devolve, para cada cliente COM e-mail, o assunto e o texto já
 * preenchidos (`idioma` 'en' = o que o cliente recebe; 'pt' = a leitura da equipe). Não grava nada.
 * `assunto`/`texto` opcionais: o texto editado na tela (senão vale o do modelo escolhido, no idioma pedido). `so_pedido`: devolve o texto só desse pedido (a prévia);
 * `lista` traz sempre todos os clientes com e-mail (para navegar na prévia).
 */
export async function preparar({ pedidos, modelo_id: modeloId, assunto, texto, idioma, so_pedido: soPedido }) {
  const ids = lerPedidos(pedidos, MAX_SELECIONAR);
  const lang = idioma === 'pt' ? 'pt' : 'en';
  const rows = await carregarPedidos(ids);
  const modelos = await listarModelos();
  const sug = modeloDaSelecao(rows.map((r) => r.classe));
  const escolhido = modelos.find((m) => m.id === (modeloId || sug.modelo)) ?? modelos.find((m) => m.id === sug.modelo) ?? modelos[0] ?? null;
  const base = {
    assunto: String(assunto ?? '').trim() || (lang === 'pt' ? escolhido?.assunto_pt : escolhido?.assunto_en) || '',
    texto: String(texto ?? '').trim() || (lang === 'pt' ? escolhido?.corpo_pt : escolhido?.corpo_en) || '',
  };
  validarTextos(base.assunto, base.texto, { exigir: false });
  const assinatura = await assinaturaAtual();
  const comEmail = rows.filter((r) => emailValido(r.email));
  const itens = comEmail.filter((r) => !soPedido || r.pedido_id === soPedido).map((r) => {
    const t = comoTicket(r, assinatura);
    return { pedido_id: r.pedido_id, pedido: r.pedido, nome: r.nome, email: r.email, rastreio: r.rastreio, classe: r.classe, classe_nome: r.classe_nome,
      assunto: renderizar(base.assunto, t, lang), texto: renderizar(base.texto, t, lang) };
  });
  return {
    total: ids.length, encontrados: rows.length, com_email: comEmail.length, nao_encontrados: ids.filter((id) => !rows.some((r) => r.pedido_id === id)),
    sem_email: rows.filter((r) => !emailValido(r.email)).map((r) => ({ pedido_id: r.pedido_id, pedido: r.pedido })),
    modelo_sugerido: sug.modelo, por_modelo: sug.por_modelo,
    lista: comEmail.map((r) => ({ pedido_id: r.pedido_id, pedido: r.pedido, nome: r.nome, email: r.email, classe_nome: r.classe_nome })), traducao_ia: Boolean(process.env.ANTHROPIC_API_KEY),
    modelo: escolhido, modelos: modelos.map((m) => ({ id: m.id, nome: m.nome, descricao_pt: m.descricao_pt })), modelos_ordem: MODELOS_ORDEM, idioma: lang, itens,
  };
}

/** Conferência (SEM gravar nada): quem receberia, a mensagem de exemplo, avisos de dado faltando e de contato anterior (mesma conferência do Suporte Ativo). */
export async function simular({ pedidos, assunto, texto, modelo_id: modeloId }) {
  const ids = lerPedidos(pedidos, MAX_POR_LOTE);
  const { assunto: a, texto: t } = validarTextos(assunto, texto);
  const rows = await carregarPedidos(ids); const assinatura = await assinaturaAtual();
  const com = rows.filter((r) => emailValido(r.email));
  const semEmail = rows.filter((r) => !emailValido(r.email)).map((r) => ({ pedido_id: r.pedido_id, pedido: r.pedido }));
  const usados = new Set([...`${a} ${t}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
  const semDados = [];
  for (const r of com) {
    const tk = comoTicket(r, assinatura);
    const falta = ['pedido', 'rastreio', 'link_rastreio', 'endereco'].filter((k) => usados.has(k) && (k === 'endereco' ? !tk.endereco_entrega : !renderizar(`{${k}}`, tk)));
    if (falta.length) semDados.push({ pedido_id: r.pedido_id, pedido: r.pedido, faltando: falta });
  }
  const contatos = await buscarContatos(com.map((r) => r.email), com.map((r) => r.pedido_id));
  // ticket aberto que o pedido já tem não conta como "contato anterior" dele mesmo (igual ao Suporte Ativo)
  const { rows: abertos } = com.length ? await query(`SELECT id, CASE WHEN transacao_id LIKE 'avulso:%' THEN substr(transacao_id, 8) ELSE transacao_id END AS pedido_id FROM sppl_ativo_tickets WHERE status_ticket <> 'fechado' AND (transacao_id = ANY($1::text[]) OR transacao_id = ANY($2::text[]))`,
    [com.map((r) => r.pedido_id), com.map((r) => `avulso:${r.pedido_id}`)]) : { rows: [] };
  const ticketAberto = new Map(abertos.map((x) => [x.pedido_id, x.id]));
  const destinatarios = com.map((r) => ({
    pedido_id: r.pedido_id, pedido: r.pedido, nome: r.nome, email: r.email, ticket_id: ticketAberto.get(r.pedido_id) ?? null,
    contatos_anteriores: enxutos(contatosAnteriores({ email: r.email, transacoes: [r.pedido_id] }, contatos, 5, ticketAberto.get(r.pedido_id) ?? null)),
  }));
  let modelo = null;
  if (modeloId) { const { rows: [m] } = await query('SELECT id, nome FROM sppl_ativo_modelos WHERE id = $1', [String(modeloId).slice(0, 60)]); modelo = m ?? null; }
  const ex = com[0] && comoTicket(com[0], assinatura);
  return {
    simulacao: true, total: com.length, destinatarios, ja_contatados: destinatarios.filter((d) => d.contatos_anteriores.length).length, sem_dados: semDados, sem_email: semEmail, modelo, idioma: 'en',
    exemplo: ex ? { para: com[0].email, assunto: renderizar(a, ex), texto: renderizar(t, ex) } : null,
    aviso: 'Cada cliente recebe o PRÓPRIO e-mail (em inglês), sem ver os demais destinatários. O envio não fecha nem resolve o ticket.',
  };
}

/** Garante o ticket de cada pedido numa transação só (tudo ou nada). Devolve { ticketPorPedido: Map, criados }. */
async function garantirTickets(ids, por) {
  const cli = await pool.connect(); const ticketPorPedido = new Map(); let criados = 0;
  try {
    await cli.query('BEGIN');
    for (const id of ids) { const g = await garantirTicket(cli, id, por); if (g) { ticketPorPedido.set(id, g.tk.id); if (g.criado) criados += 1; } }
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
  return { ticketPorPedido, criados };
}

/**
 * Confirma o envio: cria/atualiza o ticket de cada pedido com e-mail, enfileira pelo endpoint de envio do Suporte Ativo (um e-mail por cliente) e registra a
 * tratativa "E-mail enviado ao cliente" (via sistema: não conta duas vezes em "E-mails enviados"). `traducao_ia` exige `revisado: true`.
 * `chamarEnvio(corpo)` faz a chamada interna ao Suporte Ativo e devolve { status, corpo }.
 */
export async function enviar({ pedidos, assunto, texto, modelo_id: modeloId, traducao_ia: traducaoIa, revisado, confirmar }, por, chamarEnvio) {
  if (confirmar !== true) throw new ErroHttp(400, 'Confirme o envio (confirmar: true) depois de simular e conferir os destinatários e a mensagem.');
  if (traducaoIa && revisado !== true) throw new ErroHttp(400, 'O texto em inglês veio de tradução por IA: marque que um agente revisou antes de enviar.');
  const ids = lerPedidos(pedidos, MAX_POR_LOTE);
  const { assunto: a, texto: t } = validarTextos(assunto, texto);
  const rows = await carregarPedidos(ids);
  const com = rows.filter((r) => emailValido(r.email));
  if (!com.length) throw new ErroHttp(400, 'Nenhum dos pedidos selecionados tem e-mail do cliente.');
  const { ticketPorPedido, criados } = await garantirTickets(com.map((r) => r.pedido_id), por);
  const ticketsIds = com.map((r) => ticketPorPedido.get(r.pedido_id)).filter(Boolean);
  const r = await chamarEnvio({ ids: ticketsIds, modelo_id: modeloId || undefined, assunto: a, texto: t, confirmar: true });
  if (r.status !== 200) throw new ErroHttp(r.status >= 400 && r.status < 600 ? r.status : 502, r.corpo?.detail ?? 'O Suporte Ativo recusou o envio.');
  const assinatura = await assinaturaAtual();
  const assuntos = Object.fromEntries(com.map((x) => [x.pedido_id, renderizar(a, comoTicket(x, assinatura))]));
  let nomeModelo = null;
  if (modeloId) { const { rows: [m] } = await query('SELECT nome FROM sppl_ativo_modelos WHERE id = $1', [String(modeloId).slice(0, 60)]); nomeModelo = m?.nome ?? null; }
  // os e-mails JÁ estão na fila: se só o registro da tratativa falhar, o envio não é desfeito (a tela avisa)
  let gravadas = 0; let avisoTratativa = null;
  try {
    gravadas = (await registrar({ pedidos: com.map((x) => x.pedido_id), tipo: 'email_cliente', nota: `E-mail enviado pelo sistema (lote ${r.corpo?.lote ?? '—'})`, modelo: nomeModelo, assuntos, viaSistema: true, lote: r.corpo?.lote ?? null, por })).gravadas;
  } catch (e) { avisoTratativa = `Os e-mails foram enfileirados, mas não foi possível registrar a tratativa: ${String(e.message ?? e).slice(0, 120)}`; }
  return { lote: r.corpo?.lote ?? null, enfileirados: r.corpo?.enfileirados ?? 0, sem_email: rows.filter((x) => !emailValido(x.email)).map((x) => ({ pedido_id: x.pedido_id, pedido: x.pedido })),
    ignorados_fechados: r.corpo?.ignorados_fechados ?? [], tickets_criados: criados, tratativas: gravadas, aviso: avisoTratativa };
}

/**
 * "Marcar como enviados": o contato foi feito FORA do sistema (a equipe copiou a lista). Grava a tratativa "E-mail enviado ao cliente" com o modelo e o assunto
 * (já preenchido com os dados de cada pedido) nos pedidos que têm e-mail. Não envia nada. Conta em "E-mails enviados" (não é via sistema).
 */
export async function marcarEnviados({ pedidos, modelo_id: modeloId, assunto, nota }, por) {
  const ids = lerPedidos(pedidos, MAX_SELECIONAR);
  const { assunto: a } = validarTextos(assunto, 'sem texto', { exigir: false });
  const rows = await carregarPedidos(ids);
  const com = rows.filter((r) => emailValido(r.email));
  if (!com.length) throw new ErroHttp(400, 'Nenhum dos pedidos selecionados tem e-mail do cliente.');
  const assinatura = await assinaturaAtual();
  const assuntos = Object.fromEntries(com.map((x) => [x.pedido_id, a ? renderizar(a, comoTicket(x, assinatura)) : null]));
  let nomeModelo = null;
  if (modeloId) { const { rows: [m] } = await query('SELECT nome FROM sppl_ativo_modelos WHERE id = $1', [String(modeloId).slice(0, 60)]); nomeModelo = m?.nome ?? null; }
  const r = await registrar({ pedidos: com.map((x) => x.pedido_id), tipo: 'email_cliente', nota: nota ? String(nota).slice(0, 1000) : 'Marcado como enviado (e-mail enviado fora do sistema)', modelo: nomeModelo, assuntos, por });
  return { ...r, sem_email: rows.filter((x) => !emailValido(x.email)).map((x) => ({ pedido_id: x.pedido_id, pedido: x.pedido })) };
}
