/**
 * SPPL — Suporte Ativo: ticket AVULSO ("Novo ticket", iniciado pela equipe; migração 140). Funções PURAS (sem banco), testáveis com `node --test`.
 *
 * Chave do ticket avulso (`transacao_id` é NOT NULL e único entre os não fechados), sempre com prefixo `avulso:`:
 *   avulso:<transacao_id>   pedido localizado (um avulso por pedido)
 *   avulso:<e-mail>         cliente sem pedido localizado
 * O prefixo evita que fechar um avulso esconda o pedido do Monitoramento Logístico (a view `sppl_logistica` casa por transacao_id).
 */
const RE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const RE_PEDIDO = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,119}$/;

export const PREFIXO_AVULSO = 'avulso:';
export const ehAvulso = (chave) => String(chave || '').startsWith(PREFIXO_AVULSO);
export const chaveAvulso = (pedidoTransacaoId, email) => (pedidoTransacaoId ? `${PREFIXO_AVULSO}${pedidoTransacaoId}` : `${PREFIXO_AVULSO}${String(email).trim().toLowerCase()}`);
/** Texto legível da chave (o que a equipe vê no lugar de "avulso:..."). */
export const rotuloChave = (chave) => String(chave || '').replace(PREFIXO_AVULSO, '');

/** Quebra o texto colado (vírgula, ponto e vírgula, espaço, quebra de linha, tabulação) em entradas únicas, preservando a ordem. */
export function separarEntradas(texto) {
  const lista = Array.isArray(texto) ? texto : String(texto ?? '').split(/[\s,;]+/);
  const vistos = new Set(); const out = [];
  for (const bruto of lista) {
    const e = String(bruto ?? '').trim().replace(/^[<"'(]+|[>"')]+$/g, '').replace(/^#/, '');
    if (!e) continue;
    const k = e.toLowerCase(); if (vistos.has(k)) continue; vistos.add(k); out.push(e);
  }
  return out;
}

/** Classifica uma entrada: e-mail, pedido ou inválida. */
export function classificarEntrada(e) {
  const s = String(e).trim();
  if (s.includes('@')) return RE_EMAIL.test(s) && s.length <= 200 ? { tipo: 'email', valor: s.toLowerCase() } : { tipo: 'invalido', valor: s };
  return RE_PEDIDO.test(s) ? { tipo: 'pedido', valor: s } : { tipo: 'invalido', valor: s };
}

/**
 * Resolve cada entrada contra as linhas de pedido encontradas no banco (`linhas`: transacao_id, numero_pedido, nome, email, produto, plataforma,
 * fulfillment, carrier_code, tracking_number, tracking_url, data) e contra os tickets não fechados (`abertos`: id, transacao_id, pedido_transacao_id, email, origem).
 * Devolve um item por CLIENTE (duas entradas do mesmo cliente viram uma só):
 *   situacao: 'novo' | 'ja_existe' | 'nao_encontrado' | 'invalido' | 'sem_email' | 'repetido'
 */
export function resolverEntradas(entradas, linhas, abertos = []) {
  const porTransacao = new Map(); const porNumero = new Map(); const porEmail = new Map();
  const data = (l) => new Date(l.data || 0).getTime();
  for (const l of linhas) {
    if (!porTransacao.has(l.transacao_id)) porTransacao.set(l.transacao_id, l);
    const n = String(l.numero_pedido || ''); if (n && !porNumero.has(n)) porNumero.set(n, l);
    const em = String(l.email || '').trim().toLowerCase(); if (em) { const arr = porEmail.get(em) ?? []; arr.push(l); porEmail.set(em, arr); }
  }
  const achaAberto = (chaves, email) => abertos.find((t) => chaves.includes(t.transacao_id) || (t.pedido_transacao_id && chaves.includes(t.pedido_transacao_id))
                                                       || (email && t.origem === 'equipe' && String(t.email || '').toLowerCase() === email));
  const out = []; const vistos = new Set();
  for (const bruta of entradas) {
    const c = classificarEntrada(bruta);
    const item = { entrada: String(bruta), tipo: c.tipo, situacao: null, chave: null, ticket_id: null, nome: null, email: null, numero_pedido: null, pedido_transacao_id: null, produto: null, plataforma: null,
                   fulfillment: null, transportadora: null, rastreio: null, link_rastreio: null, pedidos_encontrados: 0 };
    if (c.tipo === 'invalido') { item.situacao = 'invalido'; out.push(item); continue; }
    let l = null;
    if (c.tipo === 'pedido') {
      l = porTransacao.get(c.valor) ?? porNumero.get(c.valor) ?? null;
      if (!l) { item.situacao = 'nao_encontrado'; out.push(item); continue; }
      item.pedidos_encontrados = 1;
    } else {
      const cand = (porEmail.get(c.valor) ?? []).slice().sort((a, b) => data(b) - data(a));
      item.pedidos_encontrados = new Set(cand.map((x) => x.transacao_id)).size;
      l = cand[0] ?? null;
    }
    const email = c.tipo === 'email' ? c.valor : String(l.email || '').trim().toLowerCase();
    if (!email || !RE_EMAIL.test(email)) { Object.assign(item, { situacao: 'sem_email', nome: l?.nome ?? null, numero_pedido: l?.numero_pedido ?? null, pedido_transacao_id: l?.transacao_id ?? null }); out.push(item); continue; }
    Object.assign(item, { email, nome: l?.nome ?? null, numero_pedido: l?.numero_pedido ?? null, pedido_transacao_id: l?.transacao_id ?? null, produto: l?.produto ?? null, plataforma: l?.plataforma ?? null,
                          fulfillment: l?.fulfillment ?? null, transportadora: l?.carrier_code ?? null, rastreio: l?.tracking_number ?? null, link_rastreio: l?.tracking_url ?? null });
    item.chave = chaveAvulso(item.pedido_transacao_id, email);
    if (vistos.has(item.chave)) { item.situacao = 'repetido'; out.push(item); continue; }
    vistos.add(item.chave);
    const ab = achaAberto([item.chave, item.pedido_transacao_id].filter(Boolean), email);
    if (ab) { item.situacao = 'ja_existe'; item.ticket_id = ab.id; } else item.situacao = 'novo';
    out.push(item);
  }
  return out;
}

/**
 * Alerta de contato duplicado. `contatos`: linhas { email, transacao_id, pedido_transacao_id, tipo ('envio'|'ticket'), por, quando, modelo_nome, assunto, status, ticket_id, status_ticket, origem }.
 * Devolve, para cada alvo { email, transacoes[] }, os contatos que casam por e-mail OU por pedido (mais recentes primeiro, no máximo `max`).
 */
export function contatosAnteriores(alvo, contatos, max = 5, ignorarTicketId = null) {
  const em = String(alvo.email || '').trim().toLowerCase(); const trs = new Set((alvo.transacoes || []).filter(Boolean));
  return contatos.filter((c) => !(ignorarTicketId && c.tipo === 'ticket' && c.ticket_id === ignorarTicketId)
                             && ((em && String(c.email || '').toLowerCase() === em) || trs.has(c.transacao_id) || (c.pedido_transacao_id && trs.has(c.pedido_transacao_id))))
                 .sort((a, b) => new Date(b.quando) - new Date(a.quando)).slice(0, max);
}
