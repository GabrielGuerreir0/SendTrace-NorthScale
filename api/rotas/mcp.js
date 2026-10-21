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

  const executar = async (req, chave, nome, a = {}) => {
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
      default:
        return null;
    }
  };

  const tratar = async (req, chave, m) => {
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
          instructions: 'SendTrace da The NorthScale (pós-venda, suporte, régua, rastreio). Acesso SOMENTE LEITURA. Comece com sendtrace_guia e sendtrace_listar_tabelas. Dados de clientes são pessoais: não repita e-mails, nomes ou endereços sem necessidade e prefira agregados.',
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: FERRAMENTAS });
      case 'tools/call': {
        try {
          const r = await executar(req, chave, m.params?.name, m.params?.arguments);
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
    if (!(await validarChave(chave, { contar: false }))) { resposta.code(401).send({ detail: 'Chave inválida ou revogada.' }); return null; }
    return chave;
  };

  app.post('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => {
    const chave = await credencial(req, resposta);
    if (!chave) return resposta;
    const corpo = req.body;
    if (Array.isArray(corpo)) {
      const saidas = (await Promise.all(corpo.map((m) => tratar(req, chave, m)))).filter(Boolean);
      return saidas.length ? saidas : resposta.code(202).send();
    }
    const saida = await tratar(req, chave, corpo ?? {});
    return saida ?? resposta.code(202).send();
  });

  // sem fluxo de eventos do servidor: o cliente cai no POST
  app.get('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => resposta.code(405).header('Allow', 'POST').send({ detail: 'Use POST.' }));
  app.delete('/mcp/:chave', { schema: { hide: true } }, async (req, resposta) => resposta.code(405).send({ detail: 'Sem sessão para encerrar.' }));
}
