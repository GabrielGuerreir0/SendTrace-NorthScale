-- ═══════════════════════════════════════════════════════════════════════════
--  005 · Validade da senha provisória
--
--  A senha provisória agora pode ser enviada por e-mail, e isso muda o risco:
--  ela deixa de existir só no terminal de quem criou a conta e passa a morar
--  numa caixa de entrada, para sempre.
--
--  Se a pessoa nunca entrar, aquela senha continua funcionando meses depois —
--  e uma caixa de entrada comprometida no futuro vira acesso ao painel. Com
--  prazo, o e-mail velho não serve para nada e é preciso pedir outra.
--
--  Vale SÓ enquanto `trocar_senha` é true. Depois que a pessoa define a senha
--  dela, prazo nenhum se aplica.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE painel_usuarios
  ADD COLUMN IF NOT EXISTS senha_expira_em timestamptz;

COMMENT ON COLUMN painel_usuarios.senha_expira_em IS
  'Até quando a senha provisória vale. NULL = sem prazo. Ignorado depois que trocar_senha vira false.';

-- Contas que já existiam receberam a senha provisória pelo terminal, não por
-- e-mail, então não herdam prazo: cortar o acesso delas de surpresa seria pior
-- que o risco que o prazo evita.
