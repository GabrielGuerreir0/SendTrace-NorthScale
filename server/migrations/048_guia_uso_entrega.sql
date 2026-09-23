-- ═══════════════════════════════════════════════════════════════════════════
--  048 · Guia de uso disparado por "entregue" (ebook, PAUSADO)
--
--  Pedido do Lucas (22/09/2026): trocar o gatilho do guia de uso (hoje D25,
--  dia fixo, régua desativada desde 18/09) por um disparo quando o rastreio
--  marca o pedido como 'delivered' — a ideia já estava registrada como Fase 2
--  do PDF do Rodrigo ("régua por evento"). Reaproveita o mecanismo que já
--  existe em produção: `produtos.link_ebook` (botão "EBOOK" na copy do D25,
--  mesma cascata da Área VIP) — hoje só o produto '*' tem isso preenchido
--  (link de um Google Drive). Os PDFs já estão hospedados no Drive do Lucas;
--  ele vai cadastrar o link por produto aos poucos.
--
--  NÃO usa a cascata de fallback pro '*' que `metaProduto()` faz pra prévia
--  do painel: aqui o gate é o produto TER o próprio `link_ebook` cadastrado —
--  sem isso, sem e-mail (mesmo racional da migração 030, Área VIP: "produto
--  sem valor aqui não deve cair num fallback genérico").
--
--  NÃO mexe na etapa D25 nem em `mensagens_regua` — continua pausada e
--  intacta (backup_etapas_cortes_18_09). Quando o Lucas decidir ativar,
--  ainda falta decidir se desliga a D25 fixa ou deixa as duas coexistindo
--  (não é decisão desta migração — ver Pendências e Roadmap).
--
--  PAUSADO DE PROPÓSITO (duas travas, independentes, mesmo padrão da 046):
--   1) `config_disparos.guia_uso_entrega_ativo = 'false'` — `guia_uso_fila()`
--      devolve vazio enquanto isso não virar 'true'. Ninguém envia nada só
--      por esta migração existir.
--   2) O fluxo do n8n que consome essa fila (a construir/importar depois)
--      deve subir INATIVO.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES
  ('guia_uso_entrega_ativo', 'false')
ON CONFLICT (chave) DO NOTHING;

-- O que já foi enviado (idempotência do envio — sem isso o cron reenviaria
-- o mesmo guia toda vez que rodasse, já que 'delivered' não muda de novo).
CREATE TABLE IF NOT EXISTS guia_uso_enviado (
  disparo_id  bigint PRIMARY KEY REFERENCES disparos_pos_venda(id),
  produto     text NOT NULL,
  link_ebook  text NOT NULL,
  enviado_em  timestamptz NOT NULL DEFAULT now()
);

-- Fila de pedidos prontos pro guia de uso: rastreio marcou 'delivered', o
-- produto tem link_ebook PRÓPRIO cadastrado (sem cascata pro '*'), ainda não
-- foi enviado, e o interruptor geral está ligado (senão devolve vazio
-- sempre — isso mantém a fila vazia hoje, mesmo sem nenhum produto cadastrado).
CREATE OR REPLACE FUNCTION public.guia_uso_fila(p_limite integer DEFAULT 50)
RETURNS TABLE (disparo_id bigint, email text, nome text, produto text, link_ebook text)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.email, d.nome, pr.nome, pr.link_ebook
  FROM disparos_pos_venda d
  JOIN rastreio_pedidos r ON r.transacao_id = d.transacao_id
  JOIN produtos pr ON pr.slug = d.produto_slug AND pr.slug <> '*'
  WHERE (SELECT valor FROM config_disparos WHERE chave = 'guia_uso_entrega_ativo') = 'true'
    AND r.status_interno = 'delivered'
    AND pr.link_ebook IS NOT NULL
    AND d.email IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM guia_uso_enviado g WHERE g.disparo_id = d.id)
  ORDER BY r.delivered_at
  LIMIT p_limite;
$$;

COMMENT ON FUNCTION public.guia_uso_fila IS
  'Pedidos entregues (rastreio_pedidos.status_interno = delivered) cujo produto tem link_ebook próprio (sem cascata pro *) e ainda não recebeu o e-mail do guia de uso. Devolve vazio enquanto guia_uso_entrega_ativo <> ''true''.';
