/** Grava o que veio do 17TRACK. Tudo idempotente: reenviar o mesmo webhook ou reconsultar não duplica nada. */
import { query } from '../../server/db.js';
import { normalizarItem, classificarRecusa } from './normalizar.js';

/** Histórico completo de um código (webhook ou consulta): registro + eventos novos + payload bruto. Devolve quantos eventos eram novos. */
export async function gravarTrackInfo(item, origem) {
  const n = normalizarItem(item);
  if (!n.numero) return { numero: null, novos: 0 };
  await query(
    `INSERT INTO rastreio_17t_registros (numero, carrier_17t, situacao_registro, registrado_em, cota_gasta, ultimo_status, ultimo_substatus, ultimo_evento_em, atualizado_em, ultima_consulta_em)
     VALUES ($1, $2, 'aceito', now(), 0, $3, $4, $5, now(), CASE WHEN $6 = 'consulta' THEN now() END)
     ON CONFLICT (numero) DO UPDATE SET
       carrier_17t = coalesce(EXCLUDED.carrier_17t, rastreio_17t_registros.carrier_17t),
       situacao_registro = 'aceito', motivo_recusa = NULL, codigo_erro = NULL,
       ultimo_status = EXCLUDED.ultimo_status, ultimo_substatus = EXCLUDED.ultimo_substatus,
       ultimo_evento_em = EXCLUDED.ultimo_evento_em, atualizado_em = now(),
       ultima_consulta_em = coalesce(EXCLUDED.ultima_consulta_em, rastreio_17t_registros.ultima_consulta_em)`,
    [n.numero, n.carrier, n.ultimoStatus, n.ultimoSubstatus, n.ultimoEventoEm, origem],
  );
  let novos = 0;
  if (n.eventos.length) {
    const col = (k) => n.eventos.map((e) => e[k]);
    const r = await query(
      `INSERT INTO rastreio_17t_eventos (numero, chave, ocorreu_em, status, substatus, descricao, cidade, estado, pais, provedor_17t)
       SELECT $1, * FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
       ON CONFLICT (numero, chave) DO NOTHING RETURNING id`,
      [n.numero, col('chave'), col('ocorreuEm'), col('status'), col('substatus'), col('descricao'), col('cidade'), col('estado'), col('pais'), col('provedor')],
    );
    novos = r.rows.length;
  }
  await query(`INSERT INTO rastreio_17t_payloads (numero, origem, payload) VALUES ($1, $2, $3::jsonb)`, [n.numero, origem, JSON.stringify(item)]);
  return { numero: n.numero, novos };
}

/** Resultado do registro: aceitos gastam 1 cota (só na 1ª vez); recusados guardam o motivo. */
export async function gravarRegistro({ aceitos, recusados }) {
  for (const a of aceitos) {
    await query(
      `INSERT INTO rastreio_17t_registros (numero, carrier_17t, situacao_registro, registrado_em, cota_gasta)
       VALUES ($1, $2, 'aceito', now(), 1)
       ON CONFLICT (numero) DO UPDATE SET carrier_17t = coalesce(EXCLUDED.carrier_17t, rastreio_17t_registros.carrier_17t),
         situacao_registro = 'aceito', motivo_recusa = NULL, codigo_erro = NULL,
         registrado_em = coalesce(rastreio_17t_registros.registrado_em, now())`,
      [String(a.number), Number.isInteger(a.carrier) ? a.carrier : null],
    );
  }
  for (const r of recusados) {
    const c = classificarRecusa(r.error);
    await query(
      `INSERT INTO rastreio_17t_registros (numero, carrier_17t, situacao_registro, motivo_recusa, codigo_erro)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (numero) DO UPDATE SET situacao_registro = CASE WHEN rastreio_17t_registros.situacao_registro = 'aceito' THEN 'aceito' ELSE EXCLUDED.situacao_registro END,
         motivo_recusa = EXCLUDED.motivo_recusa, codigo_erro = EXCLUDED.codigo_erro`,
      [String(r.number), Number.isInteger(r.carrier) ? r.carrier : null, c.situacao, c.motivo, c.codigo],
    );
  }
}
