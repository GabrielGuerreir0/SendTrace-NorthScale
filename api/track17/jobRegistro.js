/**
 * Job de registro no 17TRACK (SPPL): escolhe os pedidos abertos COM código de rastreio que ainda não foram registrados e os registra em lotes.
 * Desligado por padrão: ligue com `UPDATE config_disparos SET valor='true' WHERE chave='sppl_17track_ativo'` (a chave abaixo é criada pela migração 091).
 *
 * Cuidados:
 *  - só pedido ABERTO (enviado, não cancelado) e que NÃO foi reembolsado nem sofreu chargeback;
 *  - o 17TRACK detecta a transportadora (não mandamos a nossa: o nome que a FullStack envia não é confiável);
 *  - só registra pedido enviado nos últimos `sppl_17track_janela_dias` dias (padrão 30; 0 = sem limite): pedido antigo não entra na carga nem gera card (decisão do Lucas, 13/10/2026). A data usada é `shipped_at` ou, se vazia (FullStack), `criado_em`;
 *  - não gasta cota sem limite: para quando restar `sppl_17track_cota_reserva` (padrão 20) e respeita `sppl_17track_lote_por_rodada` (padrão 200);
 *  - código recusado (ex.: USPS sem pacote pago) NÃO é reenviado a cada rodada: depois de comprar o pacote, reabra com
 *    `UPDATE rastreio_17t_registros SET situacao_registro='pendente' WHERE situacao_registro='recusado' AND motivo_recusa ILIKE '%USPS%'`.
 */
import { query } from '../../server/db.js';
import * as clientePadrao from './cliente.js';
import { gravarRegistro } from './persistir.js';
import { registrarCota } from './reconciliar.js';

const num = (v, padrao) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : padrao; };

async function config() {
  const { rows } = await query(`SELECT chave, valor FROM config_disparos WHERE chave LIKE 'sppl_17track_%'`);
  const c = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  return { ativo: c.sppl_17track_ativo === 'true', reserva: num(c.sppl_17track_cota_reserva, 20), lote: Math.min(num(c.sppl_17track_lote_por_rodada, 200), 1000),
    janelaDias: Math.floor(num(c.sppl_17track_janela_dias, 30)) };
}

/** Códigos a registrar: abertos, com código, sem registro (ou 'pendente'), fora reembolso/chargeback/cancelado. Os mais recentes primeiro. */
export async function candidatos(limite, janelaDias = 30) {
  const { rows } = await query(
    `SELECT DISTINCT ON (p.tracking_number) p.tracking_number AS numero, COALESCE(p.shipped_at, p.criado_em) AS data_ref
       FROM rastreio_pedidos p
       LEFT JOIN rastreio_17t_registros r ON r.numero = p.tracking_number
       LEFT JOIN disparos_pos_venda d ON d.transacao_id = p.transacao_id
      WHERE p.tracking_number <> '' AND p.status_interno = 'shipped'
        AND (r.numero IS NULL OR r.situacao_registro = 'pendente')
        AND d.reembolsado_em IS NULL AND d.chargeback_em IS NULL
        AND ($2::int = 0 OR COALESCE(p.shipped_at, p.criado_em) >= now() - make_interval(days => $2::int))   -- só pedidos recentes (janela em dias; 0 = sem limite). A FullStack não preenche shipped_at: sem o COALESCE o NULL derrubava o pedido da janela e ele nunca era registrado (achado de 21/10)
      ORDER BY p.tracking_number, COALESCE(p.shipped_at, p.criado_em) DESC
      LIMIT $1`, [limite * 3, janelaDias]);
  return rows.sort((a, b) => String(b.data_ref).localeCompare(String(a.data_ref))).slice(0, limite).map((r) => r.numero);
}

/** Uma rodada. Devolve o resumo (para o log e para os testes). */
export async function registrarPendentes({ cliente = clientePadrao, forcar = false, log = () => {} } = {}) {
  if (!cliente.chaveConfigurada()) return { rodou: false, motivo: 'sem chave' };
  const cfg = await config();
  if (!cfg.ativo && !forcar) return { rodou: false, motivo: 'desligado' };
  const cota = (await registrarCota(cliente)) ?? (await cliente.cota());
  const restante = cota.quota_remain;
  const disponivel = Math.min(cfg.lote, Math.max(0, Number(restante) - cfg.reserva));
  if (disponivel <= 0) return { rodou: false, motivo: 'cota na reserva', restante };
  const numeros = await candidatos(disponivel, cfg.janelaDias);
  if (!numeros.length) return { rodou: true, candidatos: 0, aceitos: 0, recusados: 0, restante };
  const { aceitos, recusados } = await cliente.registrar(numeros);
  await gravarRegistro({ aceitos, recusados });
  log(`17TRACK: ${numeros.length} candidatos, ${aceitos.length} aceitos, ${recusados.length} recusados`);
  return { rodou: true, candidatos: numeros.length, aceitos: aceitos.length, recusados: recusados.length, restante: Number(restante) - aceitos.length };
}
