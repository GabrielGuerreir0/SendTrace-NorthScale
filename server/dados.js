/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Este arquivo substitui o antigo `queries.js`. As funções são as      │
 * │  MESMAS, com os mesmos nomes e o mesmo formato de retorno — o que     │
 * │  mudou é de onde vêm os dados: antes SQL, agora as rotas da API.      │
 * │  Por isso nada em `public/` precisou mudar.                           │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * A API é CRUD puro: não existe rota que agrupe, conte ou tire mediana. Todo
 * número que o painel mostra — contagem por etapa e estado, onda de 48 h,
 * entradas por dia, alcance por canal, catálogo de produtos — é calculado AQUI,
 * em JavaScript, sobre a fila baixada. As regras são as mesmas que estavam no
 * SQL; a tradução foi literal de propósito, para os números não mudarem de
 * significado ao mudar de lugar.
 *
 * O custo dessa escolha é explícito: medir a fila exige baixá-la. Enquanto ela
 * couber no teto (`API_FILA_MAX`), tudo bem; passando disso, `truncado` acende
 * e o painel avisa na tela em vez de exibir um total que não é total.
 */

import {
  obter, criar, substituir, remendar, apagar, listarTudo, ErroApi, FILA_MAX,
} from './api.js';
import { LOCK_TIMEOUT_MIN } from './config.js';

/* ═══════════════════════════  a fila, uma vez  ══════════════════════════ */

/**
 * Um snapshot faz ~8 perguntas sobre a MESMA fila. Sem esta janela curta, cada
 * uma baixaria a fila inteira de novo — oito varreduras completas a cada 10
 * segundos, para responder o que uma varredura já responde.
 *
 * O cache é do PROCESSO, não da pessoa: quem chegar primeiro busca, e os
 * demais aproveitam por alguns segundos. Vale porque o painel mostra a mesma
 * régua para todo mundo — a API não recorta a fila por usuário. Se um dia
 * recortar, este cache precisa passar a ser por credencial, senão alguém veria
 * a fatia de outro.
 */
const JANELA_MS = Number(process.env.API_CACHE_MS) || 4000;
let cache = { em: 0, valor: null, promessa: null };

export async function fila() {
  const agora = Date.now();
  if (cache.valor && agora - cache.em < JANELA_MS) return cache.valor;
  if (cache.promessa) return cache.promessa;

  cache.promessa = listarTudo('/api/disparos/')
    .then((r) => {
      cache = { em: Date.now(), valor: r, promessa: null };
      return r;
    })
    .catch((err) => {
      cache.promessa = null;
      throw err;
    });
  return cache.promessa;
}

/** Descarta o cache — usado depois de uma escrita que muda o que a tela mostra. */
export const esquecerFila = () => { cache = { em: 0, valor: null, promessa: null }; };

/** O que o painel precisa saber sobre a origem dos números. */
export async function fonteDados() {
  const { itens, total, truncado } = await fila();
  return { lidos: itens.length, total, truncado, teto: FILA_MAX };
}

/* ══════════════════════════  regras de negócio  ═════════════════════════ */

/**
 * Status que significam CANCELAMENTO.
 *
 * Antes de existirem por escrito, eles caíam no "qualquer outro status" e
 * viravam finalizados — o painel afirmava que a régua terminou bem justamente
 * para quem desistiu no meio.
 */
const CANCELADOS = new Set(['cancelado', 'cancelada', 'cancelled', 'canceled']);

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const preenchido = (v) => v !== null && v !== undefined && v !== '';

/**
 * O estado de um pedido — a mesma árvore de decisão que era o `ESTADO_SQL`.
 * Mutuamente exclusivos, e por isso somam exatamente o total.
 *
 * 'travado' inclui `processando` com `claimed_at` nulo: é anomalia (o worker
 * marcou sem registrar o lock) e some se for ignorada.
 *
 * Uma diferença deliberada em relação ao SQL antigo: o status é comparado em
 * minúsculas e sem espaços. No banco, um 'Ativo' com maiúscula caía calado em
 * "finalizado" — um pedido vivo contado como encerrado. Aqui ele é o que é.
 */
export function estadoDe(d, agora = Date.now(), lockMin = LOCK_TIMEOUT_MIN) {
  const status = String(d.status ?? '').trim().toLowerCase();
  if (status === 'ativo') {
    const p = ms(d.proximo_disparo);
    return Number.isFinite(p) && p <= agora ? 'atrasado' : 'em_dia';
  }
  if (status === 'processando') {
    const c = ms(d.claimed_at);
    return !Number.isFinite(c) || c < agora - lockMin * 60_000 ? 'travado' : 'processando';
  }
  if (CANCELADOS.has(status)) return 'cancelado';
  return 'finalizado';
}

const VIVOS = new Set(['ativo', 'processando']);
const estaVivo = (d) => VIVOS.has(String(d.status ?? '').trim().toLowerCase());

/**
 * O NOME do produto, sem o código da oferta e sem a embalagem.
 *
 * Tradução literal da expressão que rodava no Postgres. A fila guarda a oferta
 * inteira — "M3 - NeuroMind Pro (6 Bottles)", "UP1 - NeuroMind Pro (6 Bottles)"
 * — e o mesmo produto aparece sob vários códigos e tamanhos. Sem juntá-los, o
 * painel só responderia "como está a oferta M3", com o resto do produto fora da
 * conta.
 *
 * O corte do código é conservador de propósito: só cai com traço (exigindo
 * dígito, senão "Flex-ImmuneGuard" viraria "ImmuneGuard") ou com duas
 * MAIÚSCULAS mais dígito sem traço ("UP2a"). É o que salva "B12 Complex",
 * "D3 Drops" e "CoQ10 Ultra" — cortá-los somaria "B12 Complex" com "D3 Complex"
 * num "Complex" só, dois produtos escondidos atrás de um número que não é de
 * nenhum. O que a regra não reconhece fica inteiro e vira opção própria: erra
 * visível, nunca em silêncio.
 */
export function nomeProduto(bruto) {
  const cru = String(bruto ?? '').trim();
  if (!cru) return '';
  const nome = cru
    .replace(/^\s*(?:[A-Za-z]{1,4}\d+[A-Za-z]?\s*[-:]\s*|[A-Z]{2,4}\d+[a-z]?\s+)/, '')
    .replace(/\s*\([^()]*\)\s*/g, ' ')
    .replace(/\s*\$\s*[\d.,]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return nome || cru;
}

/** Recorte por produto: compara o NOME, para as ofertas caírem no mesmo número. */
const doProduto = (d, produto) => !produto || nomeProduto(d.produto) === produto;

/**
 * A qual canal o erro pertence, deduzido do prefixo de `ultimo_erro`.
 *
 * A fila guarda o erro numa coluna de texto só, sem canal — mas o worker
 * escreve o canal na frente ("sms: sem telefone valido"). Sem ler o prefixo,
 * uma falha de SMS apareceria como erro TAMBÉM no e-mail e alguém investigaria
 * um problema que não existe. Sem prefixo devolve null, e esses casos são
 * contados à parte em vez de chutados para os dois lados.
 */
export function canalDoErro(d) {
  const t = d.ultimo_erro;
  if (!t) return null;
  if (/^\s*sms\b/i.test(t)) return 'sms';
  if (/^\s*e-?mail\b/i.test(t)) return 'email';
  return null;
}

const temContato = (d, canal) => {
  if (canal === 'email') return preenchido(d.email);
  if (canal === 'sms') return preenchido(d.telefone);
  // Sem canal escolhido, "tem contato" = tem os dois.
  return preenchido(d.email) && preenchido(d.telefone);
};

/* ═══════════════════════════  régua e copy  ═════════════════════════════ */

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const etapasCache = () => listarTudo('/api/etapas/');

/** As mensagens de uma linha (ou de todas, se `linha` vier nulo). */
async function mensagensDe(linha = null) {
  const { itens } = await listarTudo('/api/mensagens/', linha ? { linha: String(linha) } : {});
  return itens;
}

/**
 * A régua completa: cadência (etapas) + copy por canal (mensagens).
 *
 * Cada etapa dispara e-mail e SMS ao mesmo tempo, então `mensagens` vem como
 * lista — não existe "o canal da etapa". Sem nenhuma etapa cadastrada devolve
 * null, e o painel avisa na tela em vez de desenhar uma régua vazia como se
 * fosse a verdade.
 */
export async function reguaDefinicao(linha = '1') {
  const [etapas, msgs] = await Promise.all([etapasCache(), mensagensDe(linha)]);
  if (!etapas.itens.length) return null;

  const porEtapa = new Map();
  for (const m of msgs) {
    if (!porEtapa.has(m.etapa)) porEtapa.set(m.etapa, []);
    porEtapa.get(m.etapa).push({
      canal: m.canal,
      assunto: m.assunto,
      texto: m.texto,
      botao: m.botao,
      destino: m.destino,
      ativo: m.ativo,
      linha: m.linha,
      corpo_html: m.corpo_html,
    });
  }

  return etapas.itens
    .map((e) => ({
      etapa: Number(e.etapa),
      nome: e.nome,
      descricao: e.descricao,
      ativo: e.ativo,
      espera_h: num(e.espera_h),
      offset_h: num(e.offset_h),
      mensagens: (porEtapa.get(Number(e.etapa)) ?? [])
        .sort((a, b) => String(a.canal).localeCompare(String(b.canal))),
    }))
    .sort((a, b) => a.etapa - b.etapa);
}

/** As etapas ativas da régua — o que uma linha precisa cobrir para ser ativável. */
export async function etapasDaRegua() {
  const { itens } = await etapasCache();
  return itens
    .map((e) => ({
      etapa: Number(e.etapa), nome: e.nome, offset_h: num(e.offset_h), ativo: e.ativo,
    }))
    .sort((a, b) => a.etapa - b.etapa);
}

/**
 * Nome, propósito e volume de copy de cada linha — alimenta o seletor.
 *
 * `prontos` repete a MESMA regra do webhook para decidir se a linha pode ser
 * ativada: um e-mail só conta com assunto E corpo; um SMS, com texto. Repeti-la
 * aqui é o que permite avisar "faltam 2 e-mails" antes de você clicar e levar
 * um 400 do n8n.
 */
export async function resumoLinhas() {
  const [linhas, msgs, etapas] = await Promise.all([
    listarTudo('/api/linhas-copy/'), mensagensDe(null), etapasCache(),
  ]);

  const exigidas = etapas.itens.filter((e) => e.ativo !== false).length;
  const ativas = msgs.filter((m) => m.ativo !== false);

  const contar = (linha) => {
    const minhas = ativas.filter((m) => String(m.linha) === String(linha));
    return {
      mensagens: minhas.length,
      etapas: new Set(minhas.map((m) => m.etapa)).size,
      emails_prontos: minhas.filter((m) => m.canal === 'email'
        && preenchido(m.assunto) && preenchido(m.corpo_html)).length,
      sms_prontos: minhas.filter((m) => m.canal === 'sms' && preenchido(m.texto)).length,
    };
  };

  // Sem cadastro de linhas, o painel ainda funciona: descobre quais existem
  // pelas próprias mensagens, como fazia o SQL de reserva.
  const base = linhas.itens.length
    ? linhas.itens.map((l) => ({
      linha: String(l.linha), nome: l.nome, intuito: l.intuito, ordem: l.ordem,
    }))
    : [...new Set(ativas.map((m) => String(m.linha)))]
      .sort()
      .map((linha) => ({ linha, nome: null, intuito: null, ordem: Number(linha) || 0 }));

  const saida = {};
  for (const l of base.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)
    || (Number(a.linha) || 0) - (Number(b.linha) || 0))) {
    const c = contar(l.linha);
    saida[l.linha] = {
      ...l,
      ...c,
      etapas_exigidas: exigidas,
      completa: c.emails_prontos >= exigidas && c.sms_prontos >= exigidas,
    };
  }
  return saida;
}

/* ── edição de copy ── */

/** A PK das mensagens na API é composta: `etapa:canal:linha`. */
const chaveMensagem = (linha, etapa, canal) => `${etapa}:${canal}:${linha}`;

/** Uma mensagem específica, com tudo que o editor precisa. */
export async function mensagem(linha, etapa, canal) {
  let m;
  try {
    m = await obter(`/api/mensagens/${chaveMensagem(linha, etapa, canal)}/`);
  } catch (err) {
    if (err instanceof ErroApi && err.status === 404) return null;
    throw err;
  }
  const { itens } = await etapasCache();
  const e = itens.find((x) => Number(x.etapa) === Number(etapa));
  return {
    etapa: Number(m.etapa),
    canal: m.canal,
    linha: String(m.linha),
    assunto: m.assunto,
    corpo_html: m.corpo_html,
    botao: m.botao,
    destino: m.destino,
    texto: m.texto,
    ativo: m.ativo,
    atualizado_em: m.atualizado_em,
    nome_etapa: e?.nome ?? null,
    offset_h: num(e?.offset_h),
  };
}

/**
 * Grava uma mensagem. A API não tem upsert, então: PUT e, se a mensagem ainda
 * não existir, POST. É o mesmo caminho para criar e para editar que o contrato
 * do robô define.
 */
export async function salvarMensagem({
  linha, etapa, canal, assunto, corpo_html: corpo, botao, destino, texto, ativo,
}) {
  const eEmail = canal === 'email';
  const corpoReq = {
    etapa: Number(etapa),
    canal,
    linha: String(linha),
    // No SMS estes campos não existem: gravar string vazia deixaria lixo que
    // depois conta como "preenchido" em qualquer verificação.
    assunto: eEmail ? (assunto ?? null) : null,
    corpo_html: eEmail ? (corpo ?? null) : null,
    botao: eEmail ? (botao ?? null) : null,
    destino: eEmail ? (destino ?? null) : null,
    texto: texto ?? '',
    ativo: ativo !== false,
  };

  let salva;
  try {
    salva = await substituir(`/api/mensagens/${chaveMensagem(linha, etapa, canal)}/`, corpoReq);
  } catch (err) {
    if (err instanceof ErroApi && err.status === 404) salva = await criar('/api/mensagens/', corpoReq);
    else throw err;
  }
  return { ...salva, etapa: Number(salva.etapa), linha: String(salva.linha) };
}

/* ── linhas de copy ── */

/**
 * Registra uma linha nova e, opcionalmente, copia a copy de outra.
 *
 * Copiar é o caminho normal: uma linha em branco são doze mensagens para
 * escrever do zero antes de poder ativar.
 *
 * O SQL fazia isso numa transação. A API não oferece uma, então há compensação
 * explícita: se a cópia falhar no meio, o que já entrou é desfeito e a linha
 * criada é apagada. Uma linha registrada com metade das mensagens seria pior
 * que nenhuma linha — ela apareceria como ativável e falharia no disparo.
 */
export async function criarLinha({ linha, nome, intuito, ordem, copiarDe }) {
  const alvo = String(linha);
  await criar('/api/linhas-copy/', {
    linha: alvo, nome, intuito: intuito || null, ordem,
  });

  let copiadas = 0;
  const feitas = [];
  try {
    if (copiarDe) {
      const origem = await mensagensDe(copiarDe);
      for (const m of origem) {
        await criar('/api/mensagens/', {
          etapa: m.etapa, canal: m.canal, linha: alvo,
          assunto: m.assunto, corpo_html: m.corpo_html, botao: m.botao,
          destino: m.destino, texto: m.texto, ativo: m.ativo,
        });
        feitas.push(chaveMensagem(alvo, m.etapa, m.canal));
        copiadas += 1;
      }
    }
  } catch (err) {
    for (const pk of feitas) {
      await apagar(`/api/mensagens/${pk}/`).catch(() => {});
    }
    await apagar(`/api/linhas-copy/${alvo}/`).catch(() => {});
    throw err;
  }

  return { linha: alvo, copiadas };
}

/**
 * Edita nome, intuito e ordem. NÃO mexe no número: ele é a chave que o webhook
 * usa e que as mensagens referenciam.
 */
export async function editarLinha(linha, { nome, intuito, ordem }) {
  const mudanca = {};
  if (nome !== undefined) mudanca.nome = nome;
  if (intuito !== undefined) mudanca.intuito = intuito;
  if (Number.isInteger(ordem)) mudanca.ordem = ordem;

  try {
    const r = await remendar(`/api/linhas-copy/${linha}/`, mudanca);
    return {
      linha: String(r.linha), nome: r.nome, intuito: r.intuito, ordem: r.ordem,
    };
  } catch (err) {
    if (err instanceof ErroApi && err.status === 404) return null;
    throw err;
  }
}

/**
 * Apaga uma linha e as mensagens dela.
 *
 * Recusa a linha ATIVA: apagá-la deixaria o robô lendo uma copy que não existe
 * mais, e o próximo disparo sairia vazio. A verificação é feita contra o que a
 * API diz estar no ar, não contra o que a tela achava quando carregou.
 */
export async function apagarLinha(linha) {
  const alvo = String(linha);
  const noAr = await linhaAtivaBruta();
  if (noAr === alvo) {
    return { ok: false, erro: 'Esta é a linha que está no ar. Ative outra antes de apagá-la.' };
  }

  const minhas = await mensagensDe(alvo);
  for (const m of minhas) {
    await apagar(`/api/mensagens/${chaveMensagem(alvo, m.etapa, m.canal)}/`).catch(() => {});
  }

  try {
    await apagar(`/api/linhas-copy/${alvo}/`);
  } catch (err) {
    if (err instanceof ErroApi && err.status === 404) return { ok: false, erro: 'Linha não encontrada.' };
    throw err;
  }
  return { ok: true };
}

/** Qual linha o robô está usando, direto de config_disparos via API. */
export async function linhaAtivaBruta() {
  try {
    const c = await obter('/api/config/linha_ativa/');
    return c?.valor ? String(c.valor) : null;
  } catch (err) {
    if (err instanceof ErroApi && err.status === 404) return null;
    throw err;
  }
}

/* ═════════════════════════════  agregações  ═════════════════════════════ */

/**
 * Consolidado por etapa — é o que alimenta os nós do canvas.
 *
 * Uma passada só pela fila: com 15 contadores por etapa, percorrer a lista uma
 * vez por métrica seria quinze varreduras para responder o que uma responde.
 */
export async function etapasRollup(produto = null) {
  const { itens } = await fila();
  const agora = Date.now();
  const porEtapa = new Map();

  const vazio = () => ({
    total: 0, em_dia: 0, atrasado: 0, processando: 0, travado: 0, finalizado: 0,
    cancelado: 0, com_erro: 0, com_retry: 0, novos_24h: 0, prestes: 0,
    proximo_em: null, max_tentativas: 0,
  });

  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    const etapa = Number(d.etapa_atual);
    if (!porEtapa.has(etapa)) porEtapa.set(etapa, { etapa, ...vazio() });
    const r = porEtapa.get(etapa);

    r.total += 1;
    r[estadoDe(d, agora)] += 1;
    if (d.ultimo_erro) r.com_erro += 1;
    if ((d.tentativas ?? 0) > 0) r.com_retry += 1;
    if (ms(d.criado_em) >= agora - 86_400_000) r.novos_24h += 1;

    const ativo = String(d.status ?? '').trim().toLowerCase() === 'ativo';
    const p = ms(d.proximo_disparo);
    // O piso "> agora" é essencial: sem ele todo vencido entraria em `prestes`,
    // e com o worker parado o painel diria "N disparam na próxima hora" ao lado
    // de "N atrasados, horário já passou" — os mesmos N, duas afirmações
    // incompatíveis, com a conexão do canvas animando tráfego num cano parado.
    if (ativo && Number.isFinite(p) && p > agora && p <= agora + 3_600_000) r.prestes += 1;
    if (ativo && Number.isFinite(p) && (r.proximo_em === null || p < ms(r.proximo_em))) {
      r.proximo_em = new Date(p).toISOString();
    }
    r.max_tentativas = Math.max(r.max_tentativas, d.tentativas ?? 0);
  }

  return [...porEtapa.values()].sort((a, b) => a.etapa - b.etapa);
}

/**
 * Micro-histograma por etapa: doze baldes de 4 h ao longo das próximas 48 h.
 *
 * Deliberadamente NÃO usa `criado_em`: ele diz quando o pedido entrou na fila
 * (etapa 0), não quando entrou na etapa atual — a fila não guarda histórico de
 * transições, então "entradas por etapa" seria mentira.
 */
export async function ondaPorEtapa(produto = null) {
  const { itens } = await fila();
  const agora = Date.now();
  const saida = [];
  const mapa = new Map();

  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    if (String(d.status ?? '').trim().toLowerCase() !== 'ativo') continue;
    const p = ms(d.proximo_disparo);
    if (!Number.isFinite(p) || p <= agora || p > agora + 48 * 3_600_000) continue;

    const balde = Math.floor(((p - agora) / 3_600_000) / 4) + 1;
    if (balde < 1 || balde > 12) continue;
    const chave = `${d.etapa_atual}|${balde}`;
    mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
  }

  for (const [chave, total] of mapa) {
    const [etapa, balde] = chave.split('|').map(Number);
    saida.push({ etapa, balde, total });
  }
  return saida.sort((a, b) => a.etapa - b.etapa || a.balde - b.balde);
}

/**
 * "Esta etapa envia neste canal" — sem olhar se o pedido tem contato.
 *
 * Separado de "alcança" porque as duas condições se combinam de formas opostas:
 * quem o canal alcança é `envia E tem contato`; quem ele perde é `envia E NÃO
 * tem contato`.
 */
const enviaNoCanal = (msgs, etapa, canal) => msgs.some(
  (m) => Number(m.etapa) === Number(etapa) && m.canal === canal && m.ativo !== false,
);
const recebeNoCanal = (msgs, d, canal) => enviaNoCanal(msgs, d.etapa_atual, canal)
  && temContato(d, canal);

/** Onda global de disparos, hora a hora, nas próximas 48 h. */
export async function ondaHoraria({
  etapa = null, canal = null, linha = '1', produto = null,
} = {}) {
  const [{ itens }, msgs] = await Promise.all([fila(), canal ? mensagensDe(linha) : []]);
  const agora = Date.now();
  const inicio = new Date(agora);
  inicio.setUTCMinutes(0, 0, 0);

  const baldes = new Map();
  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    if (String(d.status ?? '').trim().toLowerCase() !== 'ativo') continue;
    if (etapa !== null && Number(d.etapa_atual) !== Number(etapa)) continue;
    if (canal && !recebeNoCanal(msgs, d, canal)) continue;

    const p = ms(d.proximo_disparo);
    if (!Number.isFinite(p) || p < inicio.getTime() || p >= agora + 48 * 3_600_000) continue;

    const hora = new Date(p);
    hora.setUTCMinutes(0, 0, 0);
    const chave = hora.toISOString();
    baldes.set(chave, (baldes.get(chave) ?? 0) + 1);
  }

  return [...baldes.entries()]
    .map(([hora, total]) => ({ hora, total }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

/**
 * Entradas na régua por dia (últimos 14 dias).
 *
 * O corte do dia é feito no fuso do painel, não no do servidor: sem isso, tudo
 * que entrasse entre 21 h e meia-noite no Brasil cairia no dia seguinte. A
 * chave sai como 'YYYY-MM-DD' em texto, para o navegador não reinterpretar a
 * data e deslocá-la de novo.
 */
export async function entradasPorDia({
  etapa = null, canal = null, linha = '1', produto = null,
} = {}) {
  const tz = process.env.TZ_PAINEL || 'America/Sao_Paulo';
  const [{ itens }, msgs] = await Promise.all([fila(), canal ? mensagensDe(linha) : []]);

  // 'en-CA' formata exatamente como YYYY-MM-DD — o mesmo que o to_char fazia.
  const diaDe = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const agora = Date.now();
  const janela = new Set();
  for (let i = 13; i >= 0; i -= 1) janela.add(diaDe.format(new Date(agora - i * 86_400_000)));

  const contas = new Map();
  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    if (etapa !== null && Number(d.etapa_atual) !== Number(etapa)) continue;
    if (canal && !recebeNoCanal(msgs, d, canal)) continue;

    const t = ms(d.criado_em);
    if (!Number.isFinite(t)) continue;
    const chave = diaDe.format(new Date(t));
    if (!janela.has(chave)) continue;
    contas.set(chave, (contas.get(chave) ?? 0) + 1);
  }

  return [...contas.entries()]
    .map(([dia, total]) => ({ dia, total }))
    .sort((a, b) => a.dia.localeCompare(b.dia));
}

/**
 * Cadência OBSERVADA: mediana de (proximo_disparo − criado_em) por etapa, em
 * horas. Comparada com a soma dos `espera_h` configurados, revela deriva entre
 * a régua escrita e a régua que está rodando.
 *
 * Só linhas 'ativo' entram: nas demais o `proximo_disparo` é resíduo do último
 * agendamento.
 */
export async function cadenciaObservada(produto = null) {
  const { itens } = await fila();
  const porEtapa = new Map();

  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    if (String(d.status ?? '').trim().toLowerCase() !== 'ativo') continue;
    const a = ms(d.criado_em);
    const b = ms(d.proximo_disparo);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const etapa = Number(d.etapa_atual);
    if (!porEtapa.has(etapa)) porEtapa.set(etapa, []);
    porEtapa.get(etapa).push((b - a) / 3_600_000);
  }

  return [...porEtapa.entries()]
    .map(([etapa, horas]) => {
      horas.sort((x, y) => x - y);
      const meio = Math.floor(horas.length / 2);
      // Interpolação linear no meio, como o percentile_cont(0.5) fazia: com
      // amostra par, a mediana é a média dos dois valores centrais.
      const mediana = horas.length % 2 ? horas[meio] : (horas[meio - 1] + horas[meio]) / 2;
      return { etapa, amostra: horas.length, mediana_h: mediana };
    })
    .sort((a, b) => a.etapa - b.etapa);
}

/**
 * ALCANCE por canal. Como toda etapa dispara e-mail e SMS ao mesmo tempo, a
 * pergunta não é "qual o canal desta etapa" e sim: no próximo disparo, quantos
 * este canal de fato alcança?
 *
 * Duas perdas diferentes, contadas separadamente porque se resolvem de formas
 * diferentes: `sem_contato` é falta de dado do comprador; `sem_mensagem` é
 * falta de cadastro na régua.
 */
export async function porCanal(linha = '1', produto = null) {
  const [{ itens }, msgs] = await Promise.all([fila(), mensagensDe(linha)]);
  if (!msgs.length) return [];
  const agora = Date.now();

  const linhas = ['email', 'sms'].map((canal) => {
    const r = {
      canal, total: 0, alcancavel: 0, sem_contato: 0,
      em_dia: 0, atrasado: 0, processando: 0, travado: 0, com_erro: 0,
    };
    for (const d of itens) {
      if (!estaVivo(d) || !doProduto(d, produto)) continue;
      if (!enviaNoCanal(msgs, d.etapa_atual, canal)) continue;

      r.total += 1;
      if (temContato(d, canal)) r.alcancavel += 1;
      else r.sem_contato += 1;

      const e = estadoDe(d, agora);
      if (e in r) r[e] += 1;
      // Só os erros DESTE canal: uma falha de SMS não é problema do e-mail, e
      // contá-la nos dois mandaria alguém caçar um defeito que nunca existiu.
      if (canalDoErro(d) === canal) r.com_erro += 1;
    }
    return r;
  });

  // Canal sem ninguém não vira linha do card — é o que o GROUP BY fazia. Com os
  // dois vazios o card fica vazio e a tela diz que não há o que medir, em vez
  // de exibir dois zeros como se fossem medição.
  return linhas
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total || a.canal.localeCompare(b.canal));
}

/**
 * Quantos estão numa etapa sem NENHUMA mensagem ativa cadastrada. Somem do
 * recorte por canal, então precisam aparecer em algum lugar.
 */
export async function semMensagem(linha = '1', produto = null) {
  const [{ itens }, msgs] = await Promise.all([fila(), mensagensDe(linha)]);
  if (!msgs.length) return 0;

  const comCopy = new Set(msgs.filter((m) => m.ativo !== false).map((m) => Number(m.etapa)));
  return itens.filter((d) => estaVivo(d) && doProduto(d, produto)
    && !comCopy.has(Number(d.etapa_atual))).length;
}

/**
 * Erros cujo texto não diz a qual canal pertencem.
 *
 * Somem do recorte por canal, então a soma dos dois canais ficaria menor que o
 * total de erros e ninguém entenderia por quê.
 */
export async function errosSemCanal(produto = null) {
  const { itens } = await fila();
  return itens.filter((d) => estaVivo(d) && doProduto(d, produto)
    && d.ultimo_erro && canalDoErro(d) === null).length;
}

/**
 * O nome e o produto MAIS LONGOS da fila — o pior caso real do SMS.
 *
 * Medir por uma amostra confortável faria o painel dizer "1 segmento" para uma
 * mensagem que, no cliente real, sai em dois e custa o dobro. Aqui o produto
 * vai CRU, com código e embalagem: é o texto que de fato entra no lugar do
 * marcador quando a mensagem sai.
 */
export async function piorCasoSms(produto = null) {
  const { itens } = await fila();
  let nome = null;
  let prod = null;

  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    const primeiro = String(d.nome ?? '').trim().split(' ')[0];
    if (primeiro && (nome === null || primeiro.length > nome.length)) nome = primeiro;
    const p = String(d.produto ?? '').trim();
    if (p && (prod === null || p.length > prod.length)) prod = d.produto;
  }
  return { nome, produto: prod };
}

/** Distribuição bruta de status — descobre valores que não conhecemos de antemão. */
export async function statusBruto(produto = null) {
  const { itens } = await fila();
  const contas = new Map();
  for (const d of itens) {
    if (!doProduto(d, produto)) continue;
    const s = d.status ?? '';
    contas.set(s, (contas.get(s) ?? 0) + 1);
  }
  return [...contas.entries()]
    .map(([status, total]) => ({ status, total }))
    .sort((a, b) => b.total - a.total || String(a.status).localeCompare(String(b.status)));
}

/** Fila de problemas: erros registrados e itens presos no worker. */
export async function alertas(produto = null) {
  const { itens } = await fila();
  const agora = Date.now();
  const corte = agora - LOCK_TIMEOUT_MIN * 60_000;

  const escolhidos = itens.filter((d) => {
    if (!doProduto(d, produto)) return false;
    const status = String(d.status ?? '').trim().toLowerCase();
    const p = ms(d.proximo_disparo);
    const c = ms(d.claimed_at);
    return Boolean(d.ultimo_erro)
      || (status === 'processando' && (!Number.isFinite(c) || c < corte))
      || (status === 'ativo' && Number.isFinite(p) && p <= agora - 3_600_000);
  });

  return escolhidos
    .sort((a, b) => (b.tentativas ?? 0) - (a.tentativas ?? 0)
      || ordemData(a.proximo_disparo, b.proximo_disparo))
    .slice(0, 25)
    .map((d) => ({
      id: d.id,
      transacao_id: d.transacao_id,
      nome: d.nome,
      produto: d.produto,
      etapa: Number(d.etapa_atual),
      status: d.status,
      tentativas: d.tentativas ?? 0,
      ultimo_erro: d.ultimo_erro,
      proximo_disparo: d.proximo_disparo,
      claimed_at: d.claimed_at,
      criado_em: d.criado_em,
      estado: estadoDe(d, agora),
      canal_erro: canalDoErro(d),
    }));
}

/** ASC com nulos por último — o mesmo que o Postgres faz por padrão. */
function ordemData(a, b) {
  const x = ms(a);
  const y = ms(b);
  if (!Number.isFinite(x) && !Number.isFinite(y)) return 0;
  if (!Number.isFinite(x)) return 1;
  if (!Number.isFinite(y)) return -1;
  return x - y;
}

/**
 * O catálogo de produtos da fila, agrupado pelo NOME e com o total de cada um.
 *
 * Deliberadamente NÃO respeita o filtro de produto: é a lista de onde se
 * escolhe, e filtrá-la deixaria só a opção já escolhida, sem como trocar.
 */
export async function produtosDaFila() {
  const { itens } = await fila();
  const contas = new Map();
  for (const d of itens) {
    const nome = nomeProduto(d.produto);
    if (!nome) continue;
    contas.set(nome, (contas.get(nome) ?? 0) + 1);
  }
  return [...contas.entries()]
    .map(([nome, total]) => ({ produto: nome, total }))
    .sort((a, b) => b.total - a.total || a.produto.localeCompare(b.produto))
    .slice(0, 300);
}

/**
 * Drill-down paginado com filtros.
 *
 * `estado` aceita os seis estados e mais o pseudo-estado 'na_regua' = tudo que
 * ainda circula. Ele existe porque o número que o nó exibe é `na_etapa`;
 * filtrar só por etapa traria junto os finalizados e os cancelados que pararam
 * ali, e a tabela contradiria o número que acabou de ser clicado.
 */
export async function listarPedidos({
  etapa, estado, canal, problema, busca, limit, offset, ordem, linha = '1',
  produto = null,
}) {
  const [{ itens }, msgs] = await Promise.all([fila(), canal ? mensagensDe(linha) : []]);
  const agora = Date.now();
  const alvo = busca ? String(busca).toLowerCase() : null;

  const filtrados = itens.filter((d) => {
    if (!doProduto(d, produto)) return false;
    if (etapa !== null && etapa !== undefined && Number(d.etapa_atual) !== Number(etapa)) return false;

    const e = estadoDe(d, agora);
    if (estado) {
      if (estado === 'na_regua') {
        if (e === 'finalizado' || e === 'cancelado') return false;
      } else if (e !== estado) return false;
    }

    if (alvo) {
      const casa = [d.transacao_id, d.nome, d.email, d.telefone, d.produto]
        .some((c) => c && String(c).toLowerCase().includes(alvo));
      if (!casa) return false;
    }

    // O canal significa "a etapa ENVIA neste canal", sem exigir contato — a
    // MESMA definição que o card de alcance usa para contar. Com a definição
    // de "alcança", clicar em "1 com erro" no card do SMS devolvia 0 quando o
    // pedido com erro não tinha telefone: o card prometia um número e a tabela
    // entregava outro.
    if (canal && !enviaNoCanal(msgs, d.etapa_atual, canal)) return false;

    if (problema === 'com_erro') {
      if (!d.ultimo_erro) return false;
      // Com um canal escolhido, só os erros DAQUELE canal — a mesma regra do
      // card, senão o número clicado e a lista divergem.
      if (canal && canalDoErro(d) !== canal) return false;
    }
    if (problema === 'com_contato' && !temContato(d, canal ?? null)) return false;
    if (problema === 'sem_contato' && temContato(d, canal ?? null)) return false;

    return true;
  });

  const ORDENS = {
    proximo: (a, b) => ordemData(a.proximo_disparo, b.proximo_disparo),
    recente: (a, b) => ordemData(b.criado_em, a.criado_em),
    tentativas: (a, b) => (b.tentativas ?? 0) - (a.tentativas ?? 0)
      || ordemData(a.proximo_disparo, b.proximo_disparo),
  };
  filtrados.sort(ORDENS[ordem] ?? ORDENS.proximo);

  const inicio = Number.isFinite(offset) ? offset : 0;
  const fatia = Number.isFinite(limit) ? limit : filtrados.length;

  return {
    pedidos: filtrados.slice(inicio, inicio + fatia).map((d) => ({
      id: d.id,
      transacao_id: d.transacao_id,
      nome: d.nome,
      email: d.email,
      telefone: d.telefone,
      produto: d.produto,
      etapa: Number(d.etapa_atual),
      status: d.status,
      estado: estadoDe(d, agora),
      tentativas: d.tentativas ?? 0,
      ultimo_erro: d.ultimo_erro,
      proximo_disparo: d.proximo_disparo,
      claimed_at: d.claimed_at,
      criado_em: d.criado_em,
      // O que o chatbot de suporte registrou sobre este cliente — a tabela
      // abre isto no duplo clique da linha.
      chat_resumo: d.chat_resumo ?? null,
      chat_resumo_em: d.chat_resumo_em ?? null,
    })),
    total: filtrados.length,
  };
}
