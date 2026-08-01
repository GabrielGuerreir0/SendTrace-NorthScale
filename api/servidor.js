/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  SendTrace API — o backend do painel, falando direto com o Postgres.  │
 * │                                                                      │
 * │    npm run api          →  http://127.0.0.1:4400                      │
 * │    documentação         →  http://127.0.0.1:4400/api/docs/            │
 * │    contrato OpenAPI     →  http://127.0.0.1:4400/api/schema/          │
 * │                                                                      │
 * │  Mora no mesmo repositório do painel de propósito: as duas pontas     │
 * │  mudam juntas, e um contrato que vive em outro lugar diverge sem      │
 * │  ninguém perceber.                                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Fastify por causa do Swagger: o `@fastify/swagger` gera o OpenAPI A PARTIR
 * do schema declarado em cada rota — o mesmo schema que valida a requisição em
 * tempo de execução. Não existe "arquivo de documentação" para manter em dia;
 * se a rota mudar e a documentação não, é porque não mudou nada.
 */
import crypto from 'node:crypto';

import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import jwt from '@fastify/jwt';

import { pool } from '../server/db.js';
import { TODOS } from './esquemas.js';
import { ErroHttp } from './comum.js';
import rotasAcesso from './rotas/acesso.js';
import rotasFila from './rotas/fila.js';
import rotasRegua from './rotas/regua.js';
import rotasMetricas from './rotas/metricas.js';
import rotasProdutos from './rotas/produtos.js';
import rotasAtendimentos from './rotas/atendimentos.js';

const PORTA = Number(process.env.API_PORT) || 4400;
const HOST = process.env.API_HOST || '127.0.0.1';

/*
 * O segredo que assina os tokens.
 *
 * Sem valor definido o processo NÃO sobe. Um padrão embutido seria pior que a
 * ausência: todo mundo que já leu este arquivo saberia forjar um token de
 * administrador, e nada na tela denunciaria isso.
 */
const SEGREDO = process.env.API_JWT_SEGREDO || '';
if (!SEGREDO || SEGREDO.length < 32) {
  console.error('\n  ✖ API_JWT_SEGREDO ausente ou curto demais (mínimo 32 caracteres).');
  console.error('    Gere um com:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n');
  process.exit(1);
}

const ACCESS_MIN = Number(process.env.API_ACCESS_MIN) || 60;
const REFRESH_H = Number(process.env.API_REFRESH_H) || 12;

/*
 * Token de SERVIÇO — a chave fixa que integrações (o chatbot de suporte)
 * mandam em `Authorization: Bearer`, sem login e sem expiração.
 *
 * É opcional: vazio = desligado, e a API só aceita JWT. Quando definido,
 * exige o mesmo mínimo do segredo JWT — um token de 8 letras seria
 * adivinhável por força bruta, e este dá LEITURA da fila inteira.
 *
 * Quem entra por ele NÃO é administrador: lê tudo e grava o resumo de chat,
 * mas não altera régua, mensagens, linhas nem readmes. Se a chave vazar, o
 * estrago para em leitura — e trocar a chave é trocar uma linha do .env.
 */
const TOKEN_SERVICO = process.env.API_TOKEN_SERVICO || '';
if (TOKEN_SERVICO && TOKEN_SERVICO.length < 32) {
  console.error('\n  ✖ API_TOKEN_SERVICO curto demais (mínimo 32 caracteres).');
  console.error('    Gere um com:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  console.error('    Ou deixe vazio para desligar o acesso por token de serviço.\n');
  process.exit(1);
}

/** Comparação em tempo constante: o tempo de resposta não pode soletrar a chave. */
function tokenServicoValido(bruto) {
  if (!TOKEN_SERVICO || !bruto) return false;
  const a = Buffer.from(bruto);
  const b = Buffer.from(TOKEN_SERVICO);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = Fastify({
  logger: {
    level: process.env.API_LOG || 'info',
    // O corpo das requisições não entra no log: passa senha por ali.
    serializers: { req: (r) => ({ metodo: r.method, url: r.url, ip: r.ip }) },
  },
  // Corpo grande é o corpo_html de um e-mail; acima disso é abuso.
  bodyLimit: 512 * 1024,
});

/* ═════════════════════════════  segurança  ═════════════════════════════ */

await app.register(jwt, { secret: SEGREDO });

/**
 * Emite o par de tokens.
 *
 * O `access` carrega o que as rotas precisam saber sem ir ao banco (quem é, se
 * é admin). O `refresh` carrega o MÍNIMO: só o id e o tipo. Se ele guardasse o
 * `admin`, alguém rebaixado continuaria renovando como administrador até o
 * token vencer.
 */
app.decorate('emitirTokens', (u) => ({
  access: app.jwt.sign(
    { user_id: u.id, email: u.email, nome: u.nome ?? null, admin: !!u.admin, tipo: 'access' },
    { expiresIn: `${ACCESS_MIN}m` },
  ),
  refresh: app.jwt.sign({ user_id: u.id, tipo: 'refresh' }, { expiresIn: `${REFRESH_H}h` }),
}));

/**
 * Exige credencial válida e deixa quem é em `req.usuario`.
 *
 * Dois caminhos pelo MESMO cabeçalho `Authorization: Bearer`:
 *   · o token de SERVIÇO fixo (integrações como o chatbot) — sem expiração,
 *     sem login, nunca admin;
 *   · o JWT de access de uma pessoa, emitido em /api/auth/token/.
 * A chave de serviço é testada primeiro porque é uma comparação barata; o
 * que não casar com ela cai na verificação normal de JWT.
 */
app.decorate('exigirSessao', async (req) => {
  const bruto = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (tokenServicoValido(bruto)) {
    req.usuario = {
      user_id: null,
      email: 'token-servico@api',
      nome: 'Integração (token de serviço)',
      admin: false,
      tipo: 'access',
      servico: true,
    };
    return;
  }

  try {
    req.usuario = await req.jwtVerify();
  } catch {
    throw new ErroHttp(401, 'Token ausente, inválido ou vencido.');
  }
  if (req.usuario.tipo !== 'access') {
    throw new ErroHttp(401, 'Use o token de access, não o de refresh.');
  }
});

/**
 * Exige administrador.
 *
 * Tudo que escreve passa por aqui: mensagem, linha, etapa e fila mudam o que
 * sai para clientes reais. Leitura é liberada a qualquer conta ativa.
 */
app.decorate('exigirAdmin', async (req) => {
  await app.exigirSessao(req);
  if (!req.usuario.admin) throw new ErroHttp(403, 'Só administradores podem alterar isto.');
});

/* ══════════════════════════════  swagger  ══════════════════════════════ */

await app.register(swagger, {
  openapi: {
    info: {
      title: 'SendTrace API',
      version: '2.0.0',
      description: [
        'API do painel da régua de pós-venda, direto sobre o banco do SendTrace.',
        '',
        '## Como usar',
        '',
        '1. `POST /api/auth/token/` com `{"email": "...", "password": "..."}` — a conta é a',
        '   MESMA do painel.',
        '2. Mande o `access` em `Authorization: Bearer <access>`.',
        '3. Quando ele vencer, `POST /api/auth/token/refresh/` com o `refresh`.',
        '',
        'INTEGRAÇÕES (ex.: o chatbot de suporte) podem usar o TOKEN DE SERVIÇO fixo',
        '(`API_TOKEN_SERVICO` no .env do servidor) direto em `Authorization: Bearer`,',
        'sem login e sem expiração. Esse token lê tudo e grava o resumo de chat,',
        'mas nunca é administrador.',
        '',
        'No botão **Authorize** aqui em cima, cole só o access — o `Bearer` é posto para você.',
        '',
        '## O que é leitura e o que é escrita',
        '',
        'Qualquer conta ativa LÊ. Só administradores ESCREVEM: mensagem, etapa, linha e',
        'fila mudam o que sai para clientes reais.',
        '',
        '## Métricas',
        '',
        'As rotas em **Métricas** respondem perguntas agregadas sem trafegar a fila.',
        'Contar 100 mil pedidos por lá custa dezenas de bytes; pela rota `/api/disparos/`',
        'custaria 100 mil registros.',
      ].join('\n'),
    },
    // Relativo de propósito. Dentro do container o HOST é 0.0.0.0 — um
    // endereço de ESCUTA, não de chamada: o Swagger UI montaria requisições
    // para http://0.0.0.0:4400 e o navegador falharia com "Failed to fetch".
    // Com '/', as chamadas saem para a mesma origem em que a página foi
    // aberta, seja 127.0.0.1, seja um domínio atrás de proxy.
    servers: [{ url: '/', description: 'esta instância' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'O `access` devolvido por /api/auth/token/.',
        },
      },
    },
    tags: [
      { name: 'Acesso', description: 'Login e renovação de token.' },
      { name: 'Fila', description: 'Os pedidos em `disparos_pos_venda`.' },
      { name: 'Régua', description: 'Quando cada etapa dispara e o que ela diz.' },
      { name: 'Linhas', description: 'Variações de copy e qual está no ar.' },
      { name: 'Configuração', description: 'Chave/valor que o robô lê.' },
      { name: 'Usuários', description: 'Contas do painel — somente leitura.' },
      { name: 'Métricas', description: 'Perguntas agregadas, respondidas pelo banco.' },
      { name: 'Produtos', description: 'Readmes de produto — o conhecimento que a IA de suporte recebe.' },
      { name: 'Suporte', description: 'Histórico de atendimentos do chatbot — a memória do suporte por cliente.' },
      { name: 'Saúde', description: 'A API está de pé?' },
    ],
  },
});

await app.register(swaggerUi, {
  routePrefix: '/api/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
});

/**
 * O contrato em JSON, num endereço estável.
 *
 * O plugin da interface já publica um em `/api/docs/json`, mas esse endereço é
 * detalhe de implementação dela. `/api/schema/` é o que se coloca num
 * gerador de cliente ou num teste de contrato, e não muda se a UI mudar.
 */
app.get('/api/schema/', {
  schema: {
    tags: ['Saúde'],
    summary: 'O contrato OpenAPI desta API, em JSON',
    description: 'Serve para gerar cliente, validar contrato em CI ou abrir noutro '
      + 'visualizador. É gerado a partir das rotas — não existe cópia para manter.',
  },
}, async () => app.swagger());

/* ══════════════════════════════  esquemas  ═════════════════════════════ */

for (const esquema of TODOS) app.addSchema(esquema);

/* ═══════════════════════════════  rotas  ═══════════════════════════════ */

app.get('/api/health/', {
  schema: {
    tags: ['Saúde'],
    summary: 'A API responde e o banco também?',
    description: 'Rota pública: um healthcheck que exigisse token não serviria para '
      + 'orquestrador nenhum.',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          database: { type: 'boolean' },
          latencia_ms: { type: 'integer' },
        },
      },
      503: { $ref: 'Erro#' },
    },
  },
}, async (_req, resposta) => {
  const inicio = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', database: true, latencia_ms: Date.now() - inicio };
  } catch (err) {
    resposta.code(503);
    return { detail: `banco indisponível: ${err.message}` };
  }
});

/*
 * O tratamento de erro vem ANTES das rotas de propósito.
 *
 * Um `setErrorHandler` registrado depois de um `register` não vale para as
 * rotas daquele plugin: elas já capturaram o tratador padrão. O sintoma é
 * cruel — a resposta sai com o status certo e o CORPO VAZIO, porque o schema
 * de erro só declara `detail` e o tratador padrão manda `message`.
 */
/* ════════════════════════════════  erros  ══════════════════════════════ */

/**
 * Toda falha sai como `{detail}`, em português.
 *
 * O erro cru do Postgres carrega nome de coluna e trecho de consulta: ajuda a
 * diagnosticar e ajuda um atacante na mesma medida. Ele vai para o log, não
 * para a resposta — a não ser que você peça com API_ERROS_DETALHADOS.
 */
app.setErrorHandler((err, req, resposta) => {
  if (err instanceof ErroHttp) return resposta.code(err.statusCode).send({ detail: err.detalhe });

  // Erro de validação do próprio Fastify: o schema já diz o que faltou.
  if (err.validation) {
    return resposta.code(400).send({ detail: `Corpo ou parâmetro inválido: ${err.message}` });
  }

  // Os códigos do Postgres vão entre aspas: '22P02' tem letra no meio e, sem
  // elas, o arquivo inteiro deixa de compilar.
  const pg = {
    23505: 'Já existe um registro com essa chave.',
    23503: 'Depende de um registro que não existe — cadastre-o antes.',
    23514: 'Valor fora do que a coluna aceita.',
    '22P02': 'Formato inválido para um dos campos.',
    '42P01': 'A tabela não existe neste banco.',
  }[err.code];
  if (pg) return resposta.code(409).send({ detail: pg });

  req.log.error({ err }, 'falha não prevista');
  const detalhe = process.env.API_ERROS_DETALHADOS === 'true' ? err.message : undefined;
  return resposta.code(500).send({ detail: 'Falha ao processar a requisição.', ...(detalhe && { erro: detalhe }) });
});

app.setNotFoundHandler((req, resposta) => {
  resposta.code(404).send({ detail: `Rota não encontrada: ${req.method} ${req.url}` });
});

await app.register(rotasAcesso);
await app.register(rotasFila);
await app.register(rotasRegua);
await app.register(rotasMetricas);
await app.register(rotasProdutos);
await app.register(rotasAtendimentos);

/* ═══════════════════════════════  subida  ══════════════════════════════ */

try {
  await app.listen({ port: PORTA, host: HOST });
  console.log(`\n  ◗ SendTrace API`);
  console.log(`    http://${HOST}:${PORTA}`);
  console.log(`    documentação: http://${HOST}:${PORTA}/api/docs/`);
  console.log(`    access vale ${ACCESS_MIN} min · refresh vale ${REFRESH_H} h\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
