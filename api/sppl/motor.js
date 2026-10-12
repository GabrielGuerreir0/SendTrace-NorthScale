/**
 * SPPL — motor de etapas e prazos (12/10/2026). Lê as regras ATIVAS de `sppl_regras` e abre/fecha ocorrências em `sppl_ocorrencias`.
 * Nasce DESLIGADO (`sppl_motor_ativo`). `simular()` só conta, nunca escreve. Idempotente: o índice único (pedido+categoria, só abertas) impede duplicata.
 *
 * Etapas do PDF:
 *   1  sem_codigo_rastreio    pedido 'pending' sem código, `dias` úteis depois da compra
 *   2  etiqueta_sem_coleta    17TRACK em InfoReceived (etiqueta criada, sem coleta), `dias` úteis depois da etiqueta
 *   3  sem_movimento_5/10/15d 17TRACK em trânsito sem evento novo há `dias` dias corridos (subir de nível encerra o anterior)
 *   4  por status (imediato)  Exception / DeliveryFailure / alfândega etc. — abre assim que o status chega, sem esperar prazos
 *   5  fechamento             entregue, cancelado, reembolsado ou chargeback encerram as ocorrências abertas
 * Fora de escopo aqui: contato com o cliente e cobrança (outras subtarefas); só registramos a ocorrência, o dono, a prioridade e o prazo.
 */
import { query, pool } from '../../server/db.js';

const num = (v, p) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : p; };

export async function configMotor() {
  const { rows } = await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'sppl_motor_%' OR chave IN ('sppl_sorteio_ativo', 'sppl_cards_ativo')`);
  const c = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  return {
    ativo: c.sppl_motor_ativo === 'true', maxNovas: Math.min(num(c.sppl_motor_max_novas_por_rodada, 200), 5000),
    sorteio: c.sppl_sorteio_ativo === 'true', cards: c.sppl_cards_ativo === 'true',
  };
}

/** Pedido que não deve gerar ocorrência: reembolso, chargeback, cancelado. */
const FORA = `NOT EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE d.transacao_id = p.transacao_id AND (d.reembolsado_em IS NOT NULL OR d.chargeback_em IS NOT NULL))
              AND p.status_interno <> 'cancelled'`;

/** Candidatos de cada regra, já com o prazo calculado. Cada linha: pedido, número, regra e quando venceu. */
const CONSULTAS = {
  // Etapa 1 — pedido pendente sem código, X dias úteis depois da compra
  sem_codigo_rastreio: (r) => `
    SELECT p.transacao_id, NULL::text AS numero, ${r.id}::int AS regra_id, NULL::text AS status_17t, NULL::text AS substatus_17t
      FROM rastreio_pedidos p
     WHERE p.status_interno = 'pending' AND coalesce(p.tracking_number, '') = '' AND p.order_created_at IS NOT NULL
       AND ${FORA}
       AND sppl_somar_dias_uteis(p.order_created_at, ${r.dias_uteis ? Number(r.dias) : 0}) <= now()`,
  // Etapa 2 — etiqueta criada, sem coleta
  etiqueta_sem_coleta: (r) => `
    SELECT DISTINCT ON (p.transacao_id) p.transacao_id, g.numero AS numero, ${r.id}::int AS regra_id, g.ultimo_status AS status_17t, g.ultimo_substatus AS substatus_17t
      FROM rastreio_pedidos p JOIN rastreio_17t_registros g ON g.numero = p.tracking_number
      JOIN LATERAL (SELECT min(ocorreu_em) AS etiqueta_em FROM rastreio_17t_eventos e WHERE e.numero = g.numero AND e.status = 'InfoReceived') ev ON true
     WHERE g.ultimo_status = 'InfoReceived' AND ev.etiqueta_em IS NOT NULL AND ${FORA}
       AND sppl_somar_dias_uteis(ev.etiqueta_em, ${r.dias_uteis ? Number(r.dias) : 0}) <= now()
     ORDER BY p.transacao_id`,
  // Etapa 3 — em trânsito sem evento novo há X dias (corridos ou úteis, conforme a regra)
  sem_movimento: (r) => `
    SELECT DISTINCT ON (p.transacao_id) p.transacao_id, g.numero AS numero, ${r.id}::int AS regra_id, g.ultimo_status AS status_17t, g.ultimo_substatus AS substatus_17t
      FROM rastreio_pedidos p JOIN rastreio_17t_registros g ON g.numero = p.tracking_number
     WHERE g.ultimo_status = 'InTransit' AND g.ultimo_evento_em IS NOT NULL AND ${FORA}
       AND ${r.dias_uteis ? `sppl_somar_dias_uteis(g.ultimo_evento_em, ${Number(r.dias)})` : `g.ultimo_evento_em + interval '${Number(r.dias)} days'`} <= now()
     ORDER BY p.transacao_id`,
  // Etapa 4 — status que exige ação imediata
  status_imediato: (r) => `
    SELECT DISTINCT ON (p.transacao_id) p.transacao_id, g.numero AS numero, ${r.id}::int AS regra_id, g.ultimo_status AS status_17t, g.ultimo_substatus AS substatus_17t
      FROM rastreio_pedidos p JOIN rastreio_17t_registros g ON g.numero = p.tracking_number
     WHERE g.ultimo_status = '${String(r.status_17t).replace(/'/g, "''")}'
       ${r.substatus_17t ? `AND g.ultimo_substatus = '${String(r.substatus_17t).replace(/'/g, "''")}'` : ''}
       AND ${FORA}
     ORDER BY p.transacao_id`,
};

function consultaDaRegra(r) {
  if (r.origem === 'tempo' && r.categoria === 'sem_codigo_rastreio') return CONSULTAS.sem_codigo_rastreio(r);
  if (r.origem === 'tempo' && r.categoria === 'etiqueta_sem_coleta') return CONSULTAS.etiqueta_sem_coleta(r);
  if (r.origem === 'tempo' && r.categoria.startsWith('sem_movimento_')) return CONSULTAS.sem_movimento(r);
  // Regras por status só ABREM ocorrência se imediatas e com ação (as outras são informativas ou vêm das regras de tempo).
  if (r.origem === 'status_17t' && r.imediato && r.acao && r.status_17t) return CONSULTAS.status_imediato(r);
  return null;
}

/** Não reabre o que já existe: ocorrência aberta da mesma categoria, ou encerrada com o MESMO status (ex.: 5 dias encerrado por escalada). */
const JA_EXISTE = (cat) => `EXISTS (SELECT 1 FROM sppl_ocorrencias o WHERE o.transacao_id = x.transacao_id AND o.categoria = '${String(cat).replace(/'/g, "''")}'
      AND (o.situacao NOT IN ('resolvida','cancelada') OR (o.status_17t IS NOT DISTINCT FROM x.status_17t AND o.substatus_17t IS NOT DISTINCT FROM x.substatus_17t)))`;

async function regrasAtivas() {
  const { rows } = await query(`SELECT * FROM sppl_regras WHERE ativa AND origem <> 'sem_dado' ORDER BY ordem, id`);
  return rows;
}

/** Quantas ocorrências cada regra abriria agora (sem escrever). */
export async function simular() {
  const resumo = [];
  for (const r of await regrasAtivas()) {
    const sql = consultaDaRegra(r);
    if (!sql) continue;
    const { rows } = await query(`SELECT count(*)::int AS n FROM (${sql}) x WHERE NOT ${JA_EXISTE(r.categoria)}`);
    resumo.push({ regra_id: r.id, categoria: r.categoria, titulo: r.titulo, abriria: rows[0].n });
  }
  return resumo;
}

/** Abre as ocorrências que venceram. Devolve quantas abriu por categoria. `maxNovas` limita o total da rodada (mais antigas primeiro por ordem de regra). */
export async function abrir({ maxNovas = 200 } = {}) {
  const abertas = {}; let restante = maxNovas;
  for (const r of await regrasAtivas()) {
    if (restante <= 0) break;
    const sql = consultaDaRegra(r);
    if (!sql) continue;
    const prazo = r.prazo_resolucao_dias != null ? `sppl_somar_dias_uteis(now(), ${Number(r.prazo_resolucao_dias)})` : 'NULL';
    const { rows } = await query(
      `INSERT INTO sppl_ocorrencias (transacao_id, numero, regra_id, categoria, etapa, status_17t, substatus_17t, prioridade, responsavel, proxima_acao, prazo_ate)
       SELECT x.transacao_id, x.numero, x.regra_id, $1, $2, x.status_17t, x.substatus_17t, $3, $4, $5, ${prazo}
         FROM (${sql}) x
        WHERE NOT ${JA_EXISTE(r.categoria)}
        LIMIT $6
       ON CONFLICT DO NOTHING RETURNING id, transacao_id`,
      [r.categoria, r.etapa, r.prioridade, r.responsavel, r.acao, restante]);
    if (rows.length) {
      abertas[r.categoria] = (abertas[r.categoria] ?? 0) + rows.length; restante -= rows.length;
      // subir de nível (5d → 10d → 15d) encerra o nível anterior do mesmo pedido
      if (r.categoria === 'sem_movimento_10d' || r.categoria === 'sem_movimento_15d') {
        const anteriores = r.categoria === 'sem_movimento_10d' ? ['sem_movimento_5d'] : ['sem_movimento_5d', 'sem_movimento_10d'];
        await query(`UPDATE sppl_ocorrencias SET situacao = 'resolvida', resolvida_em = now(), resultado = $3, atualizado_em = now()
                      WHERE transacao_id = ANY($1::text[]) AND categoria = ANY($2::text[]) AND situacao NOT IN ('resolvida','cancelada')`,
          [rows.map((x) => x.transacao_id), anteriores, `Escalada para ${r.categoria}`]);
      }
    }
  }
  return abertas;
}

/** Fecha o que deixou de valer: entregue, cancelado, reembolsado ou chargeback. Devolve quantas fechou. */
export async function fechar() {
  const { rowCount } = await query(
    `UPDATE sppl_ocorrencias o SET situacao = CASE WHEN x.motivo = 'entregue' THEN 'resolvida' ELSE 'cancelada' END,
            resolvida_em = now(), atualizado_em = now(),
            resultado = coalesce(o.resultado, CASE x.motivo WHEN 'entregue' THEN 'Pedido entregue' WHEN 'cancelado' THEN 'Pedido cancelado' ELSE 'Pedido reembolsado ou em chargeback' END)
       FROM (SELECT p.transacao_id,
                    CASE WHEN EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE d.transacao_id = p.transacao_id AND (d.reembolsado_em IS NOT NULL OR d.chargeback_em IS NOT NULL)) THEN 'reembolso'
                         WHEN p.status_interno = 'cancelled' THEN 'cancelado'
                         WHEN p.status_interno = 'delivered' OR EXISTS (SELECT 1 FROM rastreio_17t_registros g WHERE g.numero = p.tracking_number AND g.ultimo_status = 'Delivered') THEN 'entregue' END AS motivo
               FROM rastreio_pedidos p) x
      WHERE o.transacao_id = x.transacao_id AND x.motivo IS NOT NULL AND o.situacao NOT IN ('resolvida','cancelada')
        AND NOT (o.categoria = 'entregue_contestado')`);
  return rowCount;
}

/**
 * Dá dono às ocorrências abertas que ainda têm o responsável GENÉRICO da regra (ninguém mexeu) e nenhum board. Sorteio ponderado
 * (email_ia.sppl_escolher_board, migração 092). Sem board elegível, deixa como está. Uma por vez: o peso depende de quantas o agente já tem.
 */
export async function atribuir({ limite = 500 } = {}) {
  const { rows } = await query(
    `SELECT o.id, o.transacao_id FROM sppl_ocorrencias o JOIN sppl_regras g ON g.id = o.regra_id
      WHERE o.board_id IS NULL AND o.situacao NOT IN ('resolvida','cancelada') AND o.responsavel IS NOT DISTINCT FROM g.responsavel
      ORDER BY o.prioridade, o.aberta_em LIMIT $1`, [limite]);
  let n = 0;
  for (const { id, transacao_id } of rows) {
    // dono do lead de e-mail (se o cliente já tem card no Suporte Escalado); sem card, sorteio ponderado (migração 095)
    const b = (await query('SELECT email_ia.sppl_escolher_board_para($1) AS board_id', [transacao_id])).rows[0].board_id;
    if (!b) break;   // ninguém elegível: não adianta tentar as outras
    const r = await query(
      // $2::bigint nos DOIS usos: em produção suporte_escalado_boards.id é bigint e sppl_ocorrencias.board_id é integer — sem o cast o Postgres
      // deduz dois tipos para o mesmo parâmetro ("inconsistent types deduced for parameter $2") e o sorteio falha (12/10/2026).
      `UPDATE sppl_ocorrencias o SET board_id = $2::bigint, atualizado_em = now(),
              responsavel = coalesce((SELECT nome FROM email_ia.suporte_escalado_boards WHERE id = $2::bigint), o.responsavel)
        WHERE o.id = $1 AND o.board_id IS NULL`, [id, b]);
    n += r.rowCount;
  }
  return n;
}

/** Abre o card do cliente no Suporte Escalado para ocorrência que exige contato (regra com contata_cliente) e ainda sem card. */
export async function abrirCards({ limite = 100 } = {}) {
  const { rows } = await query(
    `SELECT o.id FROM sppl_ocorrencias o JOIN sppl_regras g ON g.id = o.regra_id
      WHERE g.contata_cliente AND o.caso_id IS NULL AND o.board_id IS NOT NULL AND o.situacao NOT IN ('resolvida','cancelada')
      ORDER BY o.prioridade, o.aberta_em LIMIT $1`, [limite]);
  let n = 0;
  for (const { id } of rows) { const r = await query('SELECT public.sppl_abrir_card($1) AS caso', [id]); if (r.rows[0].caso) n++; }
  return n;
}

/**
 * Resolve sozinho o alerta cuja CONDIÇÃO deixou de valer: o pedido ganhou código de rastreio, a etiqueta foi coletada, o pacote voltou a se mover, saiu da exceção.
 * (`fechar()` só cuida de entregue/cancelado/reembolso; sem isto o time trabalharia alerta velho.) Reavalia a mesma consulta que abriu o alerta: se o pedido
 * não aparece mais nela, o alerta é resolvido com o motivo no resultado. Só mexe em categorias com ao menos uma regra ATIVA e que tenham condição calculável
 * (entregue_contestado, por exemplo, vem do ticket do cliente e nunca fecha por aqui). Teto de 500 por rodada, por segurança.
 */
/** Categorias cujo alerta NÃO nasce destas consultas (vem do ticket do cliente): nunca fecham por "condição superada". */
const CATEGORIAS_SEM_CONDICAO_CALCULAVEL = ['entregue_contestado'];

export async function resolverSuperadas({ teto = 500 } = {}) {
  const porCategoria = new Map();
  for (const r of await regrasAtivas()) {
    if (CATEGORIAS_SEM_CONDICAO_CALCULAVEL.includes(r.categoria)) continue;
    const sql = consultaDaRegra(r);
    if (!sql) continue;
    if (!porCategoria.has(r.categoria)) porCategoria.set(r.categoria, []);
    porCategoria.get(r.categoria).push(sql);
  }
  let total = 0; const erros = [];
  for (const [categoria, sqls] of porCategoria) {
    if (total >= teto) break;
    // cada consulta vai isolada num subselect: elas terminam em ORDER BY, e UNION ALL direto entre elas seria SQL inválido nas categorias com várias regras
    const uniao = sqls.map((q) => `SELECT q.transacao_id FROM (${q}) q`).join('\n UNION ALL \n');
    try {
      const { rowCount } = await query(
        `UPDATE sppl_ocorrencias o SET situacao = 'resolvida', resolvida_em = now(), atualizado_em = now(),
                resultado = coalesce(nullif(o.resultado, ''), 'Resolvida automaticamente: a condição do alerta deixou de valer.')
          WHERE o.id IN (SELECT o2.id FROM sppl_ocorrencias o2
                          WHERE o2.categoria = $1 AND o2.situacao NOT IN ('resolvida','cancelada')
                            AND NOT EXISTS (SELECT 1 FROM (${uniao}) x WHERE x.transacao_id = o2.transacao_id)
                          LIMIT $2)`, [categoria, teto - total]);
      total += rowCount;
    } catch (e) { erros.push(`${categoria}: ${e.message}`); }   // uma categoria com problema não derruba as outras
  }
  if (erros.length) throw Object.assign(new Error(erros.join(' | ')), { parcial: total });
  return total;
}

/** Uma rodada completa (usada pelo agendador). */
export async function rodar({ forcar = false, log = () => {} } = {}) {
  const cfg = await configMotor();
  if (!cfg.ativo && !forcar) return { rodou: false, motivo: 'desligado' };
  const fechadas = await fechar();
  const superadas = await resolverSuperadas().catch((e) => { log(`SPPL: fechamento por condição falhou: ${e.message}`); return e.parcial ?? 0; });
  const abertas = await abrir({ maxNovas: cfg.maxNovas });
  const atribuidas = cfg.sorteio ? await atribuir().catch((e) => { log(`SPPL: sorteio falhou: ${e.message}`); return 0; }) : 0;
  const cards = cfg.cards ? await abrirCards().catch((e) => { log(`SPPL: card falhou: ${e.message}`); return 0; }) : 0;
  const total = Object.values(abertas).reduce((a, b) => a + b, 0);
  if (total || fechadas || superadas || atribuidas || cards) log(`SPPL: ${total} ocorrências abertas, ${fechadas} fechadas, ${superadas} resolvidas por condição superada, ${atribuidas} com responsável sorteado, ${cards} cards`);
  return { rodou: true, abertas, fechadas, superadas, atribuidas, cards };
}
void pool;
