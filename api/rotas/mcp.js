/**
 * Servidor MCP (Model Context Protocol) do SendTrace — para o Claude da Késsia consultar tudo, SÓ LEITURA.
 *
 *   POST /mcp/<chave str_ro_…>     JSON-RPC (transporte "streamable HTTP", sem sessão)
 *
 * A chave vai NO ENDEREÇO porque o claude.ai (navegador) e o Claude Desktop só aceitam conector remoto sem cabeçalho personalizado (ou com OAuth).
 * O endereço, portanto, é segredo: nada aqui o registra (o log e a auditoria trocam o trecho da chave por `<chave>`), e revogar a chave o invalida.
 *
 * Cada ferramenta chama a PRÓPRIA API por dentro (`app.inject`) com `Authorization: Bearer <chave>` — então vale tudo o que já vale para a chave:
 * só GET (+ POST /api/leitura/sql em transação READ ONLY), 120/min, máscara de dados pessoais, auditoria linha a linha, credenciais fora.
 */
import { validarChave } from '../leituraChaves.js';

const VERSOES = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXTO = 120_000;

const FERRAMENTAS = [
  {
    name: 'sendtrace_guia',
    description: 'Comece por aqui. Diz quem você é, os limites (linhas, tempo, chamadas por minuto) e o que NÃO pode ser lido (credenciais). Não recebe parâmetros.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sendtrace_listar_tabelas',
    description: 'Lista as tabelas e views do banco do SendTrace (esquema, nome, tipo, nº estimado de linhas, comentário). Com `tabela` (ex.: "email_ia.tickets"), devolve as colunas dela: tipo, se aceita nulo, chave primária e comentário. Use antes de escrever SQL.',
    inputSchema: { type: 'object', properties: { tabela: { type: 'string', description: 'Opcional. "tabela" ou "esquema.tabela". Sem isso, lista só os nomes.' }, busca: { type: 'string', description: 'Opcional. Filtra os nomes que contêm este texto.' } }, additionalProperties: false },
  },
  {
    name: 'sendtrace_sql',
    description: 'Roda um SELECT (ou WITH … SELECT) no Postgres do SendTrace, SOMENTE LEITURA. Um comando só, sem ponto e vírgula no meio, sem parâmetros $1. Até 20 s e 20 000 linhas (padrão 1 000). Esquemas: public e email_ia (use o prefixo email_ia. nas tabelas dele). Agregue no SQL (count, sum, group by) em vez de trazer linhas cruas.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' }, limite: { type: 'integer', minimum: 1, maximum: 20000 } }, required: ['sql'], additionalProperties: false },
  },
  {
    name: 'sendtrace_ler_tabela',
    description: 'Lê linhas de uma tabela ou view, sem escrever SQL (colunas ocultas por segurança já ficam de fora). Para filtrar ou somar, prefira sendtrace_sql.',
    inputSchema: { type: 'object', properties: { nome: { type: 'string' }, limite: { type: 'integer', minimum: 1, maximum: 20000 }, offset: { type: 'integer', minimum: 0 }, ordem: { type: 'string', description: 'Coluna para ordenar.' }, desc: { type: 'boolean' } }, required: ['nome'], additionalProperties: false },
  },
  {
    name: 'sendtrace_chamar_tela',
    description: 'Faz um GET numa rota da API que alimenta as telas do painel (fila, régua, métricas, rastreio, SPPL, Suporte Humano/Escalado…), exatamente como a tela recebe. Caminho começa com /api/ e pode levar ?query. O catálogo de rotas está em /api/schema/ (OpenAPI).',
    inputSchema: { type: 'object', properties: { caminho: { type: 'string', description: 'Ex.: /api/metricas/resumo?dias=7' } }, required: ['caminho'], additionalProperties: false },
  },
];

/** Só aparece (e só funciona) para chave marcada `edita_propriedades` (migração 122). A regra de verdade está na API; aqui é só o atalho. */
const FERRAMENTA_EDITAR = {
  name: 'sendtrace_atualizar_propriedades',
  description: 'ESCREVE (único tipo de escrita permitido): altera as PROPRIEDADES de UM ticket do Suporte Escalado, de qualquer agente — motivo_contato, detalhamento_motivo, tipo_resolucao, status_ticket, percentual_reembolso, valor_compra_usd, deducao_frascos_usd, chargeback_em. '
    + 'Só os campos enviados mudam (null limpa). Os valores têm de ser os das listas fechadas: leia antes sendtrace_chamar_tela com /api/suporte-escalado/opcoes. '
    + 'Propriedades não salva incompleto (motivo, detalhamento, tipo e status são obrigatórios) e "Reembolso parcial" exige percentual e valor da compra. '
    + 'A alteração fica no nome da dona da chave com "(Claude)" e na auditoria. Um ticket por chamada; antes de alterar vários, mostre a lista e peça confirmação.',
  inputSchema: {
    type: 'object',
    properties: {
      caso_id: { type: 'integer', minimum: 1, description: 'Número do ticket (id em email_ia.suporte_escalado).' },
      campos: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          motivo_contato: { type: ['string', 'null'] }, detalhamento_motivo: { type: ['string', 'null'] }, tipo_resolucao: { type: ['string', 'null'] }, status_ticket: { type: ['string', 'null'] },
          percentual_reembolso: { type: ['integer', 'null'] }, valor_compra_usd: { type: ['number', 'null'] }, deducao_frascos_usd: { type: ['number', 'null'] }, chargeback_em: { type: ['string', 'null'], description: 'AAAA-MM-DD' },
        },
      },
    },
    required: ['caso_id', 'campos'], additionalProperties: false,
  },
};

const texto = (obj) => {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (s.length > MAX_TEXTO) s = `${s.slice(0, MAX_TEXTO)}\n… [cortado em ${MAX_TEXTO} caracteres; peça menos linhas ou agregue no SQL]`;
  return { content: [{ type: 'text', text: s }] };
};
const erro = (msg) => ({ ...texto(msg), isError: true });

export default async function rotasMcp(app) {
  /** Chama a própria API como a chave. Devolve { status, corpo }. */
  const chamar = async (req, chave, metodo, url, corpo) => {
    const r = await app.inject({
      method: metodo, url,
      headers: {
        authorization: `Bearer ${chave}`, 'content-type': 'application/json',
        'x-forwarded-for': String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim(),
      },
      ...(corpo && { payload: JSON.stringify(corpo) }),
    });
    let dado; try { dado = JSON.parse(r.body); } catch { dado = r.body; }
    return { status: r.statusCode, corpo: dado };
  };

  const executar = async (req, chave, nome, a = {}, edita = false) => {
    let r;
    switch (nome) {
      case 'sendtrace_guia': {
        const [info, regras] = await Promise.all([chamar(req, chave, 'GET', '/api/leitura/'), chamar(req, chave, 'GET', '/api/leitura/regras')]);
        return texto({ ...info.corpo, nao_pode_ler: regras.corpo, dica: 'Comece com sendtrace_listar_tabelas; use email_ia.<tabela> para o esquema de e-mail/suporte.' });
      }
      case 'sendtrace_listar_tabelas': {
        r = await chamar(req, chave, 'GET', `/api/leitura/esquema${a.tabela ? `?tabela=${encodeURIComponent(a.tabela)}` : ''}`);
        if (r.status !== 200) return erro(r.corpo?.detail ?? `HTTP ${r.status}`);
        let lista = r.corpo.tabelas;
        if (a.busca) lista = lista.filter((t) => `${t.esquema}.${t.nome}`.includes(String(a.busca).toLowerCase()));
        if (a.tabela) return texto(lista);
        return texto(lista.map(({ colunas, ...t }) => ({ ...t, n_colunas: colunas?.length ?? 0 })));
      }
      case 'sendtrace_sql':
        r = await chamar(req, chave, 'POST', '/api/leitura/sql', { sql: a.sql, ...(a.limite && { limite: a.limite }) });
        return r.status === 200 ? texto(r.corpo) : erro(r.corpo?.detail ?? `HTTP ${r.status}`);
      case 'sendtrace_ler_tabela': {
        const q = new URLSearchParams();
        for (const k of ['limite', 'offset', 'ordem']) if (a[k] != null) q.set(k, String(a[k]));
        if (a.desc) q.set('desc', 'true');
        r = await chamar(req, chave, 'GET', `/api/leitura/tabela/${encodeURIComponent(String(a.nome ?? ''))}?${q}`);
        return r.status === 200 ? texto(r.corpo) : erro(r.corpo?.detail ?? `HTTP ${r.status}`);
      }
      case 'sendtrace_chamar_tela': {
        const c = String(a.caminho ?? '');
        if (!c.startsWith('/api/') || c.includes('..')) return erro('O caminho precisa começar com /api/.');
        r = await chamar(req, chave, 'GET', c);
        return r.status === 200 ? texto(r.corpo) : erro(`HTTP ${r.status}: ${r.corpo?.detail ?? JSON.stringify(r.corpo).slice(0, 300)}`);
      }
      case 'sendtrace_atualizar_propriedades': {
        if (!edita) return null;   // chave sem a permissão: a ferramenta nem existe para ela
        const id = Number(a.caso_id);
        if (!Number.isInteger(id) || id < 1) return erro('Informe o caso_id (número do ticket).');
        if (!a.campos || typeof a.campos !== 'object' || !Object.keys(a.campos).length) return erro('Informe os campos a alterar.');
        r = await chamar(req, chave, 'PUT', `/api/suporte-escalado/${id}/ficha`, a.campos);
        return r.status === 200 ? texto({ ok: true, caso_id: id, ficha: r.corpo }) : erro(`HTTP ${r.status}: ${r.corpo?.detail ?? r.corpo?.erro ?? JSON.stringify(r.corpo).slice(0, 300)}`);
      }
      default:
        return null;
    }
  };

  const tratar = async (req, chave, m, edita = false) => {
    const id = m.id;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const falha = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notificação (ex.: notifications/initialized): sem resposta
    switch (m.method) {
      case 'initialize': {
        const pedida = m.params?.protocolVersion;
        return ok({
          protocolVersion: VERSOES.includes(pedida) ? pedida : VERSOES[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sendtrace-leitura', version: '1.0.0' },
          instructions: 'SendTrace da The NorthScale (pós-venda, suporte, régua, rastreio). Acesso SOMENTE LEITURA (exceção: se a sua chave tiver a ferramenta sendtrace_atualizar_propriedades, ela edita as Propriedades dos tickets). Comece com sendtrace_guia e sendtrace_listar_tabelas. Dados de clientes são pessoais: não repita e-mails, nomes ou endereços sem necessidade e prefira agregados.',
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: edita ? [...FERRAMENTAS, FERRAMENTA_EDITAR] : FERRAMENTAS });
      case 'tools/call': {
        try {
          const r = await executar(req, chave, m.params?.name, m.params?.arguments, edita);
          return r ? ok(r) : falha(-32602, `Ferramenta desconhecida: ${m.params?.name}`);
        } catch (err) {
          req.log.error({ err }, 'falha em ferramenta MCP');
          return ok(erro('Falha ao executar a ferramenta.'));
        }
      }
      default: return falha(-32601, `Método não suportado: ${m.method}`);
    }
  };

  const credencial = async (req, resposta) => {
    const chave = String(req.params.chave ?? '');
    const valida = await validarChave(chave, { contar: false });
    if (!valida) { resposta.code(401).send({ detail: 'Chave inválida ou revogada.' }); return null; }
    return { chave, edita: Boolean(valida.edita_propriedades) };
  };

  app.post('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => {
    const cred = await credencial(req, resposta);
    if (!cred) return resposta;
    const { chave, edita } = cred;
    const corpo = req.body;
    if (Array.isArray(corpo)) {
      const saidas = (await Promise.all(corpo.map((m) => tratar(req, chave, m, edita)))).filter(Boolean);
      return saidas.length ? saidas : resposta.code(202).send();
    }
    const saida = await tratar(req, chave, corpo ?? {}, edita);
    return saida ?? resposta.code(202).send();
  });

  // sem fluxo de eventos do servidor: o cliente cai no POST
  app.get('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => resposta.code(405).header('Allow', 'POST').send({ detail: 'Use POST.' }));
  app.delete('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => resposta.code(405).send({ detail: 'Sem sessão para encerrar.' }));
}
