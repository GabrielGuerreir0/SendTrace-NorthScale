-- ═══════════════════════════════════════════════════════════════════════════
--  072 · Acesso por página (e papel dentro da página) para cada usuário do painel (pedido do Lucas, 05/10/2026)
--
--  Cada usuário NÃO administrador vê só as páginas (abas do menu) marcadas aqui; administrador vê todas e não precisa de linha.
--  `papel` vale por página: 'usuario' (vê só o que é seu) ou 'gestor' (vê tudo dentro daquela página). Hoje só o Suporte Escalado diferencia os dois.
--  Páginas (chave): visaogeral, suporte, regua, ticketsia, detalhesia, chatia, galeriaia, suporteescalado, relatorioia, rastreio, postmark.
--  Carga inicial: quem já existe e não é admin continua vendo TODAS as páginas (nada some de repente); o admin restringe depois pela tela de Usuários.
--  A carga só roda se a tabela estiver vazia (rodar de novo não devolve página que o admin tirou). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS painel_usuarios_acessos (
  usuario_id  bigint NOT NULL REFERENCES painel_usuarios(id) ON DELETE CASCADE,
  pagina      text   NOT NULL,
  papel       text   NOT NULL DEFAULT 'usuario' CHECK (papel IN ('usuario', 'gestor')),
  PRIMARY KEY (usuario_id, pagina)
);
COMMENT ON TABLE painel_usuarios_acessos IS 'Páginas do painel que cada usuário não-admin pode abrir, com o papel dele em cada uma (072).';

INSERT INTO painel_usuarios_acessos (usuario_id, pagina, papel)
SELECT u.id, p.pagina, 'usuario'
  FROM painel_usuarios u
 CROSS JOIN unnest(ARRAY['visaogeral', 'suporte', 'regua', 'ticketsia', 'detalhesia', 'chatia', 'galeriaia', 'suporteescalado', 'relatorioia', 'rastreio', 'postmark']) AS p(pagina)
 WHERE NOT u.admin
   AND NOT EXISTS (SELECT 1 FROM painel_usuarios_acessos);
