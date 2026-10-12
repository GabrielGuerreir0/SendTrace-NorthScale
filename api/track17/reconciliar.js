/**
 * Reconciliação do 17TRACK (SPPL): rede de segurança do webhook. A cada rodada reconsulta (gettrackinfo, que NÃO gasta cota) os códigos aceitos que ainda não
 * foram entregues e não foram consultados nas últimas 24 h, os mais atrasados primeiro, e grava o que mudou com a mesma gravação idempotente do webhook.
 * Código que o 17TRACK devolve sem dado também recebe `ultima_consulta_em`, para não ser retentado a cada rodada.
 * Liga/desliga: config_disparos.sppl_17track_reconciliar_ativo (nasce 'true'). Sem chave configurada não faz nada.
 */
import { query } from '../../server/db.js';
import * as clientePadrao from './cliente.js';
import { gravarTrackInfo } from './persistir.js';

export const CONSULTAS_POR_RODADA = 400;   // 10 chamadas de 40

/** Códigos a reconsultar. */
export async function candidatosReconciliacao(limite) {
  const { rows } = await query(
    `SELECT numero FROM rastreio_17t_registros
      WHERE situacao_registro = 'aceito' AND coalesce(ultimo_status, '') NOT IN ('Delivered', 'Expired')
        AND coalesce(ultima_consulta_em, 'epoch') < now() - interval '24 hours'
      ORDER BY coalesce(ultima_consulta_em, 'epoch'), atualizado_em NULLS FIRST LIMIT $1`, [limite]);
  return rows.map((r) => r.numero);
}

/** Guarda a cota restante para o cartão de saúde e o alerta (função SQL sppl_saude_problemas). Erro aqui nunca derruba a rodada. */
export async function registrarCota(cliente = clientePadrao) {
  try {
    const c = await cliente.cota();
    if (c && c.quota_remain !== undefined) {
      await query(`INSERT INTO config_disparos (chave, valor) VALUES ('sppl_17track_cota_restante', $1), ('sppl_17track_cota_restante_em', now()::text)
                   ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [String(Number(c.quota_remain))]);
    }
    return c;
  } catch { return null; }
}

export async function reconciliar({ cliente = clientePadrao, forcar = false, log = () => {} } = {}) {
  if (!cliente.chaveConfigurada()) return { rodou: false, motivo: 'sem chave' };
  const ativo = (await query(`SELECT valor FROM config_disparos WHERE chave = 'sppl_17track_reconciliar_ativo'`)).rows[0]?.valor === 'true';
  if (!ativo && !forcar) return { rodou: false, motivo: 'desligado' };
  await registrarCota(cliente);
  const numeros = await candidatosReconciliacao(CONSULTAS_POR_RODADA);
  if (!numeros.length) return { rodou: true, consultados: 0, atualizados: 0, eventos_novos: 0, sem_dado: 0 };
  const { aceitos, rejeitados } = await cliente.consultar(numeros);
  let eventos = 0;
  for (const item of aceitos) { eventos += (await gravarTrackInfo(item, 'consulta')).novos; }
  const vistos = new Set([...aceitos.map((a) => String(a.number)), ...rejeitados.map((r) => String(r.number))]);
  // quem respondeu (com ou sem dado) sai da fila por 24 h
  await query(`UPDATE rastreio_17t_registros SET ultima_consulta_em = now() WHERE numero = ANY($1::text[])`, [[...vistos]]);
  log(`17TRACK reconciliação: ${numeros.length} consultados, ${aceitos.length} com dado, ${eventos} eventos novos, ${rejeitados.length} sem dado`);
  return { rodou: true, consultados: numeros.length, atualizados: aceitos.length, eventos_novos: eventos, sem_dado: rejeitados.length };
}
