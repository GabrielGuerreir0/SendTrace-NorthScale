-- ═══════════════════════════════════════════════════════════════════════════
--  114 · Suporte Humano — Propriedades automáticas também para ticket que a plataforma reembolsa DEPOIS (achado da Késsia no #9426, 20/10/2026)
--
--  A 104 só preenche quando o SISTEMA move o card para "Reembolsado". Ticket que já estava Finalizado (ou em outra coluna) quando a plataforma reembolsou
--  nunca passava por lá e ficava com as Propriedades em branco. `preencher_propriedades_reembolso_plataforma` roda na mesma rotina de 30 min dos
--  indicadores (api/servidor.js) e preenche, com os mesmos valores da 104:
--      Reembolso / Sem informação - Reembolsado pela plataforma / Reembolsado pela plataforma / Fechado
--  Regras (conservadoras):
--    · só ticket principal (sem ticket_mae_id) criado nos últimos 365 dias, com reembolso da plataforma DEPOIS da criação do ticket e o cliente SEM compra ativa
--      (reembolso parcial, só um upsell, não conta);
--    · só ficha SEM Motivo do contato e sem edição de pessoa (propriedades_atualizado_por vazio ou 'Sistema') — nunca sobrescreve o que a equipe salvou;
--    · não mexe em card que está em "Reembolsado" (pessoa que arrasta para lá escolhe não preencher — regra da 104);
--    · não muda a coluna do card nem o status do kanban.
--  `p_simular = true` só conta (devolve quantos receberiam), sem gravar. Aditiva e idempotente.
--  Desfazer: DROP FUNCTION email_ia.preencher_propriedades_reembolso_plataforma(boolean);  (e tirar a chamada em api/servidor.js)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.preencher_propriedades_reembolso_plataforma(p_simular boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE v_n integer;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _prop_reemb (caso_id bigint PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _prop_reemb;
  INSERT INTO _prop_reemb
  SELECT c.id
    FROM (
      SELECT s.id, lower(s.remetente_email) AS email, s.criado_em
        FROM email_ia.suporte_escalado s
        LEFT JOIN email_ia.suporte_escalado_ficha f ON f.suporte_escalado_id = s.id
       WHERE s.ticket_mae_id IS NULL AND s.criado_em > now() - interval '365 days' AND s.status <> 'reembolsado'
         AND coalesce(f.motivo_contato, '') = ''
         AND (f.propriedades_atualizado_por IS NULL OR f.propriedades_atualizado_por = 'Sistema')
    ) c
   WHERE (SELECT max(d.reembolsado_em) FROM public.disparos_pos_venda d WHERE lower(d.email) = c.email AND d.reembolsado_em IS NOT NULL) > c.criado_em
     AND NOT email_ia.cliente_tem_compra_ativa(c.email);
  SELECT count(*) INTO v_n FROM _prop_reemb;
  IF NOT p_simular AND v_n > 0 THEN
    INSERT INTO email_ia.suporte_escalado_ficha
           (suporte_escalado_id, motivo_contato, detalhamento_motivo, tipo_resolucao, status_ticket,
            propriedades_atualizado_por, propriedades_atualizado_em, atualizado_por)
    SELECT p.caso_id, 'Reembolso', 'Sem informação - Reembolsado pela plataforma', 'Reembolsado pela plataforma', 'Fechado', 'Sistema', now(), 'Sistema'
      FROM _prop_reemb p
    ON CONFLICT (suporte_escalado_id) DO UPDATE
       SET motivo_contato = EXCLUDED.motivo_contato, detalhamento_motivo = EXCLUDED.detalhamento_motivo,
           tipo_resolucao = EXCLUDED.tipo_resolucao, status_ticket = EXCLUDED.status_ticket,
           propriedades_atualizado_por = 'Sistema', propriedades_atualizado_em = now(), atualizado_por = 'Sistema', atualizado_em = now()
     WHERE coalesce(email_ia.suporte_escalado_ficha.motivo_contato, '') = ''
       AND (email_ia.suporte_escalado_ficha.propriedades_atualizado_por IS NULL OR email_ia.suporte_escalado_ficha.propriedades_atualizado_por = 'Sistema');
  END IF;
  RETURN v_n;
END $f$;
