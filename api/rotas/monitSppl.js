/**
 * MONIT-SPPL — Monitoramento Logístico (Késsia, 26/11/2026). Rotas sob `/api/rastreio/monit/…` (a página "Rastreio de Pedidos" já libera o prefixo).
 *
 *   GET  config              grupos, classes, causas, tipos de tratativa, quadros (textos da seção 12)
 *   GET  estado              hora REAL da última leitura ("dados lidos em")
 *   POST atualizar           refaz a classificação agora (botão "Atualizar")
 *   GET  lista               pedidos em aberto classificados (filtros da seção 3, ordenação e paginação no servidor)
 *   GET  resumo              barras por grupo e classe, vários rastreios, "A verificar com o dev"
 *   GET  pedido/:id/folha    ficha do pedido + linha do tempo de eventos
 *   (fase 2) GET quadros, rastreios-gerados, reembolso-logistica, sem-rastreio, busca
 *   (fase 3) GET tratativas/painel · POST tratativas · DELETE tratativas/:id · GET pedidos.xlsx
 *   (fase 4) GET prazos
 *   (seção 8) GET email/modelos · POST email/preparar · POST email/simular · POST email/enviar · POST email/marcar · POST email/traduzir
 *   A ficha (`pedido/:id/folha`) traz também a `jornada` do pedido (marcos e etapas com faixa de ritmo).
 *
 * Fases 1, 2 e 4 são SOMENTE LEITURA (a atualização grava só em `monit_pedidos`, tabela de apoio). A fase 3 grava tratativas em `sppl_ativo_acoes` (Suporte Ativo).
 * Dado pessoal só para quem já tem a página Rastreio.
 */
import { ErroHttp } from '../comum.js';
import { GRUPOS, GRUPO_VERIFICAR, CLASSES, CAUSAS_FILTRO, TIPOS_TRATATIVA, QUADROS, ROTULO_FULFILLMENT } from '../monit/classes.js';
import { atualizarMonit, estadoLeitura, INTERVALO_MS } from '../monit/atualizar.js';
import { lerFiltros, listar, resumir, DESDE_PADRAO } from '../monit/consultas.js';
import { montarFolha } from '../monit/folha.js';
import { kpis, rastreiosGerados, reembolsoLogistica, semRastreioTabelas, buscar } from '../monit/quadros.js';
import { registrar, remover, painel } from '../monit/tratativas.js';
import { prazos } from '../monit/prazos.js';
import { gerarXlsx } from '../monit/exportar.js';
import { listarModelos, preparar, simular, enviar, marcarEnviados } from '../monit/email.js';
import { traduzir } from '../monit/traduzir.js';
import { MODELO_POR_CLASSE, MODELO_PADRAO } from '../monit/emailPuro.js';

const auth = { onRequest: [] };
const quem = (req) => String(req.usuario?.nome || req.usuario?.email || 'desconhecido').slice(0, 120);
export { quem };

export default async function rotasMonitSppl(app) {
  auth.onRequest = [app.exigirSessao];
  const tags = ['Rastreio'];

  app.get('/api/rastreio/monit/config', { ...auth, schema: { tags, summary: 'MONIT-SPPL — grupos, classes e textos de negócio', security: [{ bearerAuth: [] }] } }, async () => ({
    grupos: GRUPOS, grupo_verificar: GRUPO_VERIFICAR, classes: CLASSES, causas: CAUSAS_FILTRO, tipos_tratativa: TIPOS_TRATATIVA, quadros: QUADROS, rotulo_fulfillment: ROTULO_FULFILLMENT,
    desde_padrao: DESDE_PADRAO, atualiza_a_cada_min: INTERVALO_MS / 60_000,
  }));

  app.get('/api/rastreio/monit/estado', { ...auth, schema: { tags, summary: 'MONIT-SPPL — hora real da última leitura', security: [{ bearerAuth: [] }] } }, async () => ({ ...(await estadoLeitura()), agora: new Date().toISOString() }));

  app.post('/api/rastreio/monit/atualizar', { ...auth, schema: { tags, summary: 'MONIT-SPPL — refaz a classificação agora (botão Atualizar)', security: [{ bearerAuth: [] }] } }, async () => {
    const antes = await estadoLeitura();
    // leitura de menos de 20 s não precisa ser refeita (cliques repetidos)
    if (antes.lido_em && Date.now() - new Date(antes.lido_em).getTime() < 20_000) return { ...antes, reaproveitada: true, agora: new Date().toISOString() };
    const r = await atualizarMonit({ log: (m) => app.log.info(m) });
    return { ...(await estadoLeitura()), ...r, agora: new Date().toISOString() };
  });

  app.get('/api/rastreio/monit/lista', { ...auth, schema: { tags, summary: 'MONIT-SPPL — pedidos em aberto classificados', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {});
    const tamanho = Math.min(500, Math.max(1, Number(req.query?.tamanho) || 100));
    const pagina = Math.max(1, Number(req.query?.pagina) || 1);
    const r = await listar(f, { ordem: req.query?.ordem, dir: req.query?.dir, limite: tamanho, offset: (pagina - 1) * tamanho });
    return { ...r, pagina, tamanho, filtros: f, lido_em: (await estadoLeitura()).lido_em };
  });

  app.get('/api/rastreio/monit/resumo', { ...auth, schema: { tags, summary: 'MONIT-SPPL — contagens por grupo e classe', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {}, { incluirClasse: false });
    return { ...(await resumir(f)), filtros: f, lido_em: (await estadoLeitura()).lido_em };
  });

  app.get('/api/rastreio/monit/pedido/:id/folha', { ...auth, schema: { tags, summary: 'MONIT-SPPL — ficha do pedido e linha do tempo', security: [{ bearerAuth: [] }] } }, async (req) => {
    const id = String(req.params.id ?? '').slice(0, 120);
    const folha = await montarFolha(id);
    if (!folha) throw new ErroHttp(404, 'Pedido não encontrado.');
    return folha;
  });

  /* ───────────── fase 2: quadros, KPIs, tabelinhas e busca ───────────── */
  const cache = new Map();   // leituras caras guardadas por 60 s (a classificação em si só muda a cada 10 min)
  const comCache = async (chave, fn) => { const c = cache.get(chave); if (c && Date.now() - c.t < 60_000) return c.v; const v = await fn(); cache.set(chave, { t: Date.now(), v }); if (cache.size > 50) cache.delete(cache.keys().next().value); return v; };

  app.get('/api/rastreio/monit/quadros', { ...auth, schema: { tags, summary: 'MONIT-SPPL — quadros Q1–Q5 e KPIs da barra superior', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {}, { incluirClasse: false });
    return { kpis: await comCache(`kpis:${f.desde}`, () => kpis(f.desde)), quadros: QUADROS };
  });
  app.get('/api/rastreio/monit/rastreios-gerados', { ...auth, schema: { tags, summary: 'MONIT-SPPL — códigos gerados hoje, ontem e na semana', security: [{ bearerAuth: [] }] } }, async () => comCache('gerados', rastreiosGerados));
  app.get('/api/rastreio/monit/reembolso-logistica', { ...auth, schema: { tags, summary: 'MONIT-SPPL — reembolsos e chargebacks × situação logística', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {}, { incluirClasse: false });
    return { itens: await comCache(`reemb:${f.desde}`, () => reembolsoLogistica(f.desde)) };
  });
  app.get('/api/rastreio/monit/sem-rastreio', { ...auth, schema: { tags, summary: 'MONIT-SPPL — Sem rastreio por plataforma e por fulfillment', security: [{ bearerAuth: [] }] } }, async (req) => semRastreioTabelas(lerFiltros(req.query ?? {}, { incluirClasse: false })));
  app.get('/api/rastreio/monit/busca', { ...auth, schema: { tags, summary: 'MONIT-SPPL — busca em toda a base (mínimo 4 caracteres)', security: [{ bearerAuth: [] }] } }, async (req) => buscar(req.query?.q));

  /* ───────────── fase 3: tratativas (Suporte Ativo) e planilha ───────────── */
  app.get('/api/rastreio/monit/tratativas/painel', { ...auth, schema: { tags, summary: 'MONIT-SPPL — aba Tratativas: números, status por classe, o que foi feito e pedidos tratados', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {}, { incluirClasse: false });
    return painel({ desde: f.desde, reemb: f.reemb });
  });
  app.post('/api/rastreio/monit/tratativas', { ...auth, schema: { tags, summary: 'MONIT-SPPL — registra uma tratativa em cada pedido selecionado', security: [{ bearerAuth: [] }] } }, async (req) => {
    const b = req.body ?? {};
    return registrar({ pedidos: b.pedidos, tipo: b.tipo, nota: b.nota, modelo: b.modelo, assunto: b.assunto, por: quem(req) });
  });
  app.delete('/api/rastreio/monit/tratativas/:id', { ...auth, schema: { tags, summary: 'MONIT-SPPL — remove (marca como removida) uma tratativa', security: [{ bearerAuth: [] }] } }, async (req) => remover(req.params.id, quem(req)));

  app.get('/api/rastreio/monit/pedidos.xlsx', { ...auth, schema: { tags, summary: 'MONIT-SPPL — planilha .xlsx (32 colunas) com os mesmos filtros da lista', security: [{ bearerAuth: [] }] } }, async (req, reply) => {
    const f = lerFiltros(req.query ?? {});
    const { buffer, nome, linhas } = await gerarXlsx(f, { ordem: req.query?.ordem, dir: req.query?.dir });
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="pedidos.xlsx"; filename*=UTF-8''${encodeURIComponent(nome)}`).header('X-Linhas', String(linhas)).header('X-Nome-Arquivo', encodeURIComponent(nome)).send(buffer);
  });

  /* ───────────── seção 8: e-mail padrão (preparar, simular, enviar, marcar como enviados, traduzir) ───────────── */
  const segs = [{ bearerAuth: [] }];
  app.get('/api/rastreio/monit/email/modelos', { ...auth, schema: { tags, summary: 'MONIT-SPPL — modelos de e-mail ativos (do Suporte Ativo) e a tabela MODELO_POR_CLASSE', security: segs } }, async () => ({
    modelos: await listarModelos(), modelo_por_classe: MODELO_POR_CLASSE, modelo_padrao: MODELO_PADRAO, traducao_ia: Boolean(process.env.ANTHROPIC_API_KEY),
  }));
  app.post('/api/rastreio/monit/email/preparar', { ...auth, schema: { tags, summary: 'MONIT-SPPL — "Preparar e-mail padrão": modelo sugerido pela classe e o texto de cada cliente (não grava nada)', security: segs } }, async (req) => preparar(req.body ?? {}));
  app.post('/api/rastreio/monit/email/simular', { ...auth, schema: { tags, summary: 'MONIT-SPPL — conferência do envio: destinatários, exemplo, avisos e contatos anteriores (não grava nada)', security: segs } }, async (req) => simular(req.body ?? {}));
  app.post('/api/rastreio/monit/email/enviar', { ...auth, schema: { tags, summary: 'MONIT-SPPL — confirma o envio individual (cria/atualiza o ticket, enfileira pelo Suporte Ativo e registra a tratativa)', security: segs } }, async (req) => {
    // o envio em si é do Suporte Ativo: chama o endpoint dele por dentro, com a sessão de quem pediu (mesmas regras, fila, teto por hora e marcadores)
    const chamarEnvio = async (corpo) => {
      const h = { 'content-type': 'application/json', 'x-forwarded-for': String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim() };
      if (req.headers.authorization) h.authorization = req.headers.authorization;
      if (req.headers.cookie) h.cookie = req.headers.cookie;
      if (req.headers['x-painel']) h['x-painel'] = req.headers['x-painel'];
      const r = await app.inject({ method: 'POST', url: '/api/rastreio/sppl/ativo/enviar', headers: h, payload: JSON.stringify(corpo) });
      let dado; try { dado = JSON.parse(r.body); } catch { dado = {}; }
      return { status: r.statusCode, corpo: dado };
    };
    return enviar(req.body ?? {}, quem(req), chamarEnvio);
  });
  app.post('/api/rastreio/monit/email/marcar', { ...auth, schema: { tags, summary: 'MONIT-SPPL — "Marcar como enviados": registra o contato feito fora do sistema (não envia nada)', security: segs } }, async (req) => marcarEnviados(req.body ?? {}, quem(req)));
  app.post('/api/rastreio/monit/email/traduzir', { ...auth, schema: { tags, summary: 'MONIT-SPPL — traduz o e-mail de português para inglês americano por IA (rascunho: exige revisão)', security: segs } }, async (req) => {
    const b = req.body ?? {};
    return traduzir({ assunto: b.assunto, corpo: b.texto ?? b.corpo });
  });

  /* ───────────── fase 4: prazos ───────────── */
  app.get('/api/rastreio/monit/prazos', { ...auth, schema: { tags, summary: 'MONIT-SPPL — aba Prazos: médias e medianas por etapa', security: [{ bearerAuth: [] }] } }, async (req) => {
    const f = lerFiltros(req.query ?? {}, { incluirClasse: false });
    return comCache(`prazos:${f.desde}:${f.reemb}`, () => prazos({ desde: f.desde, reemb: f.reemb }));
  });
}
