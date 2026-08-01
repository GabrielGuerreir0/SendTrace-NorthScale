import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, LOCK_TIMEOUT_MIN } from './db.js';
import { CANAIS, DESTINOS, STATUS_LABELS, ESTADOS, REGUA_FALLBACK } from './etapas.config.js';
import {
  etapasRollup, ondaPorEtapa, ondaHoraria, entradasPorDia,
  statusBruto, alertas, listarPedidos,
  reguaDefinicao, cadenciaObservada, porCanal, semMensagem, resumoLinhas, piorCasoSms, errosSemCanal, mensagem, salvarMensagem, criarLinha, apagarLinha, editarLinha, etapasDaRegua,
} from './queries.js';

import {
  autenticar, criarSessao, usuarioDaSessao, encerrarSessao, encerrarSessoesDe,
  limparSessoesVencidas, listarUsuarios, criarUsuario, trocarSenha, definirAdmin,
  definirAtivo, contarAdmins, validarSenha, normalizarEmail, emailValido,
  conferirSenha, emitirSenhaProvisoria, SESSAO_HORAS, CONVITE_DIAS,
} from './auth.js';
import { enviarConvite, emailConfigurado } from './email.js';
import {
  trocarLinha, linhaAtual, historicoLinha, linhaConfigurada, linhasValidas,
} from './linha.js';
// Mesma validação que a tela usa — um arquivo só, servido ao navegador e
// importado aqui. Validar só no front seria conselho, não garantia.
import { validarMensagem } from '../public/copy.js';
import { versao } from './versao.js';
import { query } from './db.js';

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

/** Inteiro de query string, ou null. Devolve `false` quando veio lixo. */
function inteiroOuNulo(raw) {
  if (raw === null || raw === '') return null;
  const v = Number.parseInt(raw, 10);
  return Number.isInteger(v) ? v : false;
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
    com_erro: 0, com_retry: 0, novos_24h: 0, prestes: 0,
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

  const [regua, rollup, onda, horaria, entradas, statuses, problemas, cadencia,
    canais, orfaos, linhas, piorSms, errosOrfaos] = await Promise.all([
    reguaDefinicao(linha), etapasRollup(), ondaPorEtapa(), ondaHoraria(doFiltro),
    entradasPorDia(doFiltro), statusBruto(), alertas(), cadenciaObservada(),
    porCanal(linha), semMensagem(linha), resumoLinhas(), piorCasoSms(), errosSemCanal(),
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
    filtros: { etapa: filtros.etapa ?? null, canal: filtros.canal ?? null },
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

async function rotasAuth(req, res, url, usuario) {
  const p = url.pathname;

  if (p === '/api/auth/login' && req.method === 'POST') {
    const ip = ipDe(req);
    if (ipBloqueado(ip)) {
      return json(res, 429, { erro: 'Muitas tentativas deste endereço. Aguarde alguns minutos.' });
    }
    const corpo = await lerJson(req);
    const r = await autenticar(corpo.email, corpo.senha ?? '');
    if (!r.ok) {
      marcarFalhaIp(ip);
      // Atraso fixo: o tempo de resposta não deve distinguir os motivos.
      await new Promise((ok) => setTimeout(ok, 260));
      return json(res, 401, { erro: r.erro });
    }
    const token = await criarSessao(r.usuario.id, { ip, agente: req.headers['user-agent'] });
    porCookieSessao(req, res, token, SESSAO_HORAS * 3600);
    return json(res, 200, { usuario: r.usuario });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    await encerrarSessao(lerCookie(req, COOKIE));
    limparCookieSessao(req, res);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/auth/eu') {
    if (!usuario) return json(res, 401, { erro: 'sem sessão' });
    return json(res, 200, { usuario });
  }

  // Trocar a própria senha. Exige a senha atual mesmo já estando logado: sem
  // isso, um computador deixado aberto vira sequestro de conta permanente.
  if (p === '/api/auth/senha' && req.method === 'POST') {
    if (!usuario) return json(res, 401, { erro: 'sem sessão' });
    const corpo = await lerJson(req);

    const { rows } = await query(
      'SELECT senha_hash, senha_salt, senha_params FROM painel_usuarios WHERE id = $1',
      [usuario.id],
    );
    if (!rows[0] || !(await conferirSenha(corpo.atual ?? '', rows[0]))) {
      await new Promise((ok) => setTimeout(ok, 260));
      return json(res, 400, { erro: 'Senha atual incorreta.' });
    }

    const problema = validarSenha(corpo.nova, { email: usuario.email });
    if (problema) return json(res, 400, { erro: problema });
    if (corpo.nova === corpo.atual) {
      return json(res, 400, { erro: 'A nova senha precisa ser diferente da atual.' });
    }

    await trocarSenha(usuario.id, corpo.nova);
    // Derruba as outras sessões e reabre esta: trocar a senha tem que expulsar
    // quem estivesse usando a conta com a senha antiga.
    await encerrarSessoesDe(usuario.id);
    const token = await criarSessao(usuario.id, { ip: ipDe(req), agente: req.headers['user-agent'] });
    porCookieSessao(req, res, token, SESSAO_HORAS * 3600);
    return json(res, 200, { ok: true });
  }

  return null;   // não é rota de acesso
}

async function rotasUsuarios(req, res, url, usuario) {
  if (!url.pathname.startsWith('/api/usuarios')) return null;
  if (!usuario.admin) return json(res, 403, { erro: 'Só administradores gerenciam usuários.' });

  if (url.pathname === '/api/usuarios' && req.method === 'GET') {
    return json(res, 200, {
      usuarios: await listarUsuarios(),
      eu: usuario.id,
      // A interface esconde a opção de enviar e-mail quando não há SMTP —
      // oferecer um botão que nunca funciona é pior que não oferecer.
      emailConfigurado,
      conviteDias: CONVITE_DIAS,
    });
  }

  if (url.pathname === '/api/usuarios' && req.method === 'POST') {
    const corpo = await lerJson(req);
    const email = normalizarEmail(corpo.email);
    if (!emailValido(email)) return json(res, 400, { erro: 'E-mail inválido.' });

    const problema = validarSenha(corpo.senha, { email });
    if (problema) return json(res, 400, { erro: problema });

    try {
      const novo = await criarUsuario({
        email, nome: String(corpo.nome ?? '').trim().slice(0, 120),
        senha: corpo.senha, admin: !!corpo.admin, criadoPor: usuario.id,
      });

      // O e-mail é acessório: a conta já existe e a senha aparece na tela de
      // quem criou. Uma falha de SMTP informa, mas não desfaz nada.
      let email_ = { enviado: false, motivo: 'não solicitado' };
      if (corpo.enviarEmail !== false) {
        email_ = await enviarConvite({
          para: email, senha: corpo.senha, admin: !!corpo.admin,
          quemConvidou: usuario.email, dias: CONVITE_DIAS, req,
        });
      }
      return json(res, 201, { usuario: novo, email: email_, conviteDias: CONVITE_DIAS });
    } catch (err) {
      if (err.code === '23505') return json(res, 409, { erro: 'Já existe um usuário com esse e-mail.' });
      throw err;
    }
  }

  const m = /^\/api\/usuarios\/(\d+)$/.exec(url.pathname);
  if (m && req.method === 'PATCH') {
    const alvo = Number(m[1]);
    const corpo = await lerJson(req);

    if ('admin' in corpo) {
      // Rebaixar a si mesmo tiraria o acesso à própria tela que você está
      // usando, sem confirmação e sem volta se não houver outro admin.
      if (alvo === usuario.id && corpo.admin === false) {
        return json(res, 400, { erro: 'Você não pode remover o seu próprio acesso de administrador.' });
      }
      if (corpo.admin === false && (await contarAdmins()) <= 1) {
        return json(res, 400, { erro: 'Precisa sobrar pelo menos um administrador ativo.' });
      }
      const r = await definirAdmin(alvo, corpo.admin);
      if (!r) return json(res, 404, { erro: 'Usuário não encontrado.' });
    }

    if ('ativo' in corpo) {
      if (alvo === usuario.id && corpo.ativo === false) {
        return json(res, 400, { erro: 'Você não pode desativar a própria conta.' });
      }
      if (corpo.ativo === false) {
        const { rows } = await query('SELECT admin FROM painel_usuarios WHERE id = $1', [alvo]);
        if (rows[0]?.admin && (await contarAdmins()) <= 1) {
          return json(res, 400, { erro: 'Precisa sobrar pelo menos um administrador ativo.' });
        }
      }
      const r = await definirAtivo(alvo, corpo.ativo);
      if (!r) return json(res, 404, { erro: 'Usuário não encontrado.' });
    }

    // Senha provisória nova, definida por um admin. Sempre com prazo e sempre
    // exigindo troca — ninguém deve seguir sabendo a senha de outro.
    let email_ = null;
    if (corpo.senha) {
      const { rows } = await query(
        'SELECT email, admin FROM painel_usuarios WHERE id = $1', [alvo],
      );
      if (!rows[0]) return json(res, 404, { erro: 'Usuário não encontrado.' });
      const problema = validarSenha(corpo.senha, { email: rows[0].email });
      if (problema) return json(res, 400, { erro: problema });

      await emitirSenhaProvisoria(alvo, corpo.senha);

      if (corpo.enviarEmail !== false) {
        email_ = await enviarConvite({
          para: rows[0].email, senha: corpo.senha, admin: rows[0].admin,
          quemConvidou: usuario.email, dias: CONVITE_DIAS, req,
        });
      }
    }

    return json(res, 200, {
      usuarios: await listarUsuarios(), eu: usuario.id,
      ...(email_ ? { email: email_, conviteDias: CONVITE_DIAS } : {}),
    });
  }

  return json(res, 404, { erro: 'rota não encontrada' });
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

    const token = lerCookie(req, COOKIE);
    const usuario = await usuarioDaSessao(token);

    // Nada além do login pode ser cacheado por proxy: o painel é por usuário.
    res.setHeader('Vary', 'Cookie');

    if (req.method !== 'GET' && !temCabecalhoDoPainel(req)) {
      return json(res, 403, { erro: 'requisição não reconhecida' });
    }

    const respostaAuth = await rotasAuth(req, res, url, usuario);
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

    // Já logado não tem o que fazer na tela de login.
    if (url.pathname === '/login' || url.pathname === '/login.html') {
      res.writeHead(302, { Location: '/' }).end();
      return ATENDIDO;
    }

    // Senha provisória: o painel fica fechado até ela ser trocada. Só as rotas
    // de acesso respondem — é o que a tela de troca precisa.
    if (usuario.trocar_senha && url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/api/auth/')) {
      return json(res, 403, { erro: 'troca de senha pendente', trocarSenha: true });
    }

    const respostaUsuarios = await rotasUsuarios(req, res, url, usuario);
    if (respostaUsuarios !== null) return respostaUsuarios;

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
        if (err.code === '23505') return json(res, 409, { erro: `A linha ${nova} já existe.` });
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
          // 23503 = violação de chave estrangeira. Acontece quando a linha não
          // foi registrada em painel_linhas_copy — a ordem que o contrato exige.
          if (err.code === '23503') {
            return json(res, 400, {
              erro: `A linha ${linhaM} não está registrada em painel_linhas_copy. `
                + 'Cadastre a linha antes de salvar mensagens nela.',
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

      return json(res, 200, await snapshot({ etapa, canal, linha }));
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
      }));
    }

    if (url.pathname === '/api/health') {
      const inicio = Date.now();
      await pool.query('SELECT 1');
      return json(res, 200, { ok: true, latenciaMs: Date.now() - inicio });
    }

    if (req.method !== 'GET') {
      return json(res, 405, { erro: 'método não permitido' });
    }

    return await servirEstatico(req, res, url.pathname);
  } catch (err) {
    console.error(`[api] ${url.pathname}:`, err.message);
    // A mensagem crua do Postgres pode carregar nome de coluna e trecho de
    // consulta. Isso ajuda no diagnóstico local e ajuda um atacante em
    // produção, então só sai quando você pedir.
    const detalhe = process.env.ERROS_DETALHADOS === 'true' ? err.message : undefined;
    return json(res, 500, { erro: 'falha ao processar a requisição', detalhe });
  }
});

/* Sessões vencidas não são apagadas na hora — a linha só deixa de casar no
   SELECT. Sem uma varrida periódica a tabela cresce para sempre. */
limparSessoesVencidas().catch(() => {});
const faxina = setInterval(() => limparSessoesVencidas().catch(() => {}), 60 * 60 * 1000);
faxina.unref();

servidor.listen(PORT, HOST, () => {
  console.log(`\n  ◗ SendTrace · régua de pós-venda`);
  console.log(`    http://${HOST}:${PORT}`);
  console.log(`    travado = 'processando' há mais de ${LOCK_TIMEOUT_MIN} min`);
  console.log(`    acesso protegido · sessão de ${SESSAO_HORAS} h`);
  console.log(`    convite por e-mail: ${emailConfigurado ? 'ligado' : 'desligado (sem SMTP no .env)'}\n`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    servidor.close(() => pool.end().then(() => process.exit(0)));
  });
}
