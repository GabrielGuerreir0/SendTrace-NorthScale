-- ═══════════════════════════════════════════════════════════════════════════
--  045 · Horário do 1º toque humano (P8 / P9 da Visão Geral v2)
--
--  Motivo (21/09/2026): o G1 (crítico atendido em até 2 h), o G6 (reação em até 24 h) e o F3 (tempo até
--  um humano pegar o caso) usavam `suporte_escalado.iniciado_em` como "hora em que um humano pegou".
--  Só que `iniciado_em` também é preenchido por AUTOMAÇÃO: o n8n "Limpar Kanban: Pedidos Já
--  Reembolsados" grava `status='reembolsado'` + `iniciado_em = now()`, e o fluxo do formulário move o
--  caso para `formulario`. Resultado: caso movido por robô contava como "humano atendeu".
--
--  Agora há uma coluna própria, gravada SÓ por ação de uma pessoa no painel:
--    email_ia.suporte_escalado.primeiro_toque_humano_em  — mover o caso de coluna, nota interna,
--        data de entrega, transferir de board (as rotas do painel gravam; a nota, por gatilho);
--    email_ia.tickets.primeira_resposta_humana_em        — o 1º toque humano do cliente (copiado do
--        caso escalado por gatilho, ou o fechamento manual do ticket).
--
--  Backfill (só o que dá para atribuir a uma pessoa com segurança):
--    · 1ª nota de um autor humano (fora "Automação…" e "Claude…");
--    · 1ª mudança para `iniciado` ou `em_analise` (nenhum fluxo do n8n nem rota grava essas colunas
--      sozinha; só o painel).
--  Movimentos para `reembolsado`, `formulario`, `finalizado` etc. NÃO entram: não dá para separar
--  humano de automação no histórico. Por isso os casos antigos ficam com menos base — a tela mostra.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE email_ia.suporte_escalado ADD COLUMN IF NOT EXISTS primeiro_toque_humano_em timestamptz;
ALTER TABLE email_ia.tickets          ADD COLUMN IF NOT EXISTS primeira_resposta_humana_em timestamptz;

-- ── backfill do caso escalado ───────────────────────────────────────────────────────────────────────
UPDATE email_ia.suporte_escalado s
   SET primeiro_toque_humano_em = x.t
  FROM (
    SELECT id, min(t) AS t FROM (
      SELECT suporte_escalado_id AS id, criado_em AS t FROM email_ia.suporte_escalado_notas
       WHERE autor IS NOT NULL AND autor !~* '^(automa|claude)'
      UNION ALL
      SELECT suporte_escalado_id, mudou_em FROM email_ia.suporte_escalado_historico
       WHERE status_novo IN ('iniciado', 'em_analise')
    ) u GROUP BY id
  ) x
 WHERE x.id = s.id AND s.primeiro_toque_humano_em IS NULL;

-- ── backfill do ticket: 1º toque do caso escalado, ou o fechamento manual ────────────────────────────
UPDATE email_ia.tickets t
   SET primeira_resposta_humana_em = x.t
  FROM (
    SELECT lower(remetente_email) AS em, min(primeiro_toque_humano_em) AS t
      FROM email_ia.suporte_escalado WHERE primeiro_toque_humano_em IS NOT NULL GROUP BY 1
  ) x
 WHERE x.em = lower(t.remetente_email) AND t.primeira_resposta_humana_em IS NULL;

UPDATE email_ia.tickets
   SET primeira_resposta_humana_em = resolvido_em
 WHERE primeira_resposta_humana_em IS NULL AND resolvido_por = 'humano' AND resolvido_em IS NOT NULL;

-- ── gatilhos ────────────────────────────────────────────────────────────────────────────────────────
-- Nota de uma pessoa = toque humano (notas de "Automação…"/"Claude…" não contam).
CREATE OR REPLACE FUNCTION email_ia.trg_nota_toque_humano() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.autor IS NOT NULL AND NEW.autor !~* '^(automa|claude)' THEN
    UPDATE email_ia.suporte_escalado
       SET primeiro_toque_humano_em = coalesce(primeiro_toque_humano_em, NEW.criado_em)
     WHERE id = NEW.suporte_escalado_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_nota_toque_humano ON email_ia.suporte_escalado_notas;
CREATE TRIGGER trg_nota_toque_humano AFTER INSERT ON email_ia.suporte_escalado_notas
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_nota_toque_humano();

-- Toque no caso → vale para o ticket do mesmo cliente (mantém o mais antigo).
CREATE OR REPLACE FUNCTION email_ia.trg_caso_toque_no_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.primeiro_toque_humano_em IS NOT NULL
     AND NEW.primeiro_toque_humano_em IS DISTINCT FROM OLD.primeiro_toque_humano_em THEN
    UPDATE email_ia.tickets
       SET primeira_resposta_humana_em = least(coalesce(primeira_resposta_humana_em, NEW.primeiro_toque_humano_em),
                                               NEW.primeiro_toque_humano_em)
     WHERE lower(remetente_email) = lower(NEW.remetente_email);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_caso_toque_no_ticket ON email_ia.suporte_escalado;
CREATE TRIGGER trg_caso_toque_no_ticket AFTER UPDATE OF primeiro_toque_humano_em ON email_ia.suporte_escalado
  FOR EACH ROW EXECUTE FUNCTION email_ia.trg_caso_toque_no_ticket();

COMMENT ON COLUMN email_ia.suporte_escalado.primeiro_toque_humano_em IS
  '1ª ação de uma PESSOA no caso (mover coluna, nota, data de entrega, transferir). Automação não grava. Casos antigos: só nota humana ou mudança para iniciado/em_analise.';
COMMENT ON COLUMN email_ia.tickets.primeira_resposta_humana_em IS
  '1º toque humano no cliente (do caso escalado, ou o fechamento manual do ticket).';
