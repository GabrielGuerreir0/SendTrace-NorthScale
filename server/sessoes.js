/**
 * As sessões do navegador — e, presas a cada uma, as credenciais da API.
 *
 * Ficam em MEMÓRIA, não no banco. O que a sessão guarda agora é um par de JWT
 * vivos: gravá-los em disco criaria um segundo lugar de onde vazar credencial
 * de acesso à API, com o agravante de sobreviverem ao processo. Em memória
 * eles morrem junto com ele.
 *
 * O preço é explícito: reiniciar o painel derruba as sessões e todo mundo entra
 * de novo. Como o token é por pessoa e a senha nunca fica guardada, não há como
 * reconstruir a sessão sozinho — e fingir que ela sobreviveu, com um token que
 * não existe mais, daria erro em toda tela em vez de um login limpo.
 *
 * A chave do mapa é o HASH do cookie, não o cookie: assim um despejo de memória
 * não devolve credenciais prontas para uso.
 */
import crypto from 'node:crypto';
import { SESSAO_HORAS } from './config.js';

const sessoes = new Map();

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Cria a sessão e devolve o token que vai no cookie.
 *
 * 32 bytes de aleatoriedade criptográfica: é o que impede alguém de adivinhar
 * a sessão de outra pessoa em vez de precisar da senha dela.
 */
export function abrirSessao({ usuario, credencial }) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessoes.set(hash(token), {
    usuario,
    credencial,
    expira: Date.now() + SESSAO_HORAS * 3600_000,
  });
  return token;
}

/** A sessão viva deste cookie, ou null. Vencida é apagada na hora. */
export function lerSessao(token) {
  if (!token) return null;
  const chave = hash(token);
  const s = sessoes.get(chave);
  if (!s) return null;
  if (s.expira <= Date.now()) { sessoes.delete(chave); return null; }
  return s;
}

export function fecharSessao(token) {
  if (token) sessoes.delete(hash(token));
}

/** Quantas sessões abertas esta pessoa tem — usado só para exibir. */
export const contarSessoesDe = (email) => {
  let n = 0;
  for (const s of sessoes.values()) if (s.usuario?.email === email) n += 1;
  return n;
};

/**
 * Poda o que já venceu.
 *
 * Sem isto o mapa só cresce: uma sessão vencida deixa de casar no `lerSessao`,
 * mas continua ocupando memória para sempre.
 */
export function limparVencidas() {
  const agora = Date.now();
  for (const [chave, s] of sessoes) if (s.expira <= agora) sessoes.delete(chave);
}
