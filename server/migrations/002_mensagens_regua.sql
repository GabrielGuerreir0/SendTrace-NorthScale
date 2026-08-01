-- ═══════════════════════════════════════════════════════════════════════════
--  002 · A régua real: cadência (etapas_regua) × copy por canal (mensagens_regua)
--
--  MUDANÇA DE MODELO. Na 001 cada etapa tinha UM canal. Errado: no workflow
--  real toda etapa dispara E-MAIL E SMS AO MESMO TEMPO. Então:
--
--    etapas_regua      QUANDO dispara  → etapa, nome, espera_h, ativo
--    mensagens_regua   O QUE diz       → (etapa, canal) → assunto, texto, CTA
--
--  A coluna `canal` sai de etapas_regua: uma etapa não tem canal, ela tem uma
--  mensagem POR canal. Quem tem canal é a mensagem.
--
--  Continua sem tocar em disparos_pos_venda — nenhuma linha da fila é lida,
--  alterada ou apagada por esta migração.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. etapas_regua vira só cadência ───────────────────────────────────────

-- Meia hora não cabe em integer: a etapa 0 dispara 30 min após a compra, então
-- a espera dela até o Dia 1 é 23,5 h.
ALTER TABLE etapas_regua ALTER COLUMN espera_h TYPE numeric(8,2);

ALTER TABLE etapas_regua DROP COLUMN IF EXISTS canal;
ALTER TABLE etapas_regua DROP COLUMN IF EXISTS titulo;
ALTER TABLE etapas_regua DROP COLUMN IF EXISTS mensagem;

-- Quando a etapa dispara, contado da ENTRADA na fila (a compra). Existe porque
-- a etapa 0 não dispara em t=0: espera 30 min. Sem isto o painel não consegue
-- comparar a régua escrita com a observada na primeira etapa.
ALTER TABLE etapas_regua ADD COLUMN IF NOT EXISTS offset_h numeric(8,2);

COMMENT ON COLUMN etapas_regua.offset_h IS 'Horas desde a compra até esta etapa disparar. Etapa 0 = 0.5 (30 min).';
COMMENT ON COLUMN etapas_regua.espera_h IS 'Horas até a PRÓXIMA etapa. NULL = etapa final.';

-- ── 2. mensagens_regua: a copy, uma linha por (etapa, canal) ───────────────

CREATE TABLE IF NOT EXISTS mensagens_regua (
  etapa         smallint     NOT NULL REFERENCES etapas_regua(etapa) ON DELETE CASCADE,
  canal         text         NOT NULL CHECK (canal IN ('email', 'sms')),

  -- Só e-mail. No SMS fica NULL: SMS não tem assunto.
  assunto       text,
  -- SMS: o texto integral que sai. E-mail: a linha de abertura, para o painel
  -- mostrar do que a mensagem trata sem despejar o HTML inteiro na tela.
  texto         text         NOT NULL,
  -- Rótulo e destino do botão (só e-mail).
  botao         text,
  destino       text         CHECK (destino IS NULL OR destino IN ('EBOOK', 'ASSISTENTE')),

  -- Opcional: o HTML completo, se você quiser que o n8n leia a copy daqui em
  -- vez de manter os TEMPLATES hardcoded no nó de Code. O painel não renderiza
  -- este campo — ele existe para o n8n.
  corpo_html    text,

  ativo         boolean      NOT NULL DEFAULT true,
  atualizado_em timestamptz  NOT NULL DEFAULT now(),

  PRIMARY KEY (etapa, canal)
);

COMMENT ON TABLE  mensagens_regua IS 'Copy de cada etapa, por canal. Toda etapa dispara e-mail e SMS simultaneamente.';
COMMENT ON COLUMN mensagens_regua.texto IS 'SMS: mensagem integral. E-mail: linha de abertura (o HTML completo vai em corpo_html).';

CREATE INDEX IF NOT EXISTS mensagens_regua_canal_idx ON mensagens_regua (canal);

-- ── 3. A régua real, extraída do nó de Code do n8n ─────────────────────────
--
--  6 etapas: 30 min após a compra, depois Dia 1 a Dia 5.
--  As esperas abaixo são a leitura dos comentários do workflow. Se o worker
--  estiver rodando outra cadência, o painel acusa — é para isso que existe o
--  "régua escrita × régua que roda".
--
--  Sobrescreve os placeholders da 001 (DO UPDATE, não DO NOTHING). Daqui em
--  diante suas edições são suas: nenhuma migração futura mexe nestas linhas.

INSERT INTO etapas_regua (etapa, nome, offset_h, espera_h, descricao) VALUES
  (0, 'Confirmação + e-book',    0.5,  23.5, '30 min após a compra · pedido confirmado e brinde liberado'),
  (1, 'Logística + formato',     24,   24,   'Dia 1 · status do envio e por que a fórmula é líquida'),
  (2, 'Logística — Dia 2',       48,   24,   'Dia 2 · etiqueta em processamento'),
  (3, 'Logística — Dia 3',       72,   24,   'Dia 3 · saiu para entrega, rastreio a caminho'),
  (4, 'A caminho + pergunta',    96,   24,   'Dia 4 · em trânsito e convite para responder'),
  (5, 'Guia de uso completo',    120,  NULL, 'Dia 5 · modo de uso e expectativa — última automática')
ON CONFLICT (etapa) DO UPDATE
   SET nome          = EXCLUDED.nome,
       offset_h      = EXCLUDED.offset_h,
       espera_h      = EXCLUDED.espera_h,
       descricao     = EXCLUDED.descricao,
       atualizado_em = now();

-- ── 4. As mensagens: e-mail e SMS de cada etapa ────────────────────────────

INSERT INTO mensagens_regua (etapa, canal, assunto, texto, botao, destino) VALUES
  (0, 'email',
      '{nome}, your {produto} order is confirmed — your free gift is inside',
      'You just made a decision most people never make. Order confirmed, and the Sharp Mind After 40 Guide is yours right now.',
      'Download Your Free Guide →', 'EBOOK'),
  (0, 'sms', NULL,
      '{nome}, you just made a great choice for your brain health! We sent you something important - check your email now. Reply STOP to end',
      NULL, NULL),

  (1, 'email',
      '{nome}, your {produto} order is on track',
      'Where the order stands today, plus why {produto} is a liquid formula and not capsules.',
      'Open the Free Guide →', 'EBOOK'),
  (1, 'sms', NULL,
      'Hi {nome}, we just sent an update regarding your {produto} order. Check your inbox now! Reply STOP to end',
      NULL, NULL),

  (2, 'email',
      '{nome}, your {produto} is progressing well',
      'Day 2: prepared and ready to ship, shipping label being processed.',
      'Questions about my order →', 'ASSISTENTE'),
  (2, 'sms', NULL,
      'Hi {nome}, we just sent a Day 2 update regarding your {produto} order. Check your inbox now! Reply STOP to end',
      NULL, NULL),

  (3, 'email',
      '{nome}, quick update on your {produto} shipment',
      'Day 3: handed to the carrier and on its way — tracking link arriving in your inbox.',
      'Check my order →', 'ASSISTENTE'),
  (3, 'sms', NULL,
      'Hi {nome}, your {produto} is moving! We just emailed you a Day 3 update - check your inbox. Reply STOP to end',
      NULL, NULL),

  (4, 'email',
      '{nome}, your {produto} is on its way — one question for you',
      'Day 4: in transit. And a question — what moment are you most looking forward to?',
      'Check my order →', 'ASSISTENTE'),
  (4, 'sms', NULL,
      'Hi {nome}, your {produto} is getting closer! Our team just emailed you and we''d love your feedback - check your inbox. Reply STOP to end',
      NULL, NULL),

  (5, 'email',
      '{nome}, read this before your {produto} arrives',
      'The complete usage guide: why liquid drops, how to take it, and the honest week-by-week timeline.',
      'Questions? Talk to us →', 'ASSISTENTE'),
  (5, 'sms', NULL,
      'Hi {nome}, great news! {produto} is almost there. Check your inbox for an important update to read before it arrives. Reply STOP to end',
      NULL, NULL)
ON CONFLICT (etapa, canal) DO UPDATE
   SET assunto       = EXCLUDED.assunto,
       texto         = EXCLUDED.texto,
       botao         = EXCLUDED.botao,
       destino       = EXCLUDED.destino,
       atualizado_em = now();
