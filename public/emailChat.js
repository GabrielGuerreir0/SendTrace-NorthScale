/**
 * Central de E-mail IA — Tela 3: Chat com IA. Conversa em linguagem natural
 * com um agente Claude que só executa SELECT/WITH somente leitura no banco
 * (§5). Histórico guardado em sessionStorage — não no servidor.
 */
import { $, api, markdownParaHtml } from './emailComum.js';

const CHAVE_HISTORICO = 'email_ia_chat_historico';
const CHAVE_MODELO = 'email_ia_chat_modelo';

const SUGESTOES = [
  'Quantos tickets estão em aberto agora?',
  'Quais os principais motivos de devolução deste mês?',
  'Resuma os e-mails com urgência alta que ainda aguardam resposta.',
  'Quais clientes têm 2 ou mais devoluções registradas?',
];

let historico = [];
try { historico = JSON.parse(sessionStorage.getItem(CHAVE_HISTORICO) ?? '[]'); } catch { historico = []; }
let carregando = false;

function salvarHistorico() {
  try { sessionStorage.setItem(CHAVE_HISTORICO, JSON.stringify(historico)); } catch { /* sessão cheia/bloqueada: segue só em memória */ }
}

/* ═══════════════════════════════  desenho  ═══════════════════════════════ */

function criarBalaoInicial() {
  const div = document.createElement('div');
  div.className = 'ch-balao';
  div.dataset.papel = 'assistant';
  const corpo = document.createElement('div');
  corpo.className = 'ch-balao-corpo';
  corpo.innerHTML = markdownParaHtml('Olá! Eu leio o banco da Central de E-mail IA em modo somente leitura — '
    + 'pergunte sobre tickets, e-mails, devoluções, clientes ou vendas ligadas a eles. '
    + 'Toda pergunta que envolve números eu confiro consultando o banco de verdade.');
  div.append(corpo);
  return div;
}

function criarSugestoes() {
  const div = document.createElement('div');
  div.className = 'ch-sugestoes';
  for (const texto of SUGESTOES) {
    const b = document.createElement('button');
    b.className = 'btn ch-sugestao';
    b.type = 'button';
    b.textContent = texto;
    b.addEventListener('click', () => enviar(texto));
    div.append(b);
  }
  return div;
}

function criarBalaoCarregando() {
  const div = document.createElement('div');
  div.className = 'ch-balao ch-balao--carregando';
  div.dataset.papel = 'assistant';
  const corpo = document.createElement('div');
  corpo.className = 'ch-balao-corpo';
  corpo.innerHTML = '<span class="ch-pontos"><i></i><i></i><i></i></span>';
  div.append(corpo);
  return div;
}

function criarBalao(msg) {
  const div = document.createElement('div');
  div.className = 'ch-balao';
  div.dataset.papel = msg.role;
  const corpo = document.createElement('div');
  corpo.className = 'ch-balao-corpo';
  if (msg.role === 'assistant') corpo.innerHTML = markdownParaHtml(msg.content);
  else corpo.textContent = msg.content;
  div.append(corpo);

  if (msg.role === 'assistant' && msg.consultas?.length) {
    const det = document.createElement('details');
    det.className = 'ch-consultas';
    const sum = document.createElement('summary');
    sum.textContent = `${msg.consultas.length} consulta${msg.consultas.length === 1 ? '' : 's'} ao banco`;
    det.append(sum);
    for (const c of msg.consultas) {
      const pre = document.createElement('pre');
      pre.textContent = `${c.sql}\n-- ${c.linhas} linha${c.linhas === 1 ? '' : 's'}`;
      det.append(pre);
    }
    div.append(det);
  }
  return div;
}

function renderMensagens() {
  const container = $('ch-mensagens');
  container.replaceChildren();
  if (!historico.length) {
    container.append(criarBalaoInicial(), criarSugestoes());
  } else {
    for (const msg of historico) container.append(criarBalao(msg));
  }
  if (carregando) container.append(criarBalaoCarregando());
  container.scrollTop = container.scrollHeight;
}

/* ═══════════════════════════════  envio  ══════════════════════════════════ */

async function enviar(textoBruto) {
  const conteudo = String(textoBruto ?? '').trim();
  if (!conteudo || carregando) return;

  historico.push({ role: 'user', content: conteudo });
  salvarHistorico();
  $('ch-input').value = '';
  carregando = true;
  $('ch-enviar').disabled = true;
  renderMensagens();

  try {
    const { ok, dados } = await api('/api/chat', {
      metodo: 'POST',
      corpo: {
        mensagens: historico.map(({ role, content }) => ({ role, content })),
        modelo: $('ch-modelo').value,
      },
    });
    if (!ok || dados.erro) {
      historico.push({ role: 'assistant', content: `⚠ ${dados?.erro ?? 'Não consegui falar com a IA agora.'}` });
    } else {
      historico.push({ role: 'assistant', content: dados.resposta ?? '', consultas: dados.consultas ?? [] });
    }
  } catch (err) {
    historico.push({ role: 'assistant', content: `⚠ ${err.message}` });
  } finally {
    carregando = false;
    $('ch-enviar').disabled = false;
    salvarHistorico();
    renderMensagens();
    $('ch-input').focus();
  }
}

/* ═══════════════════════════════  controles  ══════════════════════════════ */

$('ch-modelo').value = sessionStorage.getItem(CHAVE_MODELO) || 'claude-haiku-4-5';
$('ch-modelo').addEventListener('change', () => {
  try { sessionStorage.setItem(CHAVE_MODELO, $('ch-modelo').value); } catch { /* ignora */ }
});

$('ch-limpar').addEventListener('click', () => {
  historico = [];
  salvarHistorico();
  renderMensagens();
});

$('ch-enviar').addEventListener('click', () => enviar($('ch-input').value));
$('ch-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    enviar($('ch-input').value);
  }
});
$('ch-input').addEventListener('input', (ev) => {
  ev.target.style.height = 'auto';
  ev.target.style.height = `${Math.min(160, ev.target.scrollHeight)}px`;
});

renderMensagens();
