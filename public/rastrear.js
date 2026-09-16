/**
 * Rastreio público de pedido — sem login. Chama `GET /rastrear/:transacao_id`,
 * repassado cru por `server/index.js` pra rota pública de mesmo nome em
 * `api/rotas/rastreio.js`. A resposta nunca traz PII (endereço/e-mail/
 * telefone) — só o que dá pra mostrar num rastreio de encomenda comum.
 *
 * `encontrado: false` cobre de propósito três situações diferentes (pedido
 * inexistente, ainda não consultado, ou não encontrado no fornecedor) com a
 * MESMA mensagem — não é bug, é a rota não virando oráculo de quais códigos
 * existem (ver PLANO.md, seção 8).
 *
 * i18n (16/09/2026): os clientes das plataformas são americanos, então o
 * padrão é inglês, com um par de botões EN/PT (ver i18n.js) — a API nunca
 * manda texto pronto (`status_rotulo` do backend é ignorado aqui de
 * propósito), só `status_interno`/`status` cru, pra não depender do
 * português fixo que a API devolve.
 */
import { criarTradutor, idiomaAtual, montarSeletorIdioma } from './i18n.js';

const $ = (id) => document.getElementById(id);

const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.dataset.theme = temaSalvo;

const DIC = {
  title: { en: 'Track order · SendTrace', pt: 'Rastrear pedido · SendTrace' },
  fraseArte: { en: 'Every order leaves a trail.', pt: 'Cada pedido tem um rastro.' },
  subArte: { en: 'Enter your order code and see where it is right now.', pt: 'Digite o código do seu pedido e veja onde ele está agora.' },
  marcaSub: { en: 'Order tracking', pt: 'Rastreio de pedido' },
  tit: { en: "Where's my order?", pt: 'Onde está meu pedido?' },
  nota: {
    en: 'Enter your order code (from your purchase confirmation email) to see your shipping status.',
    pt: 'Digite o código do seu pedido (veio no e-mail de confirmação da compra) para ver o status do envio.',
  },
  labelCodigo: { en: 'Order code', pt: 'Código do pedido' },
  botaoRastrear: { en: 'Track order', pt: 'Rastrear pedido' },
  botaoBuscando: { en: 'Searching…', pt: 'Buscando…' },
  botaoTransportadora: { en: 'Track with carrier', pt: 'Rastrear na transportadora' },
  semInfo: {
    en: "We don't have tracking information for this order yet. If you purchased recently, please try again in a few hours.",
    pt: 'Ainda não temos informação de rastreio para este pedido. Se você comprou recentemente, tente de novo em algumas horas.',
  },
  botaoNovaBusca: { en: 'Look up another order', pt: 'Consultar outro pedido' },
  linkEquipe: { en: "I'm on the team — sign in", pt: 'Sou da equipe — entrar no painel' },
  erroVazio: { en: 'Enter your order code.', pt: 'Digite o código do pedido.' },
  erroLimite: { en: 'Too many requests. Try again in 1 minute.', pt: 'Muitas consultas em pouco tempo. Tente de novo em 1 minuto.' },
  erroServidor: { en: "We couldn't look this up right now. Please try again shortly.", pt: 'Não conseguimos consultar agora. Tente de novo em instantes.' },
  erroConexao: { en: 'No connection to the server.', pt: 'Sem conexão com o servidor.' },
  transportadoraFallback: { en: 'Carrier', pt: 'Transportadora' },
  codigoInline: { en: '{carrier} — code {codigo}', pt: '{carrier} — código {codigo}' },
  aindaNao: { en: 'not yet', pt: 'ainda não' },
  cancelado: { en: 'This order was cancelled on {data}.', pt: 'Este pedido foi cancelado em {data}.' },
  canceladoSemData: { en: 'This order was cancelled.', pt: 'Este pedido foi cancelado.' },
  statusIndisponivel: { en: 'Tracking not available yet', pt: 'Rastreio ainda não disponível' },
  etapaRecebido: { en: 'Order received', pt: 'Pedido recebido' },
  etapaEnviado: { en: 'Shipped', pt: 'Enviado' },
  etapaEntregue: { en: 'Delivered', pt: 'Entregue' },
};
const t = criarTradutor(DIC);

/** Status internos "mostráveis" (os mesmos que a rota pública já filtra) — rótulo por idioma, não vem da API. */
const ROTULO_STATUS = {
  pending: { en: 'Order received, preparing shipment', pt: 'Pedido recebido, preparando envio' },
  shipped: { en: 'On its way', pt: 'A caminho' },
  delivered: { en: 'Delivered', pt: 'Entregue' },
  cancelled: { en: 'Cancelled', pt: 'Cancelado' },
};
const rotuloStatus = (statusInterno) => ROTULO_STATUS[statusInterno]?.[idiomaAtual()] ?? t('statusIndisponivel');

/** As 3 etapas da jornada, em ordem — cancelado é tratado à parte (não é um degrau, é um desvio). */
const ETAPAS = () => [
  { status: 'pending', rotulo: t('etapaRecebido') },
  { status: 'shipped', rotulo: t('etapaEnviado') },
  { status: 'delivered', rotulo: t('etapaEntregue') },
];

function dataHora(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(idiomaAtual() === 'pt' ? 'pt-BR' : 'en-US', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

function mostrarErro(msg) {
  const el = $('r-erro');
  el.textContent = msg;
  el.hidden = false;
}
function limparErro() {
  $('r-erro').hidden = true;
}

function ocupado(sim) {
  $('r-buscar').disabled = sim;
  $('r-buscar').textContent = sim ? t('botaoBuscando') : t('botaoRastrear');
}

/**
 * Desenha os degraus fixos (recebido → enviado → entregue), marcando os já
 * cumpridos e destacando o atual. `cancelled` não é um degrau a mais — é um
 * desvio da jornada normal, então troca a lista inteira por um aviso.
 */
function renderizarEtapas(statusAtual, eventos) {
  const ol = $('r-etapas');
  const elCancelado = $('r-cancelado');
  ol.innerHTML = '';

  if (statusAtual === 'cancelled') {
    ol.hidden = true;
    const ev = (eventos ?? []).find((e) => e.status === 'cancelled');
    elCancelado.hidden = false;
    elCancelado.textContent = ev ? t('cancelado', { data: dataHora(ev.em) }) : t('canceladoSemData');
    return;
  }
  elCancelado.hidden = true;
  ol.hidden = false;

  const dataPorStatus = new Map((eventos ?? []).map((e) => [e.status, e.em]));
  const etapas = ETAPAS();
  const rankAtual = etapas.findIndex((e) => e.status === statusAtual);

  for (const [i, etapa] of etapas.entries()) {
    const concluida = rankAtual >= 0 && i <= rankAtual;
    const atual = i === rankAtual;
    const li = document.createElement('li');
    li.className = ['rastreio-etapa', concluida && 'is-concluida', atual && 'is-atual']
      .filter(Boolean).join(' ');
    const quando = dataPorStatus.get(etapa.status);
    li.innerHTML = `
      <span class="rastreio-etapa-ponto" aria-hidden="true"></span>
      <div class="rastreio-etapa-corpo">
        <strong>${etapa.rotulo}</strong>
        <span class="rastreio-etapa-data">${quando ? dataHora(quando) : (concluida ? '' : t('aindaNao'))}</span>
      </div>`;
    ol.appendChild(li);
  }
}

/* Guarda a última resposta encontrada pra re-renderizar tudo (etapas, datas,
 * rótulos) se a pessoa trocar de idioma com um resultado já na tela — sem
 * isto, só os textos estáticos do formulário trocariam. */
let ultimoResultado = null;

function renderizarResultado(dados) {
  $('form-buscar').hidden = true;
  $('r-resultado').hidden = false;
  $('r-sem-info').hidden = true;

  $('r-status-rotulo').textContent = rotuloStatus(dados.status_interno);
  $('r-produto').textContent = dados.produto || '';
  $('r-produto').hidden = !dados.produto;

  const temTransportadora = Boolean(dados.tracking_number);
  $('r-transportadora').hidden = !temTransportadora;
  if (temTransportadora) {
    $('r-carrier-linha').textContent = t('codigoInline', {
      carrier: dados.carrier_code || t('transportadoraFallback'),
      codigo: dados.tracking_number,
    });
    $('r-tracking-status').textContent = dados.tracking_status || '';
    $('r-tracking-status').hidden = !dados.tracking_status;
    const link = $('r-tracking-url');
    link.textContent = t('botaoTransportadora');
    if (dados.tracking_url) {
      link.href = dados.tracking_url;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  renderizarEtapas(dados.status_interno, dados.eventos);
}

function renderizarNaoEncontrado() {
  $('form-buscar').hidden = true;
  $('r-resultado').hidden = false;
  $('r-status-rotulo').textContent = t('statusIndisponivel');
  $('r-produto').hidden = true;
  $('r-transportadora').hidden = true;
  $('r-etapas').hidden = true;
  $('r-cancelado').hidden = true;
  $('r-sem-info').hidden = false;
  $('r-sem-info').textContent = t('semInfo');
}

/** Textos estáticos (fora do resultado) + o que já estiver em tela — chamado no load e a cada troca de idioma. */
function aplicarTextos() {
  document.documentElement.lang = idiomaAtual();
  document.title = t('title');
  $('t-frase').textContent = t('fraseArte');
  $('t-sub').textContent = t('subArte');
  $('t-marca-sub').textContent = t('marcaSub');
  $('t-tit').textContent = t('tit');
  $('t-nota').textContent = t('nota');
  $('t-label-codigo').textContent = t('labelCodigo');
  $('t-link-equipe').textContent = t('linkEquipe');
  $('r-nova-busca').textContent = t('botaoNovaBusca');
  ocupado($('r-buscar').disabled);

  if (!$('r-resultado').hidden) {
    if (ultimoResultado) renderizarResultado(ultimoResultado);
    else renderizarNaoEncontrado();
  }
}

montarSeletorIdioma($('idioma-seletor'), aplicarTextos);
aplicarTextos();

$('form-buscar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro();

  const id = $('r-id').value.trim();
  if (!id) return mostrarErro(t('erroVazio'));

  ocupado(true);
  try {
    const resp = await fetch(`/rastrear/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
    if (resp.status === 429) {
      mostrarErro(t('erroLimite'));
      return;
    }
    if (!resp.ok) {
      mostrarErro(t('erroServidor'));
      return;
    }
    const dados = await resp.json();
    if (!dados.encontrado) {
      ultimoResultado = null;
      renderizarNaoEncontrado();
      return;
    }
    ultimoResultado = dados;
    renderizarResultado(dados);
  } catch {
    mostrarErro(t('erroConexao'));
  } finally {
    ocupado(false);
  }
});

$('r-nova-busca').addEventListener('click', () => {
  ultimoResultado = null;
  $('r-resultado').hidden = true;
  $('form-buscar').hidden = false;
  $('r-id').value = '';
  $('r-id').focus();
});
