/**
 * Tela de recuperação de senha — duas etapas, uma página só, alternadas por
 * `?token=` estar ou não na URL (mesmo padrão de dois formulários chaveados
 * de login.js).
 *
 * Sem token: pede o e-mail (`POST /api/auth/esqueci`) — a resposta é SEMPRE
 * a mesma mensagem genérica, exista ou não a conta, para não dar pra
 * descobrir e-mail cadastrado só tentando.
 *
 * Com token (veio de um link de e-mail): pede a senha nova
 * (`POST /api/auth/redefinir`). Aqui a mensagem de erro já pode ser
 * específica — quem tem o token no e-mail já sabe que a conta existe.
 */
const $ = (id) => document.getElementById(id);

const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.dataset.theme = temaSalvo;

function mostrarErro(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}
function limparErro(el) {
  el.hidden = true;
  el.textContent = '';
}

async function postar(rota, corpo) {
  const resp = await fetch(rota, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
    body: JSON.stringify(corpo),
  });
  let dados = {};
  try { dados = await resp.json(); } catch { /* resposta sem corpo */ }
  return { ok: resp.ok, status: resp.status, dados };
}

function ocupado(botao, sim, rotulo) {
  botao.disabled = sim;
  botao.textContent = sim ? 'Aguarde…' : rotulo;
}

const formPedir = $('form-pedir');
const formDefinir = $('form-definir');

/*
 * O token só existe pra montar o POST — depois de lido, sai da barra de
 * endereço (history.replaceState) pra não ficar exposto em histórico do
 * navegador/captura de tela de quem olhar por cima do ombro.
 */
const token = new URLSearchParams(location.search).get('token');
if (token) {
  formPedir.hidden = true;
  formDefinir.hidden = false;
  history.replaceState(null, '', '/recuperar');
  $('d-nova').focus();
} else {
  $('p-email').focus();
}

/* ────────────────────────────── pedir o link ────────────────────────────── */

formPedir.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro($('p-erro'));
  $('p-sucesso').hidden = true;

  const email = $('p-email').value.trim();
  if (!email) return mostrarErro($('p-erro'), 'Preencha o e-mail.');

  ocupado($('p-enviar'), true, 'Enviar link');
  try {
    const r = await postar('/api/auth/esqueci', { email });
    // A mensagem é a mesma tanto em sucesso quanto em qualquer resposta da
    // API — só erro de rede de verdade (sem resposta nenhuma) é diferente.
    const msg = r.dados?.mensagem ?? 'Se esse e-mail tiver uma conta ativa, você recebe um link em instantes.';
    $('p-sucesso').textContent = msg;
    $('p-sucesso').hidden = false;
    formPedir.reset();
  } catch {
    mostrarErro($('p-erro'), 'Sem conexão com o servidor.');
  } finally {
    ocupado($('p-enviar'), false, 'Enviar link');
  }
});

/* ─────────────────────────── definir senha nova ─────────────────────────── */

formDefinir.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro($('d-erro'));

  const nova = $('d-nova').value;
  const repete = $('d-repete').value;

  if (nova !== repete) return mostrarErro($('d-erro'), 'As duas senhas não são iguais.');
  if (nova.length < 10) return mostrarErro($('d-erro'), 'A senha precisa ter pelo menos 10 caracteres.');

  ocupado($('d-enviar'), true, 'Salvar nova senha');
  try {
    const r = await postar('/api/auth/redefinir', { token, senha: nova });
    if (!r.ok) return mostrarErro($('d-erro'), r.dados.erro ?? 'Não foi possível redefinir a senha.');
    location.replace('/login');
  } catch {
    mostrarErro($('d-erro'), 'Sem conexão com o servidor.');
  } finally {
    ocupado($('d-enviar'), false, 'Salvar nova senha');
  }
});
