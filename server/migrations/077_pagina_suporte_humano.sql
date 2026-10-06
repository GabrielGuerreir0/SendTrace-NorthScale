-- ═══════════════════════════════════════════════════════════════════════════
--  077 · Página "Suporte Humano" (fila de respostas em lista + painel da equipe) separada do Suporte Escalado (pedido do Lucas, 06/10/2026)
--
--  Nova chave de página `suportehumano`. Carga inicial: quem já tem `suporteescalado` (e não é admin) ganha `suportehumano`, para ninguém perder a fila
--  de respostas que antes ficava dentro do Suporte Escalado. Só roda enquanto não existe nenhuma linha dessa página (rodar de novo não devolve
--  acesso que o admin tirou). O papel de gestor continua o do Suporte Escalado. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO painel_usuarios_acessos (usuario_id, pagina, papel)
SELECT a.usuario_id, 'suportehumano', 'usuario'
  FROM painel_usuarios_acessos a
  JOIN painel_usuarios u ON u.id = a.usuario_id AND NOT u.admin
 WHERE a.pagina = 'suporteescalado'
   AND NOT EXISTS (SELECT 1 FROM painel_usuarios_acessos x WHERE x.pagina = 'suportehumano')
ON CONFLICT DO NOTHING;
