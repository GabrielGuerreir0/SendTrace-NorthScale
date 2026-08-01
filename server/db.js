import pg from 'pg';

const { Pool, types } = pg;

// O driver devolve bigint (OID 20) como string para não perder precisão.
// Os ids desta tabela cabem folgado num Number, então convertemos.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n  ✖ DATABASE_URL não definida. Copie .env.example para .env e preencha.\n');
  process.exit(1);
}

const insecure = String(process.env.DB_SSL_INSECURE).toLowerCase() === 'true';

export const pool = new Pool({
  connectionString,
  ssl: insecure ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  // Neon hiberna a compute quando ociosa; o primeiro SELECT pode acordar o banco.
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => {
  console.error('[db] erro no pool ocioso:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export const LOCK_TIMEOUT_MIN = Number(process.env.LOCK_TIMEOUT_MIN) || 10;
