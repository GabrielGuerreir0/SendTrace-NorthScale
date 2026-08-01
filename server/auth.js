/**
 * Autenticação do painel: senhas, sessões e o freio de força bruta.
 *
 * Sem dependência externa — `node:crypto` já traz scrypt, que é uma KDF de
 * memória dura (resistente a GPU/ASIC) e é o que o próprio Node recomenda para
 * senha. Trazer bcrypt/argon2 aqui significaria compilar binário nativo para
 * ganhar pouco.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.js';

const scrypt = promisify(crypto.scrypt);

/* Custo do scrypt. N=16384 leva ~50–100 ms nesta classe de máquina: caro o
   bastante para força bruta, barato o bastante para um login humano. Os
   parâmetros vão gravados JUNTO do hash, então dá para endurecer no futuro sem
   invalidar as senhas já existentes. */
const CUSTO = { N: 16384, r: 8, p: 1, len: 64 };
const PARAMS = `scrypt$N=${CUSTO.N},r=${CUSTO.r},p=${CUSTO.p},len=${CUSTO.len}`;

export const SESSAO_HORAS = Number(process.env.SESSAO_HORAS) || 12;
const MAX_FALHAS = 6;
const BLOQUEIO_MIN = 15;

/* Quantos dias a senha provisória vale. Existe porque ela pode ir por e-mail e
   ficar numa caixa de entrada para sempre — sem prazo, uma conta que nunca foi
   usada continua aberta indefinidamente com a senha que alguém já viu. */
export const CONVITE_DIAS = Math.max(1, Number(process.env.CONVITE_DIAS) || 7);

/* ────────────────────────────── senha ────────────────────────────── */

function lerParams(txt) {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+),len=(\d+)$/.exec(txt ?? '');
  if (!m) return CUSTO;
  return { N: +m[1], r: +m[2], p: +m[3], len: +m[4] };
}

export async function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha.normalize('NFKC'), salt, CUSTO.len, {
    N: CUSTO.N, r: CUSTO.r, p: CUSTO.p, maxmem: 256 * 1024 * 1024,
  });
  return { hash: hash.toString('base64'), salt: salt.toString('base64'), params: PARAMS };
}

/**
 * Confere a senha em tempo constante.
 *
 * `timingSafeEqual` estoura se os buffers têm tamanhos diferentes, e esse
 * estouro em si já vazaria informação — por isso o tamanho é conferido antes e
 * a comparação só roda com buffers do mesmo tamanho.
 */
export async function conferirSenha(senha, registro) {
  const p = lerParams(registro.senha_params);
  const salt = Buffer.from(registro.senha_salt, 'base64');
  const esperado = Buffer.from(registro.senha_hash, 'base64');

  const obtido = await scrypt(String(senha).normalize('NFKC'), salt, p.len, {
    N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024,
  });
  if (obtido.length !== esperado.length) return false;
  return crypto.timingSafeEqual(obtido, esperado);
}

/**
 * Regras de senha. Comprimento é o que mais importa — uma frase longa vence
 * qualquer exigência de símbolo — então o piso é 10 e as classes são um
 * complemento, não o critério principal.
 */
const SENHAS_OBVIAS = new Set([
  'senha123456', '1234567890', 'password12', 'password123', 'qwerty12345',
  'admin123456', 'painel12345', '12345678901', 'abcd123456',
]);

export function validarSenha(senha, { email } = {}) {
  const s = String(senha ?? '');
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (s.length > 200) return 'Senha longa demais (máximo 200 caracteres).';
  if (SENHAS_OBVIAS.has(s.toLowerCase())) return 'Essa senha é previsível demais. Escolha outra.';

  // Só vale a pena barrar o trecho do e-mail se ele for longo o bastante para
  // ser um palpite útil. Com 3 letras ou menos ("ana@…", "jo@…") a regra
  // rejeitaria palavras comuns — "banana", "manhã" — sem ganhar segurança.
  const local = String(email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && s.toLowerCase().includes(local)) {
    return 'A senha não pode conter o seu e-mail.';
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (classes < 2) {
    return 'Misture pelo menos dois tipos de caractere (maiúscula, minúscula, número ou símbolo).';
  }
  return null;
}

export const normalizarEmail = (e) => String(e ?? '').trim().toLowerCase();
export const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

/* ───────────────────────────── sessões ───────────────────────────── */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export async function criarSessao(usuarioId, { ip, agente } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO painel_sessoes (token_hash, usuario_id, expira_em, ip, agente)
     VALUES ($1, $2, now() + make_interval(hours => $3::int), $4, $5)`,
    [hashToken(token), usuarioId, SESSAO_HORAS, ip ?? null, (agente ?? '').slice(0, 300)],
  );
  return token;
}

/** Devolve o usuário da sessão, ou null. Renova `visto_em` para saber quem está ativo. */
export async function usuarioDaSessao(token) {
  if (!token) return null;
  const { rows } = await query(
    `UPDATE painel_sessoes s SET visto_em = now()
      WHERE s.token_hash = $1 AND s.expira_em > now()
      RETURNING s.usuario_id`,
    [hashToken(token)],
  );
  if (!rows.length) return null;

  const { rows: us } = await query(
    `SELECT id, email, nome, admin, ativo, trocar_senha FROM painel_usuarios WHERE id = $1`,
    [rows[0].usuario_id],
  );
  const u = us[0];
  // Conta desativada enquanto a sessão estava aberta: a sessão morre junto.
  if (!u || !u.ativo) {
    await encerrarSessao(token);
    return null;
  }
  return u;
}

export async function encerrarSessao(token) {
  if (!token) return;
  await query('DELETE FROM painel_sessoes WHERE token_hash = $1', [hashToken(token)]);
}

/** Derruba TODAS as sessões de um usuário — usado ao trocar senha ou desativar. */
export async function encerrarSessoesDe(usuarioId) {
  await query('DELETE FROM painel_sessoes WHERE usuario_id = $1', [usuarioId]);
}

export async function limparSessoesVencidas() {
  await query('DELETE FROM painel_sessoes WHERE expira_em <= now()');
}

/* ──────────────────────────── login ──────────────────────────────── */

/* Hash descartável usado quando o e-mail não existe. Sem ele o login responde
   na hora para e-mail inexistente e demora ~80 ms para e-mail existente — o
   que permite descobrir quem tem conta só cronometrando. */
const ISCA = await gerarHash(crypto.randomBytes(24).toString('hex'));

export async function autenticar(emailBruto, senha) {
  const email = normalizarEmail(emailBruto);

  const { rows } = await query(
    `SELECT id, email, nome, admin, ativo, trocar_senha,
            senha_hash, senha_salt, senha_params, bloqueado_ate,
            senha_expira_em,
            (trocar_senha AND senha_expira_em IS NOT NULL AND senha_expira_em <= now())
              AS provisoria_vencida
     FROM painel_usuarios WHERE email = $1`,
    [email],
  );
  const u = rows[0];

  if (!u) {
    // Gasta o mesmo tempo de um login real antes de recusar.
    await conferirSenha(senha, { senha_hash: ISCA.hash, senha_salt: ISCA.salt, senha_params: ISCA.params });
    return { ok: false, erro: 'E-mail ou senha incorretos.' };
  }

  if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
    const faltam = Math.ceil((new Date(u.bloqueado_ate) - Date.now()) / 60000);
    return { ok: false, erro: `Muitas tentativas. Tente de novo em ${faltam} min.` };
  }

  const confere = await conferirSenha(senha, u);

  if (!confere) {
    // O bloqueio é por CONTA e fica no banco, então sobrevive a reinício do
    // processo — um contador em memória seria zerado por um restart.
    await query(
      `UPDATE painel_usuarios
          SET falhas = falhas + 1,
              bloqueado_ate = CASE WHEN falhas + 1 >= $2
                                   THEN now() + make_interval(mins => $3::int) END
        WHERE id = $1`,
      [u.id, MAX_FALHAS, BLOQUEIO_MIN],
    );
    return { ok: false, erro: 'E-mail ou senha incorretos.' };
  }

  // Conta desativada só é revelada DEPOIS da senha certa: antes disso, dizer
  // "conta desativada" confirmaria a existência do e-mail para quem chutou.
  if (!u.ativo) return { ok: false, erro: 'Esta conta está desativada.' };

  // Idem para a senha provisória vencida: a senha estava certa, então não há o
  // que esconder, e a pessoa precisa saber que o caminho é pedir outra.
  if (u.provisoria_vencida) {
    return {
      ok: false,
      erro: 'Esta senha provisória expirou. Peça um novo convite a quem administra o painel.',
    };
  }

  await query(
    'UPDATE painel_usuarios SET falhas = 0, bloqueado_ate = NULL, ultimo_acesso = now() WHERE id = $1',
    [u.id],
  );
  return {
    ok: true,
    usuario: { id: u.id, email: u.email, nome: u.nome, admin: u.admin, trocar_senha: u.trocar_senha },
  };
}

/* ──────────────────────────── usuários ───────────────────────────── */

export async function listarUsuarios() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.nome, u.admin, u.ativo, u.trocar_senha,
            u.criado_em, u.ultimo_acesso, u.bloqueado_ate,
            c.email AS criado_por_email,
            (SELECT count(*)::int FROM painel_sessoes s
              WHERE s.usuario_id = u.id AND s.expira_em > now()) AS sessoes
     FROM painel_usuarios u
     LEFT JOIN painel_usuarios c ON c.id = u.criado_por
     ORDER BY u.admin DESC, u.email`,
  );
  return rows;
}

export async function criarUsuario({ email, nome, senha, admin, criadoPor }) {
  const { hash, salt, params } = await gerarHash(senha);
  const { rows } = await query(
    `INSERT INTO painel_usuarios (email, nome, senha_hash, senha_salt, senha_params,
                                  admin, criado_por, trocar_senha, senha_expira_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, now() + make_interval(days => $8::int))
     RETURNING id, email, nome, admin, ativo, trocar_senha, senha_expira_em, criado_em`,
    [email, nome || null, hash, salt, params, !!admin, criadoPor ?? null, CONVITE_DIAS],
  );
  return rows[0];
}

/**
 * Define a senha DEFINITIVA de alguém (a própria pessoa escolhendo a dela).
 * Zera o prazo: prazo só existe enquanto a senha é provisória.
 */
export async function trocarSenha(usuarioId, senha) {
  const { hash, salt, params } = await gerarHash(senha);
  await query(
    `UPDATE painel_usuarios
        SET senha_hash = $2, senha_salt = $3, senha_params = $4,
            trocar_senha = false, senha_expira_em = NULL,
            falhas = 0, bloqueado_ate = NULL
      WHERE id = $1`,
    [usuarioId, hash, salt, params],
  );
}

/**
 * Emite uma senha PROVISÓRIA para outra pessoa (admin criando ou redefinindo).
 * Sempre com prazo e sempre exigindo troca — quem emite não deve seguir
 * sabendo a senha de ninguém. Derruba as sessões abertas da conta: uma
 * redefinição que deixa a sessão antiga viva não redefine nada.
 */
export async function emitirSenhaProvisoria(usuarioId, senha) {
  const { hash, salt, params } = await gerarHash(senha);
  await query(
    `UPDATE painel_usuarios
        SET senha_hash = $2, senha_salt = $3, senha_params = $4,
            trocar_senha = true,
            senha_expira_em = now() + make_interval(days => $5::int),
            falhas = 0, bloqueado_ate = NULL
      WHERE id = $1`,
    [usuarioId, hash, salt, params, CONVITE_DIAS],
  );
  await encerrarSessoesDe(usuarioId);
}

export async function definirAdmin(usuarioId, admin) {
  const { rows } = await query(
    'UPDATE painel_usuarios SET admin = $2 WHERE id = $1 RETURNING id, email, admin',
    [usuarioId, !!admin],
  );
  return rows[0] ?? null;
}

export async function definirAtivo(usuarioId, ativo) {
  const { rows } = await query(
    'UPDATE painel_usuarios SET ativo = $2 WHERE id = $1 RETURNING id, email, ativo',
    [usuarioId, !!ativo],
  );
  // Desativar sem derrubar a sessão deixaria a pessoa dentro do painel até o
  // cookie vencer — o desligamento tem que valer agora.
  if (rows[0] && !ativo) await encerrarSessoesDe(usuarioId);
  return rows[0] ?? null;
}

/** Quantos administradores ATIVOS existem — trava para não ficar sem nenhum. */
export async function contarAdmins() {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM painel_usuarios WHERE admin AND ativo',
  );
  return rows[0].n;
}

export async function existeAlgumUsuario() {
  const { rows } = await query('SELECT count(*)::int AS n FROM painel_usuarios');
  return rows[0].n > 0;
}
