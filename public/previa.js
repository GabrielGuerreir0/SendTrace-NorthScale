/**
 * Pré-visualização de uma mensagem: o e-mail como o cliente vai ver, ou o SMS
 * como chega no celular.
 *
 * O banco guarda só o CORPO de cada e-mail — a moldura (cabeçalho da marca,
 * botão, bloco de suporte, assinatura, rodapé) é idêntica nas 17 mensagens e é
 * remontada aqui. Guardá-la 17 vezes criaria 17 lugares para desatualizar.
 *
 * O HTML entra num iframe com `sandbox` VAZIO: sem script, sem formulário, sem
 * acesso à página que o hospeda. É conteúdo que veio do banco — mesmo sendo o
 * seu próprio banco, renderizá-lo direto no DOM do painel transformaria
 * qualquer `UPDATE` numa porta de XSS.
 */
/* Espelha o CFG e as COR do nó de Code do n8n. Se você mudar o link do
   assistente ou a cor da marca lá, mude aqui — senão a pré-visualização mente
   sobre o que está sendo enviado. */
const MARCA = {
  empresa: 'North Scale',
  suporte: 'support@northsupplements.online',
  ebook: 'https://drive.google.com/uc?export=download&id=18DkKudndjAVQ9WOwPvCTItN1ZfJxyZva',
  assistente: 'https://support.thenorthscales.com/',
  azul: '#415fe5',
  preto: '#0c0c0c',
  texto: '#1f2430',
  cinza: '#6b7280',
  cinzaBg: '#f7f8fa',
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Reproduz a moldura() do n8n. */
function moldar(corpo, botao, destino, produto, email, telefone) {
  const link = destino === 'EBOOK' ? MARCA.ebook : MARCA.assistente;
  const cta = botao
    ? `<p style="margin:28px 0"><a href="${esc(link)}" style="display:inline-block;padding:14px 26px;`
      + `background:${MARCA.azul};color:#fff;border-radius:8px;text-decoration:none;font-weight:700">`
      + `${esc(botao)}</a></p>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<base target="_blank"></head><body style="margin:0">`
    + `<div style="background:#eef0f4;padding:24px 12px">`
    + `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.6;color:${MARCA.texto}">`
    + `<div style="background:${MARCA.preto};border-radius:10px 10px 0 0;padding:20px 24px;text-align:center">`
    + `<span style="font-family:Arial Black,Arial,sans-serif;font-size:19px;font-weight:900;letter-spacing:.18em;color:#fff">`
    + `NORTH <span style="color:${MARCA.azul};letter-spacing:0">&#9650;</span> SCALE</span></div>`
    + `<div style="background:#fff;border-radius:0 0 10px 10px;padding:32px 28px">`
    + corpo
    + cta
    + `<p style="background:${MARCA.cinzaBg};border-radius:8px;padding:13px 18px;font-size:14px;color:#555">`
    + `<b>Need assistance? Our Support Team is here to help:</b><br>`
    + `<span style="color:${MARCA.cinza};font-size:13px">(Mon&ndash;Fri, 9am to 6pm EST)</span><br>`
    + `&#128231; Email: <a href="mailto:${MARCA.suporte}" style="color:${MARCA.azul};text-decoration:none">${MARCA.suporte}</a></p>`
    + `<p style="margin-top:20px">With care,<br><b>&mdash; The ${esc(produto)} Team at ${esc(MARCA.empresa)}</b></p>`
    + `</div>`
    + `<div style="padding:18px 24px;text-align:center;font-size:12px;color:#9aa0ab;line-height:1.6">`
    + `<p style="margin:0"><b style="color:#6b7280;letter-spacing:.12em">NORTH &#9650; SCALE</b></p>`
    + `<p style="margin:6px 0 0">You're receiving this email because you made a purchase on our platform.</p>`
    + `<p style="margin:6px 0 0">${esc(email)}${telefone ? ` | ${esc(telefone)}` : ''}</p></div>`
    + `</div></div></body></html>`;
}

/** O SMS como bolha de celular — o formato importa para julgar o texto. */
function molarSms(texto) {
  return `<!doctype html><html><head><meta charset="utf-8"></head>`
    + `<body style="margin:0;background:#eef0f4;padding:28px 16px;`
    + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">`
    + `<div style="max-width:330px;margin:0 auto">`
    + `<p style="margin:0 0 10px;text-align:center;font-size:11px;color:#8b8f98">`
    + `Mensagem de texto &middot; ${esc(MARCA.empresa)}</p>`
    + `<div style="background:#fff;border-radius:18px 18px 18px 5px;padding:13px 16px;`
    + `font-size:15px;line-height:1.45;color:#111;box-shadow:0 1px 2px rgba(0,0,0,.12)">`
    + `${esc(texto)}</div></div></body></html>`;
}

export function criarPrevia({
  dialogo, caixa, codigo, titulo, sub, nota, modos, fechar, editor,
}) {
  /*
   * `original` é o que veio do banco; `rascunho` é o que está no formulário.
   *
   * A pré-visualização SEMPRE monta a partir do rascunho. É isso que faz o
   * "Renderizado" mostrar a versão editada em vez da salva: sem essa
   * separação, você editaria, clicaria em pré-visualizar e veria o texto
   * antigo — exatamente o erro que torna um editor inútil.
   */
  let original = null;
  let rascunho = null;
  let contexto = null;   // { etapa, amostra }
  let modo = 'render';

  /**
   * Descarta o iframe atual, se houver.
   *
   * Sair do modo renderizado destrói o quadro em vez de escondê-lo: um iframe
   * `display:none` continua ocupando memória com o documento carregado, e
   * reexibi-lo dependia de o navegador reprocessar um `srcdoc` que não mudou.
   */
  function limparQuadro() {
    caixa.replaceChildren();
  }

  /** Monta um iframe NOVO. Recém-criado, ele sempre carrega o srcdoc. */
  function montarQuadro(doc) {
    limparQuadro();
    const frame = document.createElement('iframe');
    frame.className = 'previa-quadro';
    frame.title = 'Pré-visualização da mensagem';
    // sandbox vazio: sem script, sem formulário, sem acesso à página que o
    // hospeda. É HTML vindo do banco entrando na tela.
    frame.setAttribute('sandbox', '');
    frame.srcdoc = doc;
    caixa.appendChild(frame);
  }

  /** Monta o documento a partir do RASCUNHO — o que está sendo editado agora. */
  function documento() {
    if (!rascunho) return '';
    const preencher = (t) => String(t ?? '')
      .replace(/\{(nome|produto|uso)\}/g, (_, k) => contexto?.amostra?.[k] ?? `{${k}}`);

    if (rascunho.canal === 'sms') return molarSms(preencher(rascunho.texto));
    if (!rascunho.corpo_html) return '';
    return moldar(
      preencher(rascunho.corpo_html), preencher(rascunho.botao), rascunho.destino,
      contexto?.amostra?.produto ?? 'your order',
      'cliente@exemplo.com', '+1 555 000 0000',
    );
  }

  /** O título é o assunto — precisa acompanhar a edição, não ficar no valor salvo. */
  function pintarTitulo() {
    if (!rascunho) return;
    const preencher = (t) => String(t ?? '')
      .replace(/\{(nome|produto|uso)\}/g, (_, k) => contexto?.amostra?.[k] ?? `{${k}}`);
    titulo.textContent = rascunho.canal === 'email'
      ? (preencher(rascunho.assunto) || 'E-mail sem assunto')
      : 'SMS';
  }

  function pintar() {
    if (!rascunho) return;
    pintarTitulo();
    const doc = documento();

    caixa.hidden = modo !== 'render';
    codigo.hidden = modo !== 'codigo';
    if (editor) editor.painel.hidden = modo !== 'editar';

    for (const b of modos.querySelectorAll('.previa-modo')) {
      b.setAttribute('aria-pressed', String(b.dataset.modo === modo));
    }

    if (modo === 'render') {
      if (doc) montarQuadro(doc);
      else { limparQuadro(); caixa.hidden = true; }
    } else {
      limparQuadro();
      if (modo === 'codigo') codigo.textContent = doc || '(sem corpo cadastrado)';
    }

    if (!doc && modo === 'render') {
      nota.hidden = false;
      nota.textContent = rascunho.canal === 'email'
        ? 'Sem corpo para pré-visualizar. Escreva o corpo na aba Editar.'
        : 'Sem texto para pré-visualizar.';
    }
  }

  /** O editor avisa aqui a cada tecla; o preview passa a refletir na hora. */
  function aoEditar(campos) {
    if (!rascunho) return;
    Object.assign(rascunho, campos);
    // O título acompanha sempre; o documento só quando está visível, para não
    // remontar o iframe a cada tecla enquanto se digita na aba Editar.
    pintarTitulo();
    if (modo === 'render' || modo === 'codigo') pintar();
    if (editor) editor.aoMudarRascunho(rascunho, original);
  }

  /**
   * @param m       a mensagem (canal, assunto, botao, destino, corpo_html…)
   * @param etapa   a etapa a que ela pertence, para o cabeçalho
   * @param amostra nome/produto usados no lugar dos marcadores
   */
  function abrir(m, etapa, amostra, { podeEditar = false } = {}) {
    original = { ...m };
    rascunho = { ...m };
    contexto = { etapa, amostra };

    const eEmail = m.canal === 'email';
    sub.textContent = `Etapa ${etapa.etapa} · ${etapa.nome} · linha ${m.linha}`;

    nota.hidden = false;
    nota.textContent = `Marcadores preenchidos com "${amostra?.nome ?? '—'}" e `
      + `"${amostra?.produto ?? '—'}" — o pior caso de tamanho da sua fila. `
      + (eEmail ? 'Cabeçalho, botão e rodapé são montados como o robô faz.' : '');

    modos.hidden = false;
    if (editor) {
      editor.botao.hidden = !podeEditar;
      editor.carregar(rascunho, etapa);
    }

    modo = 'render';
    dialogo.showModal();
    pintar();
  }

  modos.addEventListener('click', (ev) => {
    const b = ev.target.closest('.previa-modo');
    if (!b) return;
    modo = b.dataset.modo;
    pintar();
  });
  fechar.addEventListener('click', () => {
    // Fechar com alteração não salva perderia o trabalho em silêncio.
    if (editor?.sujo(rascunho, original)
        && !confirm('Há alterações não salvas nesta mensagem. Fechar mesmo assim?')) return;
    dialogo.close();
  });

  // Descarta o iframe ao fechar: sem isso o documento anterior fica carregado
  // em memória até a próxima abertura.
  dialogo.addEventListener('close', () => {
    limparQuadro();
    original = null; rascunho = null; contexto = null;
  });

  return {
    abrir,
    aoEditar,
    /** Depois de salvar, o rascunho vira a nova base de comparação. */
    marcarSalvo(m) {
      original = { ...m };
      rascunho = { ...rascunho, ...m };
      pintar();
    },
    reverter() {
      if (!original) return null;
      rascunho = { ...original };
      pintar();
      return rascunho;
    },
    rascunhoAtual: () => rascunho,
  };
}
