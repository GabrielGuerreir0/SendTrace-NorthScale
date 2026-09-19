/**
 * Suporte Escalado → sub-aba "Respostas dos formulários" (19/09/2026).
 *
 * Só LEITURA de `formularios_respostas` (migração 038), alimentada pelo fluxo n8n "Forms — Sincronizar
 * respostas (Drive)" a cada 15 min. Cada resposta já vem com PERFIL e DESTINO SUGERIDO
 * (`classificar_formularios()`); a decisão de qual grupo a IA responde sozinha e qual vai pro CS é humana
 * e ainda NÃO foi tomada — por isso a API só mostra a sugestão, nunca aplica.
 *
 *   GET /api/formularios/grupos/      → KPIs + um item por perfil (contagens, sugestão)
 *   GET /api/formularios/respostas/   → linhas de UM perfil (colunas leves + situação do caso no Kanban)
 *   GET /api/formularios/:id/         → a resposta inteira (todas as perguntas)
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

/** Rótulo e explicação de cada perfil (a regra em si mora em `classificar_formularios()`, migração 038). */
export const PERFIS = {
  nao_recebeu: { ordem: 1, rotulo: 'Não recebeu o produto', descricao: 'Diz que ainda não recebeu o pedido. A entrega leva cerca de 10 dias; o rastreio costuma responder.' },
  devolver_lacrado: { ordem: 2, rotulo: 'Recebeu, não usou, lacrado', descricao: 'Tem o produto lacrado em casa e nunca usou. Caso típico de devolução.' },
  devolucao_enviada: { ordem: 3, rotulo: 'Devolução já enviada (formulário de envio)', descricao: 'Preencheu o formulário de envio: informou rastreio, transportadora e se o produto está lacrado.' },
  usou_sem_resultado: { ordem: 4, rotulo: 'Usou o produto', descricao: 'Começou a usar; pede reembolso depois de usar. A decisão de garantia é humana.' },
  entrega_ou_produto_errado: { ordem: 5, rotulo: 'Problema na entrega / produto errado', descricao: 'Relata problema na entrega ou recebeu produto diferente do pedido.' },
  reincidente: { ordem: 6, rotulo: 'Reincidente (respondeu mais de uma vez)', descricao: 'Enviou o formulário mais de uma vez: está insistindo.' },
  efeito_adverso: { ordem: 7, rotulo: 'Efeito adverso / reação', descricao: 'Relata efeito colateral, alergia ou mal-estar. Assunto de saúde.' },
  risco_reputacional: { ordem: 8, rotulo: 'Risco: golpe, advogado ou disputa', descricao: 'Fala em golpe, fraude, advogado, órgão de defesa ou disputa no cartão.' },
  outro: { ordem: 9, rotulo: 'Outros', descricao: 'Não se encaixa em nenhum perfil acima.' },
};

const LEVE = `f.id, f.formulario, f.respondido_em, f.nome, f.email, f.pedido, f.produto, f.qtd_potes, f.motivo,
  f.recebeu_produto, f.usou_produto, f.produto_em_casa, f.rastreio, f.transportadora, f.lacrado, f.destino, f.motivo_destino,
  s.id AS caso_id, s.status AS caso_status, c.rotulo AS caso_coluna, s.board_id AS caso_board`;

const JUNTA_CASO = `LEFT JOIN email_ia.suporte_escalado s ON lower(s.remetente_email) = f.email
  LEFT JOIN email_ia.suporte_escalado_colunas c ON c.board_id = s.board_id AND c.chave = s.status`;

export default async function rotasFormularios(app) {
  const FORMULARIO = { type: 'string', enum: ['reembolso', 'envio'] };

  app.get('/api/formularios/grupos/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Suporte Escalado'],
      summary: 'Grupos de perfil das respostas dos formulários (reembolso e devolução)',
      description: 'Uma linha por perfil, com contagens e o destino SUGERIDO (a decisão é humana). Só leitura.',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { formulario: FORMULARIO } },
    },
  }, async (req) => {
    const form = req.query.formulario ?? null;
    const [grupos, meta] = await Promise.all([
      query(`SELECT perfil, count(*)::int AS total, count(DISTINCT email)::int AS clientes,
                    count(*) FILTER (WHERE formulario = 'reembolso')::int AS reembolso,
                    count(*) FILTER (WHERE formulario = 'envio')::int AS envio,
                    count(*) FILTER (WHERE destino = 'automatica')::int AS sug_automatica,
                    count(*) FILTER (WHERE destino = 'escalada')::int AS sug_escalada,
                    max(respondido_em) AS ultima_resposta
             FROM formularios_respostas WHERE perfil IS NOT NULL AND ($1::text IS NULL OR formulario = $1)
             GROUP BY perfil`, [form]),
      query(`SELECT count(*)::int AS total, count(DISTINCT email)::int AS clientes,
                    count(*) FILTER (WHERE respondido_em >= now() - interval '7 days')::int AS ultimos_7_dias,
                    count(*) FILTER (WHERE perfil IS NULL)::int AS sem_perfil,
                    max(importado_em) AS ultima_importacao, max(respondido_em) AS ultima_resposta
             FROM formularios_respostas WHERE ($1::text IS NULL OR formulario = $1)`, [form]),
    ]);
    const itens = grupos.rows.map((g) => ({
      ...g, ...(PERFIS[g.perfil] ?? { ordem: 99, rotulo: g.perfil, descricao: '' }),
    })).sort((a, b) => a.ordem - b.ordem);
    return { meta: meta.rows[0], grupos: itens };
  });

  app.get('/api/formularios/respostas/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Suporte Escalado'],
      summary: 'Respostas de UM perfil (colunas leves + situação do caso no Kanban)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['perfil'],
        properties: { perfil: { type: 'string' }, formulario: FORMULARIO, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } },
      },
    },
  }, async (req) => {
    const { perfil, formulario = null, limit = 500 } = req.query;
    const { rows } = await query(
      `SELECT ${LEVE} FROM formularios_respostas f ${JUNTA_CASO}
       WHERE f.perfil = $1 AND ($2::text IS NULL OR f.formulario = $2)
       ORDER BY f.respondido_em DESC NULLS LAST, f.id DESC LIMIT $3`,
      [perfil, formulario, limit],
    );
    return { perfil, total: rows.length, itens: rows };
  });

  app.get('/api/formularios/:id/', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Suporte Escalado'],
      summary: 'Uma resposta inteira (todas as perguntas)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  }, async (req) => {
    const { rows } = await query(
      `SELECT ${LEVE}, f.dados, f.perfil FROM formularios_respostas f ${JUNTA_CASO} WHERE f.id = $1`,
      [req.params.id],
    );
    if (!rows.length) throw new ErroHttp(404, 'Resposta não encontrada.');
    return { ...rows[0], ...(PERFIS[rows[0].perfil] ? { perfil_rotulo: PERFIS[rows[0].perfil].rotulo } : {}) };
  });
}
