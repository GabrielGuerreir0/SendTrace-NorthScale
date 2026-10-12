/**
 * SPPL — regras editáveis (tabela sppl_regras, migração 090) e calendário de feriados. Dentro do Rastreio de Pedidos.
 * Leitura: qualquer conta com a página "Rastreio". Escrita: só administrador (mudar prazo muda o que o time cobra do cliente e da fulfillment).
 * Não existe DELETE de regra: desligue com `ativa: false` (a semente do PDF continua à mão para reativar).
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

const PRIORIDADES = ['P0', 'P1', 'P2', 'P3'];
const ORIGENS = ['status_17t', 'tempo', 'sem_dado'];
const REFERENCIAS = ['compra', 'etiqueta', 'ultima_movimentacao'];

const texto = (v, max, obrigatorio = false) => {
  if (v === undefined) return undefined;
  const t = v === null ? '' : String(v).trim();
  if (!t) { if (obrigatorio) throw new ErroHttp(400, 'Campo de texto obrigatório vazio.'); return null; }
  return t.slice(0, max);
};
const inteiro = (v, min, max, nome) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroHttp(400, `${nome} deve ser um número inteiro de ${min} a ${max}.`);
  return n;
};
const booleano = (v) => (v === undefined ? undefined : Boolean(v));

/** Campos que a tela pode mudar (nome do campo → como validar). */
const EDITAVEIS = {
  titulo: (v) => texto(v, 160, true), acao: (v) => texto(v, 1000), responsavel: (v) => texto(v, 200, true),
  dias: (v) => inteiro(v, 0, 365, 'Dias'), dias_uteis: booleano, prazo_resolucao_dias: (v) => inteiro(v, 0, 90, 'Prazo de resolução'),
  imediato: booleano, contata_cliente: booleano, ativa: booleano, observacao: (v) => texto(v, 1000), ordem: (v) => inteiro(v, 0, 100000, 'Ordem'),
  prioridade: (v) => { if (v === undefined) return undefined; if (!PRIORIDADES.includes(v)) throw new ErroHttp(400, 'Prioridade deve ser P0, P1, P2 ou P3.'); return v; },
};

function validar(corpo, campos) {
  const saida = {};
  for (const campo of campos) {
    const v = EDITAVEIS[campo](corpo[campo]);
    if (v !== undefined) saida[campo] = v;
  }
  return saida;
}

const COLUNAS = `id, origem, etapa, status_17t, substatus_17t, referencia_tempo, categoria, titulo, acao, responsavel, dias, dias_uteis,
  prazo_resolucao_dias, imediato, contata_cliente, prioridade, ativa, ordem, observacao, atualizado_por, atualizado_em`;

export default async function rotasSpplRegras(app) {
  app.get('/api/rastreio/sppl/regras', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — regras (status do 17TRACK e prazos)', security: [{ bearerAuth: [] }] },
  }, async () => {
    const { rows } = await query(`SELECT ${COLUNAS} FROM sppl_regras ORDER BY ordem, id`);
    return { regras: rows };
  });

  app.patch('/api/rastreio/sppl/regras/:id', {
    onRequest: [app.exigirAdmin],
    schema: { tags: ['Rastreio'], summary: 'SPPL — edita uma regra', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  }, async (req) => {
    const campos = validar(req.body ?? {}, Object.keys(EDITAVEIS));
    const chaves = Object.keys(campos);
    if (!chaves.length) throw new ErroHttp(400, 'Nada para alterar.');
    const sets = chaves.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await query(
      `UPDATE sppl_regras SET ${sets.join(', ')}, atualizado_por = $${chaves.length + 2}, atualizado_em = now() WHERE id = $1 RETURNING ${COLUNAS}`,
      [req.params.id, ...chaves.map((c) => campos[c]), req.usuario?.email ?? null],
    );
    if (!rows[0]) throw new ErroHttp(404, 'Regra não encontrada.');
    return rows[0];
  });

  app.post('/api/rastreio/sppl/regras', {
    onRequest: [app.exigirAdmin],
    schema: { tags: ['Rastreio'], summary: 'SPPL — cria uma regra', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const b = req.body ?? {};
    if (!ORIGENS.includes(b.origem)) throw new ErroHttp(400, `Origem deve ser ${ORIGENS.join(', ')}.`);
    const categoria = texto(b.categoria, 80, true);
    if (b.origem === 'tempo' && !REFERENCIAS.includes(b.referencia_tempo)) throw new ErroHttp(400, `Regra de tempo precisa de referência: ${REFERENCIAS.join(', ')}.`);
    if (b.origem === 'status_17t' && !texto(b.status_17t, 60, true)) throw new ErroHttp(400, 'Regra de status precisa do status do 17TRACK.');
    const c = validar(b, ['titulo', 'acao', 'responsavel', 'dias', 'dias_uteis', 'prazo_resolucao_dias', 'imediato', 'contata_cliente', 'prioridade', 'observacao', 'ordem']);
    const { rows } = await query(
      `INSERT INTO sppl_regras (origem, etapa, status_17t, substatus_17t, referencia_tempo, categoria, titulo, acao, responsavel, dias, dias_uteis, prazo_resolucao_dias, imediato, contata_cliente, prioridade, ordem, observacao, atualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,'Equipe interna de PPL'),$10,coalesce($11,true),$12,coalesce($13,false),coalesce($14,false),coalesce($15,'P3'),coalesce($16,900),$17,$18)
       RETURNING ${COLUNAS}`,
      [b.origem, inteiro(b.etapa, 1, 5, 'Etapa') ?? null, texto(b.status_17t, 60) ?? null, texto(b.substatus_17t, 80) ?? null, b.origem === 'tempo' ? b.referencia_tempo : null,
        categoria, c.titulo ?? categoria, c.acao ?? null, c.responsavel ?? null, c.dias ?? null, c.dias_uteis ?? null, c.prazo_resolucao_dias ?? null, c.imediato ?? null,
        c.contata_cliente ?? null, c.prioridade ?? null, c.ordem ?? null, c.observacao ?? null, req.usuario?.email ?? null],
    );
    return rows[0];
  });

  app.get('/api/rastreio/sppl/feriados', {
    onRequest: [app.exigirSessao],
    schema: { tags: ['Rastreio'], summary: 'SPPL — feriados (dias não úteis)', security: [{ bearerAuth: [] }] },
  }, async () => ({ feriados: (await query(`SELECT to_char(data, 'YYYY-MM-DD') AS data, descricao FROM sppl_feriados ORDER BY data`)).rows }));

  app.post('/api/rastreio/sppl/feriados', {
    onRequest: [app.exigirAdmin],
    schema: { tags: ['Rastreio'], summary: 'SPPL — cadastra um feriado', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    const data = String(req.body?.data ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) throw new ErroHttp(400, 'Data no formato AAAA-MM-DD.');
    await query(`INSERT INTO sppl_feriados (data, descricao) VALUES ($1, $2) ON CONFLICT (data) DO UPDATE SET descricao = EXCLUDED.descricao`, [data, texto(req.body?.descricao, 120) ?? null]);
    return { data };
  });

  app.delete('/api/rastreio/sppl/feriados/:data', {
    onRequest: [app.exigirAdmin],
    schema: { tags: ['Rastreio'], summary: 'SPPL — remove um feriado', security: [{ bearerAuth: [] }] },
  }, async (req) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.data)) throw new ErroHttp(400, 'Data no formato AAAA-MM-DD.');
    const { rowCount } = await query(`DELETE FROM sppl_feriados WHERE data = $1`, [req.params.data]);
    if (!rowCount) throw new ErroHttp(404, 'Feriado não encontrado.');
    return { ok: true };
  });
}
