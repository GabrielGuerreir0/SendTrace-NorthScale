-- ═══════════════════════════════════════════════════════════════════════════
--  022 · Régua da Família 1 — Neuro/Cognitivo: etapas + copy (D0 a D25)
--
--  7 etapas novas, com numeração própria (10-16) pra não colidir com a linha
--  '1' (Confiança, etapas 0-5) — ver migração 021 pra por quê. Timing exato
--  do documento do funil: D0, D1, D3 (NOVA — não existe na régua genérica),
--  D5, D8, D15, D25. E-mail apenas (SMS desligado pra esta família).
--
--  Copy final em inglês do documento, com dois ajustes deliberados:
--
--  1) "[First Name]" virou {nome} e o link do e-book virou botão (destino
--     EBOOK), não texto colado no corpo — mesmo mecanismo que as outras
--     linhas já usam (produtos.link_ebook), em vez de um marcador de texto
--     solto que ninguém preenche.
--
--  2) NeuroPulsePro é o único produto da família focado em NEUROPATIA, não
--     memória (nota da Seção 9 do documento: "não cruzar linguagem com os
--     demais produtos"). A copy '*' (fallback) cita Bacopa monnieri/alecrim,
--     que é linguagem de MEMÓRIA — errada pra ele. Como o documento não
--     escreveu uma versão própria pra Neuropatia (só sinalizou o risco),
--     as etapas com menção a composto (10, 11, 13, 15) ganham aqui uma copy
--     específica pra neuropulsepro, deliberadamente genérica (sem nome de
--     composto — o documento não validou um "padrão comum" pra ele, ao
--     contrário do que fez pros produtos de memória na Seção 9/10.1).
--     Etapas 12, 14 e 16 não citam composto — servem para todos os 7 sem
--     ajuste.
--
--  Garantia (Seção 10, item 2 do documento — bloqueio duro) resolvida via
--  token `{garantia_dias}`, não um número fixo — o prazo real depende da
--  PLATAFORMA do pedido (JVZoo 60 dias, DigiStore24 180, BuyGoods 60,
--  confirmado 10/09/2026), e o mesmo produto vende por mais de uma. Ver
--  migração 024 (mapeamento plataforma→dias + nó "Montar Mensagem").
--
--  Nenhum produto é roteado pra esta linha ainda (ver migração 021) — falta
--  preencher os 6 produto_readmes vazios antes de ativar de vez (migração
--  025, ainda não escrita).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. cadência ──────────────────────────────────────────────────────────

INSERT INTO etapas_regua (etapa, nome, offset_h, espera_h, descricao) VALUES
  (10, 'Confirmação + orientação',       0,   24,   'D0 imediato · confirma o pedido e já orienta o uso (horário fixo, com alimento)'),
  (11, 'Motivação + abertura',           24,  48,   'D1 · reforça a decisão de compra e explica por que os compostos são combinados'),
  (12, 'Check-in de chegada (NOVA)',     72,  48,   'D3 · intercepta a janela de maior reembolso por arrependimento (pico D2-D5)'),
  (13, 'FAQ das 3 dúvidas',              120, 72,   'D5 · resolve as 3 objeções mais comuns antes de virarem ticket'),
  (14, 'Preparação + upsell reconhecido',192, 168,  'D8 · consolida rotina de uso e reconhece cross-sell quando aplicável'),
  (15, 'Visão de futuro',                360, 240,  'D15 · reforço educativo de longo prazo, sem prometer resultado'),
  (16, 'Guia de uso + garantia',         600, NULL, 'D25 · fecha dúvida de garantia antes da janela expirar — última automática')
ON CONFLICT (etapa) DO NOTHING;

-- ── 2. Etapa 10 (D0) — Confirmação + orientação ─────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  10, 'email', '4', '*',
  'Your order is confirmed — here''s exactly what to do when it arrives',
  'Confirmação + orientação de uso, já citando os dois compostos recorrentes da família (Bacopa monnieri e alecrim).',
  'Get your first-weeks guide', 'EBOOK',
  $corpo$<p>Hi {nome},</p>
<p>Your order is confirmed and on its way. Here's what matters most: take it consistently, at the same time each day, ideally with food — that's how the formula is designed to work with your body's natural absorption window.</p>
<p>Two ingredients do the heavy lifting here: <b>Bacopa monnieri</b>, used for centuries to support memory and mental clarity, and <b>rosemary extract</b>, studied for its role in supporting healthy brain activity. Neither works overnight — consistency is what matters.</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:1.6">
<b>Bacopa monnieri</b> — associated with supporting the neurotransmitters involved in recalling memories.<br><br>
<b>Rosemary extract</b> — studied for its role in supporting healthy circulation and brain activity.
</div>
<p>Questions before it even arrives? Reply here — a real person answers, not a bot.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  10, 'email', '4', 'neuropulsepro',
  'Your order is confirmed — here''s exactly what to do when it arrives',
  'Confirmação + orientação de uso — versão neuropatia (sem citar composto único, sem padrão comum validado pra este produto).',
  'Get your first-weeks guide', 'EBOOK',
  $corpo$<p>Hi {nome},</p>
<p>Your order is confirmed and on its way. Here's what matters most: take it consistently, at the same time each day, ideally with food — that's how the formula is designed to work with your body's natural absorption window.</p>
<p>{produto} is formulated to support healthy nerve function and comfort over time. Nerve support doesn't work overnight — consistency in how and when you take it is what matters most in the first few weeks.</p>
<p>Questions before it even arrives? Reply here — a real person answers, not a bot.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 3. Etapa 11 (D1) — Motivação + abertura ─────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  11, 'email', '4', '*',
  'Why Bacopa and rosemary — together',
  'Reforça a decisão de compra e explica por que os dois compostos aparecem combinados.',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Quick question while your order is on its way: what made you decide to look into memory support right now?</p>
<p>No pressure to answer — but here's something worth knowing either way: Bacopa monnieri and rosemary extract work on different pathways. Bacopa is associated with supporting the neurotransmitters involved in recall; rosemary extract has been studied for supporting healthy circulation and brain activity. That's why they're paired, not just one or the other.</p>
<p>Anything on your mind about the order or the product? Reply here.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  11, 'email', '4', 'neuropulsepro',
  'What made you look into nerve support?',
  'Reforça a decisão de compra — versão neuropatia, sem citar composto único.',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Quick question while your order is on its way: what made you decide to look into nerve support right now?</p>
<p>No pressure to answer — but here's something worth knowing either way: {produto} is designed to work gradually, supporting your body's own processes rather than acting like a quick fix. That's why consistency matters more than any single dose.</p>
<p>Anything on your mind about the order or the product? Reply here.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 4. Etapa 12 (D3, NOVA) — Check-in de chegada ────────────────────────────
--
-- Universal: não cita composto, só a fase de "carregamento" em termos gerais.
-- Serve pros 7 produtos via fallback '*', incluindo neuropulsepro.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  12, 'email', '4', '*',
  'Has your order arrived? Here''s what week one actually looks like',
  'Etapa nova: intercepta o pico de reembolso por arrependimento (D2-D5) explicando a fase de absorção gradual.',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Checking in — has your package arrived?</p>
<p>If it has: don't expect to feel anything dramatic yet. That's normal, not a sign it isn't working. Nutrient-based support like this builds gradually as your body absorbs and uses the compounds — most people are still in the loading phase at this point, not the results phase.</p>
<p>If it hasn't arrived and it's been more than a few business days, reply here right away and we'll track it down — no need to explain the full story, just say "no tracking update" and we'll take it from there.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 5. Etapa 13 (D5) — FAQ das 3 dúvidas ────────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  13, 'email', '4', '*',
  'The 3 things people ask us most in week one',
  'Resolve as 3 dúvidas mais prováveis antes que virem ticket — inclui interação com cafeína (Bacopa).',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Here's what we hear most often at this stage:</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:1.6">
<p style="margin:0 0 12px"><b>"Should I take it with or without food?"</b><br>With food, ideally the same meal each day. This supports steady absorption instead of a spike-and-drop pattern.</p>
<p style="margin:0 0 12px"><b>"How long until I notice something?"</b><br>Most people report noticing a difference in the 3rd to 6th week of consistent use. Anything faster than that isn't the formula working differently — it's expectation, not biology.</p>
<p style="margin:0"><b>"Can I take it with coffee or other supplements?"</b><br>Generally yes, but space it out by an hour from anything containing caffeine — caffeine competes for some of the same absorption pathways as Bacopa.</p>
</div>
<p>Something else on your mind? Reply here — we read every message ourselves.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  13, 'email', '4', 'neuropulsepro',
  'The 3 things people ask us most in week one',
  'FAQ — versão neuropatia, sem menção a Bacopa/cafeína (não se aplica a este produto).',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Here's what we hear most often at this stage:</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:1.6">
<p style="margin:0 0 12px"><b>"Should I take it with or without food?"</b><br>With food, ideally the same meal each day. This supports steady, consistent absorption.</p>
<p style="margin:0 0 12px"><b>"How long until I notice something?"</b><br>Most people report noticing a difference in the 3rd to 6th week of consistent use. Anything faster than that isn't the formula working differently — it's expectation, not biology.</p>
<p style="margin:0"><b>"Can I take it alongside my other supplements?"</b><br>Generally yes — if you're on any prescription medication, it's always worth a quick check with your doctor or pharmacist.</p>
</div>
<p>Something else on your mind? Reply here — we read every message ourselves.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 6. Etapa 14 (D8) — Preparação + upsell reconhecido ──────────────────────
--
-- Universal: foco em rotina de uso, sem mencionar composto. O bloco de
-- cross-sell é condicional (só dispara se o cliente também levou um item
-- reconhecido — ver tabela da Seção 3.1 do documento); fica marcado aqui
-- como comentário HTML pro n8n localizar e substituir, não como texto fixo.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  14, 'email', '4', '*',
  'One week in — a small adjustment that helps',
  'Antecipa o erro mais comum (inconsistência de horário) e reconhece cross-sell quando aplicável.',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>One week in now. If you've been inconsistent with timing — some days morning, some days forgotten entirely — that's the single biggest factor in not feeling a difference later. Pick one time of day and anchor it to something you already do daily (coffee, brushing your teeth) so it becomes automatic.</p>
<!-- BLOCO_CROSSELL: preencher no n8n só se o cliente também comprou um item de cross-sell reconhecido (Seção 3.1) -->$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 7. Etapa 15 (D15) — Visão de futuro ─────────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  15, 'email', '4', '*',
  'What to actually pay attention to from here',
  'Reforço educativo sem promessa de resultado — exemplos concretos de memória (nomear alguém mais rápido, menos neblina mental).',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Around this point, people who've stayed consistent typically start noticing something — not a dramatic shift, but small moments: recalling a name a little faster, feeling less foggy by mid-afternoon. That's the pattern to watch for, not a before/after moment.</p>
<p>If you're not noticing anything at all by now, it's worth checking your consistency first — timing and food pairing matter more than most people expect (see the note we sent in week one).</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  15, 'email', '4', 'neuropulsepro',
  'What to actually pay attention to from here',
  'Visão de futuro — versão neuropatia, exemplos de conforto/sensibilidade em vez de memória.',
  NULL, NULL,
  $corpo$<p>Hi {nome},</p>
<p>Around this point, people who've stayed consistent typically start noticing something — not a dramatic shift, but small moments of everyday comfort. That's the pattern to watch for, not a before/after moment.</p>
<p>If you're not noticing anything at all by now, it's worth checking your consistency first — timing and food pairing matter more than most people expect (see the note we sent in week one).</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 8. Etapa 16 (D25) — Guia de uso + garantia ──────────────────────────────
--
-- {garantia_dias}: token novo (10/09/2026), resolvido pelo n8n a partir da
-- PLATAFORMA real do pedido (JVZoo/DigiStore24/BuyGoods têm prazos
-- diferentes) — ver migração 024 e o nó "Montar Mensagem". Não é um número
-- fixo por produto porque o MESMO produto vende por mais de uma plataforma
-- com garantias diferentes.

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, texto, botao, destino, corpo_html, ativo)
VALUES (
  16, 'email', '4', '*',
  'Your guarantee, in case you need it',
  'Fecha dúvida de garantia antes da janela expirar — nunca dificulta o reembolso, sempre aponta o caminho direto.',
  'Full guarantee details', 'ASSISTENTE',
  $corpo$<p>Hi {nome},</p>
<p>Quick reminder: your order is backed by our guarantee for {garantia_dias} days from the date of purchase — no forms, no hoops. If something's not working for you, just reply to this email directly with your order number. You won't need to re-explain anything we already have on file.</p>$corpo$,
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;
