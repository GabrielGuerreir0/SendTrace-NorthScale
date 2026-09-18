-- ═══════════════════════════════════════════════════════════════════════════
--  033 · Família 3 — linha "Pressão Alta" (Honeyflush, HoneyPril, HeartFlush)
--       + limpeza da nota interna da etapa 40 (revisão jurídica)
--
--  Origem (18/09/2026): "Copy Família 3 — Pressão Alta" (Rodrigo Macedo, Head
--  de CS) e "Compliance × Plataformas — Famílias 4 e 5".
--
--  1) Pressão Alta ganha linha PRÓPRIA ('10', etapas 70-76), separada da
--     Diabetes (linha '6', etapas 30-36) — Hawaiian Harmony, GlycoPulse e
--     GlycoEden NÃO mudam. Mesma cadência (espera/offset) da linha 6.
--  2) Etapas 0, 1, 3 e 5 do documento = etapas 70, 71, 73 e 75 (D0, D1, D5,
--     D15), com a copy do PDF, aplicada como veio. Etapas 72, 74 e 76
--     (check-in de chegada, preparação, garantia) NÃO estão no PDF: herdam a
--     copy da linha 6, cuja nota interna as marca como neutras entre
--     Diabetes/Pressão Alta — e uma trava no fim aborta a migração se algum
--     texto voltado ao cliente citar Diabetes.
--  3) A assinatura do PDF ("Team HealthWellnes") fica de fora: a moldura do
--     e-mail já fecha com "With care, — The {produto} Team".
--  4) Honeyflush, HoneyPril e HeartFlush passam pra linha '10'. HeartFlush
--     ainda não existia em `produtos` (produto novo, sem venda): é criado.
--  5) A nota interna (`texto`, só do painel) da etapa 40 (Família 4) citava
--     "placas tóxicas" — o termo sai. O e-mail que o cliente recebe
--     (`corpo_html`) não continha o termo.
--
--  Rodar com `psql -1` (tudo ou nada). Idempotente (ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. linha nova ───────────────────────────────────────────────────────────

INSERT INTO painel_linhas_copy (linha, nome, intuito, ordem)
VALUES (
  '10', 'Família 3 — Pressão Alta',
  'Honeyflush, HoneyPril, HeartFlush — mecanismo "cimento arterial" (Arterial Flush Ritual, 3 fases em 180 dias), validado na oferta real do Honeyflush. HoneyPril e HeartFlush usam o mecanismo comum da família, sem detalhe específico não validado. Régua de 7 etapas (D0 a D25), pico D2-D5, mesma cadência da linha Diabetes. E-mail apenas, bidirecional. Copy das etapas 0, 1, 3 e 5 vinda do documento do Rodrigo (18/09/2026); as etapas 2, 4 e 6 herdam a copy neutra da Diabetes.',
  8
)
ON CONFLICT (linha) DO NOTHING;

-- a linha Diabetes deixa de dizer que Pressão Alta "continua na linha 1"
UPDATE painel_linhas_copy
SET intuito = replace(intuito,
  'Honeyflush e HeartFlush (Pressão Alta) continuam na linha 1 — precisam de uma variante própria de copy (mecanismo "cimento arterial") antes de entrar nesta linha, para não mandar copy de Diabetes pra cliente de Pressão Alta.',
  'Pressão Alta (Honeyflush, HoneyPril, HeartFlush) tem linha própria (10), para não mandar copy de Diabetes pra cliente de Pressão Alta.')
WHERE linha = '6';

UPDATE mensagens_regua
SET texto = replace(texto,
  'Honeyflush/HeartFlush (Pressão Alta) ainda não têm variante própria (pendência bloqueante).',
  'Pressão Alta tem linha própria (10).')
WHERE linha = '6' AND etapa = 30 AND produto = '*' AND canal = 'email';

-- ── 2. cadência: mesmas 7 etapas da linha 6, +40 ────────────────────────────

INSERT INTO etapas_regua (etapa, nome, espera_h, offset_h, ativo, descricao, linha)
SELECT e.etapa + 40, e.nome, e.espera_h, e.offset_h, e.ativo, e.descricao, '10'
FROM etapas_regua e
WHERE e.linha = '6' AND e.etapa BETWEEN 30 AND 36
ON CONFLICT (etapa) DO NOTHING;

-- ── 3. copy nova: etapas 70, 71, 73, 75 ─────────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
VALUES (
  70, 'email', '10', '*',
  'Your order is confirmed — here''s exactly what to do when it arrives',
  $c$<p>Hi {nome},</p>
<p>Your order is confirmed and on its way. Here's what matters most: take it consistently, at the same time each day, ideally with food — that's how the formula is designed to work with your body's natural absorption window.</p>
<p>The formula works in phases: it's designed to help clear existing buildup first, then support the natural flexibility of your arterial walls over time. It follows a 3-phase pattern (more on that in the next few days) — consistency matters far more than any single dose.</p>
<p>Your full first-weeks guide is below if you want the details.</p>
<p>Questions before it even arrives? Reply here — a real person answers, not a bot.</p>$c$,
  'Get your first-weeks guide', 'EBOOK',
  'Confirmação + orientação — Pressão Alta (mecanismo "cimento arterial", 3 fases). Copy do documento "Copy Família 3 — Pressão Alta" (18/09/2026), Etapa 0. Vale para Honeyflush, HoneyPril e HeartFlush.',
  true
), (
  71, 'email', '10', '*',
  'Why this works in phases, not all at once',
  $c$<p>Hi {nome},</p>
<p>Quick question while your order is on its way: what made you decide to look into this right now?</p>
<p>No pressure to answer — but here's something worth knowing either way: the formula is designed to work through 3 phases over time — first addressing existing buildup, then restoring flexibility, then building lasting support. That's why it's not a one-dose fix, and why the full pattern takes time to show up.</p>
<p>Anything on your mind about the order or the product? Reply here.</p>$c$,
  NULL, NULL,
  'Motivação + abertura — Pressão Alta. Copy do documento "Copy Família 3 — Pressão Alta" (18/09/2026), Etapa 1.',
  true
), (
  73, 'email', '10', '*',
  'The 3 things people ask us most in week one',
  $c$<p>Hi {nome},</p>
<p>Here's what we hear most often at this stage:</p>
<p><b>"Should I take it with or without food?"</b> — With food, ideally the same meal each day, for steady, consistent support.</p>
<p><b>"How long until I notice something?"</b> — This one works in phases over time, not overnight — most people report noticing a difference over the following weeks, not the first few days.</p>
<p><b>"Can I take it alongside my blood pressure medication?"</b> — This is a question for your doctor or pharmacist, since it depends on your specific prescription. We'd rather be direct about that than guess.</p>
<p>Something else on your mind? Reply here — we read every message ourselves.</p>$c$,
  NULL, NULL,
  'FAQ das 3 dúvidas — Pressão Alta. Copy do documento "Copy Família 3 — Pressão Alta" (18/09/2026), Etapa 3. As 3 perguntas são hipótese baseada no mecanismo, não dado filtrado de "Motivos de contato" (mesma pendência não-bloqueante da Diabetes).',
  true
), (
  75, 'email', '10', '*',
  'What to actually pay attention to from here',
  $c$<p>Hi {nome},</p>
<p>Around this point, people who've stayed consistent typically start noticing something — not a dramatic shift, but small signs. That's the pattern to watch for, not a before/after moment.</p>
<p>If you're not noticing anything at all by now, it's worth checking your consistency first — timing and food pairing matter more than most people expect.</p>
<p>As always, any changes to blood pressure medication or monitoring routines should go through your doctor — we're here to support the habit, not to replace medical guidance.</p>$c$,
  NULL, NULL,
  'Visão de futuro — Pressão Alta. Copy do documento "Copy Família 3 — Pressão Alta" (18/09/2026), Etapa 5.',
  true
)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 4. copy herdada da linha 6 (neutra entre Diabetes/Pressão Alta): 72, 74, 76 ──

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT m.etapa + 40, m.canal, '10', '*', m.assunto, m.corpo_html, m.botao, m.destino,
       'Copy neutra herdada da linha 6 (etapa ' || m.etapa || ') — não está no documento de Pressão Alta; vale para a família.',
       true
FROM mensagens_regua m
WHERE m.linha = '6' AND m.produto = '*' AND m.canal = 'email' AND m.etapa IN (32, 34, 36)
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── 5. produtos: HeartFlush nasce; os 3 vão pra linha 10 ────────────────────

INSERT INTO produtos (slug, nome, linha, ativo)
VALUES ('heartflush', 'HeartFlush', '10', true)
ON CONFLICT (slug) DO NOTHING;

UPDATE produtos SET linha = '10' WHERE slug IN ('honeyflush', 'honeypril', 'heartflush');

-- ── 6. revisão jurídica: nota interna da etapa 40 (Família 4) sem o termo ───

UPDATE mensagens_regua
SET texto = 'Confirmação + orientação — mecanismo comum de circulação, tom discreto (assunto sensível). Cruzamento de compliance por plataforma feito em 18/09/2026 (documento Compliance × Plataformas); pendente: política de claims de saúde do Digistore24 e entidade de venda (GmbH/Inc.).'
WHERE linha = '7' AND etapa = 40 AND produto = '*' AND canal = 'email';

-- ── 7. trava: aborta (e desfaz tudo, com psql -1) se algo saiu errado ───────

DO $$
DECLARE n int;
BEGIN
  -- texto voltado ao cliente da linha 10 não pode falar de Diabetes
  SELECT count(*) INTO n FROM mensagens_regua m
  WHERE m.linha = '10'
    AND concat_ws(' ', m.assunto, m.corpo_html, m.botao)
        ~* 'cinnamon|berberine|canela|diabet|glucose|insulin|blood sugar|glicemi';
  IF n > 0 THEN
    RAISE EXCEPTION 'Linha 10 herdou % mensagem(ns) com texto de Diabetes voltado ao cliente — nada foi aplicado.', n;
  END IF;

  SELECT count(*) INTO n FROM mensagens_regua WHERE linha = '10' AND ativo;
  IF n <> 7 THEN RAISE EXCEPTION 'Esperava 7 mensagens na linha 10, achei % — nada foi aplicado.', n; END IF;

  SELECT count(*) INTO n FROM etapas_regua WHERE linha = '10' AND ativo;
  IF n <> 7 THEN RAISE EXCEPTION 'Esperava 7 etapas na linha 10, achei % — nada foi aplicado.', n; END IF;

  SELECT count(*) INTO n FROM produtos WHERE linha = '10';
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 produtos na linha 10, achei % — nada foi aplicado.', n; END IF;

  -- os termos da revisão jurídica não podem existir em mensagens_regua
  SELECT count(*) INTO n FROM mensagens_regua m
  WHERE to_jsonb(m)::text ~* 'neurocytin|sciatica degeneration|oxidative nerve|nerve strangle|xenotox|toxic plaque|placas t[oó]xicas';
  IF n > 0 THEN RAISE EXCEPTION 'Ainda há % mensagem(ns) com termo da revisão jurídica — nada foi aplicado.', n; END IF;
END $$;
