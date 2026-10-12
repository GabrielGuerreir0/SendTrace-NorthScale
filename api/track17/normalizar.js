/**
 * 17TRACK — funções PURAS (sem rede, sem banco): transformam a resposta da API/webhook no que o SendTrace grava.
 * O status e o substatus ORIGINAIS do 17TRACK são preservados; a categoria interna (SPPL) é outro campo, noutra tabela.
 * Local do evento: só cidade/estado/país (decisão de 12/10/2026). CEP, rua e coordenadas nunca saem daqui.
 */
import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const texto = (v) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 500));

/** Chave estável do evento: o mesmo evento reenviado (webhook repetido, reconciliação) cai no mesmo valor. */
export function chaveEvento(numero, e) {
  return md5([numero, e.ocorreuEm ?? '', e.status ?? '', e.substatus ?? '', e.descricao ?? ''].join('|'));
}

/** Um item `accepted` do gettrackinfo (ou o `data` de um webhook) → registro + eventos, mais novo primeiro. */
export function normalizarItem(item) {
  const numero = String(item?.number ?? '').trim();
  const ti = item?.track_info ?? {};
  const eventos = [];
  for (const prov of ti.tracking?.providers ?? []) {
    for (const e of prov.events ?? []) {
      const ev = {
        ocorreuEm: e.time_utc ?? null,
        status: texto(e.stage),
        substatus: texto(e.sub_status),
        descricao: texto(e.description),
        cidade: texto(e.address?.city),
        estado: texto(e.address?.state),
        pais: texto(e.address?.country),
        provedor: texto(prov.provider?.name),
      };
      ev.chave = chaveEvento(numero, ev);
      eventos.push(ev);
    }
  }
  eventos.sort((a, b) => String(b.ocorreuEm ?? '').localeCompare(String(a.ocorreuEm ?? '')));
  const ultimo = ti.latest_event?.time_utc ?? eventos[0]?.ocorreuEm ?? null;
  return {
    numero,
    carrier: Number.isInteger(item?.carrier) ? item.carrier : null,
    ultimoStatus: texto(ti.latest_status?.status),
    ultimoSubstatus: texto(ti.latest_status?.sub_status),
    ultimoEventoEm: ultimo,
    eventos,
  };
}

/** Recusa do registro → situação interna. USPS exige pacote pago; "Carrier cannot be detected" = transportadora que o 17TRACK não reconhece. */
export function classificarRecusa(erro) {
  const codigo = Number(erro?.code ?? 0) || null;
  const msg = String(erro?.message ?? '').slice(0, 300);
  if (codigo === -18019909) return { situacao: 'sem_dado', motivo: msg, codigo };
  return { situacao: 'recusado', motivo: msg, codigo };
}

/** Assinatura do webhook: sha256(corpo bruto + "/" + chave) em hex, no cabeçalho `sign`. Comparação em tempo constante. */
export function assinaturaValida(corpoBruto, sign, chave) {
  if (!corpoBruto || !sign || !chave) return false;
  const esperado = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(corpoBruto), Buffer.from('/' + chave)])).digest();
  let recebido;
  try { recebido = Buffer.from(String(sign).trim().toLowerCase(), 'hex'); } catch { return false; }
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

/** Pedaços de até `n` (a API aceita no máximo 40 códigos por chamada). */
export function emLotes(lista, n = 40) {
  const saida = [];
  for (let i = 0; i < lista.length; i += n) saida.push(lista.slice(i, i + n));
  return saida;
}
