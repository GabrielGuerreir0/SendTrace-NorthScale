-- ═══════════════════════════════════════════════════════════════════════════
--  003 · Copy de RETENÇÃO — alinha a régua com o nó de Code atual do n8n
--
--  O que mudou de fato, e por quê:
--
--  O envio e o rastreio não estão sob nosso controle, então a copy parou de
--  AFIRMAR status de logística ("postado", "etiqueta emitida", "saiu para
--  entrega"). Prometer um estado que não se pode garantir é o que transforma
--  ansiedade em pedido de reembolso. No lugar, cada mensagem canaliza a dúvida
--  para o suporte ANTES de ela virar decisão.
--
--  Por isso os nomes das etapas 1–4 mudam aqui. Os antigos ("Logística — Dia
--  2", "Logística — Dia 3") descreviam a régua anterior; mantê-los faria o
--  painel rotular como logística um e-mail que hoje é FAQ ou preparação de uso.
--  O nome da etapa é o que o operador lê no nó — ele tem que dizer a verdade.
--
--  A cadência NÃO muda: 30 min, depois Dia 1 a Dia 5.
--
--  Roda uma vez (ver painel_migracoes em setup.js). Daqui em diante a copy no
--  banco é sua: edite por SQL à vontade que nenhuma migração encosta nela.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE etapas_regua SET nome = 'Confirmação + e-book',
       descricao = '30 min após a compra · confirma a decisão e entrega o brinde'
 WHERE etapa = 0;
UPDATE etapas_regua SET nome = 'Tranquiliza + pergunta',
       descricao = 'Dia 1 · acalma sem afirmar status e puxa resposta sobre o e-book'
 WHERE etapa = 1;
UPDATE etapas_regua SET nome = 'FAQ das 3 dúvidas',
       descricao = 'Dia 2 · responde o que mais gera reembolso e abre canal com o suporte'
 WHERE etapa = 2;
UPDATE etapas_regua SET nome = 'Preparação + compromisso',
       descricao = 'Dia 3 · rotina de uso e o check-in de 4 semanas no calendário'
 WHERE etapa = 3;
UPDATE etapas_regua SET nome = 'Visão de futuro',
       descricao = 'Dia 4 · faz o cliente escrever o próprio motivo para esperar'
 WHERE etapa = 4;
UPDATE etapas_regua SET nome = 'Guia de uso + garantia',
       descricao = 'Dia 5 · como tomar, linha do tempo honesta e garantia — última automática'
 WHERE etapa = 5;

-- ── A copy, transcrita do nó de Code ───────────────────────────────────────

UPDATE mensagens_regua SET
  assunto = '{nome}, your {produto} order is confirmed — your free gift is inside',
  texto   = 'Confirma a compra reforçando a decisão, entrega o e-book e abre o canal de suporte. Único prazo citado: a estimativa de 5–7 dias úteis da oferta.',
  botao   = 'Download Your Free Guide →',
  destino = 'EBOOK'
 WHERE etapa = 0 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = '{nome}, you just made a great choice for your brain health! We sent you something important - check your email now. Reply STOP to end'
 WHERE etapa = 0 AND canal = 'sms';

UPDATE mensagens_regua SET
  assunto = '{nome}, all on track — plus a quick question for you',
  texto   = 'Tranquiliza sem afirmar status, pede resposta sobre o e-book e planta a semente do formato líquido.',
  botao   = 'Open the Free Guide →',
  destino = 'EBOOK'
 WHERE etapa = 1 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, all on track with your {produto} order - and we sent you a quick question by email. Check your inbox! Reply STOP to end'
 WHERE etapa = 1 AND canal = 'sms';

UPDATE mensagens_regua SET
  assunto = '{nome}, the 3 questions everyone asks about their {produto} order',
  texto   = 'Responde de frente as três dúvidas que mais viram reembolso e posiciona o suporte como primeiro passo.',
  botao   = 'Questions about my order →',
  destino = 'ASSISTENTE'
 WHERE etapa = 2 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, we just answered the 3 most common questions about {produto} orders by email - check your inbox! Reply STOP to end'
 WHERE etapa = 2 AND canal = 'sms';

UPDATE mensagens_regua SET
  assunto = '{nome}, do this before your {produto} arrives (takes 2 minutes)',
  texto   = 'Checklist de 2 minutos: horário fixo, âncora num hábito, lembrete no celular e o check-in de 4 semanas marcado no calendário.',
  botao   = 'Check my order →',
  destino = 'ASSISTENTE'
 WHERE etapa = 3 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, 2 minutes today = better results with {produto}. We emailed you a quick prep checklist - check your inbox. Reply STOP to end'
 WHERE etapa = 3 AND canal = 'sms';

UPDATE mensagens_regua SET
  assunto = '{nome}, one question before your {produto} arrives',
  texto   = 'Pergunta qual momento a pessoa mais espera — responder por escrito reduz arrependimento.',
  botao   = 'Check my order →',
  destino = 'ASSISTENTE'
 WHERE etapa = 4 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, your {produto} is getting closer! Our team just emailed you and we''d love your feedback - check your inbox. Reply STOP to end'
 WHERE etapa = 4 AND canal = 'sms';

UPDATE mensagens_regua SET
  assunto = '{nome}, read this before your {produto} arrives',
  texto   = 'Guia completo: por que gotas, como tomar, linha do tempo honesta (1–7 d, 7–21 d, 4–12 sem) e a garantia como redutor de ansiedade.',
  botao   = 'Questions? Talk to us →',
  destino = 'ASSISTENTE'
 WHERE etapa = 5 AND canal = 'email';

UPDATE mensagens_regua SET
  texto = 'Hi {nome}, great news! {produto} is almost there. Check your inbox for an important update to read before it arrives. Reply STOP to end'
 WHERE etapa = 5 AND canal = 'sms';
