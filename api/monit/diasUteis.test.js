// TESTE_BANCO=1 DATABASE_URL=… node --test api/monit/diasUteis.test.js
// Dias úteis (fim de semana e feriados dos EUA) de `monit_dias_uteis`. Precisa do banco (a função mora na migração 142), então só roda com TESTE_BANCO=1;
// o SQL fica em diasUteis.teste.sql e roda dentro de BEGIN … ROLLBACK (não grava nada). Sem a variável, o teste é pulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ligado = process.env.TESTE_BANCO === '1' && Boolean(process.env.DATABASE_URL);

test('monit_dias_uteis: fim de semana, Thanksgiving (26/11/2026) e Natal (25/12/2026)', { skip: ligado ? false : 'defina TESTE_BANCO=1 e DATABASE_URL' }, async () => {
  const { pool } = await import('../../server/db.js');
  const sql = await readFile(new URL('./diasUteis.teste.sql', import.meta.url), 'utf8');
  const cli = await pool.connect();
  try {
    // o arquivo traz o próprio BEGIN/ROLLBACK; várias instruções vão numa única chamada simples (sem parâmetros)
    await cli.query(sql);
    assert.ok(true);
  } finally {
    await cli.query('ROLLBACK').catch(() => {});   // garantia extra se algo falhar no meio
    cli.release(); await pool.end();
  }
});
