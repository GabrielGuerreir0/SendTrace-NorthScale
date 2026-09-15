-- ═══════════════════════════════════════════════════════════════════════════
--  029 · Rastreamento de pedidos (Red Rock) — snapshot + histórico
--
--  Pedido do usuário (15/09/2026): saber onde cada pedido está de verdade,
--  com uma linha do tempo. Ver o plano completo em
--  arquivo/Rastreamento de Disparo (plano nao implementado)/PLANO.md.
--
--  Escrita SÓ pelo script de polling (server/rastreio/consultar_redrock.py,
--  acesso direto ao Postgres) — a API do painel (api/rotas/rastreio.js) é
--  só leitura, mesmo isolamento que o resto do projeto já usa pra
--  credencial externa.
--
--  Sem FK pra disparos_pos_venda de propósito (mesmo motivo de sempre neste
--  projeto): um transacao_id pode aparecer aqui antes/depois/nunca de
--  aparecer na fila da régua — nascem de eventos diferentes.
--
--  status_interno: 'pendente_consulta' (nunca checado) | 'nao_encontrado'
--  (a Red Rock devolveu 404 — não é erro, é outro fulfillment center,
--  ver seção 3 do plano) | 'pending' | 'shipped' | 'delivered' | 'cancelled'
--  (os três primeiros direto do campo `status` cru da Red Rock) |
--  'exception' (erro de rede/API na consulta, não 404) | 'desconhecido'
--  (a Red Rock respondeu com um status que ainda não mapeamos).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rastreio_pedidos (
  transacao_id        text PRIMARY KEY,
  provedor             text,
  status_interno        text NOT NULL DEFAULT 'pendente_consulta',
  status_bruto           text,
  order_number             text,
  order_created_at           timestamptz,
  total                         numeric,
  currency                       text,
  fully_fulfilled                  boolean,
  fully_fulfilled_at                 timestamptz,
  cancellation                         jsonb,
  tracking                               jsonb,
  tracking_number                          text,
  carrier_code                               text,
  tracking_url                                 text,
  tracking_status                                text,
  shipped_at                                       timestamptz,
  delivered_at                                       timestamptz,
  ultima_consulta_em                                   timestamptz,
  ultimo_erro                                            text,
  criado_em                                                timestamptz NOT NULL DEFAULT now(),
  atualizado_em                                              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rastreio_pedidos_status_idx ON rastreio_pedidos (status_interno);
CREATE INDEX IF NOT EXISTS rastreio_pedidos_atualizado_idx ON rastreio_pedidos (atualizado_em DESC);

CREATE TABLE IF NOT EXISTS rastreio_eventos (
  id               bigserial PRIMARY KEY,
  transacao_id     text NOT NULL REFERENCES rastreio_pedidos(transacao_id) ON DELETE CASCADE,
  status_anterior  text,
  status_novo      text NOT NULL,
  fonte            text NOT NULL,
  detectado_em     timestamptz NOT NULL DEFAULT now(),
  detalhe          jsonb
);

CREATE INDEX IF NOT EXISTS rastreio_eventos_transacao_idx ON rastreio_eventos (transacao_id, detectado_em DESC);
