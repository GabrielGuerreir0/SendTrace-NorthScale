-- ═══════════════════════════════════════════════════════════════════════════
--  008 · As três linhas de copy, com nome e intenção
--
--  Cada linha é uma ESTRATÉGIA diferente para o mesmo funil, não uma variação
--  de texto. Sem o nome e o propósito na tela, "Linha 2" não diz nada a quem
--  precisa decidir qual ativar — por isso eles viram dado, não comentário.
--
--  Também corrige a Linha 1: os assuntos do Dia 1 mudaram e as menções a
--  rastreio saíram (regra fixa do workflow: nunca afirmar status de logística
--  nem citar código de rastreamento, porque nada disso está sob nosso
--  controle e prometer o que não se controla é o que vira reembolso).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS painel_linhas_copy (
  linha    text PRIMARY KEY CHECK (linha IN ('1', '2', '3')),
  nome     text NOT NULL,
  intuito  text,
  ordem    smallint NOT NULL DEFAULT 1
);

COMMENT ON TABLE painel_linhas_copy IS 'Nome e propósito de cada linha de copy. Aparece nas abas de Etapas de comunicação.';

INSERT INTO painel_linhas_copy (linha, nome, intuito, ordem) VALUES
  ('1', 'Confiança',
       'Retenção e anti-reembolso. Reduz a ansiedade da espera, responde as dúvidas antes de virarem problema, usa a garantia como calmante e canaliza tudo para o suporte antes de virar cancelamento.', 1),
  ('2', 'Ciência',
       'Educação e valor percebido. Constrói valor pelo racional: por que gotas em vez de cápsulas, os erros que sabotam resultados, a ciência dos hábitos e o baseline mensurável. Cliente convencido pela lógica segura o pedido e usa o produto certo.', 2),
  ('3', 'Emoção',
       'Identidade e visão de futuro. Ancora a compra num motivo pessoal, acolhe a dúvida do Dia 2 como normal, transforma o uso num ritual e faz o cliente visualizar o "eu daqui a 30 dias". Gera mais respostas e reduz arrependimento.', 3)
ON CONFLICT (linha) DO UPDATE
   SET nome = EXCLUDED.nome, intuito = EXCLUDED.intuito, ordem = EXCLUDED.ordem;

-- ── Linha 1 · correções ────────────────────────────────────────────────────
-- Dia 0 e Dia 2 perderam as menções a rastreio; o Dia 1 trocou de assunto.

UPDATE mensagens_regua SET
  texto = 'Confirma a compra reforçando a decisão e entrega o e-book. Cita só a estimativa de 5–7 dias úteis da oferta — sem rastreio, sem afirmar status.'
 WHERE etapa = 0 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET
  assunto = '{nome}, all good with your order — plus a quick question for you',
  texto   = 'Tranquiliza sem afirmar status ("nada que você precise fazer"), pede resposta sobre o e-book e planta a semente do formato líquido.'
 WHERE etapa = 1 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, all good with your {produto} order - and we sent you a quick question by email. Check your inbox! Reply STOP to end'
 WHERE etapa = 1 AND canal = 'sms' AND linha = '1';

UPDATE mensagens_regua SET
  texto = 'FAQ das 3 dúvidas que mais viram reembolso: prazo, por que gotas e "algo parece errado". Oferece checar o pedido em vez de prometer rastreio.'
 WHERE etapa = 2 AND canal = 'email' AND linha = '1';

-- ── Linha 2 · Ciência ──────────────────────────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, assunto, texto, botao, destino) VALUES
  (0, 'email', '2',
      '{nome}, order confirmed — here''s what happens in your brain next',
      'Enquadra a compra pelo racional: declínio cognitivo é uma ladeira que responde a ação, não um interruptor. Entrega o e-book como protocolo, não como brinde.',
      'Download Your Free Guide →', 'EBOOK'),
  (0, 'sms', '2', NULL,
      '{nome}, your {produto} order is confirmed! We emailed you a science-backed guide you can start today - check your inbox. Reply STOP to end',
      NULL, NULL),

  (1, 'email', '2',
      '{nome}, why {produto} is drops — not capsules (the science)',
      'Responde a pergunta mais frequente pela biodisponibilidade: a cápsula perde dose na digestão, o sublingual absorve direto. Prepara o guia do Dia 5.',
      'Open the Free Guide →', 'EBOOK'),
  (1, 'sms', '2', NULL,
      'Hi {nome}, ever wondered why {produto} comes as drops, not capsules? The science is in your inbox - a 2-minute read. Reply STOP to end',
      NULL, NULL),

  (2, 'email', '2',
      '{nome}, the 3 mistakes that ruin supplement results',
      'Os 3 erros que fazem um suplemento "não funcionar": horário aleatório, julgar cedo demais e ignorar sono e hidratação. Mais um quarto sobre o pedido.',
      'Questions about my order →', 'ASSISTENTE'),
  (2, 'sms', '2', NULL,
      'Hi {nome}, 3 common mistakes can undermine your {produto} results - we emailed you how to avoid all of them. Reply STOP to end',
      NULL, NULL),

  (3, 'email', '2',
      '{nome}, the 2-minute setup that makes habits stick',
      'Hábito se sustenta por desenho, não por força de vontade: horário fixo, âncora num hábito existente, lembrete externo e o check-in da semana 4 no calendário.',
      'Check my order →', 'ASSISTENTE'),
  (3, 'sms', '2', NULL,
      'Hi {nome}, science says habit design beats willpower. We emailed you the 2-minute setup for {produto}. Reply STOP to end',
      NULL, NULL),

  (4, 'email', '2',
      '{nome}, note this down today (you''ll thank yourself in 4 weeks)',
      'Pede para registrar o baseline HOJE (palavras perdidas, clareza de 0 a 10, tempo de foco). Sem um "antes", o cérebro esquece o peso da névoa e subestima o progresso.',
      'Check my order →', 'ASSISTENTE'),
  (4, 'sms', '2', NULL,
      'Hi {nome}, do this before {produto} arrives: note how your focus feels today. In 4 weeks the comparison will surprise you. Details in your inbox. Reply STOP to end',
      NULL, NULL),

  (5, 'email', '2',
      '{nome}, your complete {produto} protocol is here',
      'Protocolo completo: por que gotas, como tomar, linha do tempo honesta (1–7 d, 7–21 d, 4–12 sem) e a garantia como permissão para não avaliar cedo demais.',
      'Questions? Talk to us →', 'ASSISTENTE'),
  (5, 'sms', '2', NULL,
      'Hi {nome}, your complete {produto} protocol just landed in your inbox - read it before your package arrives. Reply STOP to end',
      NULL, NULL)
ON CONFLICT (etapa, canal, linha) DO UPDATE
   SET assunto = EXCLUDED.assunto, texto = EXCLUDED.texto,
       botao = EXCLUDED.botao, destino = EXCLUDED.destino, atualizado_em = now();

-- ── Linha 3 · Emoção ───────────────────────────────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, linha, assunto, texto, botao, destino) VALUES
  (0, 'email', '3',
      '{nome}, this is where things start to change',
      'Volta ao momento da decisão — o nome que não veio, a manhã enevoada — e nomeia o ato de agir. O e-book vira o primeiro passo da jornada, não um brinde.',
      'Start With Your Free Gift →', 'EBOOK'),
  (0, 'sms', '3', NULL,
      '{nome}, today you chose to fight for your mind. Your welcome gift is waiting in your email - start today! Reply STOP to end',
      NULL, NULL),

  (1, 'email', '3',
      '{nome}, who are you doing this for?',
      'Pede para a pessoa escrever o próprio motivo. Quem nomeia o "porquê" é quem mantém a constância quando a caixa chega — e a resposta por e-mail cria compromisso.',
      'Open Your Free Guide →', 'EBOOK'),
  (1, 'sms', '3', NULL,
      'Hi {nome}, quick personal question from our team - it''s in your inbox and takes 30 seconds. We read every reply! Reply STOP to end',
      NULL, NULL),

  (2, 'email', '3',
      '{nome}, if doubt shows up today — read this',
      'Acolhe a dúvida do Dia 2 como normal e previsível, tira o peso dela e canaliza para o suporte antes que cresça no escuro.',
      'Talk to our team →', 'ASSISTENTE'),
  (2, 'sms', '3', NULL,
      'Hi {nome}, second thoughts are normal on day 2 - we wrote you something worth reading. Check your inbox. Reply STOP to end',
      NULL, NULL),

  (3, 'email', '3',
      '{nome}, a 30-second promise to your future self',
      'Transforma os 30 segundos diários num ritual: momento fixo, lembrete gentil e o "check-in comigo mesmo" marcado para daqui a 4 semanas.',
      'Check my order →', 'ASSISTENTE'),
  (3, 'sms', '3', NULL,
      'Hi {nome}, 30 seconds a day is all {produto} asks. We emailed you a simple ritual to make it effortless. Reply STOP to end',
      NULL, NULL),

  (4, 'email', '3',
      '{nome}, picture yourself 30 days from now',
      'Faz visualizar quatro cenas concretas do "eu daqui a 30 dias" e pergunta qual delas a pessoa quer de volta primeiro. Nomear torna real.',
      'Check my order →', 'ASSISTENTE'),
  (4, 'sms', '3', NULL,
      'Hi {nome}, close your eyes and picture yourself 30 days from now... we painted the picture in your inbox. Reply STOP to end',
      NULL, NULL),

  -- A mensagem que trouxe esta copy foi CORTADA no meio do corpo do Dia 5.
  -- O assunto veio inteiro; o rótulo do botão e o SMS não. Ficam NULL de
  -- propósito: o painel mostra a lacuna em vez de eu inventar um texto que
  -- ninguém escreveu e que passaria por real.
  (5, 'email', '3',
      '{nome}, your new chapter is about to arrive',
      'Fecha a jornada: por que gotas, como tomar, linha do tempo honesta e a garantia como paz de espírito. ⚠ A copy recebida foi cortada no meio — confira o texto final no n8n.',
      NULL, 'ASSISTENTE'),
  (5, 'sms', '3', NULL,
      '⚠ SMS não recebido — a mensagem com esta copy foi cortada antes do fim. Pegue o texto no n8n (Linha 3, etapa 5) e atualize aqui.',
      NULL, NULL)
ON CONFLICT (etapa, canal, linha) DO UPDATE
   SET assunto = EXCLUDED.assunto, texto = EXCLUDED.texto,
       botao = EXCLUDED.botao, destino = EXCLUDED.destino, atualizado_em = now();
