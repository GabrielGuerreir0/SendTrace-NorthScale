-- ═══════════════════════════════════════════════════════════════════════════
--  061 · Grupo de controle de 10% dos pedidos, sem régua (Plano D30 · AB23, regra R1) — 01/10/2026
--
--  Sem grupo de controle a melhora do plano não é comprovável. Regra R1: todo pedido NOVO cujo id é múltiplo de 10 (~10%)
--  nasce como controle: não recebe a régua de pós-venda (só os e-mails transacionais da plataforma e o atendimento normal).
--
--  Como funciona (não mexe no Processador nem nos fluxos Reporting):
--    · `disparos_pos_venda.controle` marca o pedido;
--    · um gatilho BEFORE INSERT (separado do gatilho de produto/etapa) marca `controle = true` quando `id % 10 = 0` e já grava o
--      pedido como `concluido` — o Processador só reivindica `ativo`, então nunca envia. O `ON CONFLICT DO NOTHING` dos Reporting
--      não reabre o pedido. Pedidos antigos NÃO são afetados (a regra vale só para linhas novas);
--    · `config_disparos.controle_inicio` guarda quando o experimento começou (a comparação só olha pedidos a partir daí);
--    · a visão `v_controle_vs_regua` compara reembolso/chargeback em 7, 14 e 30 dias entre controle e régua, por plataforma.
--
--  Fora desta migração (propositalmente): excluir o controle do recibo consolidado e do guia de uso por entrega — as funções
--  `recibo_consolidado_fila` e `guia_uso_fila` foram redefinidas à mão em produção; ver
--  `Correções/plano_d30/ab23_excluir_controle_recibo_guia.sql`.
--
--  Idempotente. Só ESPAÇA/REDUZ envio (10% dos pedidos novos ficam sem a régua).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE disparos_pos_venda ADD COLUMN IF NOT EXISTS controle boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN disparos_pos_venda.controle IS 'Grupo de controle (AB23/R1): pedido novo com id múltiplo de 10 nasce concluído e não recebe a régua. Serve para comparar reembolso com e sem régua.';

CREATE OR REPLACE FUNCTION public.trg_disparos_controle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS NOT NULL AND NEW.id % 10 = 0 THEN
    NEW.controle := true;
    NEW.status := 'concluido';
    NEW.ultimo_erro := 'controle: sem régua (grupo de controle de 10%, AB23)';
  END IF;
  RETURN NEW;
END;
$function$;

-- Antes do gatilho de produto/etapa não importa a ordem: este só mexe em controle/status/ultimo_erro.
DROP TRIGGER IF EXISTS trg_disparos_controle ON disparos_pos_venda;
CREATE TRIGGER trg_disparos_controle BEFORE INSERT ON disparos_pos_venda
  FOR EACH ROW EXECUTE FUNCTION public.trg_disparos_controle();

-- Início do experimento: só pedidos criados a partir daqui entram na comparação.
INSERT INTO config_disparos (chave, valor) VALUES ('controle_inicio', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
ON CONFLICT (chave) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_disparos_controle_criado ON disparos_pos_venda (criado_em) WHERE controle;

-- Reembolso/chargeback em 7, 14 e 30 dias da compra, controle × régua. "elegíveis" = pedidos que já completaram a janela.
CREATE OR REPLACE VIEW public.v_controle_vs_regua AS
SELECT btrim(d.plataforma) AS plataforma,
       CASE WHEN d.controle THEN 'controle' ELSE 'regua' END AS grupo,
       count(*)::int AS pedidos,
       count(*) FILTER (WHERE d.criado_em <= now() - interval '7 days')::int  AS elegiveis_d7,
       count(*) FILTER (WHERE coalesce(d.reembolsado_em, d.chargeback_em) <= d.criado_em + interval '7 days'
                          AND d.criado_em <= now() - interval '7 days')::int  AS reembolsos_d7,
       count(*) FILTER (WHERE d.criado_em <= now() - interval '14 days')::int AS elegiveis_d14,
       count(*) FILTER (WHERE coalesce(d.reembolsado_em, d.chargeback_em) <= d.criado_em + interval '14 days'
                          AND d.criado_em <= now() - interval '14 days')::int AS reembolsos_d14,
       count(*) FILTER (WHERE d.criado_em <= now() - interval '30 days')::int AS elegiveis_d30,
       count(*) FILTER (WHERE coalesce(d.reembolsado_em, d.chargeback_em) <= d.criado_em + interval '30 days'
                          AND d.criado_em <= now() - interval '30 days')::int AS reembolsos_d30
FROM disparos_pos_venda d
WHERE d.criado_em >= (SELECT valor::timestamptz FROM config_disparos WHERE chave = 'controle_inicio')
GROUP BY 1, 2;

COMMENT ON VIEW public.v_controle_vs_regua IS 'AB23: reembolso/chargeback em D7/D14/D30, grupo de controle (sem régua) × com régua, por plataforma. Só pedidos criados depois de config_disparos.controle_inicio.';
