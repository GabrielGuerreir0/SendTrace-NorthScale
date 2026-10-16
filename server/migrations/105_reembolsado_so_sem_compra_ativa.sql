-- ═══════════════════════════════════════════════════════════════════════════
--  105 · Suporte Humano — pedido principal estornado com upsell ainda ativo NÃO vai para "Reembolsado": fica na fila do agente (16/10/2026)
--
--  Origem: ticket #15696 (Késsia) — cliente com pedido principal reembolsado e 3 upsells aprovados foi movido sozinho para Reembolsado (fora da fila) em 5 minutos
--  pelo nó "Limpar Kanban: Pedidos Já Reembolsados" do n8n (qualquer disparo cancelado/reembolsado do e-mail) e ficou 3 dias sem resposta. 117 casos assim em 16/10.
--  Regra nova: só vai para Reembolsado (automático) quem NÃO tem nenhuma compra ativa no dash (todas estornadas/canceladas).
--   1) email_ia.cliente_tem_compra_ativa(email): há compra no dash que não foi reembolsada/chargeback (nem estornada por linha negativa ligada a ela);
--   2) gatilho de VETO (BEFORE INSERT/UPDATE, roda por último): se o SISTEMA tenta pôr o caso em Reembolsado e o cliente tem compra ativa, o caso fica como estava
--      (UPDATE: devolve status/iniciado_em/atualizado_em antigos; INSERT: nasce como pendente). Vale para TODOS os caminhos (n8n, rotina 058, triagem) sem mexer no n8n.
--      Não veta: movimento por pessoa (sessão com sendtrace.usuario) nem cliente de recorrência já tratado como reembolsado (regra de 25/09, migração 051).
--   3) mover_reembolsados_pendentes (058) passa a mover só o grupo A (todos os pedidos estornados).
--  Quem não está no dash (ex.: BuyGoods, sem estorno no dash) não é vetado: segue como antes.
--  Aditiva e idempotente. Desfazer: DROP TRIGGER trg_zz_veto_reembolsado_com_compra_ativa ON email_ia.suporte_escalado; restaurar a função da 058.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION email_ia.cliente_tem_compra_ativa(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (
    SELECT 1 FROM dash_pedidos a
     WHERE lower(a.customer_email) = lower(btrim(p_email))
       AND a.gross >= 0
       AND upper(coalesce(a.status, '')) NOT IN ('REFUNDED', 'CHARGEBACK')
       AND NOT EXISTS (SELECT 1 FROM dash_pedidos b
                        WHERE lower(b.customer_email) = lower(btrim(p_email)) AND b.gross < 0 AND b.parent_external_id IS NOT NULL
                          AND b.parent_external_id IN (a.session_id, a.external_id)))
$f$;

CREATE OR REPLACE FUNCTION email_ia.trg_veto_reembolsado_com_compra_ativa() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.status IS DISTINCT FROM 'reembolsado' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'reembolsado' THEN RETURN NEW; END IF;
  IF nullif(current_setting('sendtrace.usuario', true), '') IS NOT NULL THEN RETURN NEW; END IF;      -- pessoa moveu: vale
  IF email_ia.recorrencia_estado(NEW.remetente_email) = 'reembolsado' THEN RETURN NEW; END IF;       -- regra de recorrência (051): mantém
  IF NOT email_ia.cliente_tem_compra_ativa(NEW.remetente_email) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN NEW.status := 'pendente';
  ELSE NEW.status := OLD.status; NEW.iniciado_em := OLD.iniciado_em; NEW.atualizado_em := OLD.atualizado_em;
  END IF;
  RETURN NEW;
END $f$;

DROP TRIGGER IF EXISTS trg_zz_veto_reembolsado_com_compra_ativa ON email_ia.suporte_escalado;
CREATE TRIGGER trg_zz_veto_reembolsado_com_compra_ativa BEFORE INSERT OR UPDATE ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_veto_reembolsado_com_compra_ativa();

CREATE OR REPLACE FUNCTION email_ia.mover_reembolsados_pendentes(p_aplicar boolean DEFAULT false)
RETURNS TABLE (caso_id bigint, board_id bigint, status_anterior text, grupo text) LANGUAGE plpgsql AS $f$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _mrp ON COMMIT DROP AS SELECT 0::bigint AS caso_id, 0::bigint AS board_id, ''::text AS status_anterior, ''::text AS grupo WHERE false;
  TRUNCATE _mrp;
  INSERT INTO _mrp
  WITH p AS (
    SELECT s.id, s.board_id, s.status, lower(s.remetente_email) AS em
      FROM email_ia.suporte_escalado s WHERE s.status IN ('pendente', 'pendente_recorrencia')
  ), dd AS (
    SELECT p.id AS cid, x.external_id, x.session_id, x.funnel_step, upper(x.status) AS st, x.gross, nullif(x.parent_external_id, '') AS parent
      FROM p JOIN dash_pedidos x ON lower(x.customer_email) = p.em
  ), ped AS (
    SELECT a.*, (a.st IN ('REFUNDED', 'CHARGEBACK') OR EXISTS (
             SELECT 1 FROM dd b WHERE b.cid = a.cid AND b.gross < 0 AND b.parent IS NOT NULL AND b.parent IN (a.session_id, a.external_id))) AS efetivo
      FROM dd a WHERE a.gross >= 0
  ), c AS (
    SELECT cid, count(*) FILTER (WHERE efetivo) AS n_reemb, count(*) FILTER (WHERE NOT efetivo) AS n_ativos,
           bool_or(efetivo AND funnel_step IS NOT DISTINCT FROM 1) AS front_reemb
      FROM ped GROUP BY cid
  )
  SELECT p.id, p.board_id, p.status, CASE WHEN c.n_ativos = 0 THEN 'A' ELSE 'B' END
    FROM c JOIN p ON p.id = c.cid
   WHERE c.n_reemb > 0 AND c.n_ativos = 0;   -- 16/10: só quem NÃO tem mais nenhuma compra ativa (grupo A); o grupo B (principal estornado + upsell ativo) fica na fila do agente

  IF p_aplicar THEN
    UPDATE email_ia.suporte_escalado s SET status = 'reembolsado', iniciado_em = coalesce(s.iniciado_em, now()), atualizado_em = now()
     WHERE s.id IN (SELECT m.caso_id FROM _mrp m) AND s.status IN ('pendente', 'pendente_recorrencia');
    INSERT INTO email_ia.suporte_escalado_notas (suporte_escalado_id, autor, nota)
      SELECT m.caso_id, 'Sistema', 'Movido automaticamente para Reembolsado: o cliente tem pedido reembolsado/chargeback (dado do dash). Nenhuma resposta automática foi enviada por esta movimentação.'
        FROM _mrp m;
    INSERT INTO email_ia.log_reembolsados_pendentes (caso_id, board_id, status_anterior, grupo)
      SELECT m.caso_id, m.board_id, m.status_anterior, m.grupo FROM _mrp m;
  END IF;
  RETURN QUERY SELECT m.caso_id, m.board_id, m.status_anterior, m.grupo FROM _mrp m ORDER BY m.caso_id;
END
$f$;
