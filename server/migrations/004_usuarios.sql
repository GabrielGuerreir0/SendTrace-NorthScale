-- ═══════════════════════════════════════════════════════════════════════════
--  004 · Acesso ao painel: usuários e sessões
--
--  O painel deixa de ser aberto. Sem sessão válida, NADA é servido além da
--  tela de login — nem as APIs, nem o HTML, nem os assets do painel.
--
--  Decisões que valem registrar:
--
--  · A senha nunca é guardada. Guardamos scrypt(senha, salt) com salt de 16
--    bytes por usuário, e os parâmetros de custo junto do hash — assim dá para
--    endurecer o custo no futuro sem invalidar as senhas existentes.
--
--  · A sessão é guardada como HASH do token, não como o token. Se este banco
--    vazar, ninguém consegue montar um cookie válido a partir dele. É a mesma
--    lógica da senha, aplicada à sessão.
--
--  · Contagem de falhas e bloqueio temporário ficam NA LINHA do usuário, para
--    o freio de força bruta sobreviver a reinício do processo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS painel_usuarios (
  id               bigserial    PRIMARY KEY,
  -- Guardado sempre em minúsculas: e-mail não diferencia caixa na prática, e
  -- permitir "Ana@x.com" e "ana@x.com" como contas distintas é um convite a
  -- confusão e a burla de bloqueio.
  email            text         NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%._%'),
  nome             text,
  senha_hash       text         NOT NULL,
  senha_salt       text         NOT NULL,
  senha_params     text         NOT NULL DEFAULT 'scrypt$N=16384,r=8,p=1,len=64',

  admin            boolean      NOT NULL DEFAULT false,
  ativo            boolean      NOT NULL DEFAULT true,
  -- Obriga a trocar a senha no primeiro acesso. Nasce true para todo usuário
  -- criado por um administrador: quem cria escolhe uma senha provisória e não
  -- deve continuar sabendo a senha de ninguém.
  trocar_senha     boolean      NOT NULL DEFAULT true,

  criado_em        timestamptz  NOT NULL DEFAULT now(),
  criado_por       bigint       REFERENCES painel_usuarios(id) ON DELETE SET NULL,
  ultimo_acesso    timestamptz,

  falhas           integer      NOT NULL DEFAULT 0,
  bloqueado_ate    timestamptz
);

COMMENT ON TABLE  painel_usuarios IS 'Quem pode entrar no painel. A senha nunca é armazenada — só o hash scrypt.';
COMMENT ON COLUMN painel_usuarios.trocar_senha IS 'true = precisa definir uma senha própria antes de usar o painel.';
COMMENT ON COLUMN painel_usuarios.bloqueado_ate IS 'Freio de força bruta: até quando o login está recusado para esta conta.';

CREATE TABLE IF NOT EXISTS painel_sessoes (
  -- SHA-256 do token que vai no cookie. O token em si não existe no banco.
  token_hash  text         PRIMARY KEY,
  usuario_id  bigint       NOT NULL REFERENCES painel_usuarios(id) ON DELETE CASCADE,
  criado_em   timestamptz  NOT NULL DEFAULT now(),
  visto_em    timestamptz  NOT NULL DEFAULT now(),
  expira_em   timestamptz  NOT NULL,
  ip          text,
  agente      text
);

CREATE INDEX IF NOT EXISTS painel_sessoes_usuario_idx ON painel_sessoes (usuario_id);
CREATE INDEX IF NOT EXISTS painel_sessoes_expira_idx  ON painel_sessoes (expira_em);

COMMENT ON TABLE painel_sessoes IS 'Sessões ativas. Guarda o hash do token, nunca o token — um vazamento do banco não permite forjar sessão.';
