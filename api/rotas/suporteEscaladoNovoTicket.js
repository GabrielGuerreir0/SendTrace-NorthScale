/**
 * Suporte Humano — "Novo ticket" (ticket iniciado pela EQUIPE; migração 143). Pedido da Késsia: a equipe abre o ticket para mandar um e-mail pontual a um cliente
 * (por e-mail OU nº do pedido), com mensagem própria ou modelo pronto, individual ou em lote (um ticket e um e-mail por cliente, ninguém vê os dados de outro).
 *
 *   GET  /api/suporte-escalado/novo-ticket/modelos          → modelos ativos (os mesmos do Suporte Ativo), assinatura, marcadores e os boards que a pessoa pode usar
 *   POST /api/suporte-escalado/novo-ticket                  → `simular: true` confere (quem foi achado, ticket existente, contato anterior, exemplo da mensagem);
 *                                                             `confirmar: true` enfileira: um e-mail por cliente; o ticket nasce quando o e-mail sai
 *   GET  /api/suporte-escalado/novo-ticket/lote?lote=       → andamento do lote
 *   POST /api/suporte-escalado/novo-ticket/lote/reenviar    → tenta de novo os que falharam
 *
 * O ticket é um card real do Suporte Humano, com origem = 'equipe' (badge e filtro "Iniciado pela equipe"), SEM prazo de resposta contra o agente (o relógio só
 * liga quando o cliente responder) e a resposta do cliente entra no mesmo ticket (ver api/novoTicketHumanoEnvios.js).
 * Quem pode: qualquer agente com board (no próprio board) e administrador/gestor (em qualquer board). A página é a do prefixo /api/suporte-escalado (acessoPaginas).
 */
import { randomUUID } from 'node:crypto';
import { query } from '../../server/db.js';
import { ErroHttp } from '../comum.js';
import { MARCADORES } from '../sppl/ativoConstantes.js';
import { assinaturaAtual, buscarContatos, enxutos, buscarPedidosParaAvulso } from '../sppl/ativoBusca.js';
import { respostaConfigurada } from '../../server/emailSuporte.js';
import { acionarEnvioEquipe } from '../novoTicketHumanoEnvios.js';
import {
  MAX_CLIENTES, separarEntradas, classificarEntrada, prepararAlvos, resumirAlvos, alvosEnviaveis, montarMensagem, dadosFaltando, validarConteudo, escolherBoard,
} from '../novoTicketHumano.js';

const DIAS = '90';
const quem = (req) => String(req.usuario?.nome || req.usuario?.email || 'desconhecido').slice(0, 120);
const ehGestor = (req) => !!req.usuario.admin || !!req.usuario.gestorHumano || !!req.usuario.gestorEscalado;

/** Contatos dos últimos 90 dias com estes e-mails/pedidos: envios e tickets do Suporte Ativo (já existente), e-mails da equipe (Suporte Humano) e respostas de agentes. */
async function contatosDoSuporteHumano(emails, transacoes) {
  const ativo = await buscarContatos(emails, transacoes);
  if (!emails.length && !transacoes.length) return ativo;
  const equipe = await query(
    `SELECT lower(para_email) AS email, pedido_transacao_id AS transacao_id, pedido_transacao_id, 'email_equipe' AS tipo, criado_por AS por, coalesce(enviado_em, criado_em) AS quando,
            modelo_nome, assunto, status, caso_id AS ticket_id
       FROM email_ia.suporte_equipe_envios
      WHERE status IN ('enviado', 'fila', 'enviando') AND coalesce(enviado_em, criado_em) > now() - ($3 || ' days')::interval
        AND (lower(para_email) = ANY($1::text[]) OR pedido_transacao_id = ANY($2::text[]))
      ORDER BY 6 DESC LIMIT 500`, [emails, transacoes, DIAS]);
  const agentes = await query(
    `SELECT lower(r.para_email) AS email, NULL::text AS transacao_id, NULL::text AS pedido_transacao_id, 'resposta_agente' AS tipo, coalesce(b.nome, 'Agente') AS por, r.enviado_em AS quando,
            NULL::text AS modelo_nome, r.assunto, NULL::text AS status, r.caso_id AS ticket_id
       FROM email_ia.respostas_agente r LEFT JOIN email_ia.suporte_escalado_boards b ON b.id = r.board_id
      WHERE lower(r.para_email) = ANY($1::text[]) AND r.enviado_em > now() - ($2 || ' days')::interval
      ORDER BY r.enviado_em DESC LIMIT 500`, [emails, DIAS]);
  return [...ativo, ...equipe.rows, ...agentes.rows];
}

export default async function rotasSuporteEscaladoNovoTicket(app) {
  const auth = { onRequest: [app.exigirSessao] };
  const seg = [{ bearerAuth: [] }];

  /** Boards que a pessoa pode usar (o próprio; gestor/admin: todos os ativos com agente) e o dela. */
  async function boardsDaPessoa(req) {
    const { rows } = await query(`SELECT id, nome, usuario_id, ativo FROM email_ia.suporte_escalado_boards WHERE usuario_id IS NOT NULL ORDER BY nome`);
    const meu = rows.find((b) => b.usuario_id === req.usuario.user_id) ?? null;
    return { todos: rows, meuId: meu?.id ?? null, lista: (ehGestor(req) ? rows.filter((b) => b.ativo || b.id === meu?.id) : (meu ? [meu] : [])).map((b) => ({ id: b.id, nome: b.nome })) };
  }

  app.get('/api/suporte-escalado/novo-ticket/modelos', { ...auth, schema: { tags: ['Central de E-mail IA'], summary: 'Novo ticket (Suporte Humano) — modelos de e-mail ativos, assinatura e boards', security: seg } }, async (req) => {
    const { rows } = await query(`SELECT id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en FROM sppl_ativo_modelos WHERE ativo ORDER BY ordem, nome`);
    const b = await boardsDaPessoa(req);
    return { modelos: rows, assinatura: await assinaturaAtual(), marcadores: MARCADORES, max_clientes: MAX_CLIENTES, boards: b.lista, meu_board_id: b.meuId, gestor: ehGestor(req) };
  });

  app.post('/api/suporte-escalado/novo-ticket', {
    ...auth,
    schema: {
      tags: ['Central de E-mail IA'],
      summary: 'Novo ticket (Suporte Humano) — abre tickets iniciados pela equipe e envia o e-mail; `simular: true` só confere, `confirmar: true` envia',
      security: seg,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          entradas: { type: 'string', maxLength: 40000 },      // e-mails e/ou nºs de pedido (linha, vírgula, espaço)
          modelo_id: { type: 'string', maxLength: 60 }, assunto: { type: 'string', maxLength: 300 }, mensagem: { type: 'string', maxLength: 9000 },
          idioma: { type: 'string', maxLength: 4 }, motivo_contato: { type: 'string', maxLength: 300 }, board_id: { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 12 }, { type: 'null' }] },
          simular: { type: 'boolean' }, confirmar: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const b = req.body ?? {};
    const entradas = separarEntradas(b.entradas);
    if (!entradas.length) throw new ErroHttp(400, 'Informe pelo menos um e-mail ou número de pedido.');
    if (entradas.length > MAX_CLIENTES) throw new ErroHttp(400, `No máximo ${MAX_CLIENTES} clientes por vez.`);
    if (!b.simular && b.confirmar !== true) throw new ErroHttp(400, 'Confirme o envio (confirmar: true) depois de conferir.');

    // quem pode abrir ticket em qual board
    const bd = await boardsDaPessoa(req);
    const escolha = escolherBoard({ pedido: b.board_id, meuBoardId: bd.meuId, gestor: ehGestor(req), boards: bd.todos });
    if (escolha.erro) throw new ErroHttp(escolha.erro.includes('não é seu') ? 403 : 400, escolha.erro);
    const board = bd.todos.find((x) => x.id === escolha.valor);

    // modelo e conteúdo (o cliente recebe o texto em inglês, salvo se a equipe escolher português)
    let modelo = null;
    if (b.modelo_id) {
      modelo = (await query(`SELECT id, nome, assunto_pt, corpo_pt, assunto_en, corpo_en FROM sppl_ativo_modelos WHERE id = $1 AND ativo`, [String(b.modelo_id).slice(0, 60)])).rows[0];
      if (!modelo) throw new ErroHttp(400, 'Modelo de e-mail não encontrado (ou desativado).');
    }
    const cont = validarConteudo({ assunto: b.assunto, texto: b.mensagem, idioma: b.idioma }, modelo);
    if (cont.erro) throw new ErroHttp(400, cont.erro);
    const { assunto, texto, idioma } = cont.valor;
    const motivo = String(b.motivo_contato ?? '').trim().slice(0, 300) || null;

    // quem são os clientes
    const cls = entradas.map(classificarEntrada);
    const pedidosTok = cls.filter((c) => c.tipo === 'pedido').map((c) => c.valor);
    const emailsTok = cls.filter((c) => c.tipo === 'email').map((c) => c.valor);
    const linhas = await buscarPedidosParaAvulso(pedidosTok, emailsTok);
    const trs = [...new Set([...linhas.map((l) => l.transacao_id), ...pedidosTok])];
    const emails = [...new Set([...emailsTok, ...linhas.map((l) => String(l.email || '').toLowerCase()).filter(Boolean)])];
    const [tickets, isolados, contatos] = await Promise.all([
      query(`SELECT s.id, s.remetente_email, s.status, s.origem, bd.nome AS agente FROM email_ia.suporte_escalado s LEFT JOIN email_ia.suporte_escalado_boards bd ON bd.id = s.board_id
              WHERE lower(s.remetente_email) = ANY($1::text[])`, [emails]),
      query(`SELECT DISTINCT lower(t.email) AS email FROM sppl_ativo_tickets t
               JOIN sppl_ativo_envios v ON v.ticket_id = t.id AND v.status = 'enviado' AND v.enviado_em > now() - interval '45 days'
              WHERE lower(t.email) = ANY($1::text[]) AND t.status_ticket <> 'fechado'
                AND coalesce((SELECT valor FROM config_disparos WHERE chave = 'sppl_ativo_isolar_respostas'), 'true') = 'true'`, [emails]),
      contatosDoSuporteHumano(emails, trs),
    ]);
    const itens = prepararAlvos(entradas, linhas, tickets.rows, isolados.rows.map((r) => r.email), contatos);
    const novos = alvosEnviaveis(itens);
    // endereço de entrega (marcador {endereco}) só dos pedidos localizados
    const pedidosNovos = [...new Set(novos.map((i) => i.pedido_transacao_id).filter(Boolean))];
    if (pedidosNovos.length) {
      const { rows } = await query(`SELECT transacao_id, nullif(endereco_entrega, '') AS endereco_entrega FROM rastreio_pedidos WHERE transacao_id = ANY($1::text[])`, [pedidosNovos]);
      const porPedido = new Map(rows.map((r) => [r.transacao_id, r.endereco_entrega]));
      for (const i of novos) i.endereco_entrega = porPedido.get(i.pedido_transacao_id) ?? null;
    }
    const assinatura = await assinaturaAtual();
    const mensagens = new Map(novos.map((i) => [i.email, montarMensagem(assunto, texto, i, assinatura)]));
    const semDados = novos.map((i) => ({ email: i.email, faltando: dadosFaltando(assunto, texto, i) })).filter((x) => x.faltando.length);
    const resumo = { ...resumirAlvos(itens, entradas), sem_dados: semDados.length };
    const publico = (i) => { const { chave, endereco_entrega: _e, ...r } = i; return { ...r, contatos_anteriores: (r.contatos_anteriores ?? []).length ? enxutos(r.contatos_anteriores) : [] }; };

    if (b.simular) {
      const ex = novos[0];
      return {
        simulacao: true, resumo, itens: itens.map(publico), sem_dados: semDados, idioma, board: { id: board.id, nome: board.nome },
        modelo: modelo ? { id: modelo.id, nome: modelo.nome } : null,
        exemplo: ex ? { para: ex.email, ...mensagens.get(ex.email) } : null,
        aviso: 'Cada cliente recebe o PRÓPRIO e-mail, sem ver os demais. O ticket nasce "iniciado pela equipe", sem prazo de resposta; o prazo só passa a contar se o cliente responder (e a resposta entra neste mesmo ticket).',
      };
    }

    if (!respostaConfigurada) throw new ErroHttp(503, 'O envio de e-mails pelo SendTrace ainda não está configurado neste servidor (falta o login SMTP do suporte).');
    if (!novos.length) throw new ErroHttp(400, 'Nenhum cliente disponível para abrir ticket (veja a conferência).');
    const lote = randomUUID(); const por = quem(req);
    for (const i of novos) {
      const m = mensagens.get(i.email);
      await query(
        `INSERT INTO email_ia.suporte_equipe_envios (lote, para_email, nome, numero_pedido, pedido_transacao_id, produto, plataforma, idioma, assunto, texto, modelo_id, modelo_nome, motivo_contato, board_id, criado_por, criado_por_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [lote, i.email, i.nome, i.numero_pedido, i.pedido_transacao_id, i.produto, i.plataforma, idioma, m.assunto, m.texto, modelo?.id ?? null, modelo?.nome ?? null, motivo, board.id, por, req.usuario.user_id ?? null]);
    }
    acionarEnvioEquipe();
    return { lote, enfileirados: novos.length, resumo, nao_enfileirados: itens.filter((i) => i.situacao !== 'novo').map((i) => ({ entrada: i.entrada, situacao: i.situacao, ticket_id: i.ticket_id ?? null })) };
  });

  // Andamento do lote: quem pediu o lote (ou gestor/admin) acompanha; outros agentes não veem lote alheio.
  async function lotePermitido(req, lote) {
    if (!lote) throw new ErroHttp(400, 'Informe o lote.');
    if (ehGestor(req)) return;
    const { rows } = await query(`SELECT 1 FROM email_ia.suporte_equipe_envios WHERE lote = $1 AND criado_por_id = $2 LIMIT 1`, [lote, req.usuario.user_id ?? -1]);
    if (!rows.length) throw new ErroHttp(404, 'Lote não encontrado.');
  }

  app.get('/api/suporte-escalado/novo-ticket/lote', { ...auth, schema: { tags: ['Central de E-mail IA'], summary: 'Novo ticket (Suporte Humano) — andamento dos envios de um lote', security: seg, querystring: { type: 'object', required: ['lote'], properties: { lote: { type: 'string', maxLength: 60 } } } } }, async (req) => {
    const lote = String(req.query.lote);
    await lotePermitido(req, lote);
    const { rows } = await query(`SELECT status, count(*)::int AS n FROM email_ia.suporte_equipe_envios WHERE lote = $1 GROUP BY 1`, [lote]);
    const falhas = (await query(`SELECT id, para_email, erro, caso_id FROM email_ia.suporte_equipe_envios WHERE lote = $1 AND status = 'falhou' ORDER BY id LIMIT 50`, [lote])).rows;
    const tickets = (await query(`SELECT caso_id FROM email_ia.suporte_equipe_envios WHERE lote = $1 AND status = 'enviado' AND caso_id IS NOT NULL ORDER BY id LIMIT 200`, [lote])).rows.map((r) => r.caso_id);
    return { lote, por_status: Object.fromEntries(rows.map((r) => [r.status, r.n])), falhas, tickets };
  });

  app.post('/api/suporte-escalado/novo-ticket/lote/reenviar', { ...auth, schema: { tags: ['Central de E-mail IA'], summary: 'Novo ticket (Suporte Humano) — tenta de novo os envios que falharam de um lote', security: seg, body: { type: 'object', required: ['lote'], additionalProperties: false, properties: { lote: { type: 'string', maxLength: 60 } } } } }, async (req) => {
    const lote = String(req.body.lote);
    await lotePermitido(req, lote);
    const { rowCount } = await query(
      `UPDATE email_ia.suporte_equipe_envios SET status = 'fila', tentativas = 0, erro = NULL, proxima_tentativa_em = now()
        WHERE lote = $1 AND status = 'falhou' AND caso_id IS NULL`, [lote]);
    acionarEnvioEquipe();
    return { reenfileirados: rowCount };
  });
}
