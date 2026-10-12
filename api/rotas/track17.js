/**
 * Webhook do 17TRACK (SPPL) — 12/10/2026.
 * O 17TRACK avisa (POST) cada vez que um código registrado muda. Autenticação: cabeçalho `sign` =
 * sha256(corpo bruto + "/" + SEVENTEEN_TRACK_API_KEY). Sem chave configurada responde 503; assinatura errada, 401.
 * Idempotente: o mesmo evento reenviado não duplica (UNIQUE numero+chave). Responde 200 só depois de gravar; falha de
 * banco devolve 500 para o 17TRACK tentar de novo. O corpo bruto nunca vai para o log.
 */
import { ErroHttp } from '../comum.js';
import { assinaturaValida } from '../track17/normalizar.js';
import { gravarTrackInfo } from '../track17/persistir.js';

export default async function rotasTrack17(app) {
  // Escopo próprio: aqui o corpo JSON chega como Buffer, porque a assinatura é conferida sobre os bytes originais.
  await app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, corpo, feito) => feito(null, corpo));

    inst.post('/api/v1/17track/webhook', {
      schema: { tags: ['Rastreio'], summary: 'Webhook do 17TRACK (atualização de rastreio)', description: 'Chamado pelo 17TRACK; assinatura no cabeçalho `sign`.', security: [] },
    }, async (req) => {
      const chave = (process.env.SEVENTEEN_TRACK_API_KEY ?? '').trim();
      if (!chave) throw new ErroHttp(503, 'Integração com o 17TRACK não configurada.');
      const bruto = req.body;
      if (!assinaturaValida(bruto, req.headers.sign, chave)) throw new ErroHttp(401, 'Assinatura inválida.');
      let msg;
      try { msg = JSON.parse(Buffer.from(bruto).toString('utf8')); } catch { throw new ErroHttp(400, 'Corpo inválido.'); }
      if (msg?.event && msg.event !== 'TRACKING_UPDATED') return { ok: true, ignorado: msg.event };
      if (!msg?.data?.number) throw new ErroHttp(400, 'Sem número de rastreio.');
      const r = await gravarTrackInfo(msg.data, 'webhook');
      return { ok: true, eventos_novos: r.novos };
    });
  });
}
