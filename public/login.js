/**
 * Tela de entrada.
 *
 * Faz duas coisas na mesma página: o login e, quando a senha é provisória, a
 * definição da senha própria. Mandar a pessoa para o painel só para ele
 * recusar tudo com "troca pendente" seria um desvio inútil — a troca acontece
 * aqui, antes de qualquer coisa carregar.
 */
const $ = (id) => document.getElementById(id);

/* O tema é escolha do usuário e fica no localStorage; a tela de login respeita
   a mesma preferência para não piscar branco em quem usa o painel no escuro. */
const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.dataset.theme = temaSalvo;

/**
 * Para onde ir depois de entrar.
 *
 * Só aceita caminho interno começando com uma única barra. Sem essa checagem,
 * `?ir=https://outro-site` transformaria o login num trampolim de phishing —
 * a pessoa confia no domínio, entra, e é jogada para fora.
 */
function destino() {
  const cru = new URLSearchParams(location.search).get('ir') || '/';
  if (!cru.startsWith('/') || cru.startsWith('//')) return '/';
  return cru;
}

function mostrarErro(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}
function limparErro(el) {
  el.hidden = true;
  el.textContent = '';
}

/** Toda escrita leva o cabeçalho do painel — o servidor recusa sem ele (anti-CSRF). */
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

/* ────────────────────────────── entrar ────────────────────────────── */

const formEntrar = $('form-entrar');
const formSenha = $('form-senha');

formEntrar.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro($('e-erro'));

  const email = $('e-email').value.trim();
  const senha = $('e-senha').value;
  if (!email || !senha) return mostrarErro($('e-erro'), 'Preencha e-mail e senha.');

  ocupado($('e-enviar'), true, 'Entrar');
  try {
    const r = await postar('/api/auth/login', { email, senha });
    if (!r.ok) return mostrarErro($('e-erro'), r.dados.erro ?? 'Não foi possível entrar.');

    if (r.dados.usuario?.trocar_senha) {
      // Já está autenticado; só falta a senha própria. Reaproveita o que foi
      // digitado para a pessoa não redigitar a provisória.
      formEntrar.hidden = true;
      formSenha.hidden = false;
      $('s-atual').value = senha;
      $('s-nova').focus();
      return;
    }
    location.replace(destino());
  } catch {
    mostrarErro($('e-erro'), 'Sem conexão com o servidor.');
  } finally {
    ocupado($('e-enviar'), false, 'Entrar');
  }
});

/* ──────────────────────── definir senha própria ───────────────────── */

formSenha.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro($('s-erro'));

  const atual = $('s-atual').value;
  const nova = $('s-nova').value;
  const repete = $('s-repete').value;

  if (nova !== repete) return mostrarErro($('s-erro'), 'As duas senhas não são iguais.');
  if (nova.length < 10) return mostrarErro($('s-erro'), 'A senha precisa ter pelo menos 10 caracteres.');

  ocupado($('s-enviar'), true, 'Salvar e entrar');
  try {
    const r = await postar('/api/auth/senha', { atual, nova });
    if (!r.ok) return mostrarErro($('s-erro'), r.dados.erro ?? 'Não foi possível salvar.');
    location.replace(destino());
  } catch {
    mostrarErro($('s-erro'), 'Sem conexão com o servidor.');
  } finally {
    ocupado($('s-enviar'), false, 'Salvar e entrar');
  }
});
