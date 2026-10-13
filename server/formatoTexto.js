/**
 * Formatação simples das respostas do agente (4º momento da Késsia, item 1): negrito, itálico, listas numeradas/com marcador e links.
 * O agente escreve (ou cola) texto com a marcação leve de sempre — **negrito**, _itálico_ (ou *itálico*), "1. item", "- item", [texto](https://…) —
 * e o e-mail sai com HTML de verdade + uma versão em texto puro (sem asteriscos). Tudo é escapado ANTES de virar tag: só as marcas acima viram HTML.
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapar = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

const URL_OK = /^(https?:\/\/|mailto:)/i;

/** Marcas dentro de uma linha (já escapada). Links e URLs soltas viram marcadores antes, para o itálico não mexer no endereço. */
function inline(linhaEscapada) {
  const guardados = [];
  const guardar = (html) => { guardados.push(html); return `\u0000${guardados.length - 1}\u0000`; };
  let t = linhaEscapada;
  t = t.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, (_, texto, url) => guardar(`<a href="${url}">${texto}</a>`));
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"]+[^\s<>".,;:!?)])/gi, (_, pre, url) => `${pre}${guardar(`<a href="${url}">${url}</a>`)}`);
  t = t.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<![\w_])__(?!\s)(.+?)(?<!\s)__(?![\w_])/g, '<strong>$1</strong>');
  t = t.replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '<em>$1</em>');
  t = t.replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '<em>$1</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => guardados[Number(i)]);
}

/** Texto com marcação leve → HTML seguro (parágrafos, listas, negrito, itálico, links). */
export function mdParaHtml(texto) {
  const linhas = String(texto ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocos = [];
  let atual = null;   // { tipo: 'p' | 'ol' | 'ul', itens: [] }
  const fechar = () => { if (atual) { blocos.push(atual); atual = null; } };
  for (const bruta of linhas) {
    const l = bruta.replace(/\s+$/, '');
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(l);
    const ul = /^\s*[-•]\s+(.*)$/.exec(l) || /^\s*\*\s+(?!\*)(.*)$/.exec(l);
    if (!l.trim()) { fechar(); continue; }
    if (ol) { if (atual?.tipo !== 'ol') { fechar(); atual = { tipo: 'ol', itens: [] }; } atual.itens.push(ol[1]); continue; }
    if (ul) { if (atual?.tipo !== 'ul') { fechar(); atual = { tipo: 'ul', itens: [] }; } atual.itens.push(ul[1]); continue; }
    if (atual?.tipo !== 'p') { fechar(); atual = { tipo: 'p', itens: [] }; }
    atual.itens.push(l);
  }
  fechar();
  const corpo = blocos.map((b) => {
    if (b.tipo === 'p') return `<p style="margin:0 0 12px">${b.itens.map((x) => inline(escapar(x))).join('<br>')}</p>`;
    const tag = b.tipo;
    return `<${tag} style="margin:0 0 12px;padding-left:22px">${b.itens.map((x) => `<li>${inline(escapar(x))}</li>`).join('')}</${tag}>`;
  }).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${corpo}</div>`;
}

/** Versão em texto puro (a outra parte do e-mail): sem asteriscos/sublinhados de formatação; link vira "texto (url)". */
export function mdParaTexto(texto) {
  let t = String(texto ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, (_, a, u) => (a.trim() === u ? u : `${a} (${u})`));
  t = t.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '$1');
  t = t.replace(/(?<![\w_])__(?!\s)(.+?)(?<!\s)__(?![\w_])/g, '$1');
  t = t.replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '$1');
  t = t.replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '$1');
  return t;
}
