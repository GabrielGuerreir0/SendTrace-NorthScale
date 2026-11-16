-- ════════════════════════════════════════════════════════════════════════════
--  129 · Pesquisa de motivo de estorno — reembolso, alerta de chargeback e chargeback (pedido do Lucas, 15/11/2026; ClickUp 1dfjmjuc53z)
--
--  Quem estornou SEM falar com o suporte recebe um e-mail (12 h depois) com link para uma página única de perguntas de marcar.
--  Só JVZoo e Vupim, de 15/11/2026 em diante. Três tabelas:
--
--  1) pesquisa_estorno_perguntas — as perguntas, EDITÁVEIS pela tela do painel e VERSIONADAS: editar grava uma versão nova
--     (chave igual, versao + 1); a atual é a de maior versão (view pesquisa_estorno_perguntas_atuais). `ativa = false` tira a
--     pergunta da página sem apagar o histórico. Cada resposta guarda a versão que a pessoa viu, para não misturar texto antigo e novo.
--       grupo:      'todos' | 'reembolso' (pediu reembolso, REFUND) | 'banco' (foi ao banco: ALERT ou chargeback/DISPUTE)
--       tipo:       'unica' (marcar uma) | 'nota' (0 a 10) | 'texto' (campo livre)
--       opcoes:     [{"valor": "sem_resultado", "rotulo": "I didn't see..."}]  (valor é estável; rótulo é o texto da tela)
--       mostrar_se: {"pergunta": "motivo", "valores": ["sem_resultado"]} — só aparece se a resposta daquela pergunta estiver na lista.
--                   Se a pergunta citada não aparece para o grupo (ex.: 'reconhece' no reembolso), a condição vale.
--       texto_banco: texto alternativo para o grupo 'banco' (NULL = o mesmo texto).
--  2) pesquisa_estorno_convites — um por estorno elegível (venda principal ou upsell), com token próprio e o funil
--     (enviado, aberto, clicou, iniciou, concluiu). `descartado` = por que não foi enviado (falou com o suporte, descadastrado...).
--  3) pesquisa_estorno_respostas — uma por pergunta respondida.
--
--  Aditiva e idempotente (o seed só entra se a pergunta ainda não existe). Desfazer: DROP das 3 tabelas e da view.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pesquisa_estorno_perguntas (
  chave        text        NOT NULL CHECK (chave ~ '^[a-z][a-z0-9_]{1,39}$'),
  versao       integer     NOT NULL CHECK (versao > 0),
  grupo        text        NOT NULL CHECK (grupo IN ('todos', 'reembolso', 'banco')),
  ordem        integer     NOT NULL,
  tipo         text        NOT NULL CHECK (tipo IN ('unica', 'nota', 'texto')),
  texto        text        NOT NULL CHECK (length(texto) BETWEEN 3 AND 300),
  texto_banco  text        CHECK (texto_banco IS NULL OR length(texto_banco) BETWEEN 3 AND 300),
  opcoes       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  mostrar_se   jsonb,
  obrigatoria  boolean     NOT NULL DEFAULT true,
  ativa        boolean     NOT NULL DEFAULT true,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  criado_por   text,
  PRIMARY KEY (chave, versao)
);

CREATE OR REPLACE VIEW pesquisa_estorno_perguntas_atuais AS
  SELECT DISTINCT ON (chave) * FROM pesquisa_estorno_perguntas ORDER BY chave, versao DESC;

CREATE TABLE IF NOT EXISTS pesquisa_estorno_convites (
  id                    bigserial   PRIMARY KEY,
  token                 text        NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  origem                text        NOT NULL CHECK (origem IN ('venda', 'upsell')),
  ref_id                bigint      NOT NULL,          -- disparos_pos_venda.id ou compras_upsell_downsell.id
  plataforma            text        NOT NULL,
  transacao_id          text,
  email                 text        NOT NULL,
  nome                  text,
  produto               text,
  estorno_tipo          text,                          -- REFUND | ALERT | DISPUTE (JVZoo) | CHARGEBACK (Vupim)
  grupo                 text        NOT NULL CHECK (grupo IN ('reembolso', 'banco')),
  estornado_em          timestamptz,
  enviar_apos           timestamptz,                   -- estornado_em + 12 h
  criado_em             timestamptz NOT NULL DEFAULT now(),
  email_enviado_em      timestamptz,
  email_message_id      text,
  lembrete_enviado_em   timestamptz,
  lembrete_message_id   text,
  aberto_em             timestamptz,
  clicou_em             timestamptz,
  iniciado_em           timestamptz,
  concluido_em          timestamptz,
  suspeita_fraude       boolean     NOT NULL DEFAULT false,
  descartado            text,
  UNIQUE (origem, ref_id)
);
CREATE INDEX IF NOT EXISTS pesquisa_estorno_convites_envio_idx ON pesquisa_estorno_convites (enviar_apos) WHERE email_enviado_em IS NULL AND descartado IS NULL;
CREATE INDEX IF NOT EXISTS pesquisa_estorno_convites_email_idx ON pesquisa_estorno_convites (lower(email));

CREATE TABLE IF NOT EXISTS pesquisa_estorno_respostas (
  convite_id       bigint      NOT NULL REFERENCES pesquisa_estorno_convites(id) ON DELETE CASCADE,
  pergunta_chave   text        NOT NULL,
  pergunta_versao  integer     NOT NULL,
  valor            text,                               -- NULL = pulou (pergunta opcional)
  respondido_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (convite_id, pergunta_chave),
  FOREIGN KEY (pergunta_chave, pergunta_versao) REFERENCES pesquisa_estorno_perguntas (chave, versao)
);

-- Versão 1 das perguntas (texto aprovado pelo Lucas em 15/11/2026). Só entra se a chave ainda não existe.
INSERT INTO pesquisa_estorno_perguntas (chave, versao, grupo, ordem, tipo, texto, texto_banco, opcoes, mostrar_se, obrigatoria, criado_por)
SELECT v.chave, 1, v.grupo, v.ordem, v.tipo, v.texto, v.texto_banco, v.opcoes::jsonb, v.mostrar_se::jsonb, v.obrigatoria, 'migração 129'
FROM (VALUES
  ('reconhece', 'banco', 10, 'unica', 'Do you recognize this purchase?', NULL,
   '[{"valor":"sim","rotulo":"Yes, I recognize it"},{"valor":"nao","rotulo":"No, I don''t recognize it"}]', NULL, true),
  ('motivo', 'todos', 20, 'unica', 'What was the main reason for your refund?', 'What was the main reason you contacted your bank?',
   '[{"valor":"sem_resultado","rotulo":"I didn''t see the results I expected"},{"valor":"nao_chegou","rotulo":"My order didn''t arrive or took too long"},{"valor":"diferente","rotulo":"The product was different from what I expected"},{"valor":"mal_estar","rotulo":"I didn''t feel well using it"},{"valor":"cobranca","rotulo":"I didn''t recognize a charge"},{"valor":"engano","rotulo":"I bought it by mistake"},{"valor":"outro","rotulo":"Something else"}]',
   '{"pergunta":"reconhece","valores":["sim"]}', true),
  ('tempo_uso', 'todos', 30, 'unica', 'How long did you use it?', NULL,
   '[{"valor":"menos_1_semana","rotulo":"Less than 1 week"},{"valor":"1_2_semanas","rotulo":"1 to 2 weeks"},{"valor":"3_4_semanas","rotulo":"3 to 4 weeks"},{"valor":"mais_1_mes","rotulo":"More than a month"},{"valor":"nao_usou","rotulo":"I didn''t use it"}]',
   '{"pergunta":"motivo","valores":["sem_resultado"]}', true),
  ('recebeu_rastreio', 'todos', 31, 'unica', 'Did you receive a tracking code by email?', NULL,
   '[{"valor":"sim","rotulo":"Yes"},{"valor":"nao","rotulo":"No"},{"valor":"nao_lembra","rotulo":"I don''t remember"}]',
   '{"pergunta":"motivo","valores":["nao_chegou"]}', true),
  ('cobranca_qual', 'todos', 32, 'unica', 'Which charge didn''t you recognize?', NULL,
   '[{"valor":"produto","rotulo":"The product itself"},{"valor":"adicional","rotulo":"An additional product added to my order"},{"valor":"duplicada","rotulo":"I was charged more than once"},{"valor":"nao_sabe","rotulo":"I''m not sure"}]',
   '{"pergunta":"motivo","valores":["cobranca"]}', true),
  ('contatou_suporte', 'todos', 40, 'unica', 'Did you try to contact our support before?', NULL,
   '[{"valor":"sim_sem_resposta","rotulo":"Yes, but I didn''t get an answer"},{"valor":"sim_nao_resolveu","rotulo":"Yes, but it didn''t solve my problem"},{"valor":"nao_sabia","rotulo":"No, I didn''t know how"},{"valor":"preferiu_banco","rotulo":"No, I preferred to go to my bank"},{"valor":"nao","rotulo":"No"}]',
   '{"pergunta":"reconhece","valores":["sim"]}', true),
  ('nota', 'todos', 50, 'nota', 'How likely are you to buy from us again?', NULL, '[]',
   '{"pergunta":"reconhece","valores":["sim"]}', false),
  ('comentario', 'todos', 60, 'texto', 'Anything else you would like to tell us?', NULL, '[]', NULL, false)
) AS v(chave, grupo, ordem, tipo, texto, texto_banco, opcoes, mostrar_se, obrigatoria)
WHERE NOT EXISTS (SELECT 1 FROM pesquisa_estorno_perguntas p WHERE p.chave = v.chave);
