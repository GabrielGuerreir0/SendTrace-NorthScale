
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCK_TIMEOUT_MIN, SESSAO_HORAS, CONVITE_DIAS } from './config.js';
import { CANAIS, DESTINOS, STATUS_LABELS, ESTADOS, REGUA_FALLBACK } from './etapas.config.js';
// A régua, a fila E os usuários vêm da API: o painel não toca o Postgres. A
// gestão de contas (criar, promover, desativar, senha provisória) é proxy das
// rotas /api/usuarios/ da API, com o token de quem está logado; só o CONVITE
// por e-mail sai daqui, porque o SMTP é configuração do painel.
import {
  etapasRollup, ondaPorEtapa, ondaHoraria, entradasPorDia,
  statusBruto, alertas, listarPedidos,
  reguaDefinicao, cadenciaObservada, porCanal, semMensagem, resumoLinhas, piorCasoSms, errosSemCanal, mensagem, salvarMensagem, criarLinha, apagarLinha, editarLinha, etapasDaRegua,
  produtosDaFila, fonteDados,
} from './dados.js';
import {
  apiConfigurada, enderecoApi, saude as saudeApi, ErroApi,
  autenticarUsuario, dadosDoToken, comCredencial, obter as obterApi, listarTudo,
  criar as criarApi, substituir as substituirApi, apagar as apagarApi,
  remendar as remendarApi,
} from './api.js';
import { enviarConvite, emailConfigurado } from './email.js';
import {
  abrirSessao, lerSessao, fecharSessao, contarSessoesDe, limparVencidas,
} from './sessoes.js';
import {
  trocarLinha, linhaAtual, historicoLinha, linhaConfigurada, linhasValidas,
} from './linha.js';
// Mesma validação que a tela usa — um arquivo só, servido ao navegador e
// importado aqui. Validar só no front seria conselho, não garantia.
import { validarMensagem } from '../public/copy.js';
import { versao } from './versao.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 4300;
const HOST = process.env.HOST || '127.0.0.1';

const COOKIE = 'painel_sessao';

/* Só isto é servido sem sessão — o necessário para desenhar o próprio login.
   Todo o resto (o painel, os assets dele e todas as APIs) exige sessão. */
const PUBLICOS = new Set(['/login', '/login.html', '/login.js', '/styles.css']);

function lerCookie(req, nome) {
  const cru = req.headers.cookie;
  if (!cru) return null;
  for (const parte of cru.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) {
      return decodeURIComponent(parte.slice(i + 1).trim());
    }
  }
  return null;
}

/**
 * `Secure` só entra quando a conexão é HTTPS de fato. Marcar Secure em HTTP
 * faria o navegador descartar o cookie em silêncio e o login nunca completaria
 * no uso local, que é o caso normal deste painel.
 *
 * `SameSite=Strict` é a principal defesa de CSRF: o cookie não viaja em
 * requisição originada de outro site, então nenhum formulário externo consegue
 * agir em nome de quem está logado aqui.
 */
function porCookieSessao(req, res, token, segundos) {
  const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const pedacos = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${segundos}`,
  ];
  if (https) pedacos.push('Secure');
  res.setHeader('Set-Cookie', pedacos.join('; '));
}

function limparCookieSessao(req, res) {
  const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const pedacos = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (https) pedacos.push('Secure');
  res.setHeader('Set-Cookie', pedacos.join('; '));
}

/** Corpo JSON com teto de tamanho — sem teto, um POST enorme derruba o processo. */
async function lerJson(req, limite = 8 * 1024) {
  const partes = [];
  let n = 0;
  for await (const bloco of req) {
    n += bloco.length;
    if (n > limite) throw new Error('corpo grande demais');
    partes.push(bloco);
  }
  if (!n) return {};
  return JSON.parse(Buffer.concat(partes).toString('utf8'));
}

/* Freio por IP, complementar ao bloqueio por conta que vive no banco. Este
   pega o ataque que varre MUITOS e-mails a partir de um mesmo lugar — o freio
   por conta, sozinho, não veria isso. Em memória de propósito: é uma barreira
   de curto prazo, e o freio durável é o do banco. */
const tentativasIp = new Map();
const IP_MAX = 20;
const IP_JANELA_MS = 10 * 60 * 1000;

function ipBloqueado(ip) {
  const reg = tentativasIp.get(ip);
  if (!reg) return false;
  if (Date.now() - reg.desde > IP_JANELA_MS) { tentativasIp.delete(ip); return false; }
  return reg.n >= IP_MAX;
}
function marcarFalhaIp(ip) {
  const reg = tentativasIp.get(ip);
  if (!reg || Date.now() - reg.desde > IP_JANELA_MS) {
    tentativasIp.set(ip, { n: 1, desde: Date.now() });
  } else {
    reg.n += 1;
  }
  // Sem poda, um atacante variando o IP faria o Map crescer sem limite.
  if (tentativasIp.size > 5000) {
    const corte = Date.now() - IP_JANELA_MS;
    for (const [k, v] of tentativasIp) if (v.desde < corte) tentativasIp.delete(k);
  }
}

const ipDe = (req) =>
  (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';

/**
 * Exigência de cabeçalho próprio em tudo que muda estado. O navegador não
 * permite cabeçalho personalizado numa requisição cross-site sem preflight, e
 * preflight nenhum é autorizado aqui — então isto barra CSRF mesmo que algum
 * navegador antigo ignore o SameSite.
 */
const temCabecalhoDoPainel = (req) => req.headers['x-painel'] === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// 'na_regua' é pseudo-estado: tudo que ainda circula (não-finalizado). É o que
// o clique num nó do canvas usa, para a tabela bater com o número do nó.
const ESTADO_IDS = new Set([...ESTADOS.map((e) => e.id), 'na_regua']);
const CANAL_IDS = new Set(Object.keys(CANAIS));
/* Situações que o card de alcance expõe e que a tabela sabe filtrar. */
const PROBLEMA_IDS = new Set(['com_erro', 'sem_contato', 'com_contato']);

/**
 * Nome de produto vindo da query string, ou null.
 *
 * Só normaliza e limita o tamanho: a comparação no banco é por igualdade e
 * parametrizada, então um nome desconhecido devolve lista vazia — que é a
 * resposta correta para "os pedidos de um produto que não existe".
 */
function produtoOuNulo(raw) {
  const v = (raw ?? '').trim();
  return v === '' ? null : v.slice(0, 200);
}

/** Inteiro de query string, ou null. Devolve `false` quando veio lixo. */
function inteiroOuNulo(raw) {
  if (raw === null || raw === '') return null;
  const v = Number.parseInt(raw, 10);
  return Number.isInteger(v) ? v : false;
}

/**
 * Traduz o corpo de erro do Django para uma frase.
 *
 * O DRF devolve `{"linha": ["Já existe ..."], "texto": ["Obrigatório."]}`. Jogar
 * esse JSON na tela transfere ao usuário o trabalho de decifrar o formato do
 * framework; `padrao` cobre o caso de vir algo que não sabemos ler.
 */
function detalharErroApi(err, padrao) {
  const corpo = err?.corpo;
  if (!corpo || typeof corpo !== 'object') return padrao;
  const partes = [];
  for (const [campo, valor] of Object.entries(corpo)) {
    const txt = Array.isArray(valor) ? valor.join(' ') : String(valor);
    if (!txt) continue;
    partes.push(campo === 'detail' || campo === 'non_field_errors' ? txt : `${campo}: ${txt}`);
  }
  return partes.length ? partes.join(' · ').slice(0, 300) : padrao;
}

/* Devolve ATENDIDO para o roteador distinguir "esta rota respondeu" de "esta
   rota não é minha" (null). Sem isso a distinção ficaria por conta de
   `undefined !== null`, que quebra em silêncio se alguém puser um `return`. */
const ATENDIDO = Symbol('atendido');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
  return ATENDIDO;
}

/**
 * Casa a definição da régua (etapas_regua) com os números da fila
 * (disparos_pos_venda).
 *
 * Uma etapa que aparece na fila mas não está na régua é DESCOBERTA e marcada:
 * ou o n8n avançou para uma etapa que ninguém cadastrou, ou alguém apagou a
 * linha da régua com gente parada nela. Nos dois casos é coisa para ver, então
 * o painel mostra em vez de esconder.
 */
function montarEtapas(regua, rollup) {
  const porId = new Map(regua.map((e) => [e.etapa, { ...e }]));

  for (const r of rollup) {
    if (!porId.has(r.etapa)) {
      porId.set(r.etapa, {
        etapa: r.etapa,
        nome: `Etapa ${r.etapa}`,
        mensagens: [],
        espera_h: null,
        offset_h: null,
        ativo: true,
        descricao: 'Existe na fila mas não está cadastrada em etapas_regua',
        autoDetectada: true,
      });
    }
  }

  const vazio = {
    total: 0, em_dia: 0, atrasado: 0, processando: 0, travado: 0, finalizado: 0,
    cancelado: 0, com_erro: 0, com_retry: 0, novos_24h: 0, prestes: 0,
    proximo_em: null, max_tentativas: 0,
  };
  const porEtapa = new Map(rollup.map((r) => [r.etapa, r]));

  return [...porId.values()]
    .sort((a, b) => a.etapa - b.etapa)
    .map((def) => ({ ...def, ...vazio, ...(porEtapa.get(def.etapa) ?? {}) }));
}

/**
 * Espera configurada acumulada até cada etapa (soma dos espera_h anteriores),
 * para comparar com a mediana observada e expor deriva entre a régua escrita
 * e a régua que está rodando.
 */
function acumularEsperas(etapas) {
  let acc = 0;
  const mapa = new Map();
  for (const e of etapas) {
    // `offset_h` é o valor declarado: horas da compra até esta etapa disparar.
    // É mais fiel que somar as esperas, porque a etapa 0 não dispara em t=0 —
    // ela espera 30 min, e essa meia hora some de qualquer soma de espera_h.
    mapa.set(e.etapa, Number.isFinite(e.offset_h) ? e.offset_h : acc);
    // Etapa desativada é pulada pelo worker, então a espera dela não faz parte
    // do caminho — somá-la inflaria o tempo total da régua.
    if (e.ativo !== false && Number.isFinite(e.espera_h)) acc += e.espera_h;
  }
  return mapa;
}

async function snapshot(filtros = {}) {
  /*
   * Qual linha de copy o painel exibe.
   *
   * Por padrão é a ATIVA — mostrar a copy de uma linha enquanto outra está
   * valendo seria exibir mensagem que ninguém está recebendo. `filtros.linha`
   * permite espiar outra antes de ativá-la, e a tela deixa claro quando o que
   * está na tela não é o que está no ar.
   */
  const validas = await linhasValidas();
  const ativa = (await linhaAtual())?.linha ?? validas[0] ?? '1';
  const linha = validas.includes(String(filtros.linha)) ? String(filtros.linha) : ativa;
  const doFiltro = { ...filtros, linha };
  /*
   * O produto recorta o painel INTEIRO, ao contrário de etapa/canal (que só
   * recortam os dois gráficos temporais). É outra pergunta: "como está a régua
   * deste produto" — e responder com os nós e os KPIs de todos os produtos
   * juntos daria um número que não é do produto nenhum.
   */
  const produto = filtros.produto ?? null;

  const [regua, rollup, onda, horaria, entradas, statuses, problemas, cadencia,
    canais, orfaos, linhas, piorSms, errosOrfaos, produtos, fonte] = await Promise.all([
    reguaDefinicao(linha), etapasRollup(produto), ondaPorEtapa(produto), ondaHoraria(doFiltro),
    entradasPorDia(doFiltro), statusBruto(produto), alertas(produto), cadenciaObservada(produto),
    porCanal(linha, produto), semMensagem(linha, produto), resumoLinhas(),
    piorCasoSms(produto), errosSemCanal(produto), produtosDaFila(), fonteDados(),
  ]);

  const reguaOk = regua !== null;
  const etapas = montarEtapas(reguaOk ? regua : REGUA_FALLBACK, rollup);

  // Cadência: configurada (soma dos espera_h) × observada (mediana real).
  const acumulado = acumularEsperas(etapas);
  const medianas = new Map(cadencia.map((c) => [c.etapa, c]));
  for (const e of etapas) {
    const obs = medianas.get(e.etapa);
    e.espera_acumulada_h = acumulado.get(e.etapa) ?? null;
    e.observado_h = obs?.mediana_h === null || obs?.mediana_h === undefined
      ? null
      : Math.round(Number(obs.mediana_h) * 10) / 10;
    e.observado_amostra = obs?.amostra ?? 0;
  }

  // Acopla os 12 baldes de 48h a cada etapa.
  const baldes = new Map();
  for (const r of onda) {
    if (!baldes.has(r.etapa)) baldes.set(r.etapa, new Array(12).fill(0));
    if (r.balde >= 1 && r.balde <= 12) baldes.get(r.etapa)[r.balde - 1] = r.total;
  }
  for (const e of etapas) {
    e.onda48h = baldes.get(e.etapa) ?? new Array(12).fill(0);
    // O número que o nó exibe é quem AINDA está circulando na etapa. Uma linha
    // com status terminal continua carregando o etapa_atual em que parou, então
    // somá-la ao nó contaria como "nesta etapa" alguém que já saiu da régua.
    e.na_etapa = e.em_dia + e.atrasado + e.processando + e.travado;
  }

  const soma = (campo) => etapas.reduce((acc, e) => acc + (e[campo] || 0), 0);
  const totais = {
    total: soma('total'),
    em_dia: soma('em_dia'),
    atrasado: soma('atrasado'),
    processando: soma('processando'),
    travado: soma('travado'),
    finalizado: soma('finalizado'),
    cancelado: soma('cancelado'),
    com_erro: soma('com_erro'),
    com_retry: soma('com_retry'),
    novos_24h: soma('novos_24h'),
    prestes: soma('prestes'),
  };
  // "na régua" = ainda em circulação (tudo que não é terminal)
  totais.na_regua = soma('na_etapa');

  // Quem está numa etapa sem NENHUMA mensagem ativa não aparece em nenhum
  // canal — o card de alcance ficaria mudo sobre eles. Vai explícito.
  totais.sem_mensagem = orfaos;
  // Erros sem canal identificado no texto: somem do recorte por canal, então
  // a soma dos dois canais fica menor que o total. Vai explícito.
  totais.erro_sem_canal = errosOrfaos;

  return {
    geradoEm: new Date().toISOString(),
    lockTimeoutMin: LOCK_TIMEOUT_MIN,
    reguaOk,
    filtros: {
      etapa: filtros.etapa ?? null, canal: filtros.canal ?? null, produto,
    },
    // O catálogo do seletor do topo, sempre completo — é dele que se escolhe.
    produtos,
    /*
     * De onde vieram estes números.
     *
     * Sem rota de agregação na API, medir a fila é baixá-la. `truncado` diz que
     * ela passou do teto e o painel está falando de uma PARTE — a tela precisa
     * avisar, porque um total que não é total mente com aparência de dado.
     */
    fonte: { ...fonte, api: enderecoApi },
    // `exibindo` é a linha desenhada na tela; `ativa` é a que está valendo nos
    // envios. Quando divergem, a interface avisa — é o caso de quem está
    // espiando outra linha antes de trocar.
    linha: {
      exibindo: linha,
      ativa,
      configurado: linhaConfigurada,
      resumo: linhas,
    },
    etapas,
    totais,
    estados: ESTADOS,
    canais: CANAIS,
    destinos: DESTINOS,
    // O maior nome e o maior produto da fila. O painel mede o SMS por eles em
    // vez de por uma amostra confortável: é o pior caso que decide se a
    // mensagem vira dois segmentos e custa o dobro.
    piorCasoSms: piorSms,
    porCanal: canais.map((c) => ({
      ...c,
      label: CANAIS[c.canal]?.label ?? c.canal,
      faltando: CANAIS[c.canal]?.faltando ?? 'sem contato',
    })),
    statusBruto: statuses.map((s) => ({ ...s, label: STATUS_LABELS[s.status] ?? s.status })),
    ondaHoraria: horaria.map((h) => ({ hora: h.hora, total: h.total })),
    entradasPorDia: entradas,
    alertas: problemas,
  };
}

async function servirEstatico(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const alvo = path.resolve(PUBLIC_DIR, rel);

  // Trava contra path traversal: o alvo tem que continuar dentro de /public.
  if (alvo !== PUBLIC_DIR && !alvo.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }

  try {
    /*
     * ETag a partir de tamanho + data do arquivo.
     *
     * `no-cache` manda revalidar, mas SEM validador o navegador não tem como
     * perguntar "mudou?" — e alguns servem a cópia antiga assim mesmo. O
     * resultado é o pior tipo de bug: o código novo está no servidor, o
     * usuário jura que não mudou nada, e os dois têm razão.
     *
     * Com ETag, um arquivo alterado sempre chega inteiro; um inalterado custa
     * um 304 vazio.
     */
    const info = await fs.stat(alvo);
    const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }

    const conteudo = await fs.readFile(alvo);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(alvo).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    });
    res.end(conteudo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
  }
}

/* ─────────────────────────  rotas de acesso  ───────────────────────── */

/**
 * Quem é a pessoa por trás deste token.
 *
 * O `user_id` vem do payload do JWT; o resto (nome, se é admin) vem de
 * `/api/usuarios/{id}/`, já com o token dela. Se essa leitura falhar, a sessão
 * ainda vale — só entra sem os poderes de administrador. Recusar o login
 * inteiro porque um detalhe do perfil não carregou trocaria "entrou sem o botão
 * Usuários" por "não entrou", que é pior.
 */
async function perfilDoToken(credencial) {
  const carga = dadosDoToken(credencial.access);
  const id = carga.user_id ?? carga.id ?? null;
  const base = { id, email: carga.email ?? null, nome: null, admin: false, ativo: true };
  if (id === null) return base;

  try {
    const u = await comCredencial(credencial, () => obterApi(`/api/usuarios/${id}/`));
    return {
      id: u.id ?? id,
      email: u.email ?? base.email,
      nome: u.nome ?? null,
      admin: Boolean(u.admin),
      ativo: u.ativo !== false,
      trocar_senha: Boolean(u.trocar_senha),
    };
  } catch (err) {
    console.error('[auth] token válido, perfil não carregou:', err.message);
    return base;
  }
}

async function rotasAuth(req, res, url, sessao) {
  const p = url.pathname;

  /*
   * Login. Quem confere a senha é a API, não o painel.
   *
   * O painel não guarda senha nem hash: manda o que foi digitado para
   * /api/auth/token/ e fica com o par access/refresh que voltar. Uma conta
   * desativada lá para de entrar aqui no mesmo instante, sem sincronização.
   */
  if (p === '/api/auth/login' && req.method === 'POST') {
    const ip = ipDe(req);
    if (ipBloqueado(ip)) {
      return json(res, 429, { erro: 'Muitas tentativas deste endereço. Aguarde alguns minutos.' });
    }
    const corpo = await lerJson(req);
    const email = String(corpo.email ?? '').trim().toLowerCase();
    const senha = corpo.senha ?? '';
    if (!email || !senha) return json(res, 400, { erro: 'Preencha e-mail e senha.' });

    let credencial;
    try {
      credencial = await autenticarUsuario(email, senha);
    } catch (err) {
      if (err instanceof ErroApi && (err.status === 400 || err.status === 401)) {
        marcarFalhaIp(ip);
        // Atraso fixo: o tempo de resposta não deve distinguir os motivos.
        await new Promise((ok) => setTimeout(ok, 260));
        return json(res, 401, { erro: 'E-mail ou senha incorretos.' });
      }
      throw err;
    }

    const usuario = await perfilDoToken(credencial);
    if (!usuario.ativo) return json(res, 403, { erro: 'Esta conta está desativada.' });

    const token = abrirSessao({ usuario, credencial });
    porCookieSessao(req, res, token, SESSAO_HORAS * 3600);
    return json(res, 200, { usuario });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    fecharSessao(lerCookie(req, COOKIE));
    limparCookieSessao(req, res);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/auth/eu') {
    if (!sessao) return json(res, 401, { erro: 'sem sessão' });
    return json(res, 200, { usuario: sessao.usuario });
  }

  /*
   * Trocar a própria senha. Quem confere a atual e grava a nova é a API
   * (`POST /api/auth/senha/`), com o token desta pessoa. É este caminho que
   * transforma a senha provisória de um convite em definitiva.
   */
  if (p === '/api/auth/senha' && req.method === 'POST') {
    if (!sessao) return json(res, 401, { erro: 'sem sessão' });
    const corpo = await lerJson(req);
    try {
      await criarApi('/api/auth/senha/', {
        atual: String(corpo.atual ?? ''),
        nova: String(corpo.nova ?? ''),
      });
    } catch (err) {
      // O 400 da API é veredito ("senha atual incorreta", "curta demais"),
      // não sessão morta — sem este catch ele cairia no tratador global, que
      // derrubaria a sessão ou responderia 502.
      if (err instanceof ErroApi && (err.status === 400 || err.status === 403)) {
        return json(res, 400, { erro: detalharErroApi(err, 'Não foi possível trocar a senha.') });
      }
      throw err;
    }
    // A troca zera a pendência; o objeto da sessão é o mesmo que as próximas
    // requisições leem, então o painel abre sem exigir novo login.
    sessao.usuario.trocar_senha = false;
    return json(res, 200, { ok: true });
  }

  return null;   // não é rota de acesso
}

/**
 * Usuários — gestão completa, por proxy.
 *
 * Quem escreve de verdade é a API (`POST`/`PATCH /api/usuarios/`), com o token
 * do administrador logado — as travas (último admin, auto-rebaixamento, regra
 * de senha) moram lá. O painel só acrescenta o que é dele: a contagem de
 * sessões e o CONVITE por e-mail, porque o SMTP é configuração daqui.
 */
async function rotasUsuarios(req, res, url, sessao) {
  if (!url.pathname.startsWith('/api/usuarios')) return null;
  if (!sessao.usuario.admin) {
    return json(res, 403, { erro: 'Só administradores gerenciam usuários.' });
  }

  const cargaUsuarios = async () => {
    const { itens } = await listarTudo('/api/usuarios/');
    return {
      usuarios: itens.map((u) => ({
        ...u,
        // A contagem é das sessões DESTE painel, que é o que ele sabe de fato.
        sessoes: contarSessoesDe(u.email),
      })),
      eu: sessao.usuario.id,
      // A interface esconde a opção de enviar e-mail quando não há SMTP —
      // oferecer um botão que nunca funciona é pior que não oferecer.
      emailConfigurado,
      conviteDias: CONVITE_DIAS,
    };
  };

  if (url.pathname === '/api/usuarios' && req.method === 'GET') {
    return json(res, 200, await cargaUsuarios());
  }

  if (url.pathname === '/api/usuarios' && req.method === 'POST') {
    const corpo = await lerJson(req);
    let novo;
    try {
      novo = await criarApi('/api/usuarios/', {
        email: String(corpo.email ?? ''),
        nome: String(corpo.nome ?? '').trim().slice(0, 120),
        senha: String(corpo.senha ?? ''),
        admin: !!corpo.admin,
      });
    } catch (err) {
      // 400/409 da API é veredito de validação (e-mail inválido, senha fraca,
      // duplicata) — vai para a tela como está, sem virar 502 nem derrubar
      // a sessão no tratador global.
      if (err instanceof ErroApi && (err.status === 400 || err.status === 409)) {
        return json(res, err.status, {
          erro: detalharErroApi(err, 'A API recusou a criação do usuário.'),
        });
      }
      throw err;
    }

    // O e-mail é acessório: a conta já existe e a senha aparece na tela de
    // quem criou. Uma falha de SMTP informa, mas não desfaz nada.
    let envio = { enviado: false, motivo: 'não solicitado' };
    if (corpo.enviarEmail !== false) {
      envio = await enviarConvite({
        para: novo.email, senha: corpo.senha, admin: !!corpo.admin,
        quemConvidou: sessao.usuario.email, dias: CONVITE_DIAS, req,
      });
    }
    return json(res, 201, { usuario: novo, email: envio, conviteDias: CONVITE_DIAS });
  }

  const m = /^\/api\/usuarios\/(\d+)$/.exec(url.pathname);
  if (m && req.method === 'PATCH') {
    const corpo = await lerJson(req);
    // Só o que a API conhece segue adiante — `enviarEmail` é assunto do painel.
    const mudanca = {};
    for (const campo of ['admin', 'ativo', 'senha']) {
      if (campo in corpo) mudanca[campo] = corpo[campo];
    }

    let alterado;
    try {
      alterado = await remendarApi(`/api/usuarios/${m[1]}/`, mudanca);
    } catch (err) {
      if (err instanceof ErroApi && (err.status === 400 || err.status === 404 || err.status === 409)) {
        return json(res, err.status, {
          erro: detalharErroApi(err, 'A API recusou a mudança.'),
        });
      }
      throw err;
    }

    // Senha provisória nova: o convite sai daqui, como na criação.
    let envio = null;
    if (corpo.senha && corpo.enviarEmail !== false) {
      envio = await enviarConvite({
        para: alterado.email, senha: corpo.senha, admin: !!alterado.admin,
        quemConvidou: sessao.usuario.email, dias: CONVITE_DIAS, req,
      });
    }

    return json(res, 200, {
      ...(await cargaUsuarios()),
      ...(envio ? { email: envio } : {}),
    });
  }

  return json(res, 404, { erro: 'rota não encontrada' });
}

/**
 * O miolo de toda requisição autenticada.
 *
 * Roda SEMPRE dentro de `comCredencial`, então qualquer chamada à API daqui
 * para baixo já sai com o token de quem está logado — sem precisar carregar a
 * credencial de parâmetro em parâmetro até o fundo de dados.js.
 */
async function atender(req, res, url, sessao) {
  const usuario = sessao?.usuario ?? null;
  res.setHeader('Vary', 'Cookie');

  if (req.method !== 'GET' && !temCabecalhoDoPainel(req)) {
    return json(res, 403, { erro: 'requisição não reconhecida' });
  }

  const respostaAuth = await rotasAuth(req, res, url, sessao);
  if (respostaAuth !== null) return respostaAuth;

  if (!usuario) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { erro: 'sem sessão' });
    if (PUBLICOS.has(url.pathname)) {
      await servirEstatico(req, res, url.pathname === '/login' ? '/login.html' : url.pathname);
      return ATENDIDO;
    }
    // Guarda para onde a pessoa queria ir, para voltar depois do login.
    const destino = url.pathname + url.search;
    res.writeHead(302, {
      Location: `/login?ir=${encodeURIComponent(destino === '/' ? '/' : destino)}`,
    }).end();
    return ATENDIDO;
  }

  // Já logado não tem o que fazer na tela de login — EXCETO quem ainda deve
  // trocar a senha provisória: a tela de definir senha própria mora lá, e
  // redirecionar viraria um pingue-pongue entre / e /login.
  if (url.pathname === '/login' || url.pathname === '/login.html') {
    if (!usuario.trocar_senha) {
      res.writeHead(302, { Location: '/' }).end();
      return ATENDIDO;
    }
    await servirEstatico(req, res, '/login.html');
    return ATENDIDO;
  }

  // Senha provisória: o painel fica fechado até ela ser trocada. Só as rotas
  // de acesso respondem — é o que a tela de troca precisa.
  if (usuario.trocar_senha && url.pathname.startsWith('/api/')
      && !url.pathname.startsWith('/api/auth/')) {
    return json(res, 403, { erro: 'troca de senha pendente', trocarSenha: true });
  }

  const respostaUsuarios = await rotasUsuarios(req, res, url, sessao);
  if (respostaUsuarios !== null) return respostaUsuarios;

  /* ── readmes de produto: o conhecimento da IA de suporte ──
     O texto mora no banco (produto_readmes, via API). Quem escreve aqui está
     literalmente ensinando o chatbot sobre o produto: ele baixa os readmes
     ativos e os injeta no próprio prompt a cada conversa. */
  if (url.pathname === '/api/produtos-ia' && req.method === 'GET') {
    const r = await obterApi('/api/produto-readmes/', { page_size: 200 });
    return json(res, 200, { readmes: r.results ?? [] });
  }

  /* ── histórico de atendimentos do chatbot (o modal do duplo clique) ── */
  if (url.pathname === '/api/atendimentos' && req.method === 'GET') {
    const transacao = String(url.searchParams.get('transacao_id') ?? '').trim();
    const email = String(url.searchParams.get('email') ?? '').trim();
    if (!transacao && !email) return json(res, 400, { erro: 'Informe ?transacao_id= ou ?email=.' });
    // Com os dois, a API casa qualquer um (OR) — o histórico novo por
    // transação e o antigo por e-mail chegam juntos.
    const r = await obterApi('/api/atendimentos/', {
      ...(transacao ? { transacao_id: transacao } : {}),
      ...(email ? { email } : {}),
      page_size: 10,
    });
    return json(res, 200, { atendimentos: r.results ?? [] });
  }

  const rotaReadme = /^\/api\/produtos-ia\/(.+)$/.exec(url.pathname);
  if (rotaReadme && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!usuario.admin) {
      return json(res, 403, { erro: 'Só administradores editam os readmes de produto.' });
    }
    const produto = decodeURIComponent(rotaReadme[1]).trim().slice(0, 300);
    if (!produto) return json(res, 400, { erro: 'Produto sem nome.' });
    const rotaApi = `/api/produto-readmes/${encodeURIComponent(produto)}/`;

    if (req.method === 'DELETE') {
      try {
        await apagarApi(rotaApi);
      } catch (err) {
        // Apagar o que não existe já é o estado desejado — não é erro.
        if (!(err instanceof ErroApi && err.status === 404)) throw err;
      }
      return json(res, 200, { ok: true });
    }

    const corpo = await lerJson(req, 256 * 1024);
    const readme = String(corpo.readme ?? '').trim();
    if (!readme) return json(res, 400, { erro: 'Escreva o readme antes de salvar.' });

    const dados = {
      produto,
      readme,
      ativo: corpo.ativo !== false,
      // Fica registrado quem ensinou a IA por último — sai da sessão, não do
      // corpo, para o navegador não assinar como outra pessoa.
      atualizado_por: usuario.email ?? null,
    };
    let salvo;
    try {
      salvo = await substituirApi(rotaApi, dados);
    } catch (err) {
      // PUT em produto novo dá 404 na API: é a primeira vez — cria.
      if (err instanceof ErroApi && err.status === 404) {
        salvo = await criarApi('/api/produto-readmes/', dados);
      } else if (err instanceof ErroApi && err.status === 400) {
        return json(res, 400, { erro: 'A API recusou o readme — confira o tamanho do texto.' });
      } else {
        throw err;
      }
    }
    return json(res, 200, { readme: salvo });
  }

  /* ── linhas de copy: criar e apagar ── */
  if (url.pathname === '/api/linhas' && req.method === 'POST') {
    if (!usuario.admin) {
      return json(res, 403, { erro: 'Só administradores criam linhas de copy.' });
    }
    const corpo = await lerJson(req);
    const nova = String(corpo.linha ?? '').trim();

    // Mesmo formato que o CHECK do banco aceita — recusar aqui dá uma
    // mensagem legível em vez do erro cru da constraint.
    if (!/^\d{1,4}$/.test(nova)) {
      return json(res, 400, { erro: 'O número da linha deve ter de 1 a 4 dígitos.' });
    }
    const nome = String(corpo.nome ?? '').trim().slice(0, 60);
    if (!nome) return json(res, 400, { erro: 'A linha precisa de um nome.' });

    const existentes = await linhasValidas();
    if (existentes.includes(nova)) {
      return json(res, 409, { erro: `A linha ${nova} já existe.` });
    }
    const copiarDe = corpo.copiarDe ? String(corpo.copiarDe) : null;
    if (copiarDe && !existentes.includes(copiarDe)) {
      return json(res, 400, { erro: `Não existe linha ${copiarDe} para copiar.` });
    }

    const ordem = Number.isInteger(corpo.ordem)
      ? corpo.ordem
      : (Number.parseInt(nova, 10) || existentes.length + 1);

    try {
      const r = await criarLinha({
        linha: nova, nome, intuito: String(corpo.intuito ?? '').trim().slice(0, 600),
        ordem, copiarDe,
      });
      return json(res, 201, { ...r, linhas: await resumoLinhas() });
    } catch (err) {
      // A API recusa duplicata com 400/409 e um corpo por campo. Sem
      // traduzir, a tela mostraria o JSON cru do Django.
      if (err instanceof ErroApi && (err.status === 400 || err.status === 409)) {
        return json(res, 409, { erro: detalharErroApi(err, `A linha ${nova} já existe.`) });
      }
      throw err;
    }
  }

  const rotaLinha = /^\/api\/linhas\/(\d{1,4})$/.exec(url.pathname);
  if (rotaLinha && req.method === 'PATCH') {
    if (!usuario.admin) {
      return json(res, 403, { erro: 'Só administradores editam linhas de copy.' });
    }
    const corpo = await lerJson(req);
    const nome = corpo.nome === undefined ? undefined : String(corpo.nome).trim().slice(0, 60);
    if (nome !== undefined && !nome) {
      return json(res, 400, { erro: 'A linha precisa de um nome.' });
    }
    const r = await editarLinha(rotaLinha[1], {
      nome,
      intuito: corpo.intuito === undefined ? undefined : String(corpo.intuito).trim().slice(0, 600),
      ordem: Number.isInteger(corpo.ordem) ? corpo.ordem : undefined,
    });
    if (!r) return json(res, 404, { erro: 'Linha não encontrada.' });
    return json(res, 200, { linha: r, linhas: await resumoLinhas() });
  }

  if (rotaLinha && req.method === 'DELETE') {
    if (!usuario.admin) {
      return json(res, 403, { erro: 'Só administradores apagam linhas de copy.' });
    }
    const r = await apagarLinha(rotaLinha[1]);
    if (!r.ok) return json(res, 400, { erro: r.erro });
    return json(res, 200, { ok: true, linhas: await resumoLinhas() });
  }

  /* ── edição de copy ── */
  // /api/mensagem/:linha/:etapa/:canal
  const rotaMsg = /^\/api\/mensagem\/(\d{1,4})\/(\d{1,2})\/(email|sms)$/.exec(url.pathname);
  if (rotaMsg) {
    const [, linhaM, etapaM, canalM] = rotaMsg;
    const etapaNum = Number(etapaM);

    if (req.method === 'GET') {
      const m = await mensagem(linhaM, etapaNum, canalM);
      if (!m) return json(res, 404, { erro: 'Mensagem não encontrada.' });
      return json(res, 200, { mensagem: m, ...validarMensagem(m) });
    }

    if (req.method === 'PUT') {
      // Editar a copy muda o que sai para os clientes no próximo disparo.
      if (!usuario.admin) {
        return json(res, 403, { erro: 'Só administradores editam a copy.' });
      }
      const corpo = await lerJson(req, 128 * 1024);
      const proposta = {
        linha: linhaM, etapa: etapaNum, canal: canalM,
        assunto: corpo.assunto, corpo_html: corpo.corpo_html,
        botao: corpo.botao, destino: corpo.destino || null,
        texto: corpo.texto, ativo: corpo.ativo,
      };

      const { erros, avisos } = validarMensagem(proposta);
      if (erros.length) return json(res, 400, { erro: erros[0], erros, avisos });

      try {
        const salva = await salvarMensagem(proposta);
        return json(res, 200, { mensagem: salva, avisos });
      } catch (err) {
        // A causa comum é a linha não estar registrada — a ordem que o
        // contrato exige. A API devolve 400 com o erro por campo.
        if (err instanceof ErroApi && err.status === 400) {
          return json(res, 400, {
            erro: detalharErroApi(
              err,
              `A linha ${linhaM} não está registrada. Cadastre-a antes de salvar mensagens nela.`,
            ),
          });
        }
        throw err;
      }
    }
    return json(res, 405, { erro: 'método não permitido' });
  }

  /* ── linha de copy ativa ── */
  if (url.pathname === '/api/linha') {
    if (req.method === 'GET') {
      return json(res, 200, {
        configurado: linhaConfigurada,
        atual: await linhaAtual(),
        historico: usuario.admin ? await historicoLinha() : [],
        podeTrocar: usuario.admin,
      });
    }
    if (req.method === 'POST') {
      // Trocar a linha muda a copy de TODA a operação. Não é leitura, é
      // disparo — fica com quem administra.
      if (!usuario.admin) {
        return json(res, 403, { erro: 'Só administradores trocam a linha de mensagens.' });
      }
      const corpo = await lerJson(req);
      const r = await trocarLinha(String(corpo.linha ?? ''), usuario.id);
      if (!r.ok) return json(res, 400, { erro: r.erro });
      return json(res, 200, {
        atual: await linhaAtual(), historico: await historicoLinha(), configurado: true,
      });
    }
    return json(res, 405, { erro: 'método não permitido' });
  }

  if (url.pathname === '/api/snapshot') {
    const q = url.searchParams;

    // Os filtros só recortam os DOIS gráficos temporais. Os nós, os KPIs e o
    // alcance por canal continuam mostrando a régua inteira: filtrar o painel
    // todo esconderia justamente o contexto que dá sentido ao recorte.
    const etapa = inteiroOuNulo(q.get('etapa'));
    if (etapa === false) return json(res, 400, { erro: 'etapa inválida' });

    const canalRaw = q.get('canal');
    const canal = canalRaw && CANAL_IDS.has(canalRaw) ? canalRaw : null;

    // Qual linha de copy desenhar. Vazio (ou desconhecida) = a que está ativa;
    // quem resolve isso é o snapshot, que já consulta as linhas do banco.
    const linhaRaw = q.get('linha');
    const linha = /^\d{1,4}$/.test(linhaRaw ?? '') ? linhaRaw : null;

    // O produto é a exceção: recorta o painel inteiro, não só os gráficos.
    const produto = produtoOuNulo(q.get('produto'));

    return json(res, 200, await snapshot({ etapa, canal, linha, produto }));
  }

  if (url.pathname === '/api/pedidos') {
    const q = url.searchParams;

    const etapa = inteiroOuNulo(q.get('etapa'));
    if (etapa === false) return json(res, 400, { erro: 'etapa inválida' });

    const estadoRaw = q.get('estado');
    const estado = estadoRaw && ESTADO_IDS.has(estadoRaw) ? estadoRaw : null;

    const canalRaw = q.get('canal');
    const canal = canalRaw && CANAL_IDS.has(canalRaw) ? canalRaw : null;

    const problemaRaw = q.get('problema');
    const problema = problemaRaw && PROBLEMA_IDS.has(problemaRaw) ? problemaRaw : null;

    const buscaRaw = (q.get('q') ?? '').trim();
    const busca = buscaRaw === '' ? null : buscaRaw.slice(0, 120);

    const limit = Math.min(Math.max(Number.parseInt(q.get('limit') ?? '25', 10) || 25, 1), 200);
    const offset = Math.max(Number.parseInt(q.get('offset') ?? '0', 10) || 0, 0);

    // O filtro por canal depende de qual linha tem mensagem cadastrada, então
    // a tabela precisa saber a mesma linha que a tela está mostrando.
    const linhaRaw = q.get('linha');
    const linha = (await linhasValidas()).includes(linhaRaw)
      ? linhaRaw
      : ((await linhaAtual())?.linha ?? '1');

    return json(res, 200, await listarPedidos({
      etapa, estado, canal, problema, busca, limit, offset, ordem: q.get('ordem'), linha,
      produto: produtoOuNulo(q.get('produto')),
    }));
  }

  // A API é a única dependência do painel agora. `/api/health/` dela é rota
  // pública, então este teste não depende de o token de ninguém estar válido.
  if (url.pathname === '/api/health') {
    const inicio = Date.now();
    try {
      const api = await saudeApi();
      return json(res, 200, { ok: true, latenciaMs: Date.now() - inicio, api: { ok: true, endereco: enderecoApi, ...api } });
    } catch (err) {
      return json(res, 503, {
        ok: false,
        latenciaMs: Date.now() - inicio,
        api: { ok: false, endereco: enderecoApi, erro: err.message },
      });
    }
  }

  if (req.method !== 'GET') {
    return json(res, 405, { erro: 'método não permitido' });
  }

  return await servirEstatico(req, res, url.pathname);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    /*
     * Sinal de vida, ANTES da guarda de sessão.
     *
     * O orquestrador precisa saber se o processo responde, e ele não tem
     * sessão. Não toca no banco e não devolve nada além de "estou de pé":
     * um healthcheck que consulta o Postgres derruba o container quando o
     * banco pisca, e reiniciar não conserta banco nenhum.
     */
    if (url.pathname === '/api/vivo') {
      // A digital do código vai aqui: dá para comparar container e local com
      // um curl em cada, sem precisar abrir as duas telas e olhar.
      return json(res, 200, {
        ok: true, desde: Math.round(process.uptime()), ...(await versao()),
      });
    }

    const sessao = lerSessao(lerCookie(req, COOKIE));

    // Tudo daqui em diante fala com a API usando o token DESTA pessoa. Sem
    // sessão a credencial é nula: as rotas públicas (login e os arquivos da
    // tela de entrada) não precisam de token.
    return await comCredencial(sessao?.credencial ?? null, () => atender(req, res, url, sessao));
  } catch (err) {
    console.error(`[api] ${url.pathname}:`, err.message);
    // A mensagem crua pode carregar nome de coluna, rota interna e trecho de
    // consulta. Isso ajuda no diagnóstico local e ajuda um atacante em
    // produção, então só sai quando você pedir.
    const detalhe = process.env.ERROS_DETALHADOS === 'true' ? err.message : undefined;

    if (err instanceof ErroApi) {
      if (!apiConfigurada) {
        return json(res, 502, {
          erro: 'a API não está configurada — defina API_URL no .env e reinicie o painel',
          detalhe,
        });
      }
      /*
       * 401 da API = a credencial DESTA pessoa morreu (access vencido com
       * refresh também vencido, conta desativada, token revogado). Isso é
       * sessão perdida, não API fora do ar: devolver 502 deixaria a tela
       * piscando "sem conexão" para sempre, quando o conserto é entrar de
       * novo. O cookie some junto, senão o navegador insistiria com ele.
       */
      if (err.status === 401 || err.status === 403) {
        limparCookieSessao(req, res);
        fecharSessao(lerCookie(req, COOKIE));
        return json(res, 401, { erro: 'Sua sessão expirou. Entre de novo.' });
      }
      // A API fora do ar não é defeito do painel: 502 diz de quem é o problema.
      return json(res, 502, {
        erro: `não consegui falar com a API em ${enderecoApi}`, detalhe,
      });
    }
    return json(res, 500, { erro: 'falha ao processar a requisição', detalhe });
  }
});

/* Uma sessão vencida deixa de casar no `lerSessao`, mas continua ocupando
   memória. Sem esta varrida o mapa só cresce. */
limparVencidas();
const faxina = setInterval(limparVencidas, 60 * 60 * 1000);
faxina.unref();

servidor.listen(PORT, HOST, () => {
  console.log(`\n  ◗ SendTrace · régua de pós-venda`);
  console.log(`    http://${HOST}:${PORT}`);
  // Sem isto, um .env pela metade só apareceria como "sem conexão" na tela —
  // erro de rede aparente para um problema de configuração.
  console.log(apiConfigurada
    ? `    dados e acesso: API ${enderecoApi}`
    : '    dados: API NÃO CONFIGURADA — defina API_URL no .env');
  console.log(`    travado = 'processando' há mais de ${LOCK_TIMEOUT_MIN} min`);
  console.log(`    cada pessoa entra com a própria conta da API · sessão de ${SESSAO_HORAS} h\n`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    servidor.close(() => process.exit(0));
  });
}
