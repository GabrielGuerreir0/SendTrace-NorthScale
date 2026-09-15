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
 */
const $ = (id) => document.getElementById(id);

const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.dataset.theme = temaSalvo;

const ROTULO_EVENTO = {
  pending: 'Pedido recebido',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
};

function dataHora(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
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
  $('r-buscar').textContent = sim ? 'Buscando…' : 'Rastrear pedido';
}

function renderizarResultado(dados) {
  $('form-buscar').hidden = true;
  $('r-resultado').hidden = false;

  $('r-status-rotulo').textContent = dados.status_rotulo || 'Rastreio ainda não disponível';
  $('r-produto').textContent = dados.produto || '';
  $('r-produto').hidden = !dados.produto;

  const temTransportadora = Boolean(dados.tracking_number);
  $('r-transportadora').hidden = !temTransportadora;
  if (temTransportadora) {
    $('r-carrier').textContent = dados.carrier_code || 'Transportadora';
    $('r-tracking-number').textContent = dados.tracking_number;
    $('r-tracking-status').textContent = dados.tracking_status || '';
    $('r-tracking-status').hidden = !dados.tracking_status;
    const link = $('r-tracking-url');
    if (dados.tracking_url) {
      link.href = dados.tracking_url;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  const lista = $('r-linha-tempo');
  lista.innerHTML = '';
  for (const ev of dados.eventos ?? []) {
    const li = document.createElement('li');
    const rotulo = ROTULO_EVENTO[ev.status] ?? ev.status;
    li.innerHTML = `<strong>${rotulo}</strong><span>${dataHora(ev.em)}</span>`;
    lista.appendChild(li);
  }
}

function renderizarNaoEncontrado() {
  $('form-buscar').hidden = true;
  $('r-resultado').hidden = false;
  $('r-status-rotulo').textContent = 'Rastreio ainda não disponível';
  $('r-produto').hidden = true;
  $('r-transportadora').hidden = true;
  $('r-linha-tempo').innerHTML =
    '<li class="rastreio-linha-tempo-vazia">Ainda não temos informação de rastreio para este '
    + 'pedido. Se você comprou recentemente, tente de novo em algumas horas.</li>';
}

$('form-buscar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro();

  const id = $('r-id').value.trim();
  if (!id) return mostrarErro('Digite o código do pedido.');

  ocupado(true);
  try {
    const resp = await fetch(`/rastrear/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
    if (resp.status === 429) {
      mostrarErro('Muitas consultas em pouco tempo. Tente de novo em 1 minuto.');
      return;
    }
    if (!resp.ok) {
      mostrarErro('Não conseguimos consultar agora. Tente de novo em instantes.');
      return;
    }
    const dados = await resp.json();
    if (!dados.encontrado) {
      renderizarNaoEncontrado();
      return;
    }
    renderizarResultado(dados);
  } catch {
    mostrarErro('Sem conexão com o servidor.');
  } finally {
    ocupado(false);
  }
});

$('r-nova-busca').addEventListener('click', () => {
  $('r-resultado').hidden = true;
  $('form-buscar').hidden = false;
  $('r-id').value = '';
  $('r-id').focus();
});
