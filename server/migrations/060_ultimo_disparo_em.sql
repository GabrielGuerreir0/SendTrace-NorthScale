-- ═══════════════════════════════════════════════════════════════════════════
--  060 · Régua: guarda quando cada pedido recebeu o último e-mail (Plano D30 · AB6 / regra R2, 01/10/2026)
--
--  R2: o mesmo cliente nunca recebe duas etapas da régua em menos de 24 h (hoje 226 e-mails têm 2+ disparos vencendo no mesmo dia,
--  porque têm mais de um pedido). O Processador de Disparos passa a ADIAR o pedido para 24 h depois do último envio ao mesmo e-mail.
--  Para isso precisa saber QUANDO o último e-mail saiu: o nó "Avancar Etapa" (n8n) grava esta coluna quando o envio dá certo.
--
--  Só REDUZ/ESPAÇA envio (nunca cria e-mail). Idempotente. Antes de publicar o patch do n8n, esta migração precisa estar aplicada.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE disparos_pos_venda ADD COLUMN IF NOT EXISTS ultimo_disparo_em timestamptz;
COMMENT ON COLUMN disparos_pos_venda.ultimo_disparo_em IS 'Quando o último e-mail da régua saiu para este pedido (gravado pelo "Avancar Etapa" no sucesso). Base da regra R2: 24 h entre etapas do mesmo e-mail.';

-- A regra consulta por e-mail em minúsculas a cada ciclo de 2 min.
CREATE INDEX IF NOT EXISTS idx_disparos_email_lower ON disparos_pos_venda (lower(email));
