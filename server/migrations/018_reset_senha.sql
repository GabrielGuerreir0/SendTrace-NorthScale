-- Recuperação de senha por e-mail (self-service): link com token de uso
-- único, mesma ideia de painel_sessoes — só o HASH do token vai pro banco,
-- nunca o token cru. Expira sozinho (server/auth.js controla o prazo, hoje
-- 30 min); usado_em marca uso único.
CREATE TABLE IF NOT EXISTS painel_reset_senha (
  token_hash  text         PRIMARY KEY,
  usuario_id  bigint       NOT NULL REFERENCES painel_usuarios(id) ON DELETE CASCADE,
  criado_em   timestamptz  NOT NULL DEFAULT now(),
  expira_em   timestamptz  NOT NULL,
  usado_em    timestamptz,
  ip          text
);

-- server/auth.js apaga os tokens não-usados de um usuário sempre que emite
-- um novo (WHERE usuario_id = $1) — sem índice isso seria table scan.
CREATE INDEX IF NOT EXISTS painel_reset_senha_usuario_idx ON painel_reset_senha (usuario_id);
