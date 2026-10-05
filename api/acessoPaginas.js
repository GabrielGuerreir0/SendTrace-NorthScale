/**
 * Acesso por página (migração 072): quais abas do painel cada usuário pode abrir e com qual papel.
 *
 * Administrador vê tudo. Os outros veem só as páginas marcadas em `painel_usuarios_acessos`. A API recusa (403) a chamada de quem não tem a página
 * (não basta esconder o botão): `verificarAcessoPagina` roda dentro de `exigirSessao`. Rotas fora do mapa (login, perfil, alertas, saúde…) não pedem página.
 */
import { query } from '../server/db.js';
import { ErroHttp } from './comum.js';

export const PAGINAS = [
  { chave: 'visaogeral', rotulo: 'Visão Geral' },
  { chave: 'suporte', rotulo: 'Suporte IA' },
  { chave: 'regua', rotulo: 'Régua de pós-venda' },
  { chave: 'rastreio', rotulo: 'Rastreio de Pedidos' },
  { chave: 'postmark', rotulo: 'Postmark' },
  { chave: 'ticketsia', rotulo: 'Tickets de Atendimento' },
  { chave: 'detalhesia', rotulo: 'Mais Detalhes' },
  { chave: 'chatia', rotulo: 'Chat com IA' },
  { chave: 'galeriaia', rotulo: 'Galeria de Imagens' },
  { chave: 'suporteescalado', rotulo: 'Suporte Escalado' },
  { chave: 'relatorioia', rotulo: 'Relatório de Métricas' },
];
export const CHAVES = PAGINAS.map((p) => p.chave);
/** Papéis aceitos por página (as demais só aceitam 'usuario'). */
export const PAPEIS = { suporteescalado: ['usuario', 'gestor'] };
export const papeisDaPagina = (pagina) => PAPEIS[pagina] ?? ['usuario'];

/**
 * Prefixo de rota da API → páginas que podem chamá-la (basta ter UMA). Casamento por segmento: '/api/ticket' não pega '/api/tickets/insights'.
 * Rotas que servem várias páginas listam todas (ex.: a Visão Geral também lê os insights do Suporte Escalado e dos Tickets).
 */
const REGUA_E_RASTREIO = ['regua', 'rastreio'];
const MAPA = [
  ['/api/visao-geral', ['visaogeral', 'regua']],   // a lista de pedidos da Régua também sai daqui
  ['/api/dash', ['visaogeral']],
  ['/api/suporte-escalado/insights', ['suporteescalado', 'visaogeral']],
  ['/api/suporte-escalado', ['suporteescalado']],
  ['/api/formularios', ['suporteescalado']],
  ['/api/recorrencia', ['suporteescalado']],
  ['/api/retencao', ['suporteescalado']],
  ['/api/tickets/insights', ['ticketsia', 'detalhesia', 'visaogeral']],
  ['/api/respostas-agente', ['detalhesia', 'ticketsia', 'suporteescalado']],
  ['/api/emails', ['detalhesia', 'ticketsia', 'suporteescalado']],
  ['/api/dados', ['ticketsia', 'detalhesia']],
  ['/api/ticket', ['ticketsia', 'detalhesia']],
  ['/api/automacao', ['ticketsia', 'detalhesia']],
  ['/api/resposta', ['detalhesia', 'ticketsia']],
  ['/api/chat', ['chatia']],
  ['/api/galeria', ['galeriaia', 'detalhesia', 'suporteescalado']],
  ['/api/anexo', ['galeriaia', 'detalhesia', 'suporteescalado']],
  ['/api/imagem', ['galeriaia', 'detalhesia', 'ticketsia', 'suporteescalado']],
  ['/api/relatorio', ['relatorioia']],
  ['/api/postmark', ['postmark']],
  ['/api/metricas/rastreio', ['rastreio']],
  ['/api/rastreio', ['rastreio']],
  ['/api/atendimentos', ['suporte', 'regua']],
  ['/api/topicos', ['suporte']],
  ['/api/perguntas-sem-resposta', ['suporte']],
  ['/api/metricas', ['regua', 'rastreio', 'suporte']],
  ['/api/disparos', REGUA_E_RASTREIO],
  ['/api/upsell-downsell', REGUA_E_RASTREIO],
  ['/api/etapas', REGUA_E_RASTREIO],
  ['/api/mensagens', REGUA_E_RASTREIO],
  ['/api/linhas-copy', REGUA_E_RASTREIO],
  ['/api/linha-ativa', REGUA_E_RASTREIO],
  ['/api/linha-historico', REGUA_E_RASTREIO],
  ['/api/produtos', REGUA_E_RASTREIO],
  ['/api/config', REGUA_E_RASTREIO],
].sort((a, b) => b[0].length - a[0].length);

/** Páginas que liberam uma rota (padrão registrado no Fastify), ou null se a rota não exige página. */
export function paginasDaRota(url) {
  if (!url) return null;
  const caminho = String(url).replace(/\/+$/, '');
  for (const [prefixo, paginas] of MAPA) {
    if (caminho === prefixo || caminho.startsWith(`${prefixo}/`)) return paginas;
  }
  return null;
}

const CACHE = new Map();     // usuario_id -> { em, dados } (15 s: a mudança vale logo e a API não vai ao banco em toda chamada)
const CACHE_MS = 15_000;
export const esquecerAcessos = (usuarioId) => CACHE.delete(Number(usuarioId));

/** { paginas: [...], papeis: { pagina: papel } } de um usuário não-admin. */
export async function carregarAcessos(usuarioId) {
  const id = Number(usuarioId);
  const guardado = CACHE.get(id);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado.dados;
  const { rows } = await query('SELECT pagina, papel FROM painel_usuarios_acessos WHERE usuario_id = $1', [id]);
  const dados = {
    paginas: rows.map((r) => r.pagina).filter((p) => CHAVES.includes(p)),
    papeis: Object.fromEntries(rows.map((r) => [r.pagina, r.papel])),
  };
  CACHE.set(id, { em: Date.now(), dados });
  return dados;
}

/** Lista de acessos para a tela: admin vê todas as páginas como gestor; os demais, as marcadas. */
export async function acessosParaTela(usuario) {
  if (usuario.admin) return CHAVES.map((pagina) => ({ pagina, papel: 'gestor' }));
  const a = await carregarAcessos(usuario.id);
  return a.paginas.map((pagina) => ({ pagina, papel: a.papeis[pagina] ?? 'usuario' }));
}

/**
 * Roda dentro de exigirSessao (depois de o JWT valer): deixa `paginas`, `papeis` e `gestorEscalado` em req.usuario e recusa quem não tem a página da rota.
 * Token de serviço (integrações) e administrador passam direto.
 */
export async function verificarAcessoPagina(req) {
  const u = req.usuario;
  if (u.servico) return;
  if (u.admin) { u.paginas = CHAVES; u.papeis = {}; u.gestorEscalado = true; return; }
  let a;
  try {
    a = await carregarAcessos(u.user_id);
  } catch (err) {
    if (err.code === '42P01') { console.error('[acessos] tabela ausente (migração 072 não rodou): liberando'); return; }   // só na janela do deploy
    throw err;
  }
  u.paginas = a.paginas; u.papeis = a.papeis;
  u.gestorEscalado = a.papeis.suporteescalado === 'gestor' && a.paginas.includes('suporteescalado');
  const exigidas = paginasDaRota(req.routeOptions?.url ?? req.routerPath);
  if (exigidas && !exigidas.some((p) => a.paginas.includes(p))) {
    throw new ErroHttp(403, 'Você não tem acesso a esta página.');
  }
}
