/**
 * SPPL — Suporte Ativo: modelos de e-mail e personalização (migração 141). Funções PURAS (sem banco), testáveis com `node --test`.
 * A equipe escreve em português; o cliente recebe `assunto_en`/`corpo_en` (inglês americano). Marcadores validados ANTES do envio: nunca sai "{xyz}".
 */
import { MARCADORES, ASSINATURA_PADRAO } from './ativoConstantes.js';
import { ehAvulso } from './ativoAvulso.js';

const MAX_ASSUNTO = 200;
const MAX_CORPO = 8000;

/** Primeiro nome com inicial maiúscula ("there" quando não há nome — o e-mail sai em inglês). */
export function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : 'there';
}

/** Substitui os marcadores pelos dados de UM ticket. Marcador desconhecido continua visível aqui, mas `marcadorInvalido` recusa antes do envio. */
export function personalizar(modelo, t) {
  const v = {
    nome: primeiroNome(t.nome),
    pedido: t.numero_pedido || (ehAvulso(t.transacao_id) ? '' : t.transacao_id),   // avulso sem pedido: a chave sintética nunca vai para o cliente
    produto: t.produto || 'your order',
    rastreio: t.rastreio_reenvio || t.rastreio_original || '',
    link_rastreio: t.link_reenvio || t.link_rastreio || '',
    transportadora: t.transportadora || 'the carrier',
    endereco: t.endereco_entrega || '(address on file)',
    assinatura: String(t.assinatura || '').trim() || ASSINATURA_PADRAO,
  };
  return String(modelo).replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));
}

/** Devolve a mensagem de erro do primeiro marcador desconhecido, ou null se todos forem válidos. */
export function marcadorInvalido(...textos) {
  for (const tx of textos) for (const m of String(tx ?? '').matchAll(/\{(\w+)\}/g)) if (!MARCADORES.includes(m[1])) return `Marcador desconhecido: {${m[1]}}. Use: ${MARCADORES.map((x) => `{${x}}`).join(', ')}.`;
  return null;
}

/** Slug estável para a chave textual do modelo (sem acento, minúsculo, a-z0-9_). */
export function slugModelo(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** Valida o corpo de criar/salvar modelo. Salvar EXIGE assunto e corpo em inglês (é o que o cliente recebe). Devolve { erro } ou { valor }. */
export function validarModelo(b) {
  const t = (x, max) => String(x ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  const valor = { nome: t(b?.nome, 80), descricao_pt: t(b?.descricao_pt, 400), assunto_pt: t(b?.assunto_pt, MAX_ASSUNTO), corpo_pt: t(b?.corpo_pt, MAX_CORPO),
                  assunto_en: t(b?.assunto_en, MAX_ASSUNTO + 1), corpo_en: t(b?.corpo_en, MAX_CORPO + 1) };
  if (!valor.nome) return { erro: 'Informe o nome do modelo.' };
  if (!valor.assunto_en) return { erro: 'Informe o assunto em inglês (é o que o cliente recebe).' };
  if (valor.assunto_en.length > MAX_ASSUNTO) return { erro: `O assunto em inglês pode ter até ${MAX_ASSUNTO} caracteres.` };
  if (valor.corpo_en.length < 5) return { erro: 'Informe o texto em inglês (é o que o cliente recebe).' };
  if (valor.corpo_en.length > MAX_CORPO) return { erro: `O texto em inglês pode ter até ${MAX_CORPO} caracteres.` };
  const m = marcadorInvalido(valor.assunto_en, valor.corpo_en, valor.assunto_pt, valor.corpo_pt);
  if (m) return { erro: m };
  return { valor };
}

/** Assinatura: texto curto, sem marcadores (evita "{...}" na assinatura). */
export function validarAssinatura(a) {
  const t = String(a ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return { erro: 'Informe a assinatura.' };
  if (t.length > 200) return { erro: 'A assinatura pode ter até 200 caracteres.' };
  if (/[{}]/.test(t)) return { erro: 'A assinatura não pode ter chaves { }.' };
  return { valor: t };
}

/** Um modelo foi editado em relação à fábrica? (para a etiqueta "editado" e o botão "Voltar ao texto original") */
export function modeloEditado(m) {
  if (!m.fabrica) return false;
  return ['nome', 'descricao_pt', 'assunto_pt', 'corpo_pt', 'assunto_en', 'corpo_en'].some((k) => (m[k] ?? '') !== (m.fabrica[k] ?? ''));
}
