/**
 * Central de E-mail IA — os dois recursos que chamam Claude.
 *
 * Tudo o mais da especificação (Tickets, Dashboard, Galeria) é leitura pura
 * do schema email_ia e não precisa de IA; só ficaram de fora deste primeiro
 * corte porque não foi isso que foi pedido. As duas rotas daqui são as únicas
 * que dependem de ANTHROPIC_API_KEY — sem ela, respondem com {erro:...} em
 * vez de derrubar o processo ou a tela (a chave do banco já é obrigatória
 * para a API inteira subir; esta não).
 *
 *   POST /api/resposta  → gera/regenera o rascunho de e-mail de um cliente
 *   POST /api/chat       → conversa em linguagem natural com o banco
 */
import Anthropic from '@anthropic-ai/sdk';

import { query } from '../../server/db.js';
import { pool } from '../../server/db.js';
import { ErroHttp } from '../comum.js';

/* ══════════════════════════════  cliente Claude  ═══════════════════════════ */

let clienteAnthropic;

/** null quando a chave não está configurada — os dois handlers tratam isso. */
function obterClienteAnthropic() {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return null;
  if (!clienteAnthropic) clienteAnthropic = new Anthropic({ apiKey: chave });
  return clienteAnthropic;
}

/* ══════════════════════════  POST /api/resposta  ════════════════════════════ */

const SISTEMA_RESPOSTA = `Você escreve rascunhos de resposta a e-mails de clientes de uma loja de \
ferramentas de saúde e bem-estar, para revisão humana antes do envio — o rascunho nunca sai sozinho.

Idioma e formato:
- Responda no MESMO idioma do e-mail do cliente (a maioria é em inglês).
- Tom cordial e profissional.
- Cerca de 150 palavras.
- Texto puro do corpo do e-mail: sem markdown, sem linha de assunto.

Objetivo principal: reter a venda, evitando reembolso a todo custo. Duas regras travam qualquer \
reembolso:
(a) nunca reembolsar sem o cliente explicar o motivo;
(b) nunca reembolsar antes de 30 dias de teste do produto.

Ordem da resposta:
1. Entenda primeiro — diagnostique o problema relatado.
2. Tente resolver por orientação (uso correto do produto, dúvida esclarecida etc.).
3. Troca ou reposição SOMENTE em caso de problema de entrega.
4. Nas demais situações, ofereça um gesto comercial (desconto, cupom ou crédito) em vez de reembolso.

Nunca ofereça reembolso por iniciativa própria. Se o cliente pedir reembolso, não confirme nem \
negue — conduza para a alternativa (troca, gesto comercial) com firmeza, dizendo que "a equipe já \
está cuidando do caso".

Nunca invente dados: não cite rastreio, prazos, valores ou status que não foram informados a você.

Use somente as informações fornecidas: categoria, motivo da devolução, problema de pagamento, \
número do pedido, produto mencionado, nome do cliente, assunto e corpo do e-mail.`;

function montarPromptResposta(email) {
  const corpo = String(email.corpo_texto ?? '').slice(0, 6000);
  const linhas = [
    `Categoria: ${email.categoria ?? 'não classificada'}`,
    email.motivo_devolucao ? `Motivo da devolução: ${email.motivo_devolucao}` : null,
    email.problema_pagamento ? `Problema de pagamento: ${email.problema_pagamento}` : null,
    email.numero_pedido ? `Número do pedido: ${email.numero_pedido}` : null,
    email.produto_mencionado ? `Produto mencionado: ${email.produto_mencionado}` : null,
    `Cliente: ${email.remetente_nome || email.remetente_email}`,
    `Assunto: ${email.assunto ?? ''}`,
    '',
    'Corpo do e-mail:',
    corpo,
  ];
  return linhas.filter((l) => l !== null).join('\n');
}

function extrairTexto(blocos) {
  return blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/* ══════════════════════════════  POST /api/chat  ════════════════════════════ */

const FERRAMENTA_CONSULTAR_BANCO = {
  name: 'consultar_banco',
  description: 'Executa UMA consulta SQL somente leitura (SELECT ou WITH) no Postgres da loja '
    + '(schema email_ia + schema public do SendTrace). Roda em transação read-only — não pode '
    + 'gravar nada. Use LIMIT em consultas exploratórias. Prefira email_ia.mv_emails_x_pedidos '
    + '(materializada) a email_ia.vw_emails_x_pedidos (ao vivo, lenta).',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A consulta SELECT ou WITH a executar.' },
    },
    required: ['sql'],
  },
};

function montarSistemaChat() {
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Você é o assistente da Central de E-mail IA — conversa em português do Brasil com o \
operador de uma loja de ferramentas de saúde/bem-estar (vendidas via DigiStore24, BuyGoods, JVZoo \
e outras plataformas), sobre o banco de e-mails de suporte e as vendas ligadas a eles.

Hoje é ${dataHoje}. O histórico de e-mails começa em 17/03/2026 — datas de 2026 não são "do futuro".

Nunca invente números: sempre consulte o banco de verdade pela ferramenta consultar_banco. Use \
LIMIT em consultas exploratórias.

── Tabelas ──

email_ia.emails (~21 mil linhas, 1 e-mail por linha):
  id, message_id, data_email, remetente_email, remetente_nome, destinatario, assunto, corpo_texto,
  tem_anexo (bool), categoria, motivo_devolucao, produto_mencionado, numero_pedido, sentimento,
  urgencia, pede_resposta (bool), resumo, area_problema, responsavel, problema_pagamento,
  plataforma_origem (NULL = cliente real), resposta_sugerida, resposta_sugerida_em,
  resposta_enviada_em, resposta_automatica (bool), erro_resposta_automatica, erro_analise.

email_ia.tickets (1 por remetente_email, minúsculas):
  id, remetente_email, nome, qtd_emails, status (nao_iniciado | em_aberto | resolvido),
  primeiro_email_em, ultimo_email_em, iniciado_em, resolvido_em, reaberturas, atualizado_em,
  resumo_conversa, resumo_conversa_em, boas_vindas_enviada_em, liberado_ia_em,
  ultima_resposta_ia_em.
  Mantida por trigger: e-mail de cliente real cria/reabre o ticket. E-mail de plataforma
  (plataforma_origem preenchida) NÃO gera ticket.

email_ia.ticket_eventos (histórico de mudança de status de UM ticket):
  ticket_id (referencia email_ia.tickets, sem FK direta pra remetente_email — junte por ticket_id
  se já tiver, senão by remetente_email+tempo), de_status (NULL = primeiro registro), para_status,
  em, origem.

email_ia.suporte_escalado (16/09/2026 — casos que saíram do fluxo automático de e-mail e foram
  pro Kanban de atendimento humano; motivo_escalonamento é texto livre, classificado por ILIKE em
  quem lê, não por um enum fixo — ex.: "reembolso", "cancelamento", "endereço de devolução"):
  id, remetente_email (índice único por lower(email) — 1 caso ativo por pessoa), nome,
  resumo_conversa, motivo_escalonamento, status (default 'pendente'), email_id (referencia
  email_ia.emails), criado_em, atualizado_em, iniciado_em, finalizado_em, board_id, data_entrega.
email_ia.suporte_escalado_boards (quadros do Kanban — hoje: Vitória, Rodrigo, etc.):
  id, nome, usuario_id (dono, se for pessoal), ativo, criado_em, criado_por.
email_ia.suporte_escalado_colunas (colunas de UM board, ordem configurável):
  id, board_id, chave, rotulo, ordem, descricao.
email_ia.suporte_escalado_historico (histórico de mudança de coluna/status de UM caso):
  suporte_escalado_id, board_id, status_anterior (NULL = primeiro registro), status_novo, mudou_em.
email_ia.suporte_escalado_notas (comentários internos num caso, não vão pro cliente):
  suporte_escalado_id, autor, nota, criado_em, atualizado_em.

email_ia.aberturas_email (pixel de abertura — pode ter várias linhas por e-mail, uma por abertura):
  email_id (referencia email_ia.emails), token, ip, user_agent, aberto_em.
  "Esse e-mail foi aberto?" = EXISTS numa subquery, não JOIN direto (senão duplica a linha do e-mail
  por cada abertura).

email_ia.execucoes_resposta_automatica (1 linha por e-mail que passou pelo pipeline de resposta
  automática, mostra a ETAPA ATUAL — não é histórico, é o estado corrente, chave é email_id):
  email_id, remetente_email, remetente_nome, assunto, etapa, detalhe, iniciado_em, atualizado_em.

email_ia.rascunhos_resposta (rascunhos gerados fora do fluxo de email_ia.emails.resposta_sugerida —
  usado pelo pipeline automático, não pela geração manual via /api/resposta):
  message_id, texto_gerado, status (default 'pendente'), texto_final, revisado_por, enviado_em,
  criado_em.

email_ia.relatorios (relatório semanal já pronto, texto final, não recalcula nada):
  tipo (default 'semanal'), periodo_fim, conteudo, criado_em. Único por (tipo, periodo_fim).

email_ia.anexos (imagens, PDFs, comprovantes):
  message_id (vínculo por valor com emails.message_id, sem FK), nome_arquivo, mime_type,
  tamanho_bytes, conteudo (bytea — NUNCA SELECT * nem select conteudo), hash_md5,
  tipo_conteudo (foto_produto | defeito | nota_fiscal | comprovante | print_tela | documento |
  outro | NULL = sem análise), descricao_ia, defeito_visivel (bool), tags (text[]).

email_ia.mv_emails_x_pedidos (materialized view, cruzamento e-mail ↔ venda, atualizada a cada
15 min — PREFIRA SEMPRE esta, nunca a view ao vivo vw_emails_x_pedidos que é lenta):
  casa email_ia.emails com public.disparos_pos_venda por (1) número do pedido citado no corpo,
  (2) e-mail do remetente, (3) telefone citado no corpo, (4) nome completo. Tem remetente_email,
  transacao_id, status_pedido, vinculo (qual critério casou).

public.disparos_pos_venda (vendas na régua de pós-venda):
  transacao_id, nome, email, telefone, produto, produto_slug, plataforma,
  status (ativo | concluido | cancelado | falhou), criado_em, chat_resumo,
  reembolsado_em, chargeback_em (ambas NULL = nem um nem outro aconteceu; datam o evento, não são
  bool), id_rastreio (identificador usado pra consultar a Red Rock (paykey do JVZoo, composto do
  BuyGoods) — ver rastreio_pedidos abaixo; NULL = ainda não calculado/recebido, não
  necessariamente "sem rastreio nenhum". Não confundir com o order_id_global que a FullStack usa
  pra BuyGoods — esse não passa por aqui, é resolvido direto pelo script de rastreio.).

public.rastreio_pedidos (atualizado 18/09/2026 — status de entrega via Red Rock OU FullStack/3PL
  Central, 1 linha por transacao_id já consultado ao menos uma vez; pedido nunca consultado NÃO
  aparece aqui, não confunda com "não encontrado"):
  transacao_id (= disparos_pos_venda.transacao_id pra Red Rock; pra FullStack, pode ser o
  order_id_global da BuyGoods direto quando não tem correspondência em disparos_pos_venda — ex.:
  upsell, que não entra na régua de propósito), provedor ('redrock', 'fullstack' ou NULL = nenhum
  provedor encontrou ainda), status_interno (pendente_consulta | nao_encontrado | pending | shipped
  | delivered | cancelled | exception | desconhecido — 'nao_encontrado' NÃO é erro, é só pedido que
  nenhum dos dois provedores tem ainda — paykey do JVZoo nunca capturado, ou pedido genuinamente
  não despachado), status_bruto (valor cru do provedor — Red Rock ou FullStack), order_number,
  order_created_at, total, currency, fully_fulfilled (bool), fully_fulfilled_at, tracking_number,
  carrier_code, tracking_url, tracking_status, shipped_at, delivered_at, ultima_consulta_em,
  ultimo_erro, criado_em, atualizado_em.
  "Pedido X já foi entregue?" / "quanto tempo demorou pra entregar?" / "esse reembolso foi antes ou
  depois da entrega?" (cruzando com disparos_pos_venda.reembolsado_em) — tudo isso vem daqui.

public.rastreio_eventos (histórico de transição de status de UM rastreio_pedidos):
  transacao_id, status_anterior (NULL = primeiro registro), status_novo, fonte, detectado_em.
  fonte='backfill-email' é o backfill retroativo por e-mail (rodado uma vez em 15/09/2026) — EXCLUA
  sempre que calcular "quanto tempo leva pra..." (senão um pedido antigo achado só agora entra como
  se tivesse levado meses). fonte='backfill' é o polling normal (via cron horário), inclui tanto
  pedido novo de verdade quanto pedido antigo sendo consultado pela primeira vez — não é sinônimo de
  "não é ao vivo".

public.chat_atendimentos (atendimentos do chat de IA do site):
  id, email, transacao_id, motivo, resumo, desfecho, resolvido, reembolso_pedido,
  reembolso_evitado, risco_chargeback, csat, duracao_s, etapa_regua, iniciado_em, criado_em,
  topico_id (referencia chat_topicos).
public.chat_topicos (catálogo de assunto do chat do site): id, slug, nome, descricao.
public.chat_perguntas_sem_resposta (pergunta que a IA do chat do site não conseguiu responder —
  útil pra achar lacuna de conteúdo/FAQ): pergunta, transacao_id, email, produto, criado_em.

public.aberturas_disparo (pixel de abertura de UM disparo da régua de pós-venda — pode ter várias
  linhas por disparo, uma por abertura; não confundir com email_ia.aberturas_email, que é dos
  e-mails de suporte, não da régua):
  disparo_id, etapa, token, ip, user_agent, aberto_em.

public.produtos (catálogo): slug, nome, nome_sms, forma, uso, link_ebook, email_suporte, ativo.
public.produto_aliases: apelido por plataforma → produto_slug.
public.produto_readmes: conhecimento por produto.

public.compras_upsell_downsell (13/09/2026): upsell/downsell comprado pelo MESMO lead/cliente,
  À PARTE da régua principal — não entra em disparos_pos_venda, não dispara e-mail/SMS, só fica
  registrado. Colunas: transacao_id, nome, email, telefone, produto, tag_produto, etapa_funil
  ('upsell' | 'downsell' | 'outro'), plataforma, criado_em, reembolsado_em, chargeback_em.
  "Este lead comprou algo além do produto principal?" = casar por lower(email) com esta tabela;
  um e-mail pode ter várias linhas (um upsell aceito e um downsell recusado geram compras
  separadas). Ausência aqui não é erro: a maioria dos leads compra só o front mesmo.

── Chaves de cruzamento ──
- venda ↔ e-mail: por transacao_id = numero_pedido, ou por e-mail (prefira mv_emails_x_pedidos).
- venda ↔ chat do site: por transacao_id ou e-mail.
- venda ↔ upsell/downsell: por lower(email) em public.compras_upsell_downsell.
- venda ↔ rastreio de entrega: por transacao_id em public.rastreio_pedidos (LEFT JOIN — nem toda
  venda tem linha lá ainda). Pra saber se um reembolso/chargeback foi antes ou depois da entrega,
  compare disparos_pos_venda.reembolsado_em (ou chargeback_em) com rastreio_pedidos.delivered_at.
- e-mail ↔ caso escalado: email_ia.suporte_escalado.email_id = email_ia.emails.id, OU por
  lower(remetente_email) quando email_id vier NULL.
- ticket ↔ histórico de status: email_ia.ticket_eventos.ticket_id = email_ia.tickets.id.
- caso escalado ↔ histórico/notas: email_ia.suporte_escalado_historico/notas.suporte_escalado_id =
  email_ia.suporte_escalado.id.

── Pedido de "recomendação de resposta a um e-mail" ──
Busque o e-mail completo, o histórico do remetente (outros e-mails dele), a venda vinculada
(mv_emails_x_pedidos) e atendimentos de chat anteriores; escreva o rascunho no idioma do cliente.

── Proibido ──
Nunca selecione colunas de senha/token/sessão de tabelas administrativas: painel_usuarios.senha_*,
painel_sessoes, authtoken_token, django_session. Essas tabelas são infraestrutura do sistema
administrativo, não dados de negócio, e nunca devem ser expostas.`;
}

function validarSql(sqlBruto) {
  const sql = String(sqlBruto ?? '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('só são permitidas consultas SELECT ou WITH');
  }
  if (sql.includes(';')) {
    throw new Error('não são permitidos múltiplos comandos (ponto e vírgula no meio da consulta)');
  }
  return sql;
}

/** BEGIN TRANSACTION READ ONLY ... ROLLBACK — nunca grava, mesmo se a validação acima falhar. */
async function executarConsultaSomenteLeitura(sqlBruto) {
  const sql = validarSql(sqlBruto);
  const cliente = await pool.connect();
  let expirou = false;

  const executar = (async () => {
    await cliente.query('BEGIN TRANSACTION READ ONLY');
    await cliente.query("SET LOCAL statement_timeout = '25s'");
    const resultado = await cliente.query(sql);
    await cliente.query('ROLLBACK');
    return resultado;
  })();
  executar.catch(() => {}); // evita unhandled rejection se o cronômetro vencer primeiro

  const cronometro = new Promise((_resolve, reject) => {
    setTimeout(() => {
      expirou = true;
      reject(new Error('consulta excedeu o tempo limite de 40s'));
    }, 40_000);
  });

  try {
    const resultado = await Promise.race([executar, cronometro]);
    let textoResultado = JSON.stringify(resultado.rows);
    if (textoResultado.length > 30_000) {
      textoResultado = `${textoResultado.slice(0, 30_000)}\n… resultado truncado — refine a consulta ou use agregação.`;
    }
    return { linhas: resultado.rows.length, textoResultado };
  } finally {
    cliente.release(expirou); // expirou=true descarta a conexão em vez de devolvê-la ao pool
  }
}

async function executarChat({ anthropic, mensagens, modelo }) {
  const historico = mensagens.slice(-30).map((m) => ({
    role: m.role,
    content: String(m.content ?? '').slice(0, 20_000),
  }));
  // Cache do prompt (21/09/2026): o system prompt (~2.700 tokens, o schema do banco pra
  // ferramenta de consulta) é sempre o mesmo texto. Sem cache_control, cada iteração do loop de
  // tool-use abaixo reenviava esse prompt do zero pagando preço cheio — uma pergunta que precisa
  // de 3-4 consultas ao banco pagava o prompt inteiro 3-4 vezes. Com cache_control, só a 1ª
  // chamada da conversa paga cheio (+25% de escrita); as seguintes, dentro da mesma pergunta,
  // pagam ~10% do preço (leitura do cache, TTL de 5 min — sempre válido aqui, as iterações do
  // loop acontecem em segundos).
  const sistema = [{ type: 'text', text: montarSistemaChat(), cache_control: { type: 'ephemeral' } }];
  const consultas = [];

  for (let iteracao = 0; iteracao < 12; iteracao += 1) {
    const resposta = await anthropic.messages.create({
      model: modelo,
      max_tokens: 4096,
      system: sistema,
      tools: [FERRAMENTA_CONSULTAR_BANCO],
      messages: historico,
    });

    historico.push({ role: 'assistant', content: resposta.content });

    const blocosFerramenta = resposta.content.filter((b) => b.type === 'tool_use');
    if (resposta.stop_reason !== 'tool_use' || blocosFerramenta.length === 0) {
      return { resposta: extrairTexto(resposta.content), consultas, modelo };
    }

    const resultadosFerramenta = [];
    for (const bloco of blocosFerramenta) {
      const sql = String(bloco.input?.sql ?? '');
      try {
        const { linhas, textoResultado } = await executarConsultaSomenteLeitura(sql);
        consultas.push({ sql, linhas });
        resultadosFerramenta.push({ type: 'tool_result', tool_use_id: bloco.id, content: textoResultado });
      } catch (err) {
        resultadosFerramenta.push({
          type: 'tool_result', tool_use_id: bloco.id, content: `Erro: ${err.message}`, is_error: true,
        });
      }
    }
    historico.push({ role: 'user', content: resultadosFerramenta });
  }

  throw new Error('a conversa passou do limite de consultas');
}

/* ═══════════════════════════════════  rotas  ════════════════════════════════ */

export default async function rotasEmailIA(app) {
  app.post('/api/resposta', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Gera ou regenera o rascunho de resposta de um e-mail',
      description: 'Chama Claude Haiku com o texto do e-mail e grava o rascunho em '
        + 'resposta_sugerida. Com forcar=false e um rascunho já existente, devolve o rascunho '
        + 'salvo sem chamar a IA de novo.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          forcar: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req, resposta) => {
    const { id, forcar } = req.body;

    const { rows } = await query(
      `SELECT id, remetente_nome, remetente_email, assunto, corpo_texto,
              categoria, motivo_devolucao, problema_pagamento, numero_pedido,
              produto_mencionado, resposta_sugerida
       FROM email_ia.emails WHERE id = $1`,
      [id],
    );
    const email = rows[0];
    if (!email) throw new ErroHttp(404, 'E-mail não encontrado.');

    if (email.resposta_sugerida && !forcar) {
      return { resposta: email.resposta_sugerida };
    }

    const cliente = obterClienteAnthropic();
    if (!cliente) {
      resposta.code(200);
      return { erro: 'Geração de resposta indisponível: ANTHROPIC_API_KEY não configurada.' };
    }

    try {
      const msg = await cliente.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SISTEMA_RESPOSTA,
        messages: [{ role: 'user', content: montarPromptResposta(email) }],
      });
      const texto = extrairTexto(msg.content);
      await query(
        `UPDATE email_ia.emails SET resposta_sugerida = $1, resposta_sugerida_em = now()
         WHERE id = $2`,
        [texto, id],
      );
      return { resposta: texto };
    } catch (err) {
      req.log.error({ err }, 'falha ao gerar resposta com IA');
      resposta.code(200);
      return { erro: `Falha ao gerar resposta: ${err.message}` };
    }
  });

  app.post('/api/chat', {
    onRequest: [app.exigirSessao],
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Chat com IA sobre o banco (somente leitura)',
      description: 'Loop agentic de tool-use: a IA pode chamar consultar_banco (SELECT/WITH, '
        + 'transação read-only, até 12 iterações) antes de responder.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['mensagens'],
        properties: {
          mensagens: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
              },
            },
          },
          modelo: {
            type: 'string',
            enum: ['claude-haiku-4-5', 'claude-sonnet-5'],
            default: 'claude-haiku-4-5',
          },
        },
      },
    },
  }, async (req, resposta) => {
    const cliente = obterClienteAnthropic();
    if (!cliente) {
      resposta.code(200);
      return { erro: 'Chat indisponível: ANTHROPIC_API_KEY não configurada.' };
    }

    try {
      return await executarChat({
        anthropic: cliente,
        mensagens: req.body.mensagens,
        modelo: req.body.modelo || 'claude-haiku-4-5',
      });
    } catch (err) {
      req.log.error({ err }, 'falha no chat com IA');
      resposta.code(200);
      return { erro: err.message || 'Falha ao processar a conversa.' };
    }
  });
}
