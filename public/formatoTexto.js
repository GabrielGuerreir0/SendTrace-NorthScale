/**
 * Formatação simples das mensagens do agente (4º momento da Késsia, item 1) — mesma marcação do servidor (server/formatoTexto.js):
 * **negrito**, _itálico_ (ou *itálico*), "1. item", "- item" e [texto](https://…). Monta nós DOM (nunca innerHTML), então o texto do agente não injeta HTML.
 */
const URL_OK = /^(https?:\/\/|mailto:)/i;

function inline(texto, destino) {
  // Ordem: link com texto, URL solta, negrito, itálico. Procura a marca que aparece primeiro e repete no resto.
  const padroes = [
    { re: /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/i, faz: (m) => link(m[2], m[1]) },
    { re: /(?<![\w/])(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])/i, faz: (m) => link(m[1], m[1]) },
    { re: /\*\*(?!\s)(.+?)(?<!\s)\*\*/, faz: (m) => forte(m[1]) },
    { re: /(?<![\w_])__(?!\s)(.+?)(?<!\s)__(?![\w_])/, faz: (m) => forte(m[1]) },
    { re: /(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/, faz: (m) => italico(m[1]) },
    { re: /(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/, faz: (m) => italico(m[1]) },
  ];
  const link = (url, rotulo) => {
    if (!URL_OK.test(url)) return document.createTextNode(rotulo);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = rotulo; return a;
  };
  const embrulha = (tag, conteudo) => { const el = document.createElement(tag); inline(conteudo, el); return el; };
  const forte = (c) => embrulha('strong', c);
  const italico = (c) => embrulha('em', c);
  let resto = texto;
  while (resto) {
    let melhor = null;
    for (const p of padroes) {
      const m = p.re.exec(resto);
      if (m && (!melhor || m.index < melhor.m.index)) melhor = { m, p };
    }
    if (!melhor) { destino.append(document.createTextNode(resto)); return; }
    const { m, p } = melhor;
    if (m.index > 0) destino.append(document.createTextNode(resto.slice(0, m.index)));
    destino.append(p.faz(m));
    resto = resto.slice(m.index + m[0].length);
  }
}

/** Texto com marcação leve → fragmento DOM (parágrafos, listas, negrito, itálico, links). */
export function mdParaNos(texto) {
  const frag = document.createDocumentFragment();
  let atual = null;   // { tipo, el }
  const fechar = () => { atual = null; };
  for (const bruta of String(texto ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const l = bruta.replace(/\s+$/, '');
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(l);
    const ul = /^\s*[-•]\s+(.*)$/.exec(l) || /^\s*\*\s+(?!\*)(.*)$/.exec(l);
    if (!l.trim()) { fechar(); continue; }
    if (ol || ul) {
      const tipo = ol ? 'ol' : 'ul';
      if (atual?.tipo !== tipo) { const el = document.createElement(tipo); el.style.margin = '0 0 6px'; el.style.paddingLeft = '20px'; frag.append(el); atual = { tipo, el }; }
      const li = document.createElement('li'); inline((ol ?? ul)[1], li); atual.el.append(li);
      continue;
    }
    if (atual?.tipo !== 'p') { const el = document.createElement('p'); el.style.margin = '0 0 6px'; frag.append(el); atual = { tipo: 'p', el }; }
    else atual.el.append(document.createElement('br'));
    inline(l, atual.el);
  }
  return frag;
}

/* ── colar texto formatado (HTML da área de transferência) → marcação leve ── */
function htmlParaMd(no, ctx = { ol: 0 }) {
  let saida = '';
  for (const filho of no.childNodes) {
    if (filho.nodeType === 3) { saida += filho.textContent.replace(/\s+/g, ' '); continue; }
    if (filho.nodeType !== 1) continue;
    const tag = filho.tagName.toLowerCase();
    const dentro = () => htmlParaMd(filho, ctx);
    if (['script', 'style', 'head'].includes(tag)) continue;
    if (tag === 'br') saida += '\n';
    else if (tag === 'strong' || tag === 'b') { const t = dentro().trim(); saida += t ? `**${t}**` : ''; }
    else if (tag === 'em' || tag === 'i') { const t = dentro().trim(); saida += t ? `_${t}_` : ''; }
    else if (tag === 'a') { const t = dentro().trim(); const h = filho.getAttribute('href') || ''; saida += URL_OK.test(h) && t ? (t === h ? h : `[${t}](${h})`) : t; }
    else if (tag === 'ol') { const c = { ol: 0 }; saida += `\n${htmlParaMd(filho, c)}\n`; }
    else if (tag === 'ul') { saida += `\n${htmlParaMd(filho, { ol: -1 })}\n`; }
    else if (tag === 'li') { const t = dentro().trim(); if (ctx.ol >= 0) { ctx.ol += 1; saida += `${ctx.ol}. ${t}\n`; } else saida += `- ${t}\n`; }
    else if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'tr'].includes(tag)) saida += `\n${dentro().trim()}\n\n`;
    else saida += dentro();
  }
  return saida;
}

/** HTML colado → texto com marcação leve (negrito vira **x**, lista numerada vira "1. x"…). Devolve null se não houver nada de formatação a preservar. */
export function htmlColadoParaMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const md = htmlParaMd(doc.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return md || null;
}
