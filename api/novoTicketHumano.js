/**
 * Suporte Humano — "Novo ticket" (ticket iniciado pela EQUIPE; migração 143). Funções PURAS (sem banco), testáveis com `node --test`.
 * Reaproveita do Suporte Ativo (SPPL): separar/classificar entradas, resolver e-mail/pedido, marcadores e alerta de contato duplicado.
 *
 * Regras:
 *   • o ticket do Suporte Humano é ÚNICO por remetente (idx_suporte_escalado_email): se o e-mail já tem ticket, não cria outro (a equipe responde por ele);
 *   • um ticket por CLIENTE: dois pedidos do mesmo e-mail na lista viram um só;
 *   • contato anterior (envio do Suporte Ativo, e-mail da equipe, resposta de agente, ticket) nos últimos 90 dias gera ALERTA — não bloqueia;
 *   • cliente com e-mail do Suporte Ativo recente é BLOQUEADO: a resposta dele ficaria isolada no Suporte Ativo e não chegaria neste ticket (gatilho 101).
 */
import { resolverEntradas, contatosAnteriores } from './sppl/ativoAvulso.js';
import { personalizar, marcadorInvalido, primeiroNome } from './sppl/ativoModelos.js';

export const MAX_CLIENTES = 200;
export const IDIOMAS = ['en', 'pt'];
export { separarEntradas, classificarEntrada } from './sppl/ativoAvulso.js';

/**
 * Resolve as entradas (e-mails e/ou pedidos) e aplica as regras do Suporte Humano.
 * `tickets`: tickets que já existem para os e-mails (id, remetente_email, status, origem, agente);
 * `isolados`: e-mails (minúsculos) que o Suporte Ativo está isolando; `contatos`: linhas do alerta de duplicado (ver contatosAnteriores).
 * situacao: 'novo' | 'ticket_existente' | 'isolado_no_ativo' | 'nao_encontrado' | 'invalido' | 'sem_email' | 'repetido'
 */
export function prepararAlvos(entradas, linhas, tickets = [], isolados = [], contatos = []) {
  const itens = resolverEntradas(entradas, linhas, []);
  const porEmail = new Map(tickets.map((t) => [String(t.remetente_email || '').toLowerCase(), t]));
  const iso = new Set(isolados.map((e) => String(e).toLowerCase()));
  const vistos = new Set();
  for (const i of itens) {
    // resolverEntradas devolve 'ja_existe' só para tickets do Suporte Ativo (não passamos nenhum) e 'repetido' por pedido; aqui o critério é o e-mail.
    if (!['novo', 'repetido'].includes(i.situacao) || !i.email) continue;
    const em = i.email.toLowerCase();
    if (vistos.has(em)) { i.situacao = 'repetido'; continue; }
    vistos.add(em);
    const t = porEmail.get(em);
    if (t) { i.situacao = 'ticket_existente'; i.ticket_id = t.id; i.ticket_status = t.status ?? null; i.ticket_origem = t.origem ?? null; i.ticket_agente = t.agente ?? null; continue; }
    if (iso.has(em)) { i.situacao = 'isolado_no_ativo'; continue; }
    i.situacao = 'novo';
  }
  for (const i of itens) {
    i.contatos_anteriores = i.email && ['novo', 'ticket_existente', 'isolado_no_ativo'].includes(i.situacao)
      ? contatosAnteriores({ email: i.email, transacoes: [i.pedido_transacao_id] }, contatos, 5) : [];
  }
  return itens;
}

/** Contagens da conferência. */
export function resumirAlvos(itens, entradas = itens) {
  const conta = (s) => itens.filter((i) => i.situacao === s).length;
  return {
    entradas: entradas.length, novos: conta('novo'), ticket_existente: conta('ticket_existente'), isolado_no_ativo: conta('isolado_no_ativo'), nao_encontrados: conta('nao_encontrado'),
    invalidos: conta('invalido'), sem_email: conta('sem_email'), repetidos: conta('repetido'),
    com_contato_anterior: itens.filter((i) => i.situacao === 'novo' && i.contatos_anteriores?.length).length,
    sem_pedido: itens.filter((i) => i.situacao === 'novo' && !i.pedido_transacao_id).length,
  };
}

/** Só os alvos que viram ticket + e-mail. */
export const alvosEnviaveis = (itens) => itens.filter((i) => i.situacao === 'novo');

/** Dados que os marcadores usam, a partir do alvo resolvido (pedido, produto, rastreio...). */
export function dadosDoAlvo(i, assinatura) {
  return {
    nome: i.nome, numero_pedido: i.numero_pedido, transacao_id: i.pedido_transacao_id || '', produto: i.produto, rastreio_original: i.rastreio, link_rastreio: i.link_rastreio,
    transportadora: i.transportadora, endereco_entrega: i.endereco_entrega, assinatura,
  };
}

/** Assunto e texto finais para UM cliente (os marcadores só recebem os dados DELE). Devolve { assunto, texto }. */
export function montarMensagem(assuntoModelo, textoModelo, alvo, assinatura) {
  const dados = dadosDoAlvo(alvo, assinatura);
  return { assunto: personalizar(assuntoModelo, dados).trim(), texto: personalizar(textoModelo, dados).trim() };
}

/** Marcadores usados no texto cujo dado o cliente não tem (a mensagem sairia com lacuna): aviso, não bloqueio. */
export function dadosFaltando(assuntoModelo, textoModelo, alvo) {
  const usados = new Set([...`${assuntoModelo} ${textoModelo}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
  const d = dadosDoAlvo(alvo, 'x');
  return ['pedido', 'produto', 'rastreio', 'link_rastreio', 'endereco'].filter((k) => {
    if (!usados.has(k)) return false;
    if (k === 'endereco') return !alvo.endereco_entrega;
    if (k === 'produto') return !alvo.produto;
    return !personalizar(`{${k}}`, d);
  });
}

/** Valida assunto/texto/idioma/modelo do pedido. Devolve { erro } ou { valor: { assunto, texto, idioma } }. */
export function validarConteudo({ assunto, texto, idioma } = {}, modelo = null) {
  const id = idioma === undefined || idioma === null || idioma === '' ? 'en' : String(idioma);
  if (!IDIOMAS.includes(id)) return { erro: 'Idioma inválido (use inglês ou português).' };
  const a = String(assunto || (modelo ? (id === 'pt' ? modelo.assunto_pt : modelo.assunto_en) : '') || '').trim();
  const t = String(texto || (modelo ? (id === 'pt' ? modelo.corpo_pt : modelo.corpo_en) : '') || '').replace(/\r\n/g, '\n').trim();
  if (!a || a.length > 200) return { erro: 'Informe o assunto (até 200 caracteres).' };
  if (t.length < 5 || t.length > 8000) return { erro: 'A mensagem precisa ter entre 5 e 8000 caracteres.' };
  const m = marcadorInvalido(a, t);
  if (m) return { erro: m };
  return { valor: { assunto: a, texto: t, idioma: id } };
}

/** Quem pode abrir ticket em qual board: gestor/admin em qualquer um; os demais só no próprio. Devolve o id do board ou lança { erro }. */
export function escolherBoard({ pedido, meuBoardId, gestor, boards }) {
  const alvo = pedido === undefined || pedido === null || pedido === '' ? meuBoardId : Number(pedido);
  if (alvo === null || alvo === undefined || !Number.isInteger(alvo)) return { erro: gestor ? 'Escolha o agente (board) dono do ticket.' : 'Você não tem um board para receber o ticket.' };
  const b = boards.find((x) => x.id === alvo);
  if (!b) return { erro: 'Board não encontrado.' };
  if (!gestor && alvo !== meuBoardId) return { erro: 'Este board não é seu.' };
  return { valor: alvo };
}

export { primeiroNome };
