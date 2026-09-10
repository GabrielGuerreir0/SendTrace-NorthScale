-- ═══════════════════════════════════════════════════════════════════════════
--  026 · LIGA a Família 1 — Neuro/Cognitivo (roteia os 7 produtos pra linha 4)
--
--  Todas as pendências duras do documento resolvidas antes deste passo:
--   • SMTP: lote reduzido + checagem dinâmica de etapa (fix no n8n).
--   • Garantia real por plataforma: token {garantia_dias} (migração 024).
--   • produto_readmes preenchidos pros 7 produtos (migração 025).
--   • Bug de completude por linha corrigido (migração 023 + fluxo n8n).
--
--  A PARTIR DESTA MIGRAÇÃO, pedidos NOVOS destes 7 produtos entram na régua
--  da Família 1 (D0/D1/D3/D5/D8/D15/D25, e-mail apenas) em vez da linha
--  "Confiança" (D0-D5). Pedidos já em andamento na régua antiga continuam
--  nela até o fim — só o próximo nó "Buscar Copy Ativa" a rodar depois do
--  reimport do fluxo passa a ler por produtos.linha; não há migração de
--  disparos_pos_venda já em curso (nem deveria: trocar de régua no meio
--  confundiria o cliente com etapas fora de ordem).
--
--  Os outros 12 produtos do catálogo não são afetados — continuam em
--  linha='1', exatamente como hoje.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE produtos
SET linha = '4', atualizado_em = now()
WHERE slug IN (
  'neuromindpro', 'neuropulsepro', 'cognizil', 'memovancepro',
  'mindtrex', 'neurorecallpro', 'mindhoney60pro'
);
