/**
 * Período dos SLAs e dos dashboards do Suporte Humano (pedido do Lucas, 07/10/2026): "Hoje", últimos N dias ou uma DATA PERSONALIZADA (de/ate,
 * dia inclusive, horário de Brasília). Devolve trechos de SQL prontos (já validados: só dígitos e traços entram na consulta) e uma chave para o cache.
 */
import { ErroHttp } from './comum.js';

const FUSO = "'America/Sao_Paulo'";
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_VALIDOS = [0, 7, 30, 90];
const MAX_DIAS_PERSONALIZADO = 366;

export function lerPeriodo(query, padraoDias = 7) {
  const { de, ate } = query;
  if (de || ate) {
    if (!DATA.test(de ?? '') || !DATA.test(ate ?? '')) throw new ErroHttp(400, 'Informe as duas datas (AAAA-MM-DD).');
    const d1 = new Date(`${de}T00:00:00Z`); const d2 = new Date(`${ate}T00:00:00Z`);
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) throw new ErroHttp(400, 'Data inválida.');
    if (d1 > d2) throw new ErroHttp(400, 'A data inicial é depois da final.');
    if ((d2 - d1) / 86400000 > MAX_DIAS_PERSONALIZADO) throw new ErroHttp(400, `O período personalizado vai até ${MAX_DIAS_PERSONALIZADO} dias.`);
    return {
      tipo: 'personalizado', de, ate, chave: `c:${de}:${ate}`,
      ini: `('${de}'::date::timestamp AT TIME ZONE ${FUSO})`,
      fim: `(('${ate}'::date + 1)::timestamp AT TIME ZONE ${FUSO})`,
    };
  }
  const dias = query.dias === undefined || query.dias === null || query.dias === '' ? padraoDias : Number(query.dias);
  if (!DIAS_VALIDOS.includes(dias)) throw new ErroHttp(400, 'Período inválido.');
  return {
    tipo: 'dias', dias, chave: `d:${dias}`,
    ini: dias === 0 ? `(date_trunc('day', now() AT TIME ZONE ${FUSO}) AT TIME ZONE ${FUSO})` : `(now() - interval '${dias} days')`,
    fim: 'now()',
  };
}

/** O que a API devolve para a tela saber qual período valeu. */
export const descreverPeriodo = (p) => (p.tipo === 'personalizado' ? { tipo: p.tipo, de: p.de, ate: p.ate } : { tipo: p.tipo, dias: p.dias });
