-- ═══════════════════════════════════════════════════════════════════════════
--  024 · Janela de garantia por PLATAFORMA (Seção 10, item 2 — bloqueio duro)
--
--  Confirmado com o usuário em 10/09/2026: JVZoo 60 dias, DigiStore24 180,
--  BuyGoods 60, PagAmerican 60 (esta última não aparece em disparos_pos_venda
--  hoje — nenhum produto desta família vende por ela — mas fica registrada
--  pra quando alguma família futura precisar).
--
--  NÃO virou um número fixo por produto: o mesmo produto (ex. NeuroMindPro)
--  vende pelas 3 plataformas ao mesmo tempo, cada uma com prazo diferente —
--  cravar um só número seria errado pra 2 em cada 3 pedidos. Em vez disso,
--  vira um mapeamento plataforma→dias em `config_disparos` (mesmo mecanismo
--  já usado por `sms_regua_ativo`), lido pelo nó "Montar Mensagem" do fluxo
--  n8n e resolvido pela `disparos_pos_venda.plataforma` de CADA pedido —
--  então o {garantia_dias} que sai no e-mail é sempre o prazo real daquele
--  pedido específico. Ver o nó atualizado em
--  "fluxos-n8n/Processador de Disparos.json".
--
--  Padrão de fallback é 60 (o menor prazo confirmado): errar por promessa
--  CURTA demais não cria risco nenhum (o cliente recebe o reembolso mesmo
--  assim se a plataforma permitir mais); errar por promessa LONGA demais
--  seria uma alegação falsa a um cliente específico — assimetria proposital.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES (
  'garantia_dias_por_plataforma',
  '{"JVZoo":60,"DigiStore24":180,"BuyGoods":60,"PagAmerican":60,"_padrao":60}'
)
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

-- Corrige o texto já publicado (migração 022 rodou antes desta confirmação):
-- o placeholder [JANELA_GARANTIA]/texto fixo vira o token {garantia_dias},
-- resolvido pelo n8n na hora do envio.

UPDATE mensagens_regua
SET corpo_html = replace(corpo_html, '[JANELA_GARANTIA]', '{garantia_dias} days'),
    atualizado_em = now()
WHERE etapa = 16 AND linha = '4' AND produto = '*'
  AND corpo_html LIKE '%[JANELA_GARANTIA]%';
