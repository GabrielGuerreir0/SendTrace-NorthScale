/**
 * Suporte Escalado → sub-aba "Relatório de métricas" (recorrência) — pedido da Vitória, 25/09/2026.
 *
 * Só LEITURA de `recorrencia_clientes` / `recorrencia_cobrancas` (migração 050), alimentadas pelo gatilho em
 * `eventos_plataforma` (webhooks do JVZoo) e pela carga histórica do export do JVZoo. Recorrência = comprou a
 * entrada de US$ 39 de um produto de `recorrencia_produtos`; cerca de 31 dias depois vem a renovação (BILL).
 *
 *   GET /api/recorrencia/relatorio/  → KPIs + uma linha por mês, ACUMULADA até o fim do mês
 *
 * Definições (mesmas do pedido):
 *  • "Com recorrência" (a base) = cliente que já teve pelo menos UMA renovação cobrada, mais os que o atendente
 *    moveu na mão pra coluna "Pendente - Recorrência" (esses entram na base e nos contatos, sem data de cobrança).
 *  • "Entrou em contato" = mandou e-mail para o suporte NO DIA da 1ª renovação ou depois. Cada cliente conta
 *    uma vez. Quem cancelou/reembolsou continua contando.
 *  • "Dias até o contato" = do primeiro contato até a renovação mais recente ANTES dele (dia do calendário,
 *    fuso de São Paulo). O export do JVZoo só traz a data, sem hora, por isso não há fração de dia.
 *  • Antes da 1ª renovação o cliente aparece só em "Aguardando 1ª cobrança".
 */
import { query } from '../../server/db.js';

const TZ = 'America/Sao_Paulo';

/** Uma linha por cliente: datas do calendário de SP + primeiro contato + dias até ele. */
export const CLIENTES_SQL = `
  WITH base AS (
    SELECT c.id, c.email, c.origem, c.situacao,
           (c.entrada_em AT TIME ZONE '${TZ}')::date AS d_entrada,
           (c.primeira_cobranca_em AT TIME ZONE '${TZ}')::date AS d_cobranca,
           (c.criado_em AT TIME ZONE '${TZ}')::date AS d_criado
    FROM public.recorrencia_clientes c
  ),
  contato AS (
    SELECT b.*,
      CASE WHEN b.origem = 'manual' THEN
        (SELECT (min(h.mudou_em) AT TIME ZONE '${TZ}')::date
           FROM email_ia.suporte_escalado_historico h
           JOIN email_ia.suporte_escalado s ON s.id = h.suporte_escalado_id
          WHERE lower(s.remetente_email) = b.email AND h.status_novo = 'pendente_recorrencia')
      ELSE
        (SELECT (min(e.data_email) AT TIME ZONE '${TZ}')::date
           FROM email_ia.emails e
          WHERE lower(e.remetente_email) = b.email
            AND (e.data_email AT TIME ZONE '${TZ}')::date >= b.d_cobranca)
      END AS d_contato
    FROM base b
  )
  SELECT k.id, k.origem, k.situacao, k.d_entrada::text AS d_entrada, k.d_cobranca::text AS d_cobranca,
         k.d_contato::text AS d_contato, coalesce(k.d_cobranca, k.d_criado)::text AS d_base,
         CASE WHEN k.origem <> 'manual' AND k.d_contato IS NOT NULL THEN
           k.d_contato - (SELECT max((r.cobrado_em AT TIME ZONE '${TZ}')::date)
                            FROM public.recorrencia_cobrancas r
                           WHERE r.cliente_id = k.id AND r.tipo = 'renovacao'
                             AND (r.cobrado_em AT TIME ZONE '${TZ}')::date <= k.d_contato)
         END AS dias
  FROM contato k`;

/** Transforma as linhas de CLIENTES_SQL na tabela mensal ACUMULADA. Pura (sem banco) pra dar pra testar. */
export function agregarMeses(clientes, hoje = new Date()) {
  const dia = (d) => (d ? new Date(`${d}T00:00:00Z`) : null);   // 'YYYY-MM-DD' (o SQL manda texto: o driver deslocaria o dia por fuso)
  const linhas = clientes.map((c) => ({
    base: dia(c.d_base), entrada: dia(c.d_entrada), cobranca: dia(c.d_cobranca),
    contato: dia(c.d_contato), dias: c.dias, origem: c.origem, situacao: c.situacao,
  }));
  const comCobranca = linhas.filter((l) => l.cobranca || l.origem === 'manual');
  const datas = linhas.flatMap((l) => [l.entrada, l.base, l.contato]).filter(Boolean);
  const meses = [];
  if (datas.length) {
    const primeiro = new Date(Math.min(...datas));
    let ano = primeiro.getUTCFullYear(); let mes = primeiro.getUTCMonth();
    const anoFim = hoje.getUTCFullYear(); const mesFim = hoje.getUTCMonth();
    const media = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
    const medidos = (ls) => ls.map((l) => l.dias).filter((v) => v !== null && v !== undefined);
    while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
      const ini = Date.UTC(ano, mes, 1);
      const fim = Date.UTC(ano, mes + 1, 1);              // exclusivo
      const ate = (d) => d && d.getTime() < fim;
      const naBase = comCobranca.filter((l) => ate(l.base));
      const contatos = naBase.filter((l) => ate(l.contato));
      const doMes = contatos.filter((l) => l.contato.getTime() >= ini);
      meses.push({
        mes: `${ano}-${String(mes + 1).padStart(2, '0')}`,
        compraram: linhas.filter((l) => l.origem !== 'manual' && ate(l.entrada)).length,
        com_recorrencia: naBase.length,
        novos_na_base: naBase.filter((l) => l.base.getTime() >= ini).length,
        entraram_em_contato: contatos.length,
        pct_contato: naBase.length ? contatos.length / naBase.length : null,
        media_dias: media(medidos(contatos)),
        media_dias_no_mes: media(medidos(doMes)),
        amostra_dias: medidos(contatos).length,
        cancelaram: naBase.filter((l) => l.situacao === 'cancelada').length,
        aguardando_1a_cobranca: linhas.filter((l) => l.origem !== 'manual' && ate(l.entrada) && !(l.cobranca && ate(l.cobranca))).length,
      });
      mes += 1; if (mes > 11) { mes = 0; ano += 1; }
    }
  }
  return { meses, manuais: linhas.filter((l) => l.origem === 'manual').length };
}

export default async function rotasRecorrencia(app) {
  app.get('/api/recorrencia/relatorio/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Suporte Escalado'],
      summary: 'Relatório de métricas da recorrência: contatos sobre clientes com recorrência, por mês (acumulado)',
      description: 'Uma linha por mês, acumulada até o último dia dele. "Com recorrência" = já teve ao menos uma renovação '
        + 'cobrada (mais os movidos na mão pra coluna). "Entraram em contato" conta cada cliente uma vez, mesmo que tenha cancelado. '
        + '"Média de dias" = do contato até a renovação mais recente antes dele. Só leitura.',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { rows: clientes } = await query(CLIENTES_SQL);
    const { meses, manuais } = agregarMeses(clientes);
    const atual = meses[meses.length - 1] ?? null;

    const { rows: [prev] } = await query(
      `SELECT count(*) FILTER (WHERE c.situacao = 'ativa' AND c.cobrancas = 0 AND c.entrada_em IS NOT NULL
                                 AND (c.entrada_em + interval '31 days') <= now() + interval '7 days')::int AS proximos_7_dias,
              count(*) FILTER (WHERE c.situacao = 'ativa' AND c.cobrancas = 0 AND c.entrada_em IS NOT NULL)::int AS aguardando_total,
              max(r.cobrado_em) AS ultima_cobranca
       FROM public.recorrencia_clientes c
       LEFT JOIN public.recorrencia_cobrancas r ON r.cliente_id = c.id AND r.tipo = 'renovacao'`,
    );
    return { atual, meses, previsao: prev, manuais };
  });
}
