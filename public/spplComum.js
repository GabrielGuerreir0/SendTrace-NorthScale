/**
 * Peças comuns das duas telas novas do SPPL (2º momento da Késsia): Monitoramento Logístico e Suporte Ativo. SEMPRE em português (pedido da Késsia).
 * Todo texto vindo da API entra por textContent (nunca como HTML).
 */
export const el = (tag, texto, classe) => { const e = document.createElement(tag); if (texto !== undefined && texto !== null) e.textContent = texto; if (classe) e.className = classe; return e; };

const DATA_HORA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const SO_DATA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtDataHora = (iso) => (iso ? DATA_HORA.format(new Date(iso)) : '—');
export const fmtData = (iso) => (iso ? SO_DATA.format(new Date(iso)) : '—');
export const fmtValor = (v) => (v === null || v === undefined || v === '' ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(Number(v)));
export const ROT_PLATAFORMA = { jvzoo: 'JVZoo', buygoods: 'BuyGoods', digistore24: 'Digistore24' };
export const rotPlataforma = (p) => ROT_PLATAFORMA[String(p || '').toLowerCase().trim()] ?? (p || '—');

/** <label class="campo"><span>rótulo</span><select> */
export function campoSelect(rotulo, opcoes, valor = '', aoMudar) {
  const l = el('label', undefined, 'campo'); l.append(el('span', rotulo));
  const s = document.createElement('select');
  for (const [v, t] of opcoes) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); }
  s.value = valor; if (aoMudar) s.addEventListener('change', () => aoMudar(s.value));
  l.append(s); return { rotulo: l, select: s };
}
export function campoTexto(rotulo, { tipo = 'text', valor = '', max = 200, placeholder = '', cresce = false } = {}) {
  const l = el('label', undefined, cresce ? 'campo campo--cresce' : 'campo'); l.append(el('span', rotulo));
  const i = document.createElement('input'); i.type = tipo; i.value = valor; i.maxLength = max; i.placeholder = placeholder; l.append(i); return { rotulo: l, input: i };
}

/** Janela (dialog) reaproveitável: devolve { dlg, corpo, rodape, abrir, fechar }. O conteúdo é refeito a cada abertura. */
export function criarJanela(id, { larga = true } = {}) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = id; dlg.className = `janela sppl-modal${larga ? ' janela--larga' : ''}`;
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  const refazer = (titulo, subtitulo) => {
    dlg.replaceChildren();
    const cab = el('header', undefined, 'janela-cabeca'); const quem = el('div'); quem.append(el('h2', titulo)); if (subtitulo) quem.append(el('p', subtitulo, 'cartao-sub'));
    const x = el('button', undefined, 'btn btn-icone'); x.type = 'button'; x.title = 'Fechar'; x.append(el('span', '✕')); x.addEventListener('click', () => dlg.close());
    cab.append(quem, x);
    const corpo = el('div', undefined, 'janela-corpo');
    dlg.append(cab, corpo);
    return corpo;
  };
  return { dlg, refazer, abrir: () => { if (!dlg.open) dlg.showModal(); }, fechar: () => dlg.close() };
}

/** Selo colorido simples (reaproveita as classes de selo do SPPL). */
export function selo(texto, tom) { const s = el('span', texto, 'sppl-selo'); if (tom) s.dataset.tom = tom; return s; }

export function mensagem(alvo, texto, erro = false) { alvo.textContent = texto || ''; alvo.dataset.erro = erro ? '1' : ''; alvo.style.color = erro ? 'var(--st-travado)' : ''; }

/** Download de texto (CSV etc.). */
export async function copiarTexto(texto) { try { await navigator.clipboard.writeText(texto); return true; } catch { return false; } }
