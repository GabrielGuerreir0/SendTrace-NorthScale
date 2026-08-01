-- ═══════════════════════════════════════════════════════════════════════════
--  009 · O corpo do e-mail, para pré-visualizar a mensagem renderizada
--
--  Guarda SÓ o corpo — a parte que muda de mensagem para mensagem. O cabeçalho
--  da marca, o botão, o bloco de suporte e o rodapé são idênticos nas 17
--  mensagens e são remontados na hora de exibir. Repetir a moldura 17 vezes no
--  banco só criaria 17 lugares para desatualizar.
--
--  As cores estão resolvidas (o n8n usa ${COR.AZUL} etc.), porque aqui isto é
--  dado, não código.
--
--  A pré-visualização roda em iframe isolado, sem script e sem acesso à
--  página: é HTML de terceiro entrando na tela, e trata-se como tal.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Linha 1 · Confiança ────────────────────────────────────────────────────

UPDATE mensagens_regua SET corpo_html = $html$
<p>You just made a decision most people never make, <b>{nome}</b>.</p>
<p>Most people notice the forgetting, the foggy mornings, the words that won't come — and tell themselves it's just stress. Just age. Just something they have to live with.</p>
<p>You didn't accept that. You decided to do something about it. <b>That decision matters more than you realize right now.</b></p>
<p>Your <b>{produto}</b> order has been confirmed and is already with our fulfillment team.</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:2">
&#9989; Payment received — order confirmed<br>
&#128230; Order passed to our fulfillment team<br>
&#128197; Estimated delivery: 5&ndash;7 business days</div>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:18px 22px;margin:24px 0">
<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#415fe5;text-transform:uppercase;letter-spacing:.05em">&#127873; Your free gift — start protecting your brain today</p>
<p style="margin:0 0 6px"><b>The Sharp Mind After 40 Guide</b></p>
<p style="margin:0;font-size:13px;color:#6b7280;font-style:italic">"The 7 daily habits that protect memory, clear brain fog, and keep your mind sharp for decades"</p></div>
<p>No sign-up. No catch. It's yours right now — we recommend reading Chapter 2 before your order arrives, because the habits that protect your brain at 40, 50, and 60 are different from what you were told at 30.</p>
<p>And if any question comes up at any point — about your order, your delivery, the product itself — just reply to this email or use the support details below. Real people, fast answers.</p>
<p>Your mind is worth fighting for, {nome}. We're with you every step of the way.</p>
$html$ WHERE etapa = 0 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Quick reassurance first: your order is moving along normally and there is nothing you need to do on your end — our team keeps an eye on every order from confirmation to delivery.</p>
<p>Now, changing gears — what did you think of the <b>Sharp Mind After 40 Guide</b>? Did you get a chance to open it? Was there anything that surprised you — or anything you'd already noticed yourself? Just hit Reply and let us know. We read every response.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>One quick thing about {produto} before it arrives:</b> you'll notice it's a liquid formula — drops, not capsules. This is intentional. The active compounds are significantly better absorbed in liquid form, reaching the bloodstream faster and more completely than traditional capsules. We'll share the complete usage guide in a couple of days.</p></div>
$html$ WHERE etapa = 1 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Around day two, the same three questions come up again and again. So here are the answers, up front:</p>
<p><b style="color:#415fe5">1. "When will it arrive?"</b><br>Estimated delivery is 5&ndash;7 business days from your order date. Want us to check how yours is going? Tap the button below and ask — we'll look into it for you.</p>
<p><b style="color:#415fe5">2. "Why drops instead of capsules?"</b><br>Bioavailability. The active compounds are absorbed faster and more completely in liquid form. Your complete usage guide arrives in a few days — before your package does.</p>
<p><b style="color:#415fe5">3. "Something feels off — what do I do?"</b><br>Talk to us. Address change, delivery doubt, anything at all: message our team before anything else. Most issues are resolved in minutes.</p>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
<p style="margin:0;font-size:14px">If at any point it feels like your order is taking longer than expected, don't sit with the doubt — reach out and we'll check with the logistics team and get back to you.</p></div>
<p>We'll be in touch again tomorrow.</p>
$html$ WHERE etapa = 2 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>While your package makes its way to you, here's a two-minute setup that separates the people who <i>try</i> {produto} from the people who actually get results with it:</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>1. Pick your time.</b> Same time every day — morning works best for most people.</p>
<p style="margin:10px 0 0"><b>2. Anchor it to a habit you already have.</b> Right after your morning coffee, or right after brushing your teeth. Existing habits carry new ones.</p>
<p style="margin:10px 0 0"><b>3. Set a daily reminder on your phone.</b> Thirty seconds now saves the "did I take it today?" doubt later.</p>
<p style="margin:10px 0 0"><b>4. Open your calendar and mark 4 weeks from today: "first real check-in."</b> That's the honest window where meaningful changes consolidate. Judging before that is judging a process halfway through.</p></div>
<p>Consistency beats everything else. Not intensity, not perfection — just showing up every day.</p>
<p>Your full usage guide — exact drops, timing, and what to expect week by week — arrives in a couple of days.</p>
$html$ WHERE etapa = 3 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Day 4 — and your <b>{produto}</b> is getting closer, <b>{nome}</b>. While it makes its way to you, there's something we genuinely want to ask.</p>
<p>When it arrives and you begin your first two weeks — <b>what moment are you most looking forward to?</b></p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0">Is it joining a conversation and not losing the word you were reaching for?</p>
<p style="margin:8px 0 0">Remembering a name without having to ask twice?</p>
<p style="margin:8px 0 0">Waking up with a mind that feels clear — not slow and foggy?</p>
<p style="margin:8px 0 0">Or something more personal — staying sharp enough to be fully present for the people who depend on you?</p></div>
<p>Whatever it is, it's closer than you think.</p>
<p>Hit Reply and tell us. We read every message — and your answer helps us make sure we're giving you the right support at every step.</p>
$html$ WHERE etapa = 4 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Almost there, <b>{nome}</b>!</p>
<p>Your complete <b>{produto}</b> guide — everything you need to get real results from Day One.</p>
<div style="margin:24px 0">
<p><b style="color:#415fe5">&#128167; Why liquid drops?</b><br>{produto} is formulated as a liquid for a specific reason: bioavailability. The active compounds are absorbed significantly faster and more completely in liquid form than in capsules. With drops, the compounds enter the bloodstream directly, reaching the brain faster and with greater efficiency.</p>
<p><b style="color:#415fe5">&#129514; How to use {produto}</b><br>For your product, {uso}. Taking it at the same time every day is what matters most — morning is ideal. One missed day is fine; several missed days reset progress.</p>
<p><b style="color:#415fe5">&#128337; Honest timeline — what to expect</b><br><b>Days 1&ndash;7:</b> your body is absorbing and synthesizing nutrients. Most people notice very subtle changes — slightly clearer mornings, less mental fatigue. Some notice nothing yet. Both are completely normal.<br><b>Days 7&ndash;21:</b> this is when the first noticeable changes appear for most people. Words flow more easily. Focus holds longer. The fog that felt normal starts feeling like the exception.<br><b>Weeks 4&ndash;12:</b> the research-indicated period for significant cognitive improvements. The compounds work cumulatively — each day builds on the previous one.</p></div>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
<p style="margin:0;font-size:14px"><b>One more thing:</b> some people feel a very mild sensation under the tongue in the first few days. This is normal — it's simply the active compounds being absorbed. It passes quickly and means the formula is working.</p></div>
<p style="font-size:13px;color:#6b7280">If you have any questions about usage, check your product label or your healthcare professional.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>And one thing we want you to hear clearly:</b> your purchase is protected by our satisfaction guarantee. We're telling you this so you can <i>relax</i> — you don't need to evaluate anything in the first days. Give the formula the full window it deserves, knowing you're covered either way.</p></div>
<p>If any doubt shows up along the way — about the product, your delivery, anything at all — <b>talk to us first</b>. A two-minute conversation usually solves what days of wondering can't.</p>
<p>This is the last automatic message about this order — but our team stays available for anything you need.</p>
<p>Your {produto} is almost here, {nome}. The decision you made deserves a real chance. <b>Let's make it count.</b></p>
$html$ WHERE etapa = 5 AND canal = 'email' AND linha = '1';

-- ── Linha 2 · Ciência ──────────────────────────────────────────────────────

UPDATE mensagens_regua SET corpo_html = $html$
<p>Order confirmed, <b>{nome}</b> — and if you like knowing <i>why</i> things work, you're going to enjoy the next few days.</p>
<p>Here's a fact most people never hear: cognitive decline is not a switch that flips at a certain age. It's a slope — shaped by blood flow, neurotransmitter levels and daily habits. And research keeps pointing the same way: <b>it responds to action.</b> You just took one.</p>
<p>Your <b>{produto}</b> order has been confirmed and is already with our fulfillment team.</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:2">
&#9989; Payment received — order confirmed<br>
&#128230; Order passed to our fulfillment team<br>
&#128197; Estimated delivery: 5&ndash;7 business days</div>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:18px 22px;margin:24px 0">
<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#415fe5;text-transform:uppercase;letter-spacing:.05em">&#127873; Your free gift — the evidence comes first</p>
<p style="margin:0 0 6px"><b>The Sharp Mind After 40 Guide</b></p>
<p style="margin:0;font-size:13px;color:#6b7280;font-style:italic">"The 7 daily habits that protect memory, clear brain fog, and keep your mind sharp for decades"</p></div>
<p>Every habit in it is simple, free, and grounded in solid research — and each one multiplies what {produto} can do. We recommend starting with Chapter 2 today; your order will catch up with you in a few days.</p>
<p>Questions at any point — about your order or the product itself? Just reply to this email. Real people, fast answers.</p>
$html$ WHERE etapa = 0 AND canal = 'email' AND linha = '2';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Quick note first: your order is moving along normally — there is nothing you need to do on your end.</p>
<p>Today, the question we get more than any other: <b>why is {produto} a liquid instead of a capsule?</b></p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>The short answer: absorption.</b> A capsule has to survive your entire digestive process before its compounds reach the bloodstream — and part of the dose is lost along the way. A liquid held under the tongue starts absorbing immediately, through tissue that connects almost directly to circulation.</p></div>
<p>More of the active compounds, arriving faster, with less waste. That's the reason — and it's also why <i>how</i> you take it matters. Your complete usage guide arrives in a few days, before your package does.</p>
<p>In the meantime: have you opened the <b>Sharp Mind After 40 Guide</b>? Chapter 2 pairs especially well with what you just read. If anything in it surprised you, hit Reply and tell us — we read every message.</p>
$html$ WHERE etapa = 1 AND canal = 'email' AND linha = '2';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Years of working with customers taught us something uncomfortable: when a supplement "doesn't work", one of these three mistakes is usually the real cause. Avoid them and you're ahead of almost everyone:</p>
<p><b style="color:#415fe5">1. Taking it at random times.</b><br>Consistency drives results more than any other factor. Same time, every single day — that's what keeps levels stable and lets the compounds build on each other.</p>
<p><b style="color:#415fe5">2. Judging the results too early.</b><br>Cognitive compounds work cumulatively. The research window for significant change is weeks 4&ndash;12 — quitting on day 10 is stopping the experiment halfway through.</p>
<p><b style="color:#415fe5">3. Ignoring the basics.</b><br>Sleep and hydration are the foundation every formula builds on. The free guide we sent you covers exactly this — it isn't filler, it's the multiplier.</p>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
<p style="margin:0;font-size:14px">And a fourth one, about the order itself: if any doubt comes up — delivery, address, anything at all — don't sit with it. Message our team first; most questions are resolved in minutes.</p></div>
<p>We'll be in touch again tomorrow.</p>
$html$ WHERE etapa = 2 AND canal = 'email' AND linha = '2';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Behavioral research is remarkably clear about how new habits survive: not through willpower, but through <b>design</b>. While your {produto} makes its way to you, set up these four things — it takes two minutes:</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>1. Fix the time.</b> Same time every day — morning works best for most people.</p>
<p style="margin:10px 0 0"><b>2. Anchor it to a habit you already have.</b> Right after your morning coffee, or right after brushing your teeth. Cue then routine — that's how the brain automates behavior.</p>
<p style="margin:10px 0 0"><b>3. Set a daily reminder on your phone.</b> External memory beats good intentions, every time.</p>
<p style="margin:10px 0 0"><b>4. Mark "week 4 check-in" in your calendar.</b> That's when the evidence window opens. Judge the results there — not on day 6.</p></div>
<p>People who do this simple setup are far more likely to still be taking their formula — and seeing results — a month later. Two minutes now, worth weeks later.</p>
<p>Your full usage guide — exact drops, timing, and what to expect week by week — arrives in a couple of days.</p>
$html$ WHERE etapa = 3 AND canal = 'email' AND linha = '2';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Day 4, <b>{nome}</b> — your <b>{produto}</b> is getting closer. Today, one practical piece of advice most people skip:</p>
<p><b>Record your baseline — today, before it arrives.</b></p>
<p>Improvements in memory and focus arrive gradually, in small everyday moments. Without a "before", the brain simply forgets how heavy the fog used to be — and people underestimate their own progress.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0">Take 60 seconds and jot down, in your notes app:</p>
<p style="margin:8px 0 0">How often did you lose a word mid-sentence this week?</p>
<p style="margin:8px 0 0">How clear do your mornings feel, from 0 to 10?</p>
<p style="margin:8px 0 0">How long can you focus before drifting off?</p></div>
<p>In four weeks, read it back. That comparison — not a vague feeling — is how you'll know exactly what changed.</p>
<p>And tell us: which of those three matters most to you? Hit Reply — we read every message, and your answer helps us support you better.</p>
$html$ WHERE etapa = 4 AND canal = 'email' AND linha = '2';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Here it is, <b>{nome}</b> — your complete <b>{produto}</b> protocol. Everything below is what separates <i>taking</i> a formula from <i>getting results</i> with it.</p>
<div style="margin:24px 0">
<p><b style="color:#415fe5">&#128167; Why liquid drops?</b><br>{produto} is formulated as a liquid for a specific reason: bioavailability. The active compounds are absorbed significantly faster and more completely in liquid form than in capsules. With drops, the compounds enter the bloodstream directly, reaching the brain faster and with greater efficiency.</p>
<p><b style="color:#415fe5">&#129514; How to use {produto}</b><br>For your product, {uso}. Taking it at the same time every day is what matters most — morning is ideal. One missed day is fine; several missed days reset progress.</p>
<p><b style="color:#415fe5">&#128337; Honest timeline — what to expect</b><br><b>Days 1&ndash;7:</b> your body is absorbing and synthesizing nutrients. Most people notice very subtle changes — slightly clearer mornings, less mental fatigue. Some notice nothing yet. Both are completely normal.<br><b>Days 7&ndash;21:</b> this is when the first noticeable changes appear for most people. Words flow more easily. Focus holds longer. The fog that felt normal starts feeling like the exception.<br><b>Weeks 4&ndash;12:</b> the research-indicated period for significant cognitive improvements. The compounds work cumulatively — each day builds on the previous one.</p></div>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
<p style="margin:0;font-size:14px"><b>One more thing:</b> some people feel a very mild sensation under the tongue in the first few days. This is normal — it's simply the active compounds being absorbed. It passes quickly and means the formula is working.</p></div>
<p style="font-size:13px;color:#6b7280">If you have any questions about usage, check your product label or your healthcare professional.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>And one thing we want you to hear clearly:</b> your purchase is protected by our satisfaction guarantee. We're telling you this so you can <i>relax</i> — you don't need to evaluate anything in the first days. Give the formula the full window it deserves, knowing you're covered either way.</p></div>
<p>If any doubt shows up along the way — about the product, your delivery, anything at all — <b>talk to us first</b>. A two-minute conversation usually solves what days of wondering can't.</p>
<p>This is the last automatic message about this order — but our team stays available for anything you need.</p>
<p>Your {produto} is almost here, {nome}. Follow the protocol, give it the honest window — and let the results speak. <b>Let's make it count.</b></p>
$html$ WHERE etapa = 5 AND canal = 'email' AND linha = '2';

-- ── Linha 3 · Emoção ───────────────────────────────────────────────────────

UPDATE mensagens_regua SET corpo_html = $html$
<p>There was a moment, <b>{nome}</b> — maybe a name that wouldn't come back, a word lost mid-sentence, one foggy morning too many — when you decided you weren't going to just accept it.</p>
<p>Today you acted on that decision. <b>And acting is the part most people never do.</b></p>
<p>Your <b>{produto}</b> order has been confirmed and is already with our fulfillment team.</p>
<div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin:22px 0;font-size:14px;line-height:2">
&#9989; Payment received — order confirmed<br>
&#128230; Order passed to our fulfillment team<br>
&#128197; Estimated delivery: 5&ndash;7 business days</div>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:18px 22px;margin:24px 0">
<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#415fe5;text-transform:uppercase;letter-spacing:.05em">&#127873; Your welcome gift — the first step starts today</p>
<p style="margin:0 0 6px"><b>The Sharp Mind After 40 Guide</b></p>
<p style="margin:0;font-size:13px;color:#6b7280;font-style:italic">"The 7 daily habits that protect memory, clear brain fog, and keep your mind sharp for decades"</p></div>
<p>You don't have to wait for the package to begin. Open the guide today — Chapter 2 is the one where most readers say <i>"that's me"</i> — and take your first step while {produto} makes its way to you.</p>
<p>If any question comes up along the way, just reply to this email. There are real people on the other side, and we answer fast.</p>
<p>Your mind is worth fighting for, {nome}. Welcome to the journey.</p>
$html$ WHERE etapa = 0 AND canal = 'email' AND linha = '3';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>First, so you don't have to wonder: your order is moving along normally — there is nothing you need to do on your end.</p>
<p>Now, a more personal question. When you ordered <b>{produto}</b>, you had a reason. Maybe it was for you — tired of reaching for words that used to come easily. Maybe it was for them — wanting to stay sharp and fully present for the people who count on you.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>Whatever your reason is — put it into words. Hit Reply and tell us.</b> People who name their "why" are the ones who stay consistent when the box arrives. And yes, a real person reads every single answer.</p></div>
<p>One small heads-up before it arrives: {produto} comes as liquid drops, not capsules — absorbed faster and more completely than capsules. Your complete usage guide lands here in a few days.</p>
$html$ WHERE etapa = 1 AND canal = 'email' AND linha = '3';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Around day two, something predictable happens. The energy of the decision fades a little, the box isn't here yet, and a quiet voice shows up: <i>"Did I do the right thing?"</i></p>
<p>We want you to know two things.</p>
<p><b style="color:#415fe5">First: that voice is normal.</b> Nearly everyone hears it — it's what minds do while they wait. It says nothing about your decision.</p>
<p><b style="color:#415fe5">Second: you never have to face a doubt alone.</b> A question about delivery, about the product, about anything at all — message our team before the doubt grows in the dark. Most questions are answered in minutes, and the relief is instant.</p>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0">
<p style="margin:0;font-size:14px">Estimated delivery is 5&ndash;7 business days from your order date. If it ever feels like it's taking longer than expected, reach out — we'll check for you and get back to you.</p></div>
<p>You made this decision for a reason. Hold onto it — we'll handle the rest together.</p>
$html$ WHERE etapa = 2 AND canal = 'email' AND linha = '3';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Hi <b>{nome}</b>,</p>
<p>Everything {produto} asks of you fits in 30 seconds a day. But those 30 seconds work best as a <b>ritual</b> — a small promise you keep to yourself every morning.</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0"><b>1. Choose your moment.</b> Right after your morning coffee, right after brushing your teeth — attach it to something you already do every day.</p>
<p style="margin:10px 0 0"><b>2. Set a gentle reminder</b> on your phone, for that same time.</p>
<p style="margin:10px 0 0"><b>3. Open your calendar and mark 4 weeks from today: "check-in with myself".</b> That's the day you look back and compare — not before.</p></div>
<p>It seems small. It <i>is</i> small. But the person you'll be in a month is built from these small kept promises — one morning at a time.</p>
<p>Your complete usage guide arrives in a couple of days, before your package does.</p>
$html$ WHERE etapa = 3 AND canal = 'email' AND linha = '3';

UPDATE mensagens_regua SET corpo_html = $html$
<p>Day 4, <b>{nome}</b> — your <b>{produto}</b> is getting closer. Before it arrives, try something with us. Take five seconds and picture this:</p>
<div style="background:#eef1fd;border-left:4px solid #415fe5;border-radius:0 8px 8px 0;padding:16px 20px;margin:22px 0">
<p style="margin:0">You're in the middle of a conversation — and the word is just <i>there</i> when you reach for it.</p>
<p style="margin:8px 0 0">Someone says their name once. Later, you remember it — without asking twice.</p>
<p style="margin:8px 0 0">You wake up and your first thought is clear, not buried under fog.</p>
<p style="margin:8px 0 0">You're fully present with the people you love — not nodding along while your mind struggles to keep up.</p></div>
<p><b>Which of those moments do you want back first?</b></p>
<p>Hit Reply and tell us. It takes twenty seconds, we read every message — and naming the moment makes it real in a way that just thinking about it never does.</p>
$html$ WHERE etapa = 4 AND canal = 'email' AND linha = '3';

-- A Linha 3 / etapa 5 continua sem corpo: a mensagem que trouxe esta copy foi
-- cortada no meio do corpo. Fica NULL para o painel mostrar a lacuna em vez de
-- exibir meio e-mail como se fosse a peça inteira.
