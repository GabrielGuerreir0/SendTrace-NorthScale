/**
 * Conexão de SÓ LEITURA com o Postgres — usada pelas rotas /api/leitura/*.
 *
 * Conecta como o papel `sendtrace_leitura` (migração 115): sem superusuário, só SELECT nas tabelas liberadas (as credenciais ficam de fora),
 * `default_transaction_read_only`, tempo máximo de 20 s por consulta e no máximo 6 conexões. Por isso é um Pool PRÓPRIO, com outro usuário, e
 * não `SET ROLE` na conexão principal: a conexão principal é superusuária, e quem consegue rodar SQL nela consegue voltar ao papel original.
 *
 * `DATABASE_URL_LEITURA` vem do .env (gravado por Correções/leitura_api/ativar_leitura.sh). Sem ela, `leituraConfigurada` é false e as rotas
 * de tabela/esquema/SQL respondem 503 — a API segue de pé e as demais rotas não são afetadas.
 */
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL_LEITURA || '';
const insecure = String(process.env.DB_SSL_INSECURE).toLowerCase() === 'true';

export const leituraConfigurada = Boolean(connectionString);

const poolLeitura = leituraConfigurada
  ? new Pool({
      connectionString,
      ssl: insecure ? { rejectUnauthorized: false } : undefined,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    })
  : null;

poolLeitura?.on('error', (err) => {
  console.error('[db-leitura] erro no pool ocioso:', err.message);
});

export const LIMITE_PADRAO = 1000;
export const LIMITE_MAXIMO = 20000;

/**
 * Roda uma consulta numa transação `READ ONLY` e devolve `{ campos, linhas, truncado }`.
 *
 * `sql` entra como SUBCONSULTA de `SELECT * FROM (<sql>) AS _q LIMIT $1`: o protocolo estendido do Postgres só aceita UM comando por vez e
 * o envelope só aceita SELECT/WITH — INSERT, DDL, COPY, `;` com um segundo comando, tudo isso falha de cara. O `LIMIT` é parâmetro, nunca texto.
 * Pedimos uma linha a mais que o limite só para saber se houve corte.
 */
export async function consultarLeitura(sql, { limite = LIMITE_PADRAO } = {}) {
  if (!poolLeitura) {
    const erro = new Error('Leitura não configurada (DATABASE_URL_LEITURA).');
    erro.leitura = true;
    erro.statusCode = 503;
    throw erro;
  }
  const texto = String(sql ?? '').trim().replace(/;+\s*$/, '');
  if (!texto) {
    const erro = new Error('Informe o SQL.');
    erro.leitura = true;
    erro.statusCode = 400;
    throw erro;
  }
  if (/\$\d/.test(texto)) {
    const erro = new Error('Não use parâmetros ($1…) no SQL; escreva os valores direto.');
    erro.leitura = true;
    erro.statusCode = 400;
    throw erro;
  }
  const teto = Math.min(LIMITE_MAXIMO, Math.max(1, Number(limite) || LIMITE_PADRAO));

  const cliente = await poolLeitura.connect();
  try {
    await cliente.query('BEGIN READ ONLY');
    // a quebra de linha protege contra um comentário `--` no fim do SQL engolir o fecha-parênteses
    const r = await cliente.query(`SELECT * FROM (${texto}\n) AS _q LIMIT $1`, [teto + 1]);
    await cliente.query('ROLLBACK');
    const truncado = r.rows.length > teto;
    return { campos: r.fields.map((f) => f.name), linhas: truncado ? r.rows.slice(0, teto) : r.rows, truncado, limite: teto };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (!err.leitura) {
      // erro do Postgres (sintaxe, permissão, tempo esgotado): 400 com a mensagem — quem consulta precisa ler para corrigir
      err.leitura = true;
      err.statusCode = err.code === '57014' ? 408 : 400;
      err.message = err.code === '57014' ? 'Consulta passou do limite de 20 segundos; filtre mais ou reduza o período.' : err.message;
    }
    throw err;
  } finally {
    cliente.release();
  }
}
