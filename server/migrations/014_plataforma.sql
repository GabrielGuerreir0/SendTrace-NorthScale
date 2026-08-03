-- ═══════════════════════════════════════════════════════════════════════════
--  A plataforma de venda do pedido — DigiStore24, JVZoo, BuyGoods…
--
--  Quem escreve é o worker/n8n, no momento em que o pedido entra na fila. O
--  painel só lê: a coluna alimenta o seletor do topo, que recorta o painel
--  inteiro do mesmo jeito que o filtro por produto.
--
--  Texto livre e anulável de propósito: uma plataforma nova entra sem
--  migração (o seletor é montado do que existe na fila), e os pedidos antigos
--  — anteriores à coluna — ficam nulos em vez de ganharem um valor inventado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE disparos_pos_venda
  ADD COLUMN IF NOT EXISTS plataforma text;

COMMENT ON COLUMN disparos_pos_venda.plataforma
  IS 'Plataforma de venda do pedido (DigiStore24, JVZoo, BuyGoods…). Nulo = anterior à coluna ou não informada.';
