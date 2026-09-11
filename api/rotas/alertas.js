/**
 * Alertas por e-mail — opt-in por usuário (11/09/2026).
 *
 * Dois pedaços neste arquivo:
 *   1. Rotas de preferência (`GET`/`PATCH /api/alertas/preferencias/`) — cada
 *      pessoa liga/desliga o que quer receber, sobre a PRÓPRIA conta só.
 *   2. `verificarEEnviarAlertas()` — o checador em si, chamado por um
 *      `setInterval` em `api/servidor.js` (a cada 5 min, decisão do usuário).
 *
 * `painel_alertas_enviados` é o dedupe: cada alerta (tipo + chave do registro
 * de origem) só dispara e-mail UMA vez, não importa quantas checagens rodem
 * depois. É global (não por usuário) — quem ativa um tipo só vê alertas dali
 * pra frente, não o histórico que já foi notificado pra outra pessoa. Isso é
 * intencional: é o mesmo comportamento de assinar uma lista.
 */
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { enviarAlertas, emailConfigurado } from '../email.js';

/** Fonte de verdade dos tipos válidos — usada na validação da rota E no checador. */
const TIPOS = ['foto_defeito', 'email_urgente', 'caso_escalado', 'chargeback', 'reembolso'];

/**
 * Uma consulta por tipo, todas com a MESMA forma de saída: `chave` (texto,
 * único por tipo), `titulo`, `subtitulo`. `LIMIT` é rede de segurança — em
 * operação normal (checagem a cada 5 min) nunca deveria chegar perto disso.
 */
const CONSULTAS = {
  foto_defeito: `
    SELECT a.id::text AS chave,
           ('Foto de ' || coalesce(a.tipo_conteudo, 'anexo')) AS titulo,
           coalesce(e.remetente_nome, e.remetente_email, e.assunto) AS subtitulo
    FROM email_ia.anexos a
    JOIN email_ia.emails e ON e.message_id = a.message_id
    WHERE a.defeito_visivel = true
      AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'foto_defeito' AND x.chave = a.id::text)
    ORDER BY a.criado_em
    LIMIT 100`,

  email_urgente: `
    SELECT e.id::text AS chave,
           e.assunto AS titulo,
           coalesce(e.remetente_nome, e.remetente_email) AS subtitulo,
           e.resumo AS resumo
    FROM email_ia.emails e
    WHERE e.pede_resposta = true AND e.urgencia = 'alta'
      AND e.resposta_enviada_em IS NULL AND e.plataforma_origem IS NULL
      AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'email_urgente' AND x.chave = e.id::text)
    ORDER BY e.data_email
    LIMIT 100`,

  caso_escalado: `
    SELECT s.id::text AS chave,
           coalesce(s.nome, s.remetente_email) AS titulo,
           s.motivo_escalonamento AS subtitulo
    FROM email_ia.suporte_escalado s
    WHERE s.status = 'pendente'
      AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'caso_escalado' AND x.chave = s.id::text)
    ORDER BY s.criado_em
    LIMIT 100`,

  // As duas fontes de dispersão de venda (régua principal + upsell/downsell,
  // ver schema-email-ia.sql 11/09) precisam de prefixo na chave: os `id`
  // são seriais independentes e colidiriam sem isso.
  //
  // `motivo_devolucao`/`resumo` (11/09) vêm de um LEFT JOIN LATERAL contra
  // `email_ia.emails` do MESMO lead (por e-mail, case-insensitive) — essas
  // tabelas não têm FK entre si (sistemas diferentes: régua pós-venda vs.
  // caixa de entrada classificada pela IA), então o vínculo é por valor,
  // pegando o e-mail classificado como devolução/troca/reclamação mais
  // PRÓXIMO NO TEMPO do carimbo de chargeback/reembolso. Pode não existir
  // (chargeback direto na operadora do cartão, sem o lead escrever nada) —
  // nesse caso os dois campos vêm NULL e o alerta sai só com título/subtítulo,
  // igual antes.
  chargeback: `
    SELECT d.chave, d.titulo, d.subtitulo, m.motivo_devolucao, m.resumo
    FROM (
      SELECT 'dpv:' || id::text AS chave, ('Chargeback — ' || produto) AS titulo,
             (email || ' · ' || plataforma) AS subtitulo, email, chargeback_em AS quando
      FROM disparos_pos_venda
      WHERE chargeback_em IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'chargeback' AND x.chave = 'dpv:' || disparos_pos_venda.id::text)
      UNION ALL
      SELECT 'cud:' || id::text AS chave, ('Chargeback (upsell/downsell) — ' || produto) AS titulo,
             (email || ' · ' || plataforma) AS subtitulo, email, chargeback_em AS quando
      FROM compras_upsell_downsell
      WHERE chargeback_em IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'chargeback' AND x.chave = 'cud:' || compras_upsell_downsell.id::text)
    ) d
    LEFT JOIN LATERAL (
      SELECT e.motivo_devolucao, e.resumo
      FROM email_ia.emails e
      WHERE lower(e.remetente_email) = lower(d.email)
        AND (e.motivo_devolucao IS NOT NULL OR e.categoria IN ('devolucao', 'troca', 'reclamacao'))
      ORDER BY abs(extract(epoch FROM (e.data_email - d.quando)))
      LIMIT 1
    ) m ON true
    ORDER BY d.quando
    LIMIT 100`,

  reembolso: `
    SELECT d.chave, d.titulo, d.subtitulo, m.motivo_devolucao, m.resumo
    FROM (
      SELECT 'dpv:' || id::text AS chave, ('Reembolso — ' || produto) AS titulo,
             (email || ' · ' || plataforma) AS subtitulo, email, reembolsado_em AS quando
      FROM disparos_pos_venda
      WHERE reembolsado_em IS NOT NULL AND chargeback_em IS NULL
        AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'reembolso' AND x.chave = 'dpv:' || disparos_pos_venda.id::text)
      UNION ALL
      SELECT 'cud:' || id::text AS chave, ('Reembolso (upsell/downsell) — ' || produto) AS titulo,
             (email || ' · ' || plataforma) AS subtitulo, email, reembolsado_em AS quando
      FROM compras_upsell_downsell
      WHERE reembolsado_em IS NOT NULL AND chargeback_em IS NULL
        AND NOT EXISTS (SELECT 1 FROM painel_alertas_enviados x WHERE x.tipo = 'reembolso' AND x.chave = 'cud:' || compras_upsell_downsell.id::text)
    ) d
    LEFT JOIN LATERAL (
      SELECT e.motivo_devolucao, e.resumo
      FROM email_ia.emails e
      WHERE lower(e.remetente_email) = lower(d.email)
        AND (e.motivo_devolucao IS NOT NULL OR e.categoria IN ('devolucao', 'troca', 'reclamacao'))
      ORDER BY abs(extract(epoch FROM (e.data_email - d.quando)))
      LIMIT 1
    ) m ON true
    ORDER BY d.quando
    LIMIT 100`,
};

/** Mesma lista de `schema-email-ia.sql` (31/08) — atual + legado, pra rotular no e-mail. */
const LABEL_MOTIVO_DEVOLUCAO = {
  comprou_por_engano: 'Comprou por engano',
  queria_outro_produto: 'Queria outro produto',
  quantidade_errada: 'Quantidade errada',
  sem_resultado_esperado: 'Sem resultado esperado',
  capsulas_com_problema: 'Cápsulas com problema',
  embalagem_com_problema: 'Embalagem com problema',
  atraso_na_entrega: 'Atraso na entrega',
  motivo_saude: 'Motivo de saúde',
  propaganda_enganosa: 'Propaganda enganosa',
  compra_sem_permissao: 'Compra sem permissão',
  acha_que_e_golpe: 'Achou que era golpe',
  reacao_alergica: 'Reação alérgica',
  outro: 'Outro',
  // legado (e-mails classificados antes de 31/08/2026)
  produto_com_defeito: 'Produto com defeito',
  produto_errado: 'Produto errado',
  dano_no_transporte: 'Dano no transporte',
  arrependimento: 'Arrependimento',
  tamanho_ou_medida_errada: 'Tamanho/medida errada',
  diferente_do_anuncio: 'Diferente do anúncio',
  compra_duplicada: 'Compra duplicada',
};

const truncar = (s, max = 160) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * Linha extra do e-mail de alerta com o "porquê", quando dá pra saber:
 * chargeback/reembolso usam o motivo classificado + resumo do e-mail do lead
 * mais próximo (ver JOIN LATERAL acima); email_urgente usa o resumo da IA.
 * Os outros tipos (foto_defeito, caso_escalado) já carregam o essencial no
 * próprio subtítulo, sem precisar de mais uma linha.
 */
function montarDetalhe(tipo, item) {
  if (tipo === 'chargeback' || tipo === 'reembolso') {
    const partes = [];
    if (item.motivo_devolucao) partes.push(`Motivo: ${LABEL_MOTIVO_DEVOLUCAO[item.motivo_devolucao] ?? item.motivo_devolucao}`);
    if (item.resumo) partes.push(truncar(item.resumo));
    return partes.length > 0 ? partes.join(' — ') : undefined;
  }
  if (tipo === 'email_urgente' && item.resumo) return truncar(item.resumo);
  return undefined;
}

/**
 * Roda a checagem inteira: busca o que é novo por tipo, manda um e-mail POR
 * USUÁRIO (um digest só, com todos os tipos que ele segue), e marca tudo
 * como enviado — mesmo que o envio falhe para algum destinatário (SMTP fora
 * do ar não deve fazer a fila de "não enviados" crescer pra sempre; a
 * limitação já documentada é aceita aqui, igual ao resto do painel).
 */
export async function verificarEEnviarAlertas() {
  if (!emailConfigurado) return;

  try {
    const { rows: prefs } = await query(`
      SELECT u.id, u.email, p.tipo
      FROM painel_alertas_preferencia p
      JOIN painel_usuarios u ON u.id = p.usuario_id
      WHERE p.ativo = true AND u.ativo = true
    `);
    if (prefs.length === 0) return;

    const tiposAtivos = [...new Set(prefs.map((p) => p.tipo))].filter((t) => CONSULTAS[t]);
    if (tiposAtivos.length === 0) return;

    const novosPorTipo = {};
    for (const tipo of tiposAtivos) {
      const { rows } = await query(CONSULTAS[tipo]);
      if (rows.length > 0) novosPorTipo[tipo] = rows;
    }
    if (Object.keys(novosPorTipo).length === 0) return;

    const porUsuario = new Map();
    for (const p of prefs) {
      const itens = novosPorTipo[p.tipo];
      if (!itens || itens.length === 0) continue;
      if (!porUsuario.has(p.id)) porUsuario.set(p.id, { email: p.email, porTipo: {} });
      porUsuario.get(p.id).porTipo[p.tipo] = itens.map((item) => ({
        titulo: item.titulo,
        subtitulo: item.subtitulo,
        detalhe: montarDetalhe(p.tipo, item),
      }));
    }

    for (const { email, porTipo } of porUsuario.values()) {
      // eslint-disable-next-line no-await-in-loop
      await enviarAlertas({ para: email, porTipo });
    }

    for (const [tipo, itens] of Object.entries(novosPorTipo)) {
      const tiposCol = itens.map(() => tipo);
      const chavesCol = itens.map((it) => it.chave);
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO painel_alertas_enviados (tipo, chave)
         SELECT * FROM UNNEST($1::text[], $2::text[])
         ON CONFLICT (tipo, chave) DO NOTHING`,
        [tiposCol, chavesCol],
      );
    }
  } catch (err) {
    console.error('[alertas] falha ao verificar/enviar:', err.message);
  }
}

export default async function rotasAlertas(app) {
  app.get('/api/alertas/preferencias/', {
    schema: {
      tags: ['Alertas'],
      summary: 'Minhas preferências de alerta por e-mail',
      description: 'Sempre devolve os 5 tipos, mesmo os nunca configurados (ativo: false por padrão).',
      security: [{ bearerAuth: [] }],
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const { rows } = await query(
      'SELECT tipo, ativo FROM painel_alertas_preferencia WHERE usuario_id = $1',
      [req.usuario.user_id],
    );
    const ativos = new Map(rows.map((r) => [r.tipo, r.ativo]));
    return {
      preferencias: TIPOS.map((tipo) => ({ tipo, ativo: ativos.get(tipo) ?? false })),
      emailConfigurado,
    };
  });

  app.patch('/api/alertas/preferencias/', {
    schema: {
      tags: ['Alertas'],
      summary: 'Liga/desliga tipos de alerta da própria conta',
      description: 'Corpo: `{ preferencias: { [tipo]: boolean } }` — só os tipos enviados mudam, o resto fica como está.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          preferencias: {
            type: 'object',
            additionalProperties: { type: 'boolean' },
          },
        },
        required: ['preferencias'],
      },
    },
    onRequest: [app.exigirSessao],
  }, async (req) => {
    const entradas = Object.entries(req.body.preferencias || {})
      .filter(([tipo]) => TIPOS.includes(tipo));
    if (entradas.length === 0) throw new ErroHttp(400, 'Nenhum tipo de alerta reconhecido no corpo.');

    for (const [tipo, ativo] of entradas) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO painel_alertas_preferencia (usuario_id, tipo, ativo)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, tipo) DO UPDATE SET ativo = EXCLUDED.ativo`,
        [req.usuario.user_id, tipo, Boolean(ativo)],
      );
    }

    const { rows } = await query(
      'SELECT tipo, ativo FROM painel_alertas_preferencia WHERE usuario_id = $1',
      [req.usuario.user_id],
    );
    const ativos = new Map(rows.map((r) => [r.tipo, r.ativo]));
    return { preferencias: TIPOS.map((tipo) => ({ tipo, ativo: ativos.get(tipo) ?? false })) };
  });
}
