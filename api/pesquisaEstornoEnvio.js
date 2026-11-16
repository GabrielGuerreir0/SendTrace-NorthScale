/**
 * Pesquisa de estorno (migração 130) — rotina de envio, a cada 10 min (api/servidor.js). Nasce DESLIGADA (`pesquisa_estorno_ativo`).
 *
 *   1. Convites: estorno de JVZoo/Vupim (venda principal e upsell) desde `pesquisa_estorno_desde`, 12 h depois do estorno.
 *      Entra só a amostra do piloto (`pesquisa_estorno_pct`); o resto fica registrado como 'fora_da_amostra' (serve de comparação).
 *   2. Descarte antes de enviar: descadastrado · falou com o suporte (e-mail, Suporte Escalado, formulário ou chat) nos 30 dias antes do
 *      estorno até agora · já tem outro convite do mesmo e-mail nos últimos 60 dias · e-mail inválido/teste.
 *   3. Envio pela API do Postmark (POSTMARK_SERVER_TOKEN), um destinatário por mensagem, com teto por rodada; cada envio vai para
 *      email_envios_log (conta no teto do Postmark). 3 falhas = 'falha_envio'; destinatário inativo no Postmark = 'inativo_postmark'.
 *   4. Lembrete 4 dias depois, só para quem não clicou, não concluiu, não é suspeita de fraude, não teve bounce/spam e não falou com o suporte.
 *   5. Abertura, bounce e spam: lidos de postmark_eventos pelo MessageID (o webhook do Postmark já grava lá).
 * Nunca lança: erro vira log.
 */
import { query } from '../server/db.js';
import { proximaPergunta } from './pesquisaEstorno.js';
import { montarEmail } from './pesquisaEstornoEmail.js';

const TOKEN = process.env.POSTMARK_SERVER_TOKEN || '';
const BASE = String(process.env.PAINEL_URL || 'https://sendtrace.thenorthscales.com').replace(/\/+$/, '');
const SUPORTE = 'support@northsupplements.online';
const RE_EMAIL = '^[^@\\s,;]{1,120}@[^@\\s,;]{1,120}\\.[^@\\s,;]{2,20}$';
let rodando = false;

async function config() {
  const { rows } = await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'pesquisa_estorno_%'`);
  const c = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  const num = (v, pad, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : pad; };
  return {
    ativo: c.pesquisa_estorno_ativo === 'true',
    lembrete: c.pesquisa_estorno_lembrete_ativo !== 'false',
    pct: num(c.pesquisa_estorno_pct, 10, 100),
    max: num(c.pesquisa_estorno_max_rodada, 40, 500),
    desde: c.pesquisa_estorno_desde || '2026-11-15 03:00:00+00',
  };
}

/** 1. Cria os convites que já passaram das 12 h (idempotente: UNIQUE origem+ref_id). */
export async function criarConvites(cfg) {
  const { rowCount } = await query(`
    WITH e AS (
      SELECT 'venda' AS origem, d.id AS ref_id, d.plataforma, d.transacao_id, lower(trim(d.email)) AS email, d.nome, d.produto,
             upper(COALESCE(d.estorno_tipo, CASE WHEN d.chargeback_em IS NOT NULL THEN 'CHARGEBACK' ELSE 'REFUND' END)) AS tipo,
             LEAST(d.reembolsado_em, d.chargeback_em) AS quando
        FROM disparos_pos_venda d
       WHERE d.plataforma IN ('JVZoo', 'Vupim') AND (d.reembolsado_em IS NOT NULL OR d.chargeback_em IS NOT NULL)
      UNION ALL
      SELECT 'upsell', u.id, u.plataforma, u.transacao_id, lower(trim(u.email)), u.nome, u.produto,
             upper(COALESCE(u.estorno_tipo, CASE WHEN u.chargeback_em IS NOT NULL THEN 'CHARGEBACK' ELSE 'REFUND' END)),
             LEAST(u.reembolsado_em, u.chargeback_em)
        FROM compras_upsell_downsell u
       WHERE u.plataforma IN ('JVZoo', 'Vupim') AND (u.reembolsado_em IS NOT NULL OR u.chargeback_em IS NOT NULL)
    ), x AS (
      SELECT e.*, (abs(hashtext(e.origem || ':' || e.ref_id)) % 100) < $2 AS amostra
        FROM e
       WHERE e.quando >= $1::timestamptz AND e.quando >= now() - interval '5 days' AND e.quando + interval '12 hours' <= now()
    )
    INSERT INTO pesquisa_estorno_convites (origem, ref_id, plataforma, transacao_id, email, nome, produto, estorno_tipo, grupo,
                                           estornado_em, enviar_apos, amostra, descartado)
    SELECT origem, ref_id, plataforma, transacao_id, coalesce(email, ''), nome, produto, tipo,
           CASE WHEN tipo IN ('ALERT', 'DISPUTE', 'CHARGEBACK') THEN 'banco' ELSE 'reembolso' END,
           quando, quando + interval '12 hours', amostra,
           CASE WHEN NOT amostra THEN 'fora_da_amostra'
                WHEN coalesce(email, '') !~ $3 THEN 'email_invalido'
                WHEN email LIKE '%@example.com' OR email LIKE '%@teste%' THEN 'teste' END
      FROM x
    ON CONFLICT (origem, ref_id) DO NOTHING`, [cfg.desde, cfg.pct, RE_EMAIL]);
  return rowCount;
}

/** Quem falou com o suporte entre `desde` e agora (e-mail, Suporte Escalado, formulário, chat). `c` é o alias do convite. */
const FALOU_COM_SUPORTE = (desde) => `(
     EXISTS (SELECT 1 FROM email_ia.emails m WHERE lower(m.remetente_email) = c.email AND m.data_email >= ${desde})
  OR EXISTS (SELECT 1 FROM email_ia.suporte_escalado s WHERE (lower(s.remetente_email) = c.email OR lower(s.email_compra) = c.email) AND s.criado_em >= ${desde})
  OR EXISTS (SELECT 1 FROM formularios_respostas f WHERE lower(f.email) = c.email AND f.respondido_em >= ${desde})
  OR EXISTS (SELECT 1 FROM chat_atendimentos a WHERE lower(a.email) = c.email AND a.criado_em >= ${desde}))`;

/** 2. Marca o motivo de não enviar nos convites pendentes. */
export async function descartarInelegiveis() {
  const { rowCount } = await query(`
    UPDATE pesquisa_estorno_convites c SET descartado = r.motivo
      FROM (
        SELECT c.id, CASE
            WHEN EXISTS (SELECT 1 FROM email_descadastros x WHERE x.email = c.email) THEN 'descadastrado'
            WHEN ${FALOU_COM_SUPORTE("c.estornado_em - interval '30 days'")} THEN 'falou_com_suporte'
            WHEN EXISTS (SELECT 1 FROM pesquisa_estorno_convites o
                          WHERE o.email = c.email AND o.id <> c.id AND o.descartado IS NULL
                            AND (o.email_enviado_em > now() - interval '60 days' OR (o.email_enviado_em IS NULL AND o.id < c.id))) THEN 'outro_convite'
          END AS motivo
          FROM pesquisa_estorno_convites c
         WHERE c.email_enviado_em IS NULL AND c.descartado IS NULL AND c.enviar_apos <= now()
      ) r
     WHERE c.id = r.id AND r.motivo IS NOT NULL`);
  return rowCount;
}

/** 5. Abertura, bounce e spam pelo MessageID (postmark_eventos, gravado pelo webhook do Postmark no n8n). */
export async function sincronizarEventos() {
  await query(`
    UPDATE pesquisa_estorno_convites c
       SET aberto_em = COALESCE(c.aberto_em, ev.aberto), bounce_em = COALESCE(c.bounce_em, ev.bounce), spam_em = COALESCE(c.spam_em, ev.spam)
      FROM (
        SELECT c2.id,
               min(p.ocorreu_em) FILTER (WHERE p.tipo = 'Open') AS aberto,
               min(p.ocorreu_em) FILTER (WHERE p.tipo = 'Bounce') AS bounce,
               min(p.ocorreu_em) FILTER (WHERE p.tipo = 'SpamComplaint') AS spam
          FROM pesquisa_estorno_convites c2
          JOIN postmark_eventos p ON p.message_id IN (c2.email_message_id, c2.lembrete_message_id)
         WHERE c2.email_enviado_em > now() - interval '30 days'
         GROUP BY c2.id
      ) ev
     WHERE c.id = ev.id AND (c.aberto_em IS NULL AND ev.aberto IS NOT NULL OR c.bounce_em IS NULL AND ev.bounce IS NOT NULL OR c.spam_em IS NULL AND ev.spam IS NOT NULL)`);
}

async function postmark({ para, assunto, html, texto, tag, descadastro }) {
  const r = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': TOKEN },
    body: JSON.stringify({
      From: SUPORTE, To: para, ReplyTo: SUPORTE, Subject: assunto, HtmlBody: html, TextBody: texto, MessageStream: 'outbound', Tag: tag,
      Headers: descadastro ? [{ Name: 'List-Unsubscribe', Value: `<${descadastro}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] : [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ErrorCode) { const e = new Error(`Postmark ${r.status} ${d.ErrorCode ?? ''}: ${d.Message ?? ''}`.trim()); e.codigo = d.ErrorCode; throw e; }
  return d.MessageID;
}

/** 3 e 4. Envia os convites devidos e os lembretes. Devolve { convites, lembretes, falhas }. */
async function enviar(cfg, log) {
  const { rows: perguntas } = await query('SELECT * FROM pesquisa_estorno_perguntas_atuais');
  const primeira = { reembolso: proximaPergunta(perguntas, 'reembolso'), banco: proximaPergunta(perguntas, 'banco') };
  const out = { convites: 0, lembretes: 0, falhas: 0 };
  let restante = cfg.max;

  const { rows: devidos } = await query(`
    SELECT c.*, public.descadastro_url(c.email) AS url_descadastro FROM pesquisa_estorno_convites c
     WHERE c.email_enviado_em IS NULL AND c.descartado IS NULL AND c.enviar_apos <= now()
     ORDER BY c.enviar_apos LIMIT $1`, [restante]);
  const lembretes = cfg.lembrete ? (await query(`
    SELECT c.*, public.descadastro_url(c.email) AS url_descadastro FROM pesquisa_estorno_convites c
     WHERE c.descartado IS NULL AND c.lembrete_enviado_em IS NULL AND c.clicou_em IS NULL AND c.concluido_em IS NULL
       AND NOT c.suspeita_fraude AND c.bounce_em IS NULL AND c.spam_em IS NULL
       AND c.email_enviado_em <= now() - interval '4 days' AND c.email_enviado_em > now() - interval '10 days'
       AND NOT EXISTS (SELECT 1 FROM email_descadastros x WHERE x.email = c.email)
       AND NOT ${FALOU_COM_SUPORTE('c.email_enviado_em')}
     ORDER BY c.email_enviado_em LIMIT $1`, [restante])).rows : [];

  for (const [lista, lembrete] of [[devidos, false], [lembretes, true]]) {
    for (const c of lista) {
      if (restante <= 0) return out;
      const pergunta = primeira[c.grupo];
      if (!pergunta) { log?.('Pesquisa de estorno: nenhuma pergunta ativa para o grupo ' + c.grupo + '; envio parado.'); return out; }
      const { assunto, html, texto } = montarEmail({ c, pergunta, base: BASE, descadastro: c.url_descadastro || '', suporte: SUPORTE, lembrete });
      try {
        const id = await postmark({ para: c.email, assunto, html, texto, tag: lembrete ? 'pesquisa-estorno-lembrete' : 'pesquisa-estorno', descadastro: c.url_descadastro });
        await query(lembrete
          ? 'UPDATE pesquisa_estorno_convites SET lembrete_enviado_em = now(), lembrete_message_id = $2, erro = NULL WHERE id = $1'
          : 'UPDATE pesquisa_estorno_convites SET email_enviado_em = now(), email_message_id = $2, erro = NULL, tentativas = tentativas + 1 WHERE id = $1', [c.id, id]);
        await query(`INSERT INTO email_envios_log (origem) VALUES ('pesquisa_estorno')`);
        out[lembrete ? 'lembretes' : 'convites'] += 1;
        restante -= 1;
      } catch (e) {
        out.falhas += 1;
        // 406 = destinatário inativo no Postmark (bounce/spam antigo): não adianta tentar de novo
        const definitivo = e.codigo === 406 || (!lembrete && c.tentativas + 1 >= 3);
        if (lembrete) await query(`UPDATE pesquisa_estorno_convites SET erro = $2, lembrete_enviado_em = CASE WHEN $3 THEN now() END WHERE id = $1`, [c.id, `lembrete: ${e.message}`.slice(0, 400), definitivo]);
        else await query(`UPDATE pesquisa_estorno_convites SET tentativas = tentativas + 1, erro = $2, descartado = CASE WHEN $3 THEN $4 END WHERE id = $1`,
          [c.id, String(e.message).slice(0, 400), definitivo, e.codigo === 406 ? 'inativo_postmark' : 'falha_envio']);
        log?.(`Pesquisa de estorno: envio ${c.id} falhou: ${e.message}`);
        if (out.falhas >= 3 && out.convites + out.lembretes === 0) { log?.('Pesquisa de estorno: 3 falhas seguidas, rodada interrompida.'); return out; }
      }
    }
  }
  return out;
}

/** Uma rodada completa. `forcar` ignora a chave liga/desliga (só para teste). */
export async function rodadaPesquisaEstorno(log, { forcar = false } = {}) {
  if (rodando) return { rodou: false };
  rodando = true;
  try {
    await sincronizarEventos();
    const cfg = await config();
    if (!cfg.ativo && !forcar) return { rodou: false, motivo: 'desligada' };
    if (!TOKEN) { log?.('Pesquisa de estorno: POSTMARK_SERVER_TOKEN ausente; nada enviado.'); return { rodou: false, motivo: 'sem_token' }; }
    const criados = await criarConvites(cfg);
    const descartados = await descartarInelegiveis();
    const r = await enviar(cfg, log);
    const resumo = { rodou: true, criados, descartados, ...r };
    if (criados || r.convites || r.lembretes || r.falhas) log?.(`Pesquisa de estorno: ${JSON.stringify(resumo)}`);
    return resumo;
  } finally {
    rodando = false;
  }
}
