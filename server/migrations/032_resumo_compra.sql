-- ═══════════════════════════════════════════════════════════════════════════
--  032 · Recibo completo (resumo de tudo que o cliente levou na compra)
--
--  Pedido (18/09/2026): todo comprador recebe, ~60min depois da compra do
--  FRONT, um e-mail listando o front + os upsells/downsells aceitos nesse
--  intervalo (`compras_upsell_downsell`, juntados por e-mail + janela de
--  tempo — não existe ID de sessão de funil entre plataformas).
--
--  Canal lateral, mesmo padrão da etapa -1 (recibo) e da 900 (Área VIP,
--  migração 030): dispara dos 3 fluxos "Reporting" com um `Wait` node, fora
--  do motor numerado de `etapas_regua`/`Processador de Disparos`. O número
--  `901` é só CHAVE DE BUSCA em `mensagens_regua` (copy editável no painel).
--  Só sai com `config_disparos.emails_automaticos_ativo = 'true'` (031).
--
--  COMPLIANCE: `beneficio_curto` começa NULL de propósito. A frase de
--  benefício por produto é copy de saúde/suplemento — precisa de aprovação
--  antes de ser preenchida (não escrever claim de tratamento/cura; ver a
--  auditoria claim × ingrediente). Enquanto NULL, o fluxo usa o fallback
--  neutro abaixo, que não promete resultado nenhum.
--
--  Reimportar os 3 fluxos Reporting no n8n depois desta migração.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. produtos.beneficio_curto ─────────────────────────────────────────────

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS beneficio_curto text NULL;

COMMENT ON COLUMN produtos.beneficio_curto IS
  'Frase curta e APROVADA (sem claim de tratamento/cura) usada no e-mail de '
  'recibo completo (etapa 901). NULL = o fluxo usa o fallback neutro.';

-- ── 2. etapa 901 (registro em etapas_regua, exigido por FK) ─────────────────
--
-- `ativo=false`, igual à -1 e à 900: fora da conta de "linha completa" e
-- nunca reivindicada pelo Processador de Disparos.

INSERT INTO etapas_regua (etapa, nome, espera_h, offset_h, ativo, descricao)
VALUES (
  901, 'Recibo completo (canal lateral)', NULL, 0, false,
  'Não entra na fila da régua — disparada direto pelos 3 fluxos Reporting, ~60min após a compra do front, listando front + upsells/downsells da janela. Só sai com a chave mestra ligada.'
)
ON CONFLICT (etapa) DO NOTHING;

-- ── 3. copy universal (produto '*'), uma linha por família cadastrada ───────
--
-- Marcadores: {nome} e {itens}. `{itens}` é substituído pelo fluxo por uma
-- lista HTML (um item por produto comprado) montada em código, porque o
-- número de itens varia por cliente.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT 901, 'email', p.linha, '*',
  '{nome}, here is everything in your order',
  $corpo$<p>Hi <b>{nome}</b>,</p>
<p>Thank you for your order. Here is a summary of everything you picked up in this purchase:</p>
{itens}
<p>Each item ships and is delivered separately as it is prepared. You don't need to do anything right now — if you have any question about your order, just reply to this email or tap the button below.</p>
<p>Thank you for your trust, {nome}.</p>$corpo$,
  'Questions about my order &rarr;', NULL,
  'Resumo da compra (recibo completo). Dispara ~60min após a compra do front, fora da régua numerada (ver migração 032).',
  true
FROM painel_linhas_copy p
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;
