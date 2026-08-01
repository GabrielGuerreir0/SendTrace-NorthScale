/**
 * Redefine a senha de um usuário pelo terminal.
 *
 * Existe porque o painel não manda e-mail: sem isto, esquecer a senha do único
 * administrador tornaria o painel inacessível para sempre. Quem tem acesso ao
 * servidor e ao .env já poderia mexer no banco de qualquer jeito — então isto
 * não abre porta nenhuma que já não estivesse aberta.
 *
 *   npm run senha -- alguem@empresa.com
 *   npm run senha -- alguem@empresa.com "uma senha que eu escolhi"
 *   npm run senha -- alguem@empresa.com --admin      (promove a administrador)
 */
import crypto from 'node:crypto';
import { pool } from './db.js';
import { emitirSenhaProvisoria, validarSenha, normalizarEmail, CONVITE_DIAS } from './auth.js';
import { enviarConvite, emailConfigurado } from './email.js';

const args = process.argv.slice(2);
const email = normalizarEmail(args[0] ?? '');
const promover = args.includes('--admin');
const semEmail = args.includes('--sem-email');
const senhaDada = args.slice(1).find((a) => !a.startsWith('--'));

if (!email) {
  console.error('\n  uso: npm run senha -- email@empresa.com ["nova senha"] [--admin]\n');
  process.exit(1);
}

function gerarSenhaForte() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const letras = Array.from({ length: 20 }, () => alfabeto[crypto.randomInt(alfabeto.length)]);
  return letras.join('').replace(/(.{4})(?=.)/g, '$1-');
}

const { rows } = await pool.query(
  'SELECT id, email, admin, ativo FROM painel_usuarios WHERE email = $1', [email],
);
if (!rows.length) {
  console.error(`\n  Nenhum usuário com o e-mail ${email}.\n`);
  const { rows: todos } = await pool.query(
    'SELECT email, admin, ativo FROM painel_usuarios ORDER BY email',
  );
  if (todos.length) {
    console.error('  Existem:');
    for (const u of todos) {
      console.error(`   · ${u.email}${u.admin ? '  (admin)' : ''}${u.ativo ? '' : '  (desativado)'}`);
    }
    console.error('');
  }
  await pool.end();
  process.exit(1);
}

const usuario = rows[0];
const senha = senhaDada || gerarSenhaForte();

const problema = validarSenha(senha, { email });
if (problema) {
  console.error(`\n  Senha recusada: ${problema}\n`);
  await pool.end();
  process.exit(1);
}

// Emite como PROVISÓRIA: com prazo, exigindo troca e derrubando as sessões
// abertas — uma redefinição que deixa a sessão antiga viva não redefine nada.
await emitirSenhaProvisoria(usuario.id, senha);
await pool.query('UPDATE painel_usuarios SET ativo = true WHERE id = $1', [usuario.id]);

if (promover && !usuario.admin) {
  await pool.query('UPDATE painel_usuarios SET admin = true WHERE id = $1', [usuario.id]);
}

console.log(`\n  Senha redefinida para ${email}`);
console.log(`  senha: ${senha}`);
if (promover) console.log('  agora é administrador');
console.log(`\n  É provisória: vale ${CONVITE_DIAS} dias e o painel pede uma nova no próximo acesso.`);
console.log('  As sessões abertas dessa conta foram encerradas.');

if (semEmail) {
  console.log('  E-mail não enviado (--sem-email).\n');
} else if (!emailConfigurado) {
  console.log('  E-mail não enviado: SMTP não configurado no .env. Repasse a senha acima.\n');
} else {
  // Sem requisição HTTP aqui, então o link só sai certo com PAINEL_URL fixado.
  const r = await enviarConvite({
    para: email, senha, admin: promover || usuario.admin,
    quemConvidou: null, dias: CONVITE_DIAS, req: null,
  });
  if (r.enviado) {
    console.log(`  E-mail enviado para ${email} com o link ${r.link}`);
    if (!process.env.PAINEL_URL) {
      console.log('  (defina PAINEL_URL no .env para o link apontar para o endereço público)');
    }
    console.log('');
  } else {
    console.log(`  E-mail NÃO enviado: ${r.motivo}`);
    console.log('  Repasse a senha acima por outro caminho.\n');
  }
}

await pool.end();
