/**
 * Roda as migrações da pasta server/migrations em ordem alfabética.
 * Todas são idempotentes, então rodar de novo é seguro.
 *
 *   npm run setup
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import {
  criarUsuario, existeAlgumUsuario, validarSenha, normalizarEmail, emailValido,
} from './auth.js';

/* Senha provisória legível: sem caracteres ambíguos (O/0, l/1) porque ela vai
   ser lida de um terminal e redigitada à mão. O comprimento compensa o
   alfabeto menor — 5 grupos de 4 dão folga de sobra. */
function gerarSenhaForte() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  // randomInt em vez de randomBytes(...) % n: o resto enviesa as primeiras
  // letras do alfabeto, porque 256 não é múltiplo de 56.
  const letras = Array.from({ length: 20 }, () => alfabeto[crypto.randomInt(alfabeto.length)]);
  return letras.join('').replace(/(.{4})(?=.)/g, '$1-');
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/*
 * Registro do que já foi aplicado. Sem ele, uma migração que semeia a régua
 * roda de novo a cada `npm run setup` e sobrescreve a copy que você editou no
 * banco — exatamente o que o README promete que NÃO acontece. Cada arquivo
 * roda uma vez e fica registrado.
 */
/*
 * Trava de exclusão entre processos.
 *
 * Em container, dois réplicas subindo ao mesmo tempo rodariam as migrações em
 * paralelo. A chave primária de painel_migracoes evitaria a aplicação dupla,
 * mas uma das duas morreria com erro no meio do boot. Com a trava, a segunda
 * espera, encontra tudo aplicado e segue.
 */
const TRAVA = 8_147_320;   // número arbitrário, só precisa ser o mesmo sempre
const trava = await pool.connect();
await trava.query('SELECT pg_advisory_lock($1)', [TRAVA]);

await pool.query(`
  CREATE TABLE IF NOT EXISTS painel_migracoes (
    arquivo     text        PRIMARY KEY,
    aplicada_em timestamptz NOT NULL DEFAULT now()
  )`);

const { rows: jaFeitas } = await pool.query('SELECT arquivo FROM painel_migracoes');
const aplicadas = new Set(jaFeitas.map((r) => r.arquivo));

const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const arq of arquivos) {
  if (aplicadas.has(arq)) {
    console.log(`  ${arq} … já aplicada`);
    continue;
  }
  const sql = await fs.readFile(path.join(dir, arq), 'utf8');
  process.stdout.write(`  ${arq} … `);
  // Migração e registro na MESMA transação: se o SQL falhar no meio, nada fica
  // marcado como aplicado e a próxima execução tenta de novo do começo.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(sql);
    await cliente.query('INSERT INTO painel_migracoes (arquivo) VALUES ($1)', [arq]);
    await cliente.query('COMMIT');
    console.log('ok');
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.log('FALHOU');
    throw err;
  } finally {
    cliente.release();
  }
}

const { rows } = await pool.query(
  // DISTINCT: com três linhas de copy, cada (etapa, canal) tem três registros
  // e o resumo saía "email+email+email+sms+sms+sms".
  `SELECT e.etapa, e.nome, e.espera_h, e.ativo,
          string_agg(DISTINCT m.canal, '+') FILTER (WHERE m.ativo) AS canais
   FROM etapas_regua e
   LEFT JOIN mensagens_regua m ON m.etapa = e.etapa
   GROUP BY e.etapa, e.nome, e.espera_h, e.ativo
   ORDER BY e.etapa`,
);
console.log(`\n  Régua com ${rows.length} etapa(s):`);
for (const r of rows) {
  const espera = r.espera_h === null ? 'fim da régua' : `espera ${r.espera_h} h`;
  const canais = r.canais ?? 'SEM MENSAGEM';
  console.log(`   ${r.etapa}  ${r.nome.padEnd(24)} ${canais.padEnd(10)} ${espera}${r.ativo ? '' : '  (inativa)'}`);
}
console.log('\n  Cadência:  UPDATE etapas_regua   SET espera_h = … WHERE etapa = N;');
console.log('  Copy:      UPDATE mensagens_regua SET texto = …   WHERE etapa = N AND canal = \'sms\';');

/*
 * Administrador inicial. Criado UMA vez, só se ainda não existir nenhum
 * usuário — assim rodar o setup de novo nunca recria nem ressuscita conta.
 *
 * A senha vem de ADMIN_SENHA ou é sorteada. Ela aparece no terminal uma única
 * vez e não fica guardada em lugar nenhum recuperável: o banco só tem o hash.
 * A conta nasce com troca de senha pendente, então essa senha provisória morre
 * no primeiro acesso.
 */
if (!(await existeAlgumUsuario())) {
  const email = normalizarEmail(process.env.ADMIN_EMAIL || 'admin@painel.local');
  if (!emailValido(email)) {
    console.error(`\n  ADMIN_EMAIL inválido: ${email}\n`);
    process.exit(1);
  }

  const senha = process.env.ADMIN_SENHA || gerarSenhaForte();
  const problema = validarSenha(senha, { email });
  if (problema) {
    console.error(`\n  ADMIN_SENHA recusada: ${problema}\n`);
    process.exit(1);
  }

  await criarUsuario({ email, nome: 'Administrador', senha, admin: true, criadoPor: null });

  console.log('\n  ┌─────────────────────────────────────────────────────────────┐');
  console.log('    ADMINISTRADOR CRIADO — anote agora, não aparece de novo');
  console.log('  └─────────────────────────────────────────────────────────────┘');
  console.log(`    e-mail: ${email}`);
  console.log(`    senha:  ${senha}`);
  console.log('\n    É provisória: o painel vai pedir uma senha sua no primeiro acesso.');
  if (!process.env.ADMIN_SENHA) {
    console.log('    Para escolher a senha inicial, defina ADMIN_EMAIL e ADMIN_SENHA no .env');
    console.log('    ANTES do primeiro `npm run setup`.');
  }
  console.log('');
} else {
  const { rows: admins } = await pool.query(
    'SELECT count(*)::int AS n FROM painel_usuarios WHERE admin AND ativo',
  );
  console.log(`\n  Acesso: ${admins[0].n} administrador(es) ativo(s). Novos usuários pelo painel.\n`);
}

// Solta a trava antes de fechar o pool. `pool.end()` sozinho já derrubaria a
// conexão e o Postgres liberaria a trava, mas soltar de propósito deixa a
// intenção explícita e evita depender do efeito colateral.
await trava.query('SELECT pg_advisory_unlock($1)', [TRAVA]);
trava.release();

await pool.end();
