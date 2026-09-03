-- ═══════════════════════════════════════════════════════════════════════════
--  020 · Confirmação de compra editável + liga/desliga do SMS da régua
--
--  Duas peças, pedidas juntas (03/09/2026):
--
--  1) O SMS da régua (etapas 0-5, disparado pelo n8n "Processador de
--     Disparos") ganha um liga/desliga em `config_disparos.sms_regua_ativo`,
--     editável pelo painel (PATCH /api/config/sms_regua_ativo/, já genérico
--     via registrarCrud — nenhuma rota nova precisa). Começa em 'false': só o
--     SMS de confirmação de compra (item 2) continua saindo por enquanto.
--     Isso NÃO afeta o e-mail da régua, que continua saindo sempre — só o
--     SMS de cada etapa é que passa a depender desta chave.
--
--  2) A confirmação de compra (e-mail + SMS que saem NA HORA da venda, pelos
--     3 fluxos "Reporting" — Digistore/JVZoo/BuyGoods, não pela régua) estava
--     com o texto fixo dentro do código JS de cada um dos 3 fluxos (idêntico
--     nos 3 — triplicado). Vira `etapa = -1` em `mensagens_regua`, o mesmo
--     mecanismo já usado pelas etapas 0-5 — o código do front (public/regua.js
--     `desativadaMesmo()`) e do back (server/dados.js `recalcularOffsets`) já
--     tratam a etapa -1 como "o recibo, âncora fixa fora da régua" há tempo;
--     só faltava a LINHA existir. `ativo = false` em etapas_regua é de
--     propósito: mantém a etapa -1 fora da conta de "linha completa" (que só
--     olha `etapas_regua WHERE ativo`), já que ela não é enviada pela fila da
--     régua e não deve travar a ativação de uma linha nova.
--
--  O texto inicial é uma TRANSCRIÇÃO EXATA do TPL hardcoded (idêntico nos 3
--  fluxos Reporting hoje) — a migração não muda o que o cliente recebe, só
--  torna editável pelo painel a partir de agora. Preenchida para toda linha
--  já cadastrada em painel_linhas_copy (INSERT...SELECT, não uma linha fixa),
--  para funcionar independente de quantas linhas já existirem.
--
--  Depois desta migração: reimportar os 3 fluxos Reporting no n8n do VPS
--  (trocam o node "Montar Confirmacao" hardcoded por uma leitura desta
--  tabela) — sem isso a migração fica no banco sem efeito nenhum, os fluxos
--  antigos continuam usando o texto fixo até serem reimportados.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. liga/desliga do SMS da régua ────────────────────────────────────────

INSERT INTO config_disparos (chave, valor) VALUES ('sms_regua_ativo', 'false')
ON CONFLICT (chave) DO NOTHING;

-- ── 2. etapa -1 · "o recibo" ────────────────────────────────────────────────

INSERT INTO etapas_regua (etapa, nome, espera_h, offset_h, ativo, descricao)
VALUES (
  -1, 'Confirmação de compra', NULL, 0, false,
  'Sai na hora da venda (webhook Reporting), fora da fila da régua — não tem espera configurável nem entra na conta de "linha completa".'
)
ON CONFLICT (etapa) DO NOTHING;

-- Corpo em dollar-quoting (contém apóstrofos em "don't"/"We're") — transcrição
-- exata do template `TPL.corpo` do node "Montar Confirmacao" (idêntico nos 3
-- fluxos Reporting), entidades HTML (&#9989; etc.) inclusive, como o node
-- original escreve — o e-mail renderiza igual, só passa a vir do banco.
INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT -1, 'email', p.linha, '*',
  '{nome}, your {produto} order is confirmed — payment received',
  $corpo$<p>Great news, <b>{nome}</b> — your order went through perfectly.</p>
<p>Your payment has been received and your <b>{produto}</b> order is confirmed. Our team has already started preparing everything on our side.</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:2">
&#9989; Payment received — order confirmed<br>
&#128230; Order passed to our fulfillment team<br>
&#128197; Estimated delivery: 5&ndash;7 business days</div>
<p>You don't need to do anything right now. If any detail looks off — a typo in your address, a question about your order, anything at all — just reply to this email or tap the button below. Real people, fast answers.</p>
<p>Thank you for your trust, {nome}. We're glad you're here.</p>$corpo$,
  'Questions about my order &rarr;', NULL, '', true
FROM painel_linhas_copy p
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT -1, 'sms', p.linha, '*',
  NULL, NULL, NULL, NULL,
  '{nome}, {produto} order confirmed! Payment set. Support is in your email. Reply STOP to end',
  true
FROM painel_linhas_copy p
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;
