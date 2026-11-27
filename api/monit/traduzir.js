/**
 * MONIT-SPPL — tradução PT-BR → inglês americano do e-mail padrão por IA (spec seção 8, passo 4, e 12.3).
 * Usa a MESMA integração de IA do resto do sistema (cliente Anthropic de api/rotas/emailIA.js, chave `ANTHROPIC_API_KEY`). Sem a chave, responde 503 com
 * mensagem amigável e a tela deixa a equipe escrever o inglês à mão: NADA é inventado. A tradução é SEMPRE rascunho: a tela exige revisão antes do envio.
 * As funções de montar o pedido e ler a resposta são puras (testáveis com `node --test`); só `traduzir` fala com a IA.
 */
import { ErroHttp } from '../comum.js';
import { camposIguais } from './emailPuro.js';

export const MODELO_IA = 'claude-haiku-4-5';   // nível "quick" (mesmo modelo rápido da geração de rascunho)
const MAX_ASSUNTO = 200;
const MAX_CORPO = 8000;

/** Instrução da spec (12.3), com os campos entre chaves que o SendTrace usa. */
export const INSTRUCAO = 'Translate this customer service email from Brazilian Portuguese to natural, friendly American English. Keep every placeholder in curly braces '
  + 'exactly as written (for example {nome}, {pedido}, {rastreio}, {link_rastreio}, {transportadora}, {endereco}, {produto}, {assinatura}) and keep the line breaks. '
  + 'Reply only with JSON: {"assunto": "<subject in English>", "corpo": "<body in English>"}.';

/** Texto enviado como mensagem do usuário. */
export const montarPedido = (assunto, corpo) => `${INSTRUCAO}\n\nSUBJECT:\n${assunto}\n\nBODY:\n${corpo}`;

/** Lê a resposta da IA (JSON puro ou dentro de ```json). Devolve { assunto, corpo } ou null. */
export function lerResposta(texto) {
  const s = String(texto ?? '');
  const ini = s.indexOf('{'); const fim = s.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  let o; try { o = JSON.parse(s.slice(ini, fim + 1)); } catch { return null; }
  const assunto = String(o?.assunto ?? o?.subject ?? '').trim(); const corpo = String(o?.corpo ?? o?.body ?? '').replace(/\r\n/g, '\n').trim();
  return assunto && corpo ? { assunto, corpo } : null;
}

/** Confere a tradução contra o original: mesmos campos entre chaves no assunto e no corpo. Devolve a mensagem de erro, ou null se estiver certo. */
export function conferirTraducao(original, traduzido) {
  if (!camposIguais(original.assunto, traduzido.assunto)) return 'A tradução mudou os campos entre chaves do assunto.';
  if (!camposIguais(original.corpo, traduzido.corpo)) return 'A tradução mudou os campos entre chaves do texto.';
  return null;
}

/** Traduz assunto e corpo. Lança ErroHttp (400 entrada ruim, 503 sem IA configurada, 502 resposta inutilizável). */
export async function traduzir({ assunto, corpo }) {
  const a = String(assunto ?? '').trim(); const c = String(corpo ?? '').replace(/\r\n/g, '\n').trim();
  if (!a || !c) throw new ErroHttp(400, 'Informe o assunto e o texto em português.');
  if (a.length > MAX_ASSUNTO) throw new ErroHttp(400, `O assunto pode ter até ${MAX_ASSUNTO} caracteres.`);
  if (c.length > MAX_CORPO) throw new ErroHttp(400, `O texto pode ter até ${MAX_CORPO} caracteres.`);
  const { obterClienteAnthropic } = await import('../rotas/emailIA.js');
  const cliente = obterClienteAnthropic();
  if (!cliente) throw new ErroHttp(503, 'Tradução por IA indisponível: ANTHROPIC_API_KEY não está configurada neste servidor. Escreva o texto em inglês à mão ou use o modelo de fábrica.');
  let resp;
  try {
    resp = await cliente.messages.create({ model: MODELO_IA, max_tokens: 2048, messages: [{ role: 'user', content: montarPedido(a, c) }] });
  } catch (e) { throw new ErroHttp(502, `A IA não respondeu: ${String(e.message ?? e).slice(0, 160)}`); }
  const saida = lerResposta((resp.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  if (!saida) throw new ErroHttp(502, 'A IA devolveu uma resposta que não deu para ler. Tente de novo.');
  const erro = conferirTraducao({ assunto: a, corpo: c }, saida);
  if (erro) throw new ErroHttp(502, `${erro} Tente traduzir de novo.`);
  return { assunto: saida.assunto.slice(0, MAX_ASSUNTO), corpo: saida.corpo, modelo: MODELO_IA, revisao_obrigatoria: true };
}
