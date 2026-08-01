/**
 * Ajustes que não pertencem a nenhuma camada em particular.
 *
 * Moraram no `db.js` enquanto o painel lia SQL. Com os dados vindo da API, um
 * `import` daqui não pode mais arrastar junto um pool de Postgres — nem
 * derrubar o processo quando não existe `DATABASE_URL`.
 */

/** Acima de quantos minutos em 'processando' um pedido conta como TRAVADO. */
export const LOCK_TIMEOUT_MIN = Number(process.env.LOCK_TIMEOUT_MIN) || 10;

/** Quanto tempo a sessão do painel dura sem novo login. */
export const SESSAO_HORAS = Number(process.env.SESSAO_HORAS) || 12;
