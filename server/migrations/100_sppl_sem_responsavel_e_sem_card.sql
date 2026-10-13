-- ═══════════════════════════════════════════════════════════════════════════
--  100 · SPPL — alertas de logística SEM responsável e SEM card no Suporte Humano/Escalado (decisão do Lucas, 13/10/2026: "não pode acontecer nunca mais")
--
--  Os alertas ficam só na tela de Alertas (Rastreio → SPPL), para qualquer pessoa com acesso resolver. O SPPL não pode:
--    · sortear nem gravar responsável (board_id fica NULL);
--    · abrir, reabrir ou mexer em card do Suporte Escalado/Humano;
--    · influenciar o roteamento de cards de leads.
--  Faz: (1) as funções que abriam card e sorteavam responsável viram no-op (devolvem NULL); (2) remove o gatilho que mandava o card novo de um lead para o "dono do alerta";
--  (3) gatilho que BLOQUEIA qualquer card com origem 'sppl' (se alguém tentar criar de novo, o banco recusa). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sppl_abrir_card(p_ocorrencia bigint) RETURNS bigint LANGUAGE sql AS $f$ SELECT NULL::bigint $f$;
COMMENT ON FUNCTION public.sppl_abrir_card(bigint) IS 'DESATIVADA (100): o SPPL não abre card no Suporte Escalado/Humano. Devolve sempre NULL.';

CREATE OR REPLACE FUNCTION email_ia.sppl_escolher_board() RETURNS bigint LANGUAGE sql AS $f$ SELECT NULL::bigint $f$;
CREATE OR REPLACE FUNCTION email_ia.sppl_escolher_board_para(p_transacao text) RETURNS bigint LANGUAGE sql AS $f$ SELECT NULL::bigint $f$;
COMMENT ON FUNCTION email_ia.sppl_escolher_board() IS 'DESATIVADA (100): alerta de logística não tem responsável. Devolve sempre NULL.';

DROP TRIGGER IF EXISTS trg_suporte_escalado_sppl_dono ON email_ia.suporte_escalado;

CREATE OR REPLACE FUNCTION email_ia.trg_bloquear_card_sppl() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.origem = 'sppl' AND (TG_OP = 'INSERT' OR OLD.origem IS DISTINCT FROM 'sppl') THEN
    RAISE EXCEPTION 'Alertas do SPPL não geram card no Suporte Humano/Escalado (decisão de 13/10/2026): ficam só na tela de Alertas.';
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_bloquear_card_sppl ON email_ia.suporte_escalado;
CREATE TRIGGER trg_bloquear_card_sppl BEFORE INSERT OR UPDATE OF origem ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_bloquear_card_sppl();
