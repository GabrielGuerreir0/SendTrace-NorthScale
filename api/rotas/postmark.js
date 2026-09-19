/**
 * Aba "Postmark" — saúde do envio de e-mail (18/09/2026).
 *
 * Só LEITURA. Junta o que já existe no banco:
 *   • `postmark_eventos`  — eventos que o Postmark manda pro webhook do n8n
 *     ("Postmark — Eventos de Entrega"): Delivery, Bounce, SpamComplaint, Open, Click,
 *     SubscriptionChange. Eventos de teste (e-mail @example.com) são ignorados aqui.
 *   • `email_envios_log`  — 1 linha por e-mail da régua enviado (migração 036).
 *   • `email_ia.emails` / `email_ia.tickets` — respostas da IA e boas-vindas.
 *   • `disparos_pos_venda` — a fila da régua (atraso, falhas).
 *   • `config_disparos`   — o teto do plano (125 mil por ciclo) e a chave mestra.
 *
 * O denominador das taxas (spam, bounce) é o total ENVIADO segundo os nossos próprios logs
 * (régua + IA + boas-vindas), não os Delivery do webhook: o webhook só existe desde 18/09 e
 * um Delivery perdido não pode inflar a taxa de spam. Postmark pausa a conta acima de ~0,1%.
 *
 * `coletarPostmark` recebe a função de consulta como parâmetro pra poder ser exercitada contra
 * o banco de produção (só SELECT) sem subir a API inteira.
 */
import { query as consultaPadrao } from '../../server/db.js';

const TZ = 'America/Sao_Paulo';
const SEM_TESTE = "coalesce(email, '') NOT LIKE '%@example.com'";
const LIMITE_SPAM_POSTMARK = 0.1; // % — acima disso o Postmark avisa e pode pausar a conta

const CHAVES = [
  'orcamento_limite_ciclo', 'orcamento_margem_pct', 'orcamento_ciclo_fim',
  'orcamento_usado_inicial', 'orcamento_log_desde', 'orcamento_reserva_ia_dia', 'emails_automaticos_ativo',
];

const pct = (parte, todo) => (todo > 0 ? Math.round((parte / todo) * 10000) / 100 : null);
const virgula = (v) => String(v).replace('.', ',');

/** Roda uma consulta que pode falhar (tabela ainda inexistente etc.) sem derrubar a aba inteira. */
async function tentar(fn, padrao) {
  try { return await fn(); } catch (err) { return { __erro: err.message, ...(padrao ?? {}) }; }
}

function diasDoPeriodo(dias) {
  // Datas locais (São Paulo) de hoje-(dias-1) até hoje, como 'YYYY-MM-DD'.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const lista = [];
  for (let i = dias - 1; i >= 0; i -= 1) lista.push(fmt.format(new Date(Date.now() - i * 86400000)));
  return lista;
}

export async function coletarPostmark(dias = 7, consulta = consultaPadrao) {
  const q = async (sql, params = []) => (await consulta(sql, params)).rows;
  const desde = `(date_trunc('day', now() AT TIME ZONE '${TZ}') - ($1::int - 1) * interval '1 day') AT TIME ZONE '${TZ}'`;

  const [cfgRows, uso, saldoRow, serieRegua, serieIA, serieBV, evRows, prob, beat, fila, motivos, ia] = await Promise.all([
    tentar(() => q('SELECT chave, valor FROM config_disparos WHERE chave = ANY($1)', [CHAVES]), null),
    tentar(() => q(`WITH cfg AS (SELECT valor::timestamptz AS desde FROM config_disparos WHERE chave = 'orcamento_log_desde')
      SELECT (SELECT count(*) FROM email_envios_log l, cfg WHERE l.quando >= cfg.desde)::int AS regua,
             (SELECT count(*) FROM email_ia.emails e, cfg WHERE e.resposta_enviada_em >= cfg.desde)::int AS ia,
             (SELECT count(*) FROM email_ia.tickets t, cfg WHERE t.boas_vindas_enviada_em >= cfg.desde)::int AS boas_vindas`), null),
    tentar(() => q(`SELECT email_saldo_regua_hoje() AS saldo,
      (SELECT count(*) FROM email_envios_log WHERE quando >= (date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'))::int AS enviados_hoje`), null),
    tentar(() => q(`SELECT to_char((quando AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n
      FROM email_envios_log WHERE quando >= ${desde} GROUP BY 1`, [dias]), null),
    tentar(() => q(`SELECT to_char((resposta_enviada_em AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n
      FROM email_ia.emails WHERE resposta_enviada_em >= ${desde} GROUP BY 1`, [dias]), null),
    tentar(() => q(`SELECT to_char((boas_vindas_enviada_em AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n
      FROM email_ia.tickets WHERE boas_vindas_enviada_em >= ${desde} GROUP BY 1`, [dias]), null),
    tentar(() => q(`SELECT tipo, count(*)::int AS n FROM postmark_eventos
      WHERE coalesce(ocorreu_em, recebido_em) >= ${desde} AND ${SEM_TESTE} GROUP BY tipo`, [dias]), null),
    tentar(() => q(`SELECT tipo, subtipo, email, assunto, detalhes, coalesce(ocorreu_em, recebido_em) AS quando
      FROM postmark_eventos WHERE tipo IN ('Bounce', 'SpamComplaint', 'SubscriptionChange') AND ${SEM_TESTE}
      ORDER BY coalesce(ocorreu_em, recebido_em) DESC LIMIT 30`), null),
    tentar(() => q(`SELECT max(recebido_em) AS ultimo,
      count(*) FILTER (WHERE recebido_em >= now() - interval '24 hours')::int AS n24
      FROM postmark_eventos WHERE ${SEM_TESTE}`), null),
    tentar(() => q(`SELECT count(*) FILTER (WHERE status = 'ativo')::int AS ativos,
      count(*) FILTER (WHERE status = 'ativo' AND proximo_disparo <= now())::int AS vencidos,
      coalesce(round((max(extract(epoch FROM (now() - proximo_disparo)) / 3600)
        FILTER (WHERE status = 'ativo' AND proximo_disparo <= now()))::numeric, 1), 0)::float AS maior_atraso_h,
      count(*) FILTER (WHERE status = 'falhou' AND criado_em >= now() - interval '6 hours')::int AS falhas_6h
      FROM disparos_pos_venda`), null),
    tentar(() => q(`SELECT left(coalesce(ultimo_erro, '(sem erro registrado)'), 90) AS erro, count(*)::int AS n
      FROM disparos_pos_venda WHERE status = 'falhou' AND criado_em >= now() - interval '6 hours'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`), null),
    tentar(() => q(`SELECT count(*) FILTER (WHERE erro_resposta_automatica IS NOT NULL AND data_email >= now() - interval '48 hours')::int AS erros_48h,
      count(*) FILTER (WHERE pede_resposta AND resposta_enviada_em IS NULL AND erro_resposta_automatica IS NULL
                         AND plataforma_origem IS NULL AND data_email >= now() - interval '24 hours')::int AS pendentes_24h
      FROM email_ia.emails WHERE data_email >= now() - interval '48 hours'`), null),
  ]);

  /* ── série por dia ── */
  const mapa = (rows) => new Map(Array.isArray(rows) ? rows.map((r) => [r.dia, r.n]) : []);
  const mR = mapa(serieRegua); const mI = mapa(serieIA); const mB = mapa(serieBV);
  const serie = diasDoPeriodo(dias).map((d) => {
    const regua = mR.get(d) ?? 0; const iaN = mI.get(d) ?? 0; const bv = mB.get(d) ?? 0;
    return { dia: d, regua, ia: iaN, boas_vindas: bv, total: regua + iaN + bv };
  });
  const somaJanela = serie.reduce((s, d) => s + d.total, 0);

  /* ── cota do ciclo ── */
  const cfg = Object.fromEntries((Array.isArray(cfgRows) ? cfgRows : []).map((r) => [r.chave, r.valor]));
  const limite = Number(cfg.orcamento_limite_ciclo) || 125000;
  const inicial = Number(cfg.orcamento_usado_inicial) || 0;
  const u = (uso && !uso.__erro && uso[0]) ? uso[0] : { regua: 0, ia: 0, boas_vindas: 0 };
  const usadoTotal = inicial + u.regua + u.ia + u.boas_vindas;
  const fim = cfg.orcamento_ciclo_fim ? new Date(cfg.orcamento_ciclo_fim) : null;
  const diasRestantes = fim ? Math.max(0, Math.ceil((fim.getTime() - Date.now()) / 86400000)) : null;
  const hoje = serie[serie.length - 1]?.dia;
  // só dias COMPLETOS em que o log da régua já existia (antes de 18/09 a régua não gravava log)
  const completos = serie.filter((d) => d.dia !== hoje && d.regua > 0);
  const media = completos.length ? Math.round(completos.reduce((s, d) => s + d.total, 0) / completos.length) : null;
  const saldo = (saldoRow && !saldoRow.__erro && saldoRow[0]) ? saldoRow[0] : {};
  const cota = {
    limite, margem_pct: Number(cfg.orcamento_margem_pct) || 0, ciclo_fim: cfg.orcamento_ciclo_fim ?? null,
    dias_restantes: diasRestantes, usado_total: usadoTotal, usado: { ...u, inicial },
    pct: pct(usadoTotal, limite), saldo_hoje: saldo.saldo ?? null, enviados_hoje: saldo.enviados_hoje ?? null,
    media_diaria: media, projecao_fim_ciclo: media !== null && diasRestantes !== null ? usadoTotal + media * diasRestantes : null,
    emails_automaticos_ativo: cfg.emails_automaticos_ativo === 'true',
  };

  /* ── eventos do Postmark ── */
  const tabelaExiste = !(evRows && evRows.__erro);
  const ev = Object.fromEntries((Array.isArray(evRows) ? evRows : []).map((r) => [r.tipo, r.n]));
  // Denominador: o que saiu DEPOIS do início do log (18/09 15h46, já pelo Postmark). Antes disso o envio era pela
  // Hostinger e nada disso chegou ao Postmark; incluir inflaria o denominador e esconderia a taxa de spam.
  const inicioJanela = new Date(`${serie[0].dia}T00:00:00-03:00`);
  const logDesde = cfg.orcamento_log_desde ? new Date(cfg.orcamento_log_desde) : null;
  const enviadosJanela = logDesde && logDesde >= inicioJanela ? u.regua + u.ia + u.boas_vindas : somaJanela;
  const eventos = {
    enviados: enviadosJanela, entregues: ev.Delivery ?? 0, aberturas: ev.Open ?? 0, cliques: ev.Click ?? 0,
    bounces: ev.Bounce ?? 0, spam: ev.SpamComplaint ?? 0,
    taxa_spam: pct(ev.SpamComplaint ?? 0, enviadosJanela), taxa_bounce: pct(ev.Bounce ?? 0, enviadosJanela),
    taxa_abertura: Math.min(100, pct(ev.Open ?? 0, ev.Delivery ?? 0) ?? 0) || (ev.Delivery ? 0 : null), // eventos, não e-mails únicos: limita a 100%
    taxa_clique: Math.min(100, pct(ev.Click ?? 0, ev.Delivery ?? 0) ?? 0) || (ev.Delivery ? 0 : null),
  };
  const b = (beat && !beat.__erro && beat[0]) ? beat[0] : {};
  const webhook = { tabela_existe: tabelaExiste, ultimo_evento_em: b.ultimo ?? null, eventos_24h: b.n24 ?? 0 };
  const problemas = Array.isArray(prob) ? prob : [];

  /* ── fila / IA ── */
  const f = (fila && !fila.__erro && fila[0]) ? fila[0] : { ativos: 0, vencidos: 0, maior_atraso_h: 0, falhas_6h: 0 };
  const filaOut = { ...f, falhas_motivos: Array.isArray(motivos) ? motivos : [] };
  const iaOut = (ia && !ia.__erro && ia[0]) ? ia[0] : { erros_48h: 0, pendentes_24h: 0 };

  /* ── alertas ── */
  const alertas = [];
  const add = (nivel, titulo, detalhe) => alertas.push({ nivel, titulo, detalhe });
  if (eventos.spam > 0) {
    const t = eventos.taxa_spam;
    if (t !== null && t >= LIMITE_SPAM_POSTMARK) add('critico', `Reclamações de spam acima do limite do Postmark (${virgula(t)}%)`, `${eventos.spam} reclamação(ões) em ${enviadosJanela} envios no período. O Postmark avisa e pode pausar a conta se a taxa passar de ~${LIMITE_SPAM_POSTMARK}%. Veja quais e-mails geraram no Postmark → Activity.`);
    else add('atencao', `${eventos.spam} reclamação(ões) de spam no período (${t === null ? '—' : virgula(t)}%)`, 'Ainda abaixo do limite de 0,1%, mas vale conferir o assunto e a etapa da régua desses e-mails.');
  }
  if (eventos.bounces > 0) {
    const t = eventos.taxa_bounce;
    if (t !== null && t >= 5) add('critico', `Taxa de bounce alta (${virgula(t)}%)`, 'Muitos endereços inexistentes — reputação do domínio em risco.');
    else if (t !== null && t >= 2) add('atencao', `Taxa de bounce em ${virgula(t)}%`, `${eventos.bounces} e-mails devolvidos. O Postmark já suprime esses endereços sozinho.`);
  }
  if (cota.pct !== null && cota.pct >= 90) add('critico', `Cota do ciclo em ${virgula(cota.pct)}%`, `${usadoTotal.toLocaleString('pt-BR')} de ${limite.toLocaleString('pt-BR')} e-mails usados.`);
  else if (cota.pct !== null && cota.pct >= 75) add('atencao', `Cota do ciclo em ${virgula(cota.pct)}%`, `${usadoTotal.toLocaleString('pt-BR')} de ${limite.toLocaleString('pt-BR')} e-mails usados.`);
  if (cota.projecao_fim_ciclo !== null && cota.projecao_fim_ciclo > limite) add('atencao', 'Projeção passa do plano', `No ritmo atual (~${media?.toLocaleString('pt-BR')}/dia) o ciclo fecha em ~${Math.round(cota.projecao_fim_ciclo).toLocaleString('pt-BR')} e-mails. O teto diário da régua segura o excesso, atrasando envios.`);
  if (cota.saldo_hoje === 0) add('atencao', 'Régua parada até amanhã', 'O saldo diário de envios acabou; a fila volta a andar à meia-noite.');
  if (f.vencidos >= 1000 || f.maior_atraso_h >= 12) add('critico', `Fila da régua atrasada (${f.vencidos} vencidos, até ${virgula(f.maior_atraso_h)} h)`, 'Verifique se o fluxo "Processador de Disparos" está ativo no n8n.');
  else if (f.vencidos >= 200 || f.maior_atraso_h >= 3) add('atencao', `Fila da régua com atraso (${f.vencidos} vencidos, até ${virgula(f.maior_atraso_h)} h)`, 'Normal logo depois de um lote grande; se não baixar, verifique o n8n.');
  if (f.falhas_6h >= 50) add('critico', `${f.falhas_6h} pedidos com falha de envio nas últimas 6 h`, filaOut.falhas_motivos[0]?.erro ?? '');
  else if (f.falhas_6h > 0) add('atencao', `${f.falhas_6h} pedido(s) com falha de envio nas últimas 6 h`, filaOut.falhas_motivos[0]?.erro ?? '');
  if (iaOut.erros_48h > 0) add('atencao', `${iaOut.erros_48h} resposta(s) da IA com erro de envio (48 h)`, 'Ficam registradas com erro até alguém liberar — o cron de reenvio tenta 3 vezes.');
  if (!tabelaExiste) add('info', 'Tabela de eventos do Postmark ainda não existe', 'Ela é criada na primeira vez que o webhook do n8n recebe um evento.');
  else if (!webhook.ultimo_evento_em) add('info', 'O webhook do Postmark ainda não recebeu nenhum evento real', 'Em Postmark → Webhooks, confira se ele foi salvo (Save webhook) com os eventos marcados.');
  else if (Date.now() - new Date(webhook.ultimo_evento_em).getTime() > 3 * 3600 * 1000 && (cota.enviados_hoje ?? 0) > 100) add('atencao', 'Webhook do Postmark sem eventos há mais de 3 h', 'Há envios acontecendo, mas nenhum evento chegou. Confira o webhook no Postmark e o fluxo no n8n.');
  if (!alertas.length) add('ok', 'Tudo em ordem', 'Sem alertas de spam, bounce, cota, fila ou falha de envio no período.');

  return { gerado_em: new Date().toISOString(), dias, cota, serie, eventos, webhook, problemas, fila: filaOut, ia: iaOut, alertas };
}

let cache = { em: 0, dias: 0, valor: null };

export default async function rotasPostmark(app) {
  app.get('/api/postmark/resumo/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Postmark'],
      summary: 'Saúde do envio de e-mail: cota do plano, eventos do Postmark, fila da régua e alertas',
      description: 'Aba "Postmark". Só leitura. Taxas de spam/bounce usam o total enviado pelos logs do SendTrace '
        + 'como denominador. Eventos de teste (@example.com) são ignorados. Cache de 30 s.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { dias: { type: 'integer', minimum: 1, maximum: 90, default: 7 } },
      },
    },
  }, async (req) => {
    const dias = Number(req.query?.dias) || 7;
    if (cache.valor && cache.dias === dias && Date.now() - cache.em < 30000) return cache.valor;
    const valor = await coletarPostmark(dias);
    cache = { em: Date.now(), dias, valor };
    return valor;
  });
}
