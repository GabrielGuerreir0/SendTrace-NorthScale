-- ═══════════════════════════════════════════════════════════════════════════
--  084 · Ficha do Suporte Humano — 2º momento da solicitação da Késsia (PDF de 07/10/2026), Onda F
--
--  · data/autor da última alteração POR BLOCO (Propriedades, Logística, Ajuda) — antes os três dividiam um só `atualizado_em` (item 5);
--  · Status Logística (Solicitar, Solicitado, Responder cliente, Resolvido) e Status de Ajuda (Preciso de ajuda, Orientado - seguir
--    atendimento, Resolvido) — itens 24 e 26; as listas são validadas pela API, como o resto da ficha;
--  · calculadora do reembolso parcial: valor da compra, dedução de frascos e valor a reembolsar = MÁX(0; valor × % − dedução) (item 8);
--  · data do chargeback quando o caso "virou chargeback" (item 11);
--  · `retencao_ofertas.origem`: a Home e o dash passam a ler a retenção de Propriedades (tipo de resolução + %). A linha é gerada
--    a partir da ficha (origem = 'ficha', no máximo uma por caso); os registros manuais antigos ficam (origem = 'manual').
--  Só adiciona colunas e um índice; nada existente muda. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado_ficha
  ADD COLUMN IF NOT EXISTS propriedades_atualizado_por text,
  ADD COLUMN IF NOT EXISTS propriedades_atualizado_em  timestamptz,
  ADD COLUMN IF NOT EXISTS logistica_atualizado_por    text,
  ADD COLUMN IF NOT EXISTS logistica_atualizado_em     timestamptz,
  ADD COLUMN IF NOT EXISTS ajuda_atualizado_por        text,
  ADD COLUMN IF NOT EXISTS ajuda_atualizado_em         timestamptz,
  ADD COLUMN IF NOT EXISTS status_logistica            text,
  ADD COLUMN IF NOT EXISTS status_ajuda                text,
  ADD COLUMN IF NOT EXISTS valor_compra_usd            numeric(14,2),
  ADD COLUMN IF NOT EXISTS deducao_frascos_usd         numeric(14,2),
  ADD COLUMN IF NOT EXISTS valor_a_reembolsar_usd      numeric(14,2),
  ADD COLUMN IF NOT EXISTS chargeback_em               date;

-- O que já estava salvo conta para os dois blocos que existiam (só quando o bloco tem algum campo preenchido).
UPDATE email_ia.suporte_escalado_ficha
   SET propriedades_atualizado_por = atualizado_por, propriedades_atualizado_em = atualizado_em
 WHERE propriedades_atualizado_em IS NULL
   AND (motivo_contato IS NOT NULL OR detalhamento_motivo IS NOT NULL OR tipo_resolucao IS NOT NULL OR status_ticket IS NOT NULL);
UPDATE email_ia.suporte_escalado_ficha
   SET logistica_atualizado_por = atualizado_por, logistica_atualizado_em = atualizado_em
 WHERE logistica_atualizado_em IS NULL
   AND (motivo_reenvio IS NOT NULL OR quantidade_reenvio IS NOT NULL OR produto_reenvio IS NOT NULL OR observacao_reenvio IS NOT NULL
        OR endereco_divergencia IS NOT NULL OR novo_rastreio IS NOT NULL OR responsavel_board_id IS NOT NULL);

COMMENT ON COLUMN email_ia.suporte_escalado_ficha.valor_a_reembolsar_usd IS 'MÁX(0; valor_compra_usd × percentual_reembolso/100 − deducao_frascos_usd); calculado pela API só com "Reembolso parcial" (084).';

ALTER TABLE retencao_ofertas ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS retencao_ofertas_ficha_uq ON retencao_ofertas (caso_id) WHERE origem = 'ficha';
COMMENT ON COLUMN retencao_ofertas.origem IS 'manual = registrado no bloco Retenção (056, em desuso); ficha = gerado de Propriedades (tipo de resolução + %) pelo Suporte Humano (084).';
