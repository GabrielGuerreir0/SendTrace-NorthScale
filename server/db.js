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
  // GET /api/dados (Central de E-mail IA) dispara ~25 consultas em paralelo
  // num único Promise.all. Com max:5 elas competem em 5 lotes sequenciais —
  // sozinho já é lento, e sob concorrência (duas abas recarregando junto,
  // ou o filtro de produto/loja mudando com a tela de Detalhes já com o
  // polling de 30s ligado) o request inteiro passa dos 20s de timeout do
  // painel e vira 502. 5 conexões era folgado antes desta tela existir.
  max: 15,
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
