/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  O painel não fala mais SQL. Toda a régua e toda a fila entram por    │
 * │  aqui, pelas rotas da API do SendTrace (Django REST + JWT).           │
 * │                                                                      │
 * │    API_URL=http://187.127.255.132:8000                               │
 * │                                                                      │
 * │  NÃO existe conta de serviço. Cada pessoa entra com o PRÓPRIO e-mail  │
 * │  e senha, o painel troca isso por um par access/refresh em            │
 * │  /api/auth/token/, e toda chamada seguinte vai com o token DELA.      │
 * │  Assim a API vê quem está pedindo o quê, e uma conta desativada lá    │
 * │  para de funcionar aqui na mesma hora.                                │
 * │                                                                      │
 * │  Os tokens ficam SÓ no servidor, presos à sessão do navegador. Um     │
 * │  JWT entregue à página seria legível por quem abrisse o DevTools.     │
 * └──────────────────────────────────────────────────────────────────────┘
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const BASE = (process.env.API_URL || '').replace(/\/+$/, '');
const LIMITE_MS = Number(process.env.API_TIMEOUT_MS) || 20_000;

/** Teto de segurança ao varrer uma lista paginada inteira. Ver `listarTudo`. */
export const FILA_MAX = Number(process.env.API_FILA_MAX) || 20_000;

export const apiConfigurada = Boolean(BASE);
export const enderecoApi = BASE;

export class ErroApi extends Error {
  constructor(mensagem, { status = 0, rota = '', corpo = null } = {}) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = status;
    this.rota = rota;
    this.corpo = corpo;
  }
}

/* ══════════════════════  credencial da requisição  ══════════════════════ */

/**
 * O par de tokens de QUEM está pedindo, carregado pelo contexto assíncrono.
 *
 * A alternativa era passar a credencial como parâmetro em todas as ~20 funções
 * de `dados.js` e nas quatro de `linha.js`. Além do ruído, bastaria alguém
 * esquecer de repassar num lugar para a chamada sair sem token — ou, pior, com
 * o token de outra pessoa. Aqui não há o que esquecer: quem não estiver dentro
 * de `comCredencial` simplesmente não consegue chamar a API.
 */
const contexto = new AsyncLocalStorage();

/** Roda `fn` com os tokens desta sessão. Tudo que a API tocar usa esse par. */
export const comCredencial = (credencial, fn) => contexto.run(credencial, fn);

/** Os tokens em uso agora, ou null fora de uma requisição autenticada. */
export const credencialAtual = () => contexto.getStore() ?? null;

/* ──────────────────────────────  requisição  ──────────────────────────── */

function montarUrl(rota, params) {
  const url = new URL(rota.startsWith('http') ? rota : `${BASE}${rota}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function bruto(metodo, rota, {
  params, corpo, token, timeoutMs = LIMITE_MS,
} = {}) {
  if (!BASE) {
    throw new ErroApi('A API não está configurada: falta API_URL no .env.', { rota });
  }

  const url = montarUrl(rota, params);
  const cabecalhos = { Accept: 'application/json' };
  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  if (token) cabecalhos.Authorization = `Bearer ${token}`;

  let resposta;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      // Sem corte explícito, uma API pendurada segura a requisição do navegador
      // até o limite do sistema operacional e o painel parece travado.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const porque = err.name === 'TimeoutError'
      ? `a API não respondeu em ${Math.round(timeoutMs / 1000)} s`
      : err.message;
    throw new ErroApi(`${metodo} ${rota}: ${porque}`, { rota });
  }

  if (resposta.status === 204) return null;

  const texto = await resposta.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { bruto: texto.slice(0, 300) }; }

  if (!resposta.ok) {
    throw new ErroApi(
      `${metodo} ${rota}: HTTP ${resposta.status}`,
      { status: resposta.status, rota, corpo: dados },
    );
  }
  return dados;
}

/* ═════════════════════════════  autenticação  ═══════════════════════════ */

/**
 * Troca e-mail e senha por um par de tokens. É o login do painel.
 *
 * O corpo é `{email, password}`: o serializer da API é o
 * `PainelTokenObtainPair`, sobre os usuários do painel — com `username` ela
 * responde "email: este campo é obrigatório".
 */
export async function autenticarUsuario(email, senha) {
  const dados = await bruto('POST', '/api/auth/token/', {
    corpo: { email, password: senha },
  });
  return { access: dados.access, refresh: dados.refresh };
}

/**
 * As duas chamadas de "esqueci minha senha" — mesma razão de `autenticarUsuario`
 * ir direto em `bruto()`: quem esqueceu a senha não tem sessão nenhuma, então
 * `pedir()`/`credencialAtual()` não têm o que usar.
 */
export async function pedirRecuperacao(email) {
  return bruto('POST', '/api/auth/esqueci-senha/', { corpo: { email } });
}
export async function confirmarRecuperacao(token, senha) {
  return bruto('POST', '/api/auth/redefinir-senha/', { corpo: { token, senha } });
}

/**
 * Renova o `access` a partir do `refresh`, no lugar.
 *
 * Muda o objeto em vez de devolver um novo porque ele é o mesmo que está
 * guardado na sessão: se a renovação não chegasse lá, a próxima requisição
 * usaria de novo o token vencido e o usuário levaria um 401 a cada ciclo.
 */
async function renovarAcesso(credencial) {
  const dados = await bruto('POST', '/api/auth/token/refresh/', {
    corpo: { refresh: credencial.refresh },
  });
  credencial.access = dados.access;
  // O SimpleJWT devolve refresh novo quando a rotação está ligada.
  if (dados.refresh) credencial.refresh = dados.refresh;
  return credencial;
}

/**
 * O que a API disse sobre quem entrou, lido do próprio access.
 *
 * O JWT carrega o `user_id` no payload; sem ele o painel não teria como saber
 * de quem é o token que acabou de receber. Só é lido, nunca é confiado como
 * prova: quem valida a assinatura é a API, a cada chamada.
 */
export function dadosDoToken(access) {
  try {
    const [, carga] = String(access).split('.');
    return JSON.parse(Buffer.from(carga.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/* ──────────────────────────  chamadas autenticadas  ────────────────────── */

/**
 * Uma requisição com o token de quem está logado, e UMA retentativa em 401.
 *
 * O access vence sozinho e o painel se atualiza de 10 em 10 segundos: sem
 * renovar e repetir, cada expiração viraria um ciclo inteiro de "sem conexão"
 * sem nada de errado ter acontecido.
 */
async function pedir(metodo, rota, opcoes = {}) {
  const credencial = credencialAtual();
  if (!credencial?.access) {
    throw new ErroApi('sem credencial da API nesta requisição', { status: 401, rota });
  }

  try {
    return await bruto(metodo, rota, { ...opcoes, token: credencial.access });
  } catch (err) {
    if (!(err instanceof ErroApi) || err.status !== 401 || !credencial.refresh) throw err;
    // Refresh vencido ou revogado: o 401 sobe e a sessão do painel cai junto,
    // que é o certo — a pessoa precisa entrar de novo.
    await renovarAcesso(credencial);
    return bruto(metodo, rota, { ...opcoes, token: credencial.access });
  }
}

export const obter = (rota, params) => pedir('GET', rota, { params });
export const criar = (rota, corpo, opcoes) => pedir('POST', rota, { corpo, ...opcoes });
export const substituir = (rota, corpo) => pedir('PUT', rota, { corpo });
export const remendar = (rota, corpo) => pedir('PATCH', rota, { corpo });
export const apagar = (rota) => pedir('DELETE', rota);

/**
 * Busca um BINÁRIO (imagem de anexo) da API, com o mesmo par de tokens da
 * sessão — mas sem passar pelo `bruto()`/`pedir()` genéricos, que sempre
 * decodificam a resposta como JSON e corromperiam os bytes da imagem.
 */
export async function obterBinario(rota) {
  const credencial = credencialAtual();
  if (!credencial?.access) {
    throw new ErroApi('sem credencial da API nesta requisição', { status: 401, rota });
  }
  if (!BASE) throw new ErroApi('A API não está configurada: falta API_URL no .env.', { rota });

  const chamar = (token) => fetch(`${BASE}${rota}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(LIMITE_MS),
  });

  let resposta = await chamar(credencial.access);
  if (resposta.status === 401 && credencial.refresh) {
    await renovarAcesso(credencial);
    resposta = await chamar(credencial.access);
  }
  if (!resposta.ok) {
    throw new ErroApi(`GET ${rota}: HTTP ${resposta.status}`, { status: resposta.status, rota });
  }
  const buffer = Buffer.from(await resposta.arrayBuffer());
  return { buffer, mimeType: resposta.headers.get('content-type') || 'application/octet-stream' };
}

/**
 * Varre uma lista paginada inteira e devolve `{ itens, total, truncado }`.
 *
 * Anda por `?page=N` em vez de seguir o `next` da resposta: o link vem com o
 * host que a API enxerga de si mesma, que atrás de proxy nem sempre é um
 * endereço alcançável a partir daqui.
 *
 * `truncado` existe porque o teto é real: sem agregação do lado da API, medir a
 * fila significa baixá-la. Se um dia ela passar de FILA_MAX, o painel precisa
 * DIZER que está mostrando uma parte — um número calculado sobre metade da
 * fila, exibido como se fosse o total, é pior que nenhum número.
 */
export async function listarTudo(rota, params = {}, { max = FILA_MAX } = {}) {
  const itens = [];
  let total = 0;
  let pagina = 1;

  for (;;) {
    const dados = await obter(rota, { ...params, page: pagina });

    // DRF devolve {count,next,results}; sem paginação, um array puro.
    if (Array.isArray(dados)) return { itens: dados, total: dados.length, truncado: false };

    total = dados.count ?? 0;
    const lote = dados.results ?? [];
    itens.push(...lote);

    if (!lote.length || itens.length >= total || !dados.next) break;
    if (itens.length >= max) return { itens, total, truncado: true };
    pagina += 1;
  }

  return { itens, total: total || itens.length, truncado: false };
}

/** A API está de pé? Rota pública — não exige token nem sessão. */
export async function saude() {
  const inicio = Date.now();
  const dados = await bruto('GET', '/api/health/');
  return { ...dados, latenciaMs: Date.now() - inicio };
}
