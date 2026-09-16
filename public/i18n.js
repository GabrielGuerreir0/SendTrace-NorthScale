/**
 * i18n mínimo, sem lib — só pras páginas que precisam mesmo (hoje: o
 * rastreio público do lead e a aba interna "Rastreio de Pedidos"; o resto
 * do painel continua só em português). Cada página declara o próprio
 * dicionário `{chave: {en, pt}}` e usa `criarTradutor()` pra pegar um
 * `t(chave)` que já lê o idioma salvo — não tem central de textos do
 * painel inteiro.
 *
 * Padrão: inglês (os clientes das plataformas são americanos), com opção
 * de trocar pra português salva por navegador (localStorage, nunca manda
 * pro servidor — é preferência de quem tá vendo a tela, não do pedido).
 */
const CHAVE_STORAGE = 'idioma';
export const PADRAO = 'en';

export function idiomaAtual() {
  try {
    const salvo = localStorage.getItem(CHAVE_STORAGE);
    return salvo === 'pt' ? 'pt' : PADRAO;
  } catch {
    return PADRAO;
  }
}

export function definirIdioma(idioma) {
  try { localStorage.setItem(CHAVE_STORAGE, idioma); } catch { /* navegador sem storage (privado/bloqueado) — segue só nesta carga */ }
}

/** `t('chave')` — cai pro inglês se a chave não tiver a tradução, e pra chave crua se nem existir (nunca quebra a tela por um texto faltando). */
export function criarTradutor(dicionario) {
  return (chave, vars) => {
    const entrada = dicionario[chave];
    let texto = entrada ? (entrada[idiomaAtual()] ?? entrada.en) : chave;
    if (vars) for (const [k, v] of Object.entries(vars)) texto = texto.replaceAll(`{${k}}`, v);
    return texto;
  };
}

/** Par de botões EN/PT — a página decide onde encaixar no DOM e o que fazer ao trocar (normalmente: re-renderizar os textos). */
export function montarSeletorIdioma(container, aoTrocar) {
  const atual = idiomaAtual();
  container.replaceChildren(...['en', 'pt'].map((idioma) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `idioma-btn${idioma === atual ? ' is-ativo' : ''}`;
    btn.textContent = idioma.toUpperCase();
    btn.setAttribute('aria-pressed', String(idioma === atual));
    btn.addEventListener('click', () => {
      if (idioma === idiomaAtual()) return;
      definirIdioma(idioma);
      montarSeletorIdioma(container, aoTrocar);
      aoTrocar(idioma);
    });
    return btn;
  }));
}
