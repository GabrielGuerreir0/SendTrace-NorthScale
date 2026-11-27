/**
 * MONIT-SPPL — a ATUALIZAÇÃO de `monit_pedidos` (migração 142): refaz, numa transação, a classificação de todos os pedidos em aberto e dos sem rastreio.
 *
 * Roda sozinha a cada 10 min (`iniciarMonit`, ligado em api/servidor.js) e no botão "Atualizar" da tela (POST /api/rastreio/monit/atualizar). Só uma por vez
 * (trava de aviso `pg_try_advisory_xact_lock` + a coluna `monit_leitura.iniciado_em`); quem chega com uma já rodando recebe o estado atual. A hora REAL da
 * leitura fica em `monit_leitura.lido_em` e a tela sempre a mostra. A tabela só é trocada no COMMIT: quem lê durante a atualização vê a leitura anterior.
 */
import { pool, query } from '../../server/db.js';
import { SQL_CLASSIFICAR, SQL_SEM_RASTREIO } from './sqlClassificacao.js';

/** Pedidos mais antigos que isto nem entram na tabela (o painel usa 2026-01-01 como "todas as datas"). */
export const CORTE_TABELA = '2026-01-01';
export const INTERVALO_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 120_000;
const CHAVE_TRAVA = 4_242_142;   // número qualquer, só para a trava de aviso do Postgres

let rodando = null;

/** Estado da última leitura (hora real, duração, linhas, erro). */
export async function estadoLeitura() {
  const { rows: [r] } = await query('SELECT lido_em, duracao_ms, linhas, erro, iniciado_em FROM monit_leitura WHERE id = 1');
  return r ?? { lido_em: null, duracao_ms: null, linhas: 0, erro: null, iniciado_em: null };
}

/** Refaz a tabela. `{ ocupado: true }` se outra atualização já está rodando. Nunca lança (o erro vai para `monit_leitura.erro`). */
export async function atualizarMonit({ log = () => {} } = {}) {
  if (rodando) return { ocupado: true, ...(await estadoLeitura()) };
  rodando = (async () => {
    const t0 = Date.now();
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const { rows: [{ ok }] } = await cli.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [CHAVE_TRAVA]);
      if (!ok) { await cli.query('ROLLBACK'); return { ocupado: true }; }
      await cli.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await cli.query('UPDATE monit_leitura SET iniciado_em = now() WHERE id = 1');
      await cli.query('DELETE FROM monit_pedidos');
      await cli.query(SQL_CLASSIFICAR, [CORTE_TABELA]);
      await cli.query(SQL_SEM_RASTREIO, [CORTE_TABELA]);
      const { rows: [{ n }] } = await cli.query('SELECT count(*)::int AS n FROM monit_pedidos');
      const ms = Date.now() - t0;
      await cli.query('UPDATE monit_leitura SET lido_em = now(), duracao_ms = $1, linhas = $2, erro = NULL, iniciado_em = NULL WHERE id = 1', [ms, n]);
      await cli.query('COMMIT');
      log(`MONIT-SPPL: ${n} pedidos classificados em ${ms} ms`);
      return { ok: true, linhas: n, duracao_ms: ms };
    } catch (err) {
      await cli.query('ROLLBACK').catch(() => {});
      await query('UPDATE monit_leitura SET erro = $1, iniciado_em = NULL WHERE id = 1', [String(err.message).slice(0, 500)]).catch(() => {});
      log(`MONIT-SPPL: falha na atualização: ${err.message}`);
      return { ok: false, erro: err.message };
    } finally { cli.release(); }
  })();
  try { return await rodando; } finally { rodando = null; }
}

/** Liga o job periódico. Devolve o intervalo (para o desligamento do servidor). Erro vira só log, nunca derruba a API. */
export function iniciarMonit(log = () => {}) {
  const rodar = () => atualizarMonit({ log }).catch((e) => log(`MONIT-SPPL: ${e.message}`));
  // Na subida só refaz se a leitura estiver velha (um reinício não precisa gastar ~10 s do banco à toa).
  setTimeout(async () => {
    try { const e = await estadoLeitura(); if (!e.lido_em || Date.now() - new Date(e.lido_em).getTime() > INTERVALO_MS - 60_000) await rodar(); } catch { /* migração ainda não aplicada */ }
  }, 45_000);
  return setInterval(rodar, INTERVALO_MS);
}
