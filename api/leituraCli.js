/**
 * Administra as chaves de leitura pelo terminal (roda DENTRO do container da API, onde DATABASE_URL já existe):
 *
 *   node api/leituraCli.js criar "Késsia Martins" [--mascarar] [--descricao "Claude da Késsia"]
 *   node api/leituraCli.js listar
 *   node api/leituraCli.js revogar <id>
 *   node api/leituraCli.js permitir-propriedades <id>    a chave também edita as Propriedades dos tickets (migração 122)
 *   node api/leituraCli.js bloquear-propriedades <id>    volta a ser só leitura
 *   node api/leituraCli.js auditoria [quantas=30] [chave_id]
 *
 * `criar` imprime o token UMA vez; só o hash fica no banco.
 */
import { pool } from '../server/db.js';
import { criarChave, listarChaves, revogarChave, definirEditaPropriedades } from './leituraChaves.js';

const [, , comando, ...args] = process.argv;
const flag = (nome) => args.includes(`--${nome}`);
const valorDe = (nome) => { const i = args.indexOf(`--${nome}`); return i >= 0 ? args[i + 1] : null; };

try {
  if (comando === 'criar') {
    const dono = args.find((a) => !a.startsWith('--') && a !== valorDe('descricao'));
    if (!dono) throw new Error('Informe o dono: node api/leituraCli.js criar "Nome da pessoa"');
    const { id, token } = await criarChave({ dono, descricao: valorDe('descricao'), mascararPii: flag('mascarar'), criadaPor: 'cli' });
    console.log(`\n  Chave #${id} criada para ${dono}${flag('mascarar') ? ' (dados pessoais mascarados)' : ' (dados completos)'}.`);
    console.log('  Guarde agora — não aparece de novo:\n');
    console.log(`  ${token}\n`);
  } else if (comando === 'listar') {
    const chaves = await listarChaves();
    console.table(chaves.map((c) => ({
      id: c.id, dono: c.dono, prefixo: c.prefixo, pii: c.mascarar_pii ? 'mascarado' : 'completo', edita_propriedades: c.edita_propriedades ? 'SIM' : '',
      criada: c.criada_em.toISOString().slice(0, 16), ultimo_uso: c.ultimo_uso_em?.toISOString().slice(0, 16) ?? '—', usos: c.usos, revogada: c.revogada_em ? 'SIM' : '',
    })));
  } else if (comando === 'revogar') {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id < 1) throw new Error('Informe o id numérico da chave.');
    console.log((await revogarChave(id)) ? `Chave #${id} revogada.` : `Chave #${id} não encontrada ou já revogada.`);
  } else if (comando === 'permitir-propriedades' || comando === 'bloquear-propriedades') {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id < 1) throw new Error('Informe o id numérico da chave.');
    const liga = comando === 'permitir-propriedades';
    console.log((await definirEditaPropriedades(id, liga)) ? `Chave #${id}: edição das Propriedades ${liga ? 'LIGADA' : 'desligada'}.` : `Chave #${id} não encontrada ou revogada.`);
  } else if (comando === 'auditoria') {
    const n = Math.min(500, Number(args[0]) || 30);
    const chave = args[1] ? Number(args[1]) : null;
    const { rows } = await pool.query(
      `SELECT to_char(quando AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS quando, dono, metodo, rota, status, ms, linhas, left(coalesce(sql, consulta, ''), 70) AS pedido
         FROM leitura_auditoria WHERE ($2::bigint IS NULL OR chave_id = $2) ORDER BY id DESC LIMIT $1`,
      [n, chave],
    );
    console.table(rows);
  } else {
    console.log('Uso: criar "<dono>" [--mascarar] [--descricao "…"] | listar | revogar <id> | permitir-propriedades <id> | bloquear-propriedades <id> | auditoria [quantas] [chave_id]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n  ✖ ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
