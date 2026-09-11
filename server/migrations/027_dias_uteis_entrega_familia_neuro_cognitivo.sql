-- ═══════════════════════════════════════════════════════════════════════════
--  027 · Dias úteis de entrega de referência (Seção 10, item 1 — pendência
--        não-bloqueante do documento da Família 1 — Neuro/Cognitivo)
--
--  A Etapa 12 (D3, "Check-in de chegada") usava texto fixo genérico
--  ("a few business days") em vez de um valor configurável, diferente da
--  garantia (migração 024), que já virou token dinâmico.
--
--  Confirmado com o usuário em 11/09/2026: 7-10 dias úteis, valor único
--  (não varia por plataforma — ao contrário da garantia, o prazo de entrega
--  depende do fulfillment/transportadora, não da plataforma de pagamento).
--  Por isso vira uma chave simples em `config_disparos`, sem mapa JSON.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES ('dias_uteis_entrega_referencia', '7-10')
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

UPDATE mensagens_regua
SET corpo_html = replace(
      corpo_html,
      'it''s been more than a few business days',
      'it''s been more than {dias_uteis_entrega} business days'
    ),
    atualizado_em = now()
WHERE etapa = 12 AND linha = '4' AND produto = '*'
  AND corpo_html LIKE '%it''s been more than a few business days%';
