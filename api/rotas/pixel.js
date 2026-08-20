/**
 * Pixel de rastreamento de abertura — a ÚNICA rota da API que responde sem
 * token nenhum.
 *
 * É de propósito: quem faz a requisição é o cliente de e-mail de quem abriu
 * a mensagem (Gmail, Outlook, Apple Mail…), que não tem — e nunca deve ter —
 * credencial nossa. O efeito colateral é só uma linha de log de abertura;
 * não expõe nem altera nada sensível, então não precisa da mesma guarda que
 * o resto da API.
 *
 * Dois formatos de token, resolvidos pelo prefixo — os dois nascem no fluxo
 * n8n que manda o e-mail, sem chamada nova ao banco antes do envio:
 *   e<email_id>.<sufixo>         → resposta automática (email_ia.emails)
 *   d<disparo_id>.<etapa>.<sufixo> → régua de pós-venda (disparos_pos_venda)
 *
 * O sufixo NÃO é assinado (sem HMAC): decisão consciente para não depender
 * de `require('crypto')` dentro do Code node do n8n, cujo sandbox não
 * garante builtins liberados nesta instância. Custo aceito: quem soubesse um
 * id poderia forjar uma abertura falsa — só polui a métrica de taxa de
 * abertura, não expõe nem altera e-mail/pedido nenhum. Se um dia isso
 * importar, dá para trocar por HMAC via pgcrypto sem mudar o formato da URL.
 */
import { query } from '../../server/db.js';

// GIF transparente 1x1, bytes fixos — o menor payload válido que todo
// cliente de e-mail sabe renderizar.
const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64',
);

const RE_RESPOSTA = /^e(\d+)\.[a-z0-9]+$/i;
const RE_REGUA = /^d(\d+)\.(\d+)\.[a-z0-9]+$/i;

function extrairIp(req) {
  // Atrás do Caddy/proxy o IP real vem em X-Forwarded-For; sem proxy, o
  // socket já é o do cliente.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export default async function rotasPixel(app) {
  app.get('/pixel/:token', {
    schema: {
      tags: ['Saúde'],
      summary: 'Pixel 1x1 de rastreamento de abertura de e-mail (pública, sem token de acesso)',
      description: 'Embutido como <img> nos e-mails da resposta automática e da régua de '
        + 'pós-venda. Grava a abertura e devolve um GIF transparente — nunca falha visivelmente '
        + 'para o cliente, mesmo com token desconhecido ou erro de banco.',
      params: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
    },
  }, async (req, resposta) => {
    const bruto = String(req.params.token || '').replace(/\.gif$/i, '');
    const ip = extrairIp(req.raw);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);

    try {
      const mResposta = bruto.match(RE_RESPOSTA);
      const mRegua = bruto.match(RE_REGUA);

      if (mResposta) {
        await query(
          `INSERT INTO email_ia.aberturas_email (email_id, token, ip, user_agent)
           VALUES ($1, $2, $3, $4)`,
          [Number(mResposta[1]), bruto, ip, userAgent],
        );
      } else if (mRegua) {
        await query(
          `INSERT INTO aberturas_disparo (disparo_id, etapa, token, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [Number(mRegua[1]), Number(mRegua[2]), bruto, ip, userAgent],
        );
      }
      // Token em formato desconhecido: não grava nada, mas ainda devolve o
      // pixel — um <img> quebrado no e-mail do cliente seria pior que uma
      // abertura perdida na métrica.
    } catch (err) {
      req.log.warn({ err, token: bruto }, 'falha ao registrar abertura de pixel');
    }

    resposta
      .header('Content-Type', 'image/gif')
      // Sem cache: um hit cacheado pelo próprio cliente de e-mail nunca mais
      // bateria no servidor, e a 2ª/3ª abertura sumiria da métrica.
      .header('Cache-Control', 'no-store, no-cache, must-revalidate')
      .send(GIF_1X1);
  });
}
