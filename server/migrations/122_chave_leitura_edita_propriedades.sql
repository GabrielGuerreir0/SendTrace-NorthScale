-- ═══════════════════════════════════════════════════════════════════════════
--  122 · Chave de leitura que também EDITA as Propriedades dos tickets (pedido do Lucas, 23/10/2026, para a Késsia)
--
--  A chave `str_ro_…` continua sendo SÓ LEITURA no banco (papel sendtrace_leitura, transação READ ONLY). Esta coluna liga uma ÚNICA exceção, na API:
--  `PUT /api/suporte-escalado/:id/ficha` com campos de PROPRIEDADES (motivo do contato, detalhamento, tipo de resolução, status do ticket, % de reembolso,
--  valor da compra, dedução, data do chargeback), em ticket de qualquer agente. Tudo o mais continua negado (Logística, Ajuda, Comissão, indicadores, mover card,
--  responder cliente…). O autor gravado é "<dono> (Claude)" e a chamada vai para `leitura_auditoria` com os campos enviados.
--  Liga/desliga pelo terminal: `node api/leituraCli.js permitir-propriedades <id>` / `bloquear-propriedades <id>`. Nasce DESLIGADA.
--  Aditiva e idempotente. Desfazer: UPDATE public.chaves_leitura SET edita_propriedades = false;
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.chaves_leitura ADD COLUMN IF NOT EXISTS edita_propriedades boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.chaves_leitura.edita_propriedades IS 'true: a chave também pode editar as Propriedades dos tickets do Suporte Escalado (122). Só isso; o resto continua somente leitura.';
