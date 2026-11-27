/**
 * SPPL / Suporte Humano — consultas COMPARTILHADAS do "Novo ticket" (Suporte Ativo e Suporte Humano): assinatura padrão, alerta de contato duplicado
 * (envios e tickets do Suporte Ativo) e busca de pedidos por e-mail/número. Extraído de api/rotas/spplAtivo.js (sem mudar o comportamento) para os dois reaproveitarem.
 */
import { query } from '../../server/db.js';
import { DIAS_ALERTA_CONTATO, ASSINATURA_PADRAO } from './ativoConstantes.js';

/** Assinatura padrão do e-mail ({assinatura}); configurável na tela (config_disparos.sppl_ativo_assinatura). */
export async function assinaturaAtual() {
  const { rows } = await query(`SELECT valor FROM config_disparos WHERE chave = 'sppl_ativo_assinatura'`);
  return String(rows[0]?.valor ?? '').trim() || ASSINATURA_PADRAO;
}

/**
 * Alerta de CONTATO DUPLICADO (não bloqueia; a equipe decide): envios já feitos/na fila e tickets criados nos últimos DIAS_ALERTA_CONTATO dias para o mesmo
 * e-mail ou pedido. Devolve linhas cruas; `contatosAnteriores` (função pura) filtra por cliente.
 */
export async function buscarContatos(emails, transacoes) {
  const em = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const tr = [...new Set(transacoes.filter(Boolean))];
  if (!em.length && !tr.length) return [];
  const dias = String(DIAS_ALERTA_CONTATO);
  const envios = await query(
    `SELECT lower(v.para_email) AS email, t.transacao_id, t.pedido_transacao_id, 'envio' AS tipo, v.criado_por AS por, coalesce(v.enviado_em, v.criado_em) AS quando,
            v.modelo_nome, v.assunto, v.status, t.id AS ticket_id
       FROM sppl_ativo_envios v JOIN sppl_ativo_tickets t ON t.id = v.ticket_id
      WHERE v.status IN ('enviado', 'fila', 'enviando') AND coalesce(v.enviado_em, v.criado_em) > now() - ($3 || ' days')::interval
        AND (lower(v.para_email) = ANY($1::text[]) OR t.transacao_id = ANY($2::text[]) OR t.pedido_transacao_id = ANY($2::text[]))
      ORDER BY 6 DESC LIMIT 500`, [em, tr, dias]);
  const tickets = await query(
    `SELECT lower(email) AS email, transacao_id, pedido_transacao_id, 'ticket' AS tipo, selecionado_por AS por, selecionado_em AS quando, NULL::text AS modelo_nome, NULL::text AS assunto,
            status_ticket AS status, id AS ticket_id, origem
       FROM sppl_ativo_tickets
      WHERE selecionado_em > now() - ($3 || ' days')::interval
        AND (lower(email) = ANY($1::text[]) OR transacao_id = ANY($2::text[]) OR pedido_transacao_id = ANY($2::text[]))
      ORDER BY selecionado_em DESC LIMIT 500`, [em, tr, dias]);
  return [...envios.rows, ...tickets.rows];
}
/** Só o que a tela precisa de cada contato anterior (sem repetir dados do cliente). */
export const enxutos = (lista) => lista.map((c) => ({ tipo: c.tipo, por: c.por, quando: c.quando, modelo_nome: c.modelo_nome ?? null, assunto: c.assunto ?? null, status: c.status, ticket_id: c.ticket_id, origem: c.origem ?? null }));

/** Pedidos candidatos para as entradas do "Novo ticket": rastreio_pedidos (+ cadastro do cliente em disparos_pos_venda), depois disparos e compras de upsell/downsell sem rastreio. */
export async function buscarPedidosParaAvulso(pedidos, emails) {
  if (!pedidos.length && !emails.length) return [];
  const { rows } = await query(
    `SELECT * FROM (
       SELECT p.transacao_id, coalesce(nullif(p.order_number, ''), p.transacao_id) AS numero_pedido, d.nome, d.email, d.produto, d.plataforma, p.provedor AS fulfillment,
              p.carrier_code, p.tracking_number, p.tracking_url, coalesce(p.order_created_at, d.criado_em, p.criado_em) AS data
         FROM rastreio_pedidos p LEFT JOIN disparos_pos_venda d ON d.transacao_id = p.transacao_id
        WHERE p.transacao_id = ANY($1::text[]) OR p.order_number = ANY($1::text[]) OR lower(d.email) = ANY($2::text[])
       UNION ALL
       SELECT d.transacao_id, d.transacao_id, d.nome, d.email, d.produto, d.plataforma, NULL::text, NULL::text, NULL::text, NULL::text, d.criado_em
         FROM disparos_pos_venda d
        WHERE (d.transacao_id = ANY($1::text[]) OR lower(d.email) = ANY($2::text[])) AND NOT EXISTS (SELECT 1 FROM rastreio_pedidos p WHERE p.transacao_id = d.transacao_id)
       UNION ALL
       SELECT c.transacao_id, c.transacao_id, c.nome, c.email, c.produto, c.plataforma, NULL::text, NULL::text, NULL::text, NULL::text, c.criado_em
         FROM compras_upsell_downsell c
        WHERE (c.transacao_id = ANY($1::text[]) OR lower(c.email) = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM rastreio_pedidos p WHERE p.transacao_id = c.transacao_id) AND NOT EXISTS (SELECT 1 FROM disparos_pos_venda d WHERE d.transacao_id = c.transacao_id)
     ) u ORDER BY data DESC NULLS LAST LIMIT 3000`, [pedidos, emails]);
  return rows;
}
