/**
 * MONIT-SPPL — a FICHA do pedido ("folha", seção 13.1): dados do pedido, a linha do tempo de eventos (Rastreio, Sistema, Ocorrência, Pedido) e as
 * tratativas. Cada evento do 17Track traz o texto original (inglês), a tradução (12.5) e a classe de evento (as 14 regras); `relevante` marca o
 * movimento REAL (o que zera "dias sem movimentação"); `atual` marca o evento que decidiu a classe. Funciona também para pedido fora da lista de
 * abertos (achado pela busca): nesse caso vem sem classe.
 */
import { query } from '../../server/db.js';
import { classificarTexto, textoDoEvento, traduzirTexto, limparTextoTransportadora, rotuloSt17 } from './classes.js';
import { CTE_APOIO, enriquecer } from './consultas.js';
import { montarJornada, primeiroMovimento } from './jornada.js';

const LINK17 = (n) => `https://t.17track.net/pt#nums=${n}`;
const SEM_MOVIMENTO = new Set(['InfoReceived', 'NotFound']);

export async function montarFolha(transacaoId) {
  const { rows: [p] } = await query(
    `SELECT p.transacao_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido, p.status_interno, p.provedor, p.tracking_number, p.carrier_code, p.tracking_url, p.tracking_status,
            p.tracking, p.shipped_at, p.delivered_at, p.endereco_entrega, p.total, p.currency, p.criado_em AS cadastrado_em, p.order_created_at, p.transferido_redrock_em,
            dv.nome, dv.email, dv.produto, dv.plataforma, dv.criado_em AS criado_dv, dv.reembolsado_em, dv.chargeback_em,
            g.numero AS numero_17t, g.ultimo_status, g.ultimo_substatus
       FROM rastreio_pedidos p LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
       LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
      WHERE p.transacao_id = $1`, [transacaoId]);
  if (!p) return null;

  const { rows: [m] } = await query(
    `WITH ${CTE_APOIO}
     SELECT m.*, coalesce(em.n, 0) AS emails_enviados, em.tipos AS emails_tipos, em.ultimo AS email_ultimo FROM monit_pedidos m LEFT JOIN em ON em.pedido_id = m.transacao_id WHERE m.transacao_id = $1`, [transacaoId]);

  // códigos do pedido: o atual + os do histórico (`tracking` é um array de objetos)
  const codigos = new Map();
  if (p.tracking_number) codigos.set(p.tracking_number, { numero: p.tracking_number, transportadora: p.carrier_code, atual: true });
  for (const t of Array.isArray(p.tracking) ? p.tracking : []) {
    const n = t?.tracking_number; if (n && !codigos.has(n)) codigos.set(n, { numero: n, transportadora: t.carrier_code ?? null, atual: false });
  }
  const numeros = [...codigos.keys()];

  const eventos = [];
  let evCodigoAtual = [];   // eventos do código atual no 17Track (base da "coleta" da jornada)
  if (numeros.length) {
    const { rows: ev } = await query(
      `SELECT numero, ocorreu_em, status, substatus, descricao, cidade, estado, pais, provedor_17t FROM rastreio_17t_eventos WHERE numero = ANY($1::text[]) ORDER BY ocorreu_em DESC NULLS LAST LIMIT 400`, [numeros]);
    evCodigoAtual = ev.filter((e) => e.numero === p.tracking_number);
    let atual = null;   // o evento mais recente com classe, do código atual
    for (const e of ev) {
      const texto = textoDoEvento(e.descricao); const classe = classificarTexto(texto);
      const st = e.status ?? (e.substatus ? e.substatus.split('_')[0] : null);
      const item = { tipo: 'Rastreio', titulo: traduzirTexto(e.descricao) || rotuloSt17(st), detalhe: limparTextoTransportadora(e.descricao), original: e.descricao, local: [e.cidade, e.estado, e.pais].filter(Boolean).join(', ') || null,
        quando: e.ocorreu_em, relevante: Boolean(st) && !SEM_MOVIMENTO.has(st), status: st ? rotuloSt17(st) : null, classe_evento: classe, rastreio: e.numero,
        transportadora: e.provedor_17t ?? codigos.get(e.numero)?.transportadora ?? null, atual: false };
      if (classe && e.numero === p.tracking_number && !atual) atual = item;
      eventos.push(item);
    }
    if (atual) atual.atual = true;
  }
  // código que o 17Track não lê: o texto de `tracking_status` é o único "evento"
  if (p.tracking_number && !p.numero_17t && p.tracking_status) {
    const texto = p.tracking_status.split('|')[0].trim();
    eventos.push({ tipo: 'Rastreio', titulo: traduzirTexto(texto), detalhe: texto, original: p.tracking_status, local: null, quando: null, relevante: true, status: null, classe_evento: classificarTexto(texto),
      rastreio: p.tracking_number, transportadora: p.carrier_code, atual: true, sem_17track: true });
  }

  const { rows: sis } = await query(`SELECT status_anterior, status_novo, fonte, detectado_em FROM rastreio_eventos WHERE transacao_id = $1 ORDER BY detectado_em DESC LIMIT 60`, [transacaoId]);
  for (const s of sis) eventos.push({ tipo: 'Sistema', titulo: `Status interno: ${s.status_anterior ? `${s.status_anterior} → ` : ''}${s.status_novo}`, detalhe: `Fonte: ${s.fonte}`, local: null, quando: s.detectado_em, relevante: false, rastreio: null, transportadora: null, atual: false });

  const { rows: oc } = await query(`SELECT categoria, situacao, prioridade, aberta_em, resolvida_em, proxima_acao FROM sppl_ocorrencias WHERE transacao_id = $1 ORDER BY aberta_em DESC LIMIT 30`, [transacaoId]);
  for (const o of oc) eventos.push({ tipo: 'Ocorrência', titulo: `${o.categoria} (${o.prioridade}, ${o.situacao})`, detalhe: o.proxima_acao, local: null, quando: o.aberta_em, relevante: false, rastreio: null, transportadora: null, atual: false });

  const { rows: pl } = await query(`SELECT evento, recebido_em FROM eventos_plataforma WHERE transacao_id = $1 ORDER BY recebido_em DESC LIMIT 30`, [transacaoId]);
  const marcos = [
    [p.order_created_at ?? p.criado_dv, 'Pedido feito'], [p.shipped_at, 'Código de rastreio gerado'], [p.delivered_at, 'Entregue (segundo a fulfillment)'],
    [p.reembolsado_em, 'Reembolso registrado'], [p.chargeback_em, 'Chargeback registrado'], [p.transferido_redrock_em, 'Transferido da RedRock para a FullStack'],
  ];
  for (const [quando, titulo] of marcos) if (quando) eventos.push({ tipo: 'Pedido', titulo, detalhe: null, local: null, quando, relevante: false, rastreio: null, transportadora: null, atual: false });
  for (const e of pl) eventos.push({ tipo: 'Pedido', titulo: `Plataforma: ${e.evento}`, detalhe: null, local: null, quando: e.recebido_em, relevante: false, rastreio: null, transportadora: null, atual: false });
  eventos.sort((a, b) => (new Date(b.quando ?? 0)) - (new Date(a.quando ?? 0)));

  const { rows: trat } = await query(
    `SELECT a.id, a.trat_tipo AS tipo, a.trat_nota AS nota, a.trat_classe AS classe, a.trat_modelo AS modelo, a.trat_assunto AS assunto, a.em, a.por
       FROM sppl_ativo_acoes a JOIN sppl_ativo_tickets t ON t.id = a.ticket_id
      WHERE (t.transacao_id = $1 OR t.transacao_id = 'avulso:' || $1) AND a.trat_tipo IS NOT NULL AND a.removida_em IS NULL ORDER BY a.em DESC`, [transacaoId]);
  const { rows: tk } = await query(`SELECT id, status_ticket, motivo_problema FROM sppl_ativo_tickets WHERE (transacao_id = $1 OR transacao_id = 'avulso:' || $1) AND status_ticket <> 'fechado' ORDER BY id DESC LIMIT 1`, [transacaoId]);

  // Jornada do pedido (pedido → código → coleta → entrega): datas como na aba Prazos; os dias úteis vêm de monit_dias_uteis (mesma função da classificação)
  const tPed = p.order_created_at ?? p.criado_dv ?? p.cadastrado_em; const tCod = p.tracking_number ? p.shipped_at : null;
  const tMov = p.numero_17t ? primeiroMovimento(evCodigoAtual, tCod) : null;
  const ultimoEv = evCodigoAtual.reduce((mx, e) => (e.ocorreu_em && (!mx || new Date(e.ocorreu_em) > new Date(mx)) ? e.ocorreu_em : mx), null);
  const tEnt = p.delivered_at ?? (p.ultimo_status === 'Delivered' ? ultimoEv : null);
  const { rows: [du] } = await query(`SELECT monit_dias_uteis($1::timestamptz, coalesce($2::timestamptz, now())) AS ped_cod, monit_dias_uteis($2::timestamptz, coalesce($3::timestamptz, now())) AS cod_mov`, [tPed, tCod, tMov]);
  const jornada = montarJornada({ pedido: tPed, codigo: tCod, coleta: tMov, entrega: tEnt, diasUteis: { ped_cod: du?.ped_cod, cod_mov: du?.cod_mov } });

  const dados = m ? enriquecer({ ...m, pedido_id: m.transacao_id }) : null;
  return {
    pedido: {
      pedido_id: p.transacao_id, pedido: p.pedido, nome: p.nome, email: p.email, produtos: dados?.produtos ?? p.produto, plataforma: p.plataforma, fulfillment: p.provedor ?? 'sem fulfillment',
      status_interno: p.status_interno, rastreio: p.tracking_number, transportadora: m?.transportadora ?? p.carrier_code, link_rastreio: p.tracking_url || (p.tracking_number ? LINK17(p.tracking_number) : null),
      endereco: p.endereco_entrega, valor: p.total, moeda: p.currency, data_pedido: p.order_created_at ?? p.criado_dv, ultimo_status_17t: p.ultimo_status ? rotuloSt17(p.ultimo_status) : null,
      reembolsado_em: p.reembolsado_em, chargeback_em: p.chargeback_em,
    },
    classificacao: dados && {
      classe: dados.classe, classe_nome: dados.classe_nome, grupo: dados.grupo, causa: dados.causa, urgencia: dados.urgencia, motivo_suporte_ativo: dados.motivo_suporte_ativo, como_tratar: dados.como_tratar,
      texto_transportadora: dados.texto_transportadora, texto_pt: dados.texto_pt, evento_em: dados.evento_em, dias_desde_evento: dados.dias_desde_evento, ultima_movimentacao: dados.ultima_movimentacao,
      dias_sem_movimentacao: dados.dias_sem_movimentacao, qtd_rastreios: dados.qtd_rastreios, outros_rastreios: dados.outros_rastreios, reembolso_cb: dados.reembolso_cb, quantidade: dados.quantidade,
      calculado_em: m.calculado_em,
    },
    em_aberto: Boolean(m),
    jornada,
    codigos: [...codigos.values()],
    eventos,
    tratativas: trat,
    emails: { enviados: m?.emails_enviados ?? 0, tipos: m?.emails_tipos ?? null, ultimo: m?.email_ultimo ?? null },
    ticket: tk[0] ?? null,
    aviso: m ? null : 'Este pedido não está na lista de pedidos em aberto (já foi entregue, cancelado, ou ainda não tem leitura).',
  };
}
