-- ═══════════════════════════════════════════════════════════════════════════
--  104 · Suporte Humano — caso movido PELO SISTEMA para "Reembolsado" já nasce com as Propriedades preenchidas (pedido da Késsia/Lucas, 16/10/2026)
--
--  Quando o sistema (regra de recorrência, rotina diária de reembolsados, n8n) coloca um caso em "Reembolsado" porque a plataforma já reembolsou o cliente,
--  a ficha recebe sozinha:
--      Motivo do contato ........ Reembolso
--      Detalhamento do motivo ... Sem informação - Reembolsado pela plataforma   (opção nova, criada na API junto desta migração)
--      Tipo de resolução ........ Reembolsado pela plataforma
--      Status do ticket ......... Fechado
--  · Só vale para movimento do SISTEMA: se uma pessoa arrasta o card para Reembolsado (sessão com 'sendtrace.usuario'), a ficha não é tocada.
--  · Não sobrescreve o que uma pessoa já preencheu: só mexe se a ficha não existe ou se a última alteração das Propriedades foi do 'Sistema' (ou nunca houve).
--  · Só vale daqui para frente (não mexe nos casos que já estão em Reembolsado).
--  · Cliente que escrever depois num ticket Fechado reabre o ticket pela regra da 085 (status → Aberto + tag TICKET REABERTO).
--  Aditiva e idempotente. Desfazer: DROP TRIGGER trg_reembolsado_preenche_propriedades ON email_ia.suporte_escalado; DROP FUNCTION email_ia.trg_reembolsado_preenche_propriedades();
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.trg_reembolsado_preenche_propriedades() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.status = 'reembolsado' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'reembolsado')
     AND nullif(current_setting('sendtrace.usuario', true), '') IS NULL THEN
    INSERT INTO email_ia.suporte_escalado_ficha
           (suporte_escalado_id, motivo_contato, detalhamento_motivo, tipo_resolucao, status_ticket,
            propriedades_atualizado_por, propriedades_atualizado_em, atualizado_por)
    VALUES (NEW.id, 'Reembolso', 'Sem informação - Reembolsado pela plataforma', 'Reembolsado pela plataforma', 'Fechado',
            'Sistema', now(), 'Sistema')
    ON CONFLICT (suporte_escalado_id) DO UPDATE
       SET motivo_contato = EXCLUDED.motivo_contato, detalhamento_motivo = EXCLUDED.detalhamento_motivo,
           tipo_resolucao = EXCLUDED.tipo_resolucao, status_ticket = EXCLUDED.status_ticket,
           propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_por = 'Sistema', atualizado_em = now()
     WHERE email_ia.suporte_escalado_ficha.propriedades_atualizado_por IS NULL
        OR email_ia.suporte_escalado_ficha.propriedades_atualizado_por = 'Sistema';
  END IF;
  RETURN NULL;
END $f$;

DROP TRIGGER IF EXISTS trg_reembolsado_preenche_propriedades ON email_ia.suporte_escalado;
CREATE TRIGGER trg_reembolsado_preenche_propriedades AFTER INSERT OR UPDATE OF status ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_reembolsado_preenche_propriedades();
