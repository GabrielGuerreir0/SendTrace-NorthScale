-- ═══════════════════════════════════════════════════════════════════════════
--  143 · Suporte Humano: "Novo ticket" (ticket iniciado PELA EQUIPE, para mandar um e-mail pontual a um cliente)
--
--  Pedido da Késsia (CS): hoje o ticket só nasce quando o cliente escreve. A equipe precisa abrir o ticket, escolher o cliente (e-mail ou nº do pedido),
--  mandar a mensagem (ou um modelo pronto) e deixar tudo registrado; se o cliente responder, a resposta entra NO MESMO ticket.
--
--  • O ticket é um card REAL de email_ia.suporte_escalado (único por remetente: idx_suporte_escalado_email). O fluxo do n8n que lê support@ faz
--    INSERT ... ON CONFLICT (lower(remetente_email)) DO UPDATE: a resposta do cliente atualiza o card que já existe (email_id, ultimo_email_cliente_em).
--  • `origem` JÁ EXISTE nessa tabela (NULL = ticket normal do cliente · 'pos_forms_30d' · 'sppl'); o valor novo é 'equipe'. Nenhuma coluna `origem` é criada
--    aqui e o default NÃO muda. Gatilhos/funções que comparam `origem` (080, 092, 095, 100) só tratam 'pos_forms_30d' e 'sppl': 'equipe' passa por todos sem efeito.
--  • Colunas novas: `iniciado_por` (quem da equipe enviou) e `iniciado_pela_equipe_em` (quando). (A migração 144 também pode declará-las: IF NOT EXISTS.)
--  • SEM SLA contra o agente: o ticket nasce com primeira_resposta_agente_em = ultima_resposta_agente_em = horário do envio e ultimo_email_cliente_em NULL.
--    A "vez do agente" (v_sla_suporte_escalado) só liga quando ultimo_email_cliente_em > ultima_resposta_agente_em, ou seja, quando o cliente responder.
--    O e-mail inicial NÃO entra em email_ia.respostas_agente (inflaria "e-mails respondidos" e a 1ª resposta); fica na tabela abaixo.
--  • email_ia.suporte_equipe_envios = fila + registro dos e-mails da equipe (quem, quando, modelo, pedido, texto) — o histórico do cliente e do pedido.
--    A linha nasce 'fila'; quem envia (api/novoTicketHumanoEnvios.js) manda o e-mail e SÓ ENTÃO cria o ticket (falha de envio não deixa ticket vazio).
--
--  Só ADICIONA. Idempotente (pode rodar duas vezes).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS iniciado_por text;
ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS iniciado_pela_equipe_em timestamptz;
COMMENT ON COLUMN email_ia.suporte_escalado.iniciado_por IS 'Quem da equipe abriu o ticket pelo "Novo ticket" (origem = equipe) — 143';
COMMENT ON COLUMN email_ia.suporte_escalado.iniciado_pela_equipe_em IS 'Quando o e-mail inicial da equipe foi enviado (origem = equipe) — 143';
CREATE INDEX IF NOT EXISTS suporte_escalado_equipe_idx ON email_ia.suporte_escalado (iniciado_pela_equipe_em) WHERE origem = 'equipe';

CREATE TABLE IF NOT EXISTS email_ia.suporte_equipe_envios (
  id                   bigserial PRIMARY KEY,
  lote                 text        NOT NULL,                     -- um lote por clique em "Confirmar" (um ou vários clientes)
  para_email           text        NOT NULL,                     -- UM destinatário por mensagem (ninguém vê os dados de outro cliente)
  nome                 text,
  numero_pedido        text,                                     -- pedido vinculado (NULL = cliente sem pedido localizado)
  pedido_transacao_id  text,
  produto              text,
  plataforma           text,
  idioma               text        NOT NULL DEFAULT 'en',        -- 'en' (padrão, é o que o cliente americano recebe) | 'pt'
  assunto              text        NOT NULL,                     -- já personalizado para o cliente
  texto                text        NOT NULL,
  modelo_id            text,                                     -- sppl_ativo_modelos.id (NULL = texto escrito na hora)
  modelo_nome          text,
  motivo_contato       text,
  board_id             bigint,                                   -- board (agente) dono do ticket
  criado_por           text,
  criado_por_id        bigint,
  status               text        NOT NULL DEFAULT 'fila',
  tentativas           smallint    NOT NULL DEFAULT 0,
  erro                 text,
  message_id           text,
  caso_id              bigint REFERENCES email_ia.suporte_escalado(id) ON DELETE SET NULL,   -- o ticket criado/vinculado
  criado_em            timestamptz NOT NULL DEFAULT now(),
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  enviado_em           timestamptz
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_equipe_envios_status_chk') THEN
    ALTER TABLE email_ia.suporte_equipe_envios ADD CONSTRAINT suporte_equipe_envios_status_chk CHECK (status IN ('fila', 'enviando', 'enviado', 'falhou', 'cancelado'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS suporte_equipe_envios_fila_idx ON email_ia.suporte_equipe_envios (status, proxima_tentativa_em);
CREATE INDEX IF NOT EXISTS suporte_equipe_envios_lote_idx ON email_ia.suporte_equipe_envios (lote);
CREATE INDEX IF NOT EXISTS suporte_equipe_envios_email_idx ON email_ia.suporte_equipe_envios (lower(para_email), status);
CREATE INDEX IF NOT EXISTS suporte_equipe_envios_caso_idx ON email_ia.suporte_equipe_envios (caso_id, enviado_em DESC) WHERE caso_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS suporte_equipe_envios_pedido_idx ON email_ia.suporte_equipe_envios (pedido_transacao_id) WHERE pedido_transacao_id IS NOT NULL;
COMMENT ON TABLE email_ia.suporte_equipe_envios IS 'E-mails iniciados pela equipe no Suporte Humano ("Novo ticket", 143): fila de envio + histórico (quem, quando, modelo, pedido). Não entra em respostas_agente.';
