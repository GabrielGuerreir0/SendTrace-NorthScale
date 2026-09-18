-- ═══════════════════════════════════════════════════════════════════════════
--  030 · E-mail de Área VIP (produto-específico, fora da régua numerada)
--
--  Pedido (18/09/2026): quem compra NeuroMind Pro, NeuroRecall ou GlycoEden
--  no FRONT recebe, pouco depois da compra, um e-mail com o link da própria
--  Área VIP/Membros daquele produto (páginas já existentes, mantidas fora
--  deste repo — ver `.vip-banner` nas Thanks pages de cada produto). Outros
--  produtos não têm Área VIP e não devem receber nada.
--
--  NÃO entra no motor numerado de `etapas_regua`/`Processador de Disparos`:
--  aquelas etapas são sequenciais POR LINHA (linha '1' = 0-5, Família 1 =
--  10-16, convenção reserva 17+ pra próxima família — ver migração 021).
--  Inserir uma etapa quase-imediata ali empurraria a renumeração de tudo
--  que já existe numa linha. Em vez disso, isto é um "canal lateral" no
--  mesmo padrão que a etapa -1 (recibo) já usa: dispara direto dos 3 fluxos
--  n8n "Reporting" (BuyGoods/JVZoo/Digistore), fora da fila por tempo,
--  usando um `Wait` node pro atraso em vez do agendamento por
--  `proximo_disparo`. O número de etapa `900` aqui é só uma CHAVE DE BUSCA
--  em `mensagens_regua` (pra manter a copy editável no painel) — nunca
--  passa pelo `Processador de Disparos` nem participa do avanço automático
--  (`etapa_atual = etapa_atual + 1`), então não compete com nenhuma faixa
--  numérica real de linha nenhuma.
--
--  Reimportar os 3 fluxos Reporting no n8n do VPS depois desta migração —
--  sem isso ela fica no banco sem efeito (mesma ressalva da migração 020).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. produtos.area_vip_url — só quem tem Área VIP recebe o e-mail ─────────

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS area_vip_url text NULL;

COMMENT ON COLUMN produtos.area_vip_url IS
  'Link da Área VIP/Membros deste produto, se existir. NULL = produto sem '
  'Área VIP — o fluxo Reporting não gera nem tenta o e-mail de acesso pra '
  'ele (o gate é a própria ausência de valor aqui, não uma flag separada).';

UPDATE produtos SET area_vip_url = 'https://getneuromindpro.online/area-vip/'
WHERE slug = 'neuromindpro';

UPDATE produtos SET area_vip_url = 'https://getneurorecall.com/area-vip/'
WHERE slug = 'neurorecallpro';

UPDATE produtos SET area_vip_url = 'https://getglycoeden.com/area-vip/'
WHERE slug = 'glycoeden';

-- ── 2. etapa 900 (registro em etapas_regua, exigido por FK) ─────────────────
--
-- `ativo=false`, igual à etapa -1 (migração 020): fora da conta de "linha
-- completa" e nunca reivindicada por "Reivindicar Lote"/"Buscar Copy Ativa"
-- do Processador de Disparos — é só o registro que a FK de mensagens_regua
-- exige para aceitar `etapa=900`. O disparo real é feito pelo fluxo
-- Reporting, com um `Wait` node, não por este mecanismo.

INSERT INTO etapas_regua (etapa, nome, espera_h, offset_h, ativo, descricao)
VALUES (
  900, 'Área VIP (canal lateral)', NULL, 0, false,
  'Não entra na fila da régua — disparada direto pelos 3 fluxos Reporting, ~20min após a compra do front, só para produtos com produtos.area_vip_url preenchido.'
)
ON CONFLICT (etapa) DO NOTHING;

-- ── 3. copy do e-mail de Área VIP, por produto ───────────────────────────────
--
-- Sem linha '*' de propósito: produto sem Área VIP não deve cair num
-- fallback genérico (ele nem chega a ser buscado — o gate é o
-- `area_vip_url IS NOT NULL` no fluxo Reporting). `mensagens_regua.linha`
-- é NOT NULL (com FK pra painel_linhas_copy), então cada linha usa a
-- família REAL do produto (produtos.linha) só por consistência de dado —
-- a busca desta etapa no fluxo Reporting é por (etapa, canal, produto),
-- sem filtrar por linha nem depender de `linha_ativa`.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  900, 'email', '4', 'neuromindpro',
  'Your NeuroMind Pro VIP Area is ready, {nome}',
  'Acesso à Área VIP — NeuroMind Pro. Dispara ~20min após a compra do front, fora da régua numerada (ver migração 030).',
  'Access my VIP Area', NULL,
  $corpo$<p>Hi {nome},</p>
<p>On top of your order, you've got something extra: full access to the <b>NeuroMind Pro VIP Area</b> — exclusive content to help you get the most out of your results.</p>
<p>It's already unlocked and waiting for you.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  900, 'email', '4', 'neurorecallpro',
  'Your NeuroRecall VIP Area is ready, {nome}',
  'Acesso à Área VIP — NeuroRecall. Dispara ~20min após a compra do front, fora da régua numerada (ver migração 030).',
  'Access my VIP Area', NULL,
  $corpo$<p>Hi {nome},</p>
<p>On top of your order, you've got something extra: full access to the <b>NeuroRecall VIP Area</b> — exclusive content to help you get the most out of your results.</p>
<p>It's already unlocked and waiting for you.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  900, 'email', '6', 'glycoeden',
  'Your GlycoEden VIP Area is ready, {nome}',
  'Acesso à Área VIP — GlycoEden. Dispara ~20min após a compra do front, fora da régua numerada (ver migração 030).',
  'Access my VIP Area', NULL,
  $corpo$<p>Hi {nome},</p>
<p>On top of your order, you've got something extra: full access to the <b>GlycoEden VIP Area</b> — exclusive content to help you get the most out of your results.</p>
<p>It's already unlocked and waiting for you.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;
