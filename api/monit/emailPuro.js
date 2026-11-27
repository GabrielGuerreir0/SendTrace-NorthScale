/**
 * MONIT-SPPL — e-mail padrão (spec seção 8 e 12.3): funções PURAS (sem banco), testáveis com `node --test`.
 * O texto dos modelos e a personalização por cliente são do Suporte Ativo (api/sppl/ativoModelos.js, `personalizar`); aqui ficam só a escolha do modelo pela
 * classe (MODELO_POR_CLASSE), o "produto principal" e a conferência dos campos entre chaves.
 */
import { personalizar } from '../sppl/ativoModelos.js';
import { MARCADORES } from '../sppl/ativoConstantes.js';

/** Ordem dos 9 modelos de fábrica (migração 141): desempate quando duas classes empatam na seleção. */
export const MODELOS_ORDEM = ['endereco', 'atraso', 'acesso', 'mudou', 'retirada', 'taxa', 'recusado', 'ausente', 'devolucao'];
export const MODELO_PADRAO = 'endereco';

/** Tabela MODELO_POR_CLASSE da seção 12.3 do PDF. Classe fora da tabela (transito_normal, entregue_nao_baixado) não escolhe modelo. */
export const MODELO_POR_CLASSE = {
  aguardando_codigo: 'atraso', sem_codigo_atrasado: 'atraso', nao_encontrado: 'atraso', atraso_transportadora: 'atraso', codigo_nao_rastreavel: 'atraso',
  parado_sem_aviso: 'atraso', avaria: 'atraso', etiqueta_cancelada: 'atraso', aguardando_coleta: 'atraso', aguardando_coleta_ok: 'atraso',
  endereco: 'endereco', acesso: 'acesso', mudou: 'mudou',
  retirada: 'retirada', retido_cliente: 'retirada',
  taxa: 'taxa',
  recusado: 'recusado', devolucao_cliente: 'recusado',
  ausente: 'ausente',
  em_devolucao: 'devolucao', devolvido: 'devolucao', devolucao_endereco: 'devolucao',
};

/**
 * O modelo que abre por padrão: o mais frequente entre as classes dos pedidos selecionados; sem nenhuma classe conhecida, `endereco`.
 * Devolve `{ modelo, por_modelo }` (contagem de pedidos por modelo, só dos que a tabela cobre).
 */
export function modeloDaSelecao(classes) {
  const por = {};
  for (const c of classes ?? []) { const m = MODELO_POR_CLASSE[c]; if (m) por[m] = (por[m] ?? 0) + 1; }
  let melhor = MODELO_PADRAO; let n = 0;
  for (const m of MODELOS_ORDEM) if ((por[m] ?? 0) > n) { melhor = m; n = por[m]; }
  return { modelo: n ? melhor : MODELO_PADRAO, por_modelo: por };
}

/**
 * Produto principal, sem quantidade de frascos nem upsells: "6 Bottles ProstaVive + 2 Bottles X" → "ProstaVive". Vazio quando não sobra nada.
 */
export function produtoPrincipal(texto) {
  let s = String(texto ?? '').split(/\s\+\s/)[0];
  s = s.replace(/^\s*\d+\s*(?:x|×)?\s*(?:bottles?|frascos?|bottle|units?|unidades?|pack|packs)?(?:\s+of)?\s+/i, '');
  s = s.replace(/\(?\b\d+\s*(?:bottles?|frascos?|units?|unidades?)\b\)?/gi, '').replace(/\s*[-–—,]\s*$/, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** Valores dos campos entre chaves para UM cliente. Em português, os "sem dado" viram cliente / a transportadora / (endereço cadastrado) / seu produto. */
export function valoresMarcadores(t, idioma = 'en') {
  const v = {};
  for (const k of MARCADORES) v[k] = personalizar(`{${k}}`, t);
  if (idioma === 'pt') {
    if (!String(t.nome ?? '').trim()) v.nome = 'cliente';
    if (!t.transportadora) v.transportadora = 'a transportadora';
    if (!t.endereco_entrega) v.endereco = '(endereço cadastrado)';
    if (!t.produto) v.produto = 'seu produto';
  }
  return v;
}

/** Aplica os campos de UM cliente num texto (assunto ou corpo), em inglês ou português. Marcador desconhecido continua visível (a validação recusa antes do envio). */
export function renderizar(texto, t, idioma = 'en') {
  const v = valoresMarcadores(t, idioma);
  return String(texto ?? '').replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));
}

/** Lista ordenada dos campos entre chaves usados (com repetição): serve para comparar o texto em português com a tradução. */
export const camposDoTexto = (texto) => [...String(texto ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** A tradução manteve exatamente os mesmos campos entre chaves (mesmos nomes, mesma quantidade)? */
export function camposIguais(original, traduzido) {
  const a = camposDoTexto(original); const b = camposDoTexto(traduzido);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
