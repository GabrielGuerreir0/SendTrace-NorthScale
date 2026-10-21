-- ═══════════════════════════════════════════════════════════════════════════
--  118 · "Reembolsado pela plataforma" — classificação automática em 3 resultados (pedido da Késsia/Rodrigo, 21/10/2026)
--
--  Resolução "Reembolsado pela plataforma" passa a receber, sozinha, um destes tipos de resolução:
--      Reembolsado pela plataforma - Sem atendimento    (o agente não teve chance real de reverter)
--      Reembolsado pela plataforma - Evasão provável    (o agente atuou antes do reembolso e o cliente recusou/sumiu)
--      Reembolsado pela plataforma - Outros             (sem evasão e sem prova de que a plataforma foi mais rápida)
--  Camada 1 (esta migração, view abaixo) resolve por datas; camada 2 (api/reembolsoPlataforma.js) lê a conversa com IA.
--  Quem guarda o quê (colunas novas na ficha): como foi decidido (SQL/IA), confiança, motivo, "revisar", quando e a ASSINATURA da conversa
--  (e-mails do cliente | respostas do agente | data do reembolso | data do chargeback), usada pelo gatilho para só reavaliar quando algo mudou.
--  A rotina nasce DESLIGADA (config_disparos reembolso_plataforma_ativo = 'false'); o backfill e a simulação rodam pelo terminal (api/reembolsoPlataformaCli.js).
--  Aditiva e idempotente. Desfazer: ver reembolso_plataforma_log (guarda o tipo de antes de cada ficha) e DROP das colunas/view/tabelas.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE email_ia.suporte_escalado_ficha
  ADD COLUMN IF NOT EXISTS reembolso_plat_origem text,
  ADD COLUMN IF NOT EXISTS reembolso_plat_confianca text,
  ADD COLUMN IF NOT EXISTS reembolso_plat_motivo text,
  ADD COLUMN IF NOT EXISTS reembolso_plat_revisar boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reembolso_plat_avaliado_em timestamptz,
  ADD COLUMN IF NOT EXISTS reembolso_plat_assinatura text;
COMMENT ON COLUMN email_ia.suporte_escalado_ficha.reembolso_plat_origem IS 'SQL (camada 1), IA (camada 2) ou REGRA (sem e-mail do cliente) — 118.';
COMMENT ON COLUMN email_ia.suporte_escalado_ficha.reembolso_plat_revisar IS 'true = confiança baixa da IA: marcado para revisão humana — 118.';

-- Camada 1 (a lógica da Késsia): primeira resposta do agente x data do reembolso. Resposta de ticket mesclado conta no ticket principal.
CREATE OR REPLACE VIEW email_ia.v_reembolso_plataforma_camada1 AS
WITH ag AS (
  SELECT coalesce(s.ticket_mae_id, s.id) AS caso_id, min(r.enviado_em) AS p_resp
    FROM email_ia.respostas_agente r JOIN email_ia.suporte_escalado s ON s.id = r.caso_id
   GROUP BY 1
), b AS (
  SELECT s.id AS caso_id, f.data_reembolso_total AS dr, ag.p_resp
    FROM email_ia.suporte_escalado s
    JOIN email_ia.suporte_escalado_ficha f ON f.suporte_escalado_id = s.id
    LEFT JOIN ag ON ag.caso_id = s.id
   WHERE s.ticket_mae_id IS NULL
     AND f.tipo_resolucao IN ('Reembolsado pela plataforma', 'Reembolsado pela plataforma - Sem atendimento', 'Reembolsado pela plataforma - Evasão provável', 'Reembolsado pela plataforma - Outros')
)
SELECT caso_id,
  CASE WHEN p_resp IS NULL THEN 'Reembolsado pela plataforma - Sem atendimento'
       WHEN dr IS NOT NULL AND (p_resp AT TIME ZONE 'America/Sao_Paulo')::date >= dr THEN 'Reembolsado pela plataforma - Sem atendimento'
       ELSE NULL END AS status_camada1,   -- NULL = vai para a camada 2 (IA)
  CASE WHEN p_resp IS NULL THEN 'agente nunca respondeu'
       WHEN dr IS NOT NULL AND (p_resp AT TIME ZONE 'America/Sao_Paulo')::date >= dr THEN 'primeira resposta no dia ou depois do reembolso' END AS motivo_camada1
  FROM b;

-- Cada decisão da IA fica guardada por ticket e por conversa (assinatura e-mails|respostas) + modelo/versão do prompt: não gasta IA de novo nem oscila.
CREATE TABLE IF NOT EXISTS email_ia.reembolso_plataforma_avaliacoes (
  id bigserial PRIMARY KEY,
  caso_id bigint NOT NULL,
  conversa text NOT NULL,                 -- "n_emails|n_respostas"
  categoria text NOT NULL,                -- SEM_ATENDIMENTO | EVASAO_PROVAVEL | OUTROS
  confianca text NOT NULL,                -- alta | media | baixa
  motivo text,
  modelo text NOT NULL,                   -- modelo|versão do prompt
  avaliado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (caso_id, conversa, modelo)
);
-- Histórico do que a rotina mudou (para desfazer).
CREATE TABLE IF NOT EXISTS email_ia.reembolso_plataforma_log (
  id bigserial PRIMARY KEY,
  caso_id bigint NOT NULL,
  tipo_antes text, tipo_depois text NOT NULL,
  origem text NOT NULL, confianca text, motivo text, revisar boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reembolso_plataforma_log_caso_idx ON email_ia.reembolso_plataforma_log (caso_id);

INSERT INTO config_disparos (chave, valor) VALUES ('reembolso_plataforma_ativo', 'false') ON CONFLICT (chave) DO NOTHING;
INSERT INTO config_disparos (chave, valor) VALUES ('reembolso_plataforma_modelo', 'claude-sonnet-5') ON CONFLICT (chave) DO NOTHING;

DO $$ BEGIN
  IF to_regprocedure('public.atualizar_grants_leitura()') IS NOT NULL THEN PERFORM public.atualizar_grants_leitura(); END IF;
END $$;
