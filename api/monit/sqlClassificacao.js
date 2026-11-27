/**
 * MONIT-SPPL — o SQL que classifica TODOS os pedidos em aberto (seções 4 e 5 da especificação) e grava o resultado em `monit_pedidos` (migração 142).
 *
 * Por que materializar: a classificação lê os eventos do 17Track de ~20 mil pedidos e aplica 14 regex a cada um; ao vivo passa de vários segundos.
 * O job do servidor (`api/monit/atualizar.js`) refaz a tabela a cada 10 min (e no botão "Atualizar"), e a tela mostra a hora real da leitura.
 *
 * As 14 regras de texto vêm de `classes.js` (fonte única, a mesma da ficha do pedido). `$1` = data de corte da tabela (pedidos mais antigos não entram).
 * Sem `\s`/`\d` em regex: dentro de template string do JS a contrabarra se perde em silêncio.
 */
import { REGEX_DA_REGRA, CLASSES_CAUSA, CAUSAS_DEVOLUCAO_ENDERECO, CAUSAS_DEVOLUCAO_CLIENTE } from './classes.js';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lista = (a) => a.map(lit).join(', ');

/** CASE das 14 regras sobre uma expressão de texto (a primeira que casar vence). */
export const casoDeTexto = (expr) =>
  `CASE ${REGEX_DA_REGRA.map((r) => `WHEN ${expr} ~* ${lit(r.fonte)} THEN ${lit(r.classe)}`).join(' ')} END`;

const EV_COMPRA = `('RFND', 'refund', 'sale.refunded')`;
const EV_CB = `('chargeback', 'sale.chargeback')`;
/** "N Bottles" no texto do produto, senão o número no início; sem nenhum, 1 unidade. */
const QTD = (c) => `coalesce((regexp_match(${c}, '([0-9]+)[[:space:]]*bottles?', 'i'))[1], (regexp_match(${c}, '^[[:space:]]*([0-9]+)'))[1], '1')::int`;

export const SQL_CLASSIFICAR = `
WITH base0 AS (
  SELECT p.transacao_id, p.order_number,
         coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido,
         coalesce(p.order_created_at, dv.criado_em) AS data_pedido,
         coalesce(p.provedor, 'sem fulfillment') AS fulfillment,
         p.status_interno, p.tracking_number, p.carrier_code, p.tracking_url, p.tracking_status, p.tracking, p.shipped_at,
         p.endereco_entrega, p.total, p.currency, p.transferido_redrock_em,
         dv.criado_em AS criado_dv, dv.reembolsado_em, dv.chargeback_em, dv.plataforma AS plataforma_dv,
         coalesce(nullif(dv.email, ''), c1.email) AS email0, coalesce(nullif(dv.nome, ''), c1.nome) AS nome0,
         coalesce(nullif(dv.produto, ''), c1.produto) AS produto_principal,
         coalesce(nullif(btrim(dv.plataforma), ''), nullif(btrim(c1.plataforma), '')) AS plataforma,
         g.numero AS numero_17t, g.ultimo_status, g.ultimo_substatus,
         coalesce(p.tracking_status ~* 'original sender|returned to sender' OR g.ultimo_substatus IN ('Exception_Returned', 'Exception_Returning'), false) AS devolvido
    FROM rastreio_pedidos p
    LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
    LEFT JOIN rastreio_17t_registros g ON g.numero = p.tracking_number AND g.situacao_registro = 'aceito'
    LEFT JOIN LATERAL (SELECT cu.email, cu.nome, cu.produto, cu.plataforma FROM compras_upsell_downsell cu
                        WHERE cu.transacao_id = p.transacao_id ORDER BY (nullif(cu.email, '') IS NULL), cu.criado_em LIMIT 1) c1 ON true
   WHERE coalesce(p.order_created_at, dv.criado_em) >= $1::timestamptz
     AND p.status_interno <> 'cancelled'
     AND coalesce(p.tracking_number, '') <> ''
), om AS MATERIALIZED (   -- e-mail/nome de OUTRO pedido com o mesmo order_number (desde 2026-09-01), só para quem ficou sem e-mail
  SELECT p2.order_number, p2.transacao_id, d2.email, d2.nome FROM rastreio_pedidos p2 JOIN disparos_pos_venda d2 ON d2.transacao_id = p2.transacao_id
   WHERE p2.order_created_at >= '2026-09-01' AND nullif(d2.email, '') IS NOT NULL
     AND p2.order_number IN (SELECT order_number FROM base0 WHERE email0 IS NULL AND nullif(order_number, '') IS NOT NULL)
), base AS (
  SELECT b0.*, coalesce(b0.email0, o.email) AS email, coalesce(b0.nome0, o.nome) AS nome
    FROM base0 b0
    LEFT JOIN LATERAL (SELECT om.email, om.nome FROM om WHERE b0.email0 IS NULL AND om.order_number = b0.order_number AND om.transacao_id <> b0.transacao_id LIMIT 1) o ON true
), aberto AS (
  SELECT * FROM base
   WHERE NOT (status_interno = 'delivered' OR coalesce(ultimo_status, '') = 'Delivered') OR devolvido   -- coalesce: sem registro no 17Track o status é NULL e o NOT daria NULL (o pedido sumiria)
), ev AS (
  SELECT e.numero, e.ocorreu_em, e.provedor_17t, split_part(e.descricao, ' -> ', 1) AS texto,
         ${casoDeTexto("split_part(e.descricao, ' -> ', 1)")} AS classe,
         coalesce(e.status, split_part(e.substatus, '_', 1)) AS st
    FROM rastreio_17t_eventos e
   WHERE e.numero IN (SELECT numero_17t FROM aberto WHERE numero_17t IS NOT NULL)
), atual AS (
  SELECT DISTINCT ON (numero) numero, ocorreu_em, texto, classe FROM ev WHERE classe IS NOT NULL ORDER BY numero, ocorreu_em DESC NULLS LAST
), causa AS (
  SELECT DISTINCT ON (numero) numero, classe FROM ev WHERE classe IN (${lista(CLASSES_CAUSA)}) ORDER BY numero, ocorreu_em DESC NULLS LAST
), agg AS (
  SELECT numero, max(ocorreu_em) FILTER (WHERE st NOT IN ('InfoReceived', 'NotFound')) AS mov_real,
         min(ocorreu_em) FILTER (WHERE st = 'InfoReceived') AS etiqueta_em,
         (array_agg(provedor_17t ORDER BY ocorreu_em DESC NULLS LAST) FILTER (WHERE provedor_17t IS NOT NULL))[1] AS provedor
    FROM ev GROUP BY numero
), evt AS (   -- eventos de plataforma por transação (filtro de reembolso: sem data; rótulo: só a partir de 2026-09-01)
  SELECT transacao_id,
         bool_or(evento IN ${EV_CB}) AS cb_qualquer, bool_or(evento IN ${EV_COMPRA}) AS rf_qualquer,
         bool_or(evento IN ${EV_CB} AND recebido_em >= '2026-09-01') AS cb_rotulo, bool_or(evento IN ${EV_COMPRA} AND recebido_em >= '2026-09-01') AS rf_rotulo
    FROM eventos_plataforma
   WHERE (evento IN ${EV_CB} OR evento IN ${EV_COMPRA})
     AND transacao_id IN (SELECT transacao_id FROM aberto)
   GROUP BY transacao_id
), evm AS (   -- reembolso/chargeback do MESMO e-mail (rótulo "Em outra compra do cliente")
  SELECT lower(email) AS em, max(recebido_em) AS ultimo FROM eventos_plataforma
   WHERE recebido_em >= '2026-09-01' AND (evento IN ${EV_CB} OR evento IN ${EV_COMPRA}) AND email IS NOT NULL GROUP BY 1
), j AS (
  SELECT b.*, a.ocorreu_em AS a_em, a.texto AS a_texto, a.classe AS a_classe, c.classe AS c_classe,
         ag.mov_real, ag.etiqueta_em, ag.provedor,
         (a.classe IN ('atraso_transportadora', 'ausente') AND ag.mov_real > a.ocorreu_em + interval '1 day') AS descartado,
         -- códigos que o 17Track não lê: texto = parte de tracking_status antes de "|"; data = "| MM/DD/AAAA"
         btrim(split_part(b.tracking_status, '|', 1)) AS texto_nl,
         monit_data_us((regexp_match(b.tracking_status, '[|][[:space:]]*([0-9]{1,2}/[0-9]{1,2}/[0-9]{4})'))[1]) AS data_nl
    FROM aberto b
    LEFT JOIN atual a ON a.numero = b.numero_17t
    LEFT JOIN causa c ON c.numero = b.numero_17t
    LEFT JOIN agg ag ON ag.numero = b.numero_17t
), k AS (
  SELECT j.*, CASE WHEN j.numero_17t IS NULL THEN ${casoDeTexto('j.texto_nl')} ELSE CASE WHEN j.descartado THEN NULL ELSE j.a_classe END END AS e_classe
    FROM j
), f AS (
  SELECT k.*,
         CASE
           WHEN k.e_classe = 'entregue' THEN 'entregue_nao_baixado'
           WHEN k.numero_17t IS NULL AND k.e_classe IS NULL THEN 'codigo_nao_rastreavel'
           WHEN k.numero_17t IS NULL THEN k.e_classe
           WHEN k.e_classe IN ('devolvido', 'em_devolucao') AND k.c_classe IN (${lista(CAUSAS_DEVOLUCAO_ENDERECO)}) THEN 'devolucao_endereco'
           WHEN k.e_classe IN ('devolvido', 'em_devolucao') AND k.c_classe IN (${lista(CAUSAS_DEVOLUCAO_CLIENTE)}) THEN 'devolucao_cliente'
           WHEN k.e_classe IS NOT NULL THEN k.e_classe
           WHEN k.mov_real IS NULL THEN CASE WHEN sppl_somar_dias_uteis(coalesce(k.etiqueta_em, k.shipped_at, k.data_pedido), 2) <= now() THEN 'aguardando_coleta' ELSE 'aguardando_coleta_ok' END
           WHEN k.mov_real <= now() - interval '5 days' THEN 'parado_sem_aviso'
           ELSE 'transito_normal'
         END AS classe_final
    FROM k
)
INSERT INTO monit_pedidos (transacao_id, pedido, email_cliente, nome_cliente, classe, grupo, causa, texto_transportadora, evento_em, dias_desde_evento, fulfillment, transportadora,
                           rastreio, qtd_rastreios, outros_rastreios, transferido, link_rastreio, endereco, produtos, quantidade, valor, moeda, data_pedido, idade_dias,
                           ultima_movimentacao, dias_sem_movimentacao, plataforma, reembolso_cb, reemb, tem_17t, ultimo_status, status_interno, calculado_em)
SELECT f.transacao_id, f.pedido, f.email, f.nome, f.classe_final,
       CASE WHEN f.classe_final IN ('aguardando_coleta_ok', 'transito_normal', 'entregue_nao_baixado') THEN 'ok'
            WHEN f.classe_final IN ('aguardando_coleta', 'codigo_nao_rastreavel', 'parado_sem_aviso', 'atraso_transportadora', 'avaria', 'etiqueta_cancelada') THEN 'logistica'
            WHEN f.classe_final IN ('em_devolucao', 'devolvido') THEN 'devolucao'
            ELSE 'cliente' END,
       CASE WHEN f.numero_17t IS NULL THEN NULL ELSE f.c_classe END,
       left(regexp_replace(CASE WHEN f.numero_17t IS NULL THEN f.texto_nl WHEN f.descartado THEN NULL ELSE f.a_texto END, '[.]?[[:space:]]*For Delivery Issues.*$', '', 'i'), 160),
       ev_data.d, floor(extract(epoch FROM (now() - ev_data.d)) / 86400)::int,
       f.fulfillment, coalesce(f.provedor, f.carrier_code), f.tracking_number,
       rs.qtd, rs.outros, (f.transferido_redrock_em IS NOT NULL),
       coalesce(nullif(f.tracking_url, ''), 'https://t.17track.net/pt#nums=' || f.tracking_number),
       f.endereco_entrega,
       coalesce(f.produto_principal, '') || coalesce(' + ' || up.itens, ''),
       coalesce(CASE WHEN f.produto_principal IS NOT NULL THEN ${QTD('f.produto_principal')} END, 0) + coalesce(up.qtd, 0),
       f.total, f.currency, f.data_pedido, floor(extract(epoch FROM (now() - f.data_pedido)) / 86400)::int,
       f.mov_real, CASE WHEN f.mov_real IS NOT NULL THEN floor(extract(epoch FROM (now() - f.mov_real)) / 86400)::int END,
       f.plataforma,
       CASE WHEN f.chargeback_em IS NOT NULL OR coalesce(t.cb_rotulo, false) THEN 'Chargeback'
            WHEN f.reembolsado_em IS NOT NULL OR coalesce(t.rf_rotulo, false) THEN 'Reembolso'
            WHEN f.criado_dv IS NOT NULL AND f.email IS NOT NULL AND m.ultimo >= f.criado_dv - interval '1 hour' THEN 'Em outra compra do cliente'
            ELSE 'Não' END,
       (f.reembolsado_em IS NOT NULL OR f.chargeback_em IS NOT NULL OR coalesce(t.cb_qualquer, false) OR coalesce(t.rf_qualquer, false)),
       (f.numero_17t IS NOT NULL), f.ultimo_status, f.status_interno, now()
  FROM f
  LEFT JOIN evt t ON t.transacao_id = f.transacao_id
  LEFT JOIN evm m ON m.em = lower(f.email)
  CROSS JOIN LATERAL (SELECT CASE WHEN f.numero_17t IS NULL THEN coalesce(f.data_nl, f.data_pedido)
                                  WHEN f.classe_final IN ('transito_normal', 'parado_sem_aviso') THEN coalesce(f.mov_real, f.data_pedido)
                                  WHEN f.e_classe IS NOT NULL THEN coalesce(f.a_em, f.data_pedido)
                                  ELSE coalesce(f.etiqueta_em, f.shipped_at, f.data_pedido) END AS d) ev_data
  LEFT JOIN LATERAL (SELECT string_agg(cu.produto, ' + ' ORDER BY cu.criado_em) AS itens, sum(${QTD('cu.produto')})::int AS qtd
                       FROM compras_upsell_downsell cu
                      WHERE f.email IS NOT NULL AND lower(cu.email) = lower(f.email) AND cu.transacao_id <> f.transacao_id
                        AND cu.criado_em BETWEEN f.data_pedido - interval '5 minutes' AND f.data_pedido + interval '2 hours'
                        AND cu.reembolsado_em IS NULL AND cu.chargeback_em IS NULL) up ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS qtd,
           string_agg(x.n || ' · ' || coalesce(x.carrier, '') || ' · ' || coalesce(x.st17, 'sem 17Track'), ', ' ORDER BY x.n) FILTER (WHERE x.n <> f.tracking_number) AS outros
      FROM (SELECT DISTINCT ON (u.n) u.n, u.carrier, r.ultimo_status AS st17
              FROM (SELECT f.tracking_number AS n, f.carrier_code AS carrier
                    UNION ALL
                    SELECT t2->>'tracking_number', t2->>'carrier_code'
                      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.tracking) = 'array' THEN f.tracking ELSE '[]'::jsonb END) t2) u
              LEFT JOIN rastreio_17t_registros r ON r.numero = u.n AND r.situacao_registro = 'aceito'
             WHERE coalesce(u.n, '') <> '' ORDER BY u.n) x) rs ON true
`;

/**
 * Pedidos SEM RASTREIO (seção 6): em aberto, sem código de rastreio, fora de cancelled/delivered. Três classes, só por idade e status interno.
 * Os dias úteis usam monit_dias_uteis (America/New_York, o mesmo fuso de sppl_somar_dias_uteis). `$1` = corte, como em SQL_CLASSIFICAR.
 */
export const SQL_SEM_RASTREIO = `
WITH b AS (
  SELECT p.transacao_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS pedido, coalesce(p.order_created_at, dv.criado_em, p.criado_em) AS data_pedido,
         coalesce(p.provedor, 'sem fulfillment') AS fulfillment, p.status_interno, p.endereco_entrega, p.total, p.currency, p.transferido_redrock_em,
         dv.criado_em AS criado_dv, dv.reembolsado_em, dv.chargeback_em,
         coalesce(nullif(dv.email, ''), c1.email) AS email, coalesce(nullif(dv.nome, ''), c1.nome) AS nome,
         coalesce(nullif(dv.produto, ''), c1.produto) AS produto_principal,
         coalesce(nullif(btrim(dv.plataforma), ''), nullif(btrim(c1.plataforma), '')) AS plataforma
    FROM rastreio_pedidos p
    LEFT JOIN disparos_pos_venda dv ON dv.transacao_id = p.transacao_id
    LEFT JOIN LATERAL (SELECT cu.email, cu.nome, cu.produto, cu.plataforma FROM compras_upsell_downsell cu
                        WHERE cu.transacao_id = p.transacao_id ORDER BY (nullif(cu.email, '') IS NULL), cu.criado_em LIMIT 1) c1 ON true
   WHERE coalesce(p.order_created_at, dv.criado_em, p.criado_em) >= $1::timestamptz
     AND p.status_interno NOT IN ('cancelled', 'delivered')
     AND coalesce(p.tracking_number, '') = ''
), evt AS (
  SELECT transacao_id,
         bool_or(evento IN ${EV_CB}) AS cb_qualquer, bool_or(evento IN ${EV_COMPRA}) AS rf_qualquer,
         bool_or(evento IN ${EV_CB} AND recebido_em >= '2026-09-01') AS cb_rotulo, bool_or(evento IN ${EV_COMPRA} AND recebido_em >= '2026-09-01') AS rf_rotulo
    FROM eventos_plataforma
   WHERE (evento IN ${EV_CB} OR evento IN ${EV_COMPRA}) AND transacao_id IN (SELECT transacao_id FROM b)
   GROUP BY transacao_id
), evm AS (
  SELECT lower(email) AS em, max(recebido_em) AS ultimo FROM eventos_plataforma
   WHERE recebido_em >= '2026-09-01' AND (evento IN ${EV_CB} OR evento IN ${EV_COMPRA}) AND email IS NOT NULL GROUP BY 1
), c AS (
  SELECT b.*, CASE WHEN b.status_interno = 'nao_encontrado' THEN 'nao_encontrado'
                   WHEN sppl_somar_dias_uteis(b.data_pedido, 2) <= now() THEN 'sem_codigo_atrasado' ELSE 'aguardando_codigo' END AS classe_final
    FROM b
)
INSERT INTO monit_pedidos (transacao_id, pedido, email_cliente, nome_cliente, classe, grupo, texto_transportadora, evento_em, dias_desde_evento, dias_uteis, fulfillment,
                           qtd_rastreios, transferido, endereco, produtos, quantidade, valor, moeda, data_pedido, idade_dias, plataforma, reembolso_cb, reemb, tem_17t,
                           status_interno, calculado_em)
SELECT c.transacao_id, c.pedido, c.email, c.nome, c.classe_final, 'semrastreio',
       CASE WHEN c.classe_final = 'nao_encontrado' THEN 'Pedido não encontrado em nenhuma fulfillment' ELSE 'Pendente na fulfillment, sem código de rastreio' END,
       c.data_pedido, monit_dias_uteis(c.data_pedido, now()), monit_dias_uteis(c.data_pedido, now()), c.fulfillment, 0, (c.transferido_redrock_em IS NOT NULL), c.endereco_entrega,
       coalesce(c.produto_principal, '') || coalesce(' + ' || up.itens, ''),
       coalesce(CASE WHEN c.produto_principal IS NOT NULL THEN ${QTD('c.produto_principal')} END, 0) + coalesce(up.qtd, 0),
       c.total, c.currency, c.data_pedido, floor(extract(epoch FROM (now() - c.data_pedido)) / 86400)::int, c.plataforma,
       CASE WHEN c.chargeback_em IS NOT NULL OR coalesce(t.cb_rotulo, false) THEN 'Chargeback'
            WHEN c.reembolsado_em IS NOT NULL OR coalesce(t.rf_rotulo, false) THEN 'Reembolso'
            WHEN c.criado_dv IS NOT NULL AND c.email IS NOT NULL AND m.ultimo >= c.criado_dv - interval '1 hour' THEN 'Em outra compra do cliente'
            ELSE 'Não' END,
       (c.reembolsado_em IS NOT NULL OR c.chargeback_em IS NOT NULL OR coalesce(t.cb_qualquer, false) OR coalesce(t.rf_qualquer, false)),
       false, c.status_interno, now()
  FROM c
  LEFT JOIN evt t ON t.transacao_id = c.transacao_id
  LEFT JOIN evm m ON m.em = lower(c.email)
  LEFT JOIN LATERAL (SELECT string_agg(cu.produto, ' + ' ORDER BY cu.criado_em) AS itens, sum(${QTD('cu.produto')})::int AS qtd
                       FROM compras_upsell_downsell cu
                      WHERE c.email IS NOT NULL AND lower(cu.email) = lower(c.email) AND cu.transacao_id <> c.transacao_id
                        AND cu.criado_em BETWEEN c.data_pedido - interval '5 minutes' AND c.data_pedido + interval '2 hours'
                        AND cu.reembolsado_em IS NULL AND cu.chargeback_em IS NULL) up ON true
`;
