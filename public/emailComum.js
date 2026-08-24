/**
 * Central de E-mail IA — utilitários compartilhados pelas 4 telas novas
 * (Tickets, Detalhes, Chat, Galeria). Mesma ideia de format.js/charts.js: um
 * arquivo por responsabilidade, importado por quem precisa — evita repetir o
 * mesmo desenho de KPI/tabela/paginação quatro vezes.
 */
import { n } from './format.js';

export const $ = (id) => document.getElementById(id);

/* ══════════════════════════  requisição autenticada  ═════════════════════ */

/**
 * Mesmo contrato do `api()` de app.js: a sessão é o cookie do painel, não um
 * token — o cabeçalho X-Painel é só a defesa de CSRF exigida em toda escrita.
 */
export async function api(rota, { metodo = 'GET', corpo } = {}) {
  const resp = await fetch(rota, {
    method: metodo,
    headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Painel': '1' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (resp.status === 401) { location.replace('/login'); throw new Error('sem sessão'); }
  let dados = {};
  try { dados = await resp.json(); } catch { /* corpo vazio */ }
  return { ok: resp.ok, status: resp.status, dados };
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ══════════════════════════  tooltip dos gráficos  ════════════════════════ */

/** Mesmo <div id="tooltip"> global que a régua já usa — um elemento só na página. */
const elTooltip = $('tooltip');
export const tooltip = {
  mostrar(html, x, y) {
    if (!elTooltip) return;
    elTooltip.innerHTML = html;
    elTooltip.hidden = false;
    const r = elTooltip.getBoundingClientRect();
    const margem = 14;
    let px = x + 16;
    let py = y + 16;
    if (px + r.width > innerWidth - margem) px = x - r.width - 16;
    if (py + r.height > innerHeight - margem) py = y - r.height - 16;
    elTooltip.style.left = `${Math.max(margem, px)}px`;
    elTooltip.style.top = `${Math.max(margem, py)}px`;
  },
  esconder() { if (elTooltip) elTooltip.hidden = true; },
};

/* ══════════════════════════  rótulos dos enums (§2.6)  ════════════════════ */

export const LABEL_CATEGORIA = {
  devolucao: 'Devolução', reclamacao: 'Reclamação', duvida_produto: 'Dúvida sobre produto',
  duvida_pedido: 'Dúvida sobre pedido', orcamento: 'Orçamento', elogio: 'Elogio',
  troca: 'Troca', garantia: 'Garantia', outro: 'Outro',
};
export const LABEL_MOTIVO_DEVOLUCAO = {
  produto_com_defeito: 'Produto com defeito', produto_errado: 'Produto errado',
  dano_no_transporte: 'Dano no transporte', atraso_na_entrega: 'Atraso na entrega',
  arrependimento: 'Arrependimento', tamanho_ou_medida_errada: 'Tamanho/medida errada',
  diferente_do_anuncio: 'Diferente do anúncio', compra_duplicada: 'Compra duplicada', outro: 'Outro',
};
export const LABEL_AREA_PROBLEMA = {
  entrega: 'Entrega', produto: 'Produto', codigo_rastreio: 'Código de rastreio',
  pagamento: 'Pagamento', atendimento: 'Atendimento', anuncio_informacao: 'Anúncio/informação', outro: 'Outro',
};
export const LABEL_RESPONSAVEL = {
  transportadora: 'Transportadora', fulfillment: 'Fulfillment', nossa_empresa: 'Nossa empresa',
  fabricante: 'Fabricante', plataforma_pagamento: 'Plataforma de pagamento', cliente: 'Cliente', indefinido: 'Indefinido',
};
export const LABEL_PROBLEMA_PAGAMENTO = {
  compra_nao_reconhecida: 'Compra não reconhecida', cobranca_duplicada: 'Cobrança duplicada',
  cobranca_valor_maior: 'Cobrança de valor maior', pede_cancelamento_reembolso: 'Pede cancelamento/reembolso',
  reembolso_nao_recebido: 'Reembolso não recebido', outro_pagamento: 'Outro', sem_problema_pagamento: 'Sem problema',
};
export const LABEL_PLATAFORMA = {
  digistore24: 'DigiStore24', buygoods: 'BuyGoods', jvzoo: 'JVZoo', interno: 'Interno',
  hotmart: 'Hotmart', eduzz: 'Eduzz', monetizze: 'Monetizze', kiwify: 'Kiwify',
  clickbank: 'ClickBank', cartpanda: 'CartPanda', braintree: 'Braintree', paypal: 'PayPal',
  stripe: 'Stripe', shipoffers: 'ShipOffers', helpdesk: 'Helpdesk',
};
export const LABEL_TIPO_CONTEUDO = {
  foto_produto: 'Foto de produto', defeito: 'Defeito', nota_fiscal: 'Nota fiscal',
  comprovante: 'Comprovante', print_tela: 'Print de tela', documento: 'Documento', outro: 'Outro',
  sem_analise: 'Sem análise',
};
export const LABEL_ETAPA_AUTOMACAO = {
  gerando_resposta: 'Gerando resposta', enviando: 'Enviando', enviado: 'Enviado',
  erro_ia: 'Erro na IA', erro_envio: 'Erro no envio',
};

const rotular = (mapa, valor) => (valor ? (mapa[valor] ?? valor) : '—');
export const rotularCategoria = (v) => rotular(LABEL_CATEGORIA, v);
export const rotularMotivo = (v) => rotular(LABEL_MOTIVO_DEVOLUCAO, v);
export const rotularArea = (v) => rotular(LABEL_AREA_PROBLEMA, v);
export const rotularResponsavel = (v) => rotular(LABEL_RESPONSAVEL, v);
export const rotularPagamento = (v) => rotular(LABEL_PROBLEMA_PAGAMENTO, v);
export const rotularPlataforma = (v) => rotular(LABEL_PLATAFORMA, v);
export const rotularTipoConteudo = (v) => rotular(LABEL_TIPO_CONTEUDO, v);

/* ══════════════════════════  chips de estado  ═════════════════════════════
   Reaproveita .selo-estado (já usado pelos 6 estados da régua) com novos
   valores de data-e — as cores (§styles.css) são adicionadas junto. */

function chip(dataE, rotulo) {
  const span = document.createElement('span');
  span.className = 'selo-estado';
  span.dataset.e = dataE;
  const i = document.createElement('i');
  i.textContent = '●';
  span.append(i, document.createTextNode(rotulo));
  return span;
}

const ROT_TICKET = { nao_iniciado: 'Não iniciado', em_aberto: 'Em aberto', resolvido: 'Resolvido' };
export const chipTicket = (status) => chip(`tk-${status}`, ROT_TICKET[status] ?? status ?? '—');

const ROT_SENTIMENTO = { positivo: 'Positivo', neutro: 'Neutro', negativo: 'Negativo', muito_negativo: 'Muito negativo' };
export const chipSentimento = (v) => chip(`sent-${v}`, ROT_SENTIMENTO[v] ?? v ?? '—');

const ROT_URGENCIA = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
export const chipUrgencia = (v) => chip(`urg-${v}`, ROT_URGENCIA[v] ?? v ?? '—');

const ROT_ETAPA_AUTOMACAO = LABEL_ETAPA_AUTOMACAO;
export const chipEtapaAutomacao = (v) => chip(`auto-${v}`, ROT_ETAPA_AUTOMACAO[v] ?? v ?? '—');

const ROT_SITUACAO_PEDIDO = { nao_cancelado: 'Não cancelado', ja_cancelado: 'Já cancelado', sem_pedido_vinculado: 'Sem pedido vinculado' };
export const chipSituacaoPedido = (v) => chip(`sit-${v}`, ROT_SITUACAO_PEDIDO[v] ?? v ?? '—');

/* ══════════════════════════  copiar e-mail  ═══════════════════════════════
   Um botão pequeno reaproveitado em toda a Central de E-mail IA (tickets,
   detalhes, suporte escalado) — sempre que um e-mail de cliente aparece na
   tela, este botão fica do lado. `stopPropagation` porque várias dessas
   linhas/cartões já têm o próprio clique (expandir resumo, arrastar) — clicar
   em copiar não pode disparar os dois. */

export function botaoCopiar(valor, { titulo = 'Copiar e-mail' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-copiar';
  b.title = titulo;
  b.setAttribute('aria-label', titulo);
  b.textContent = '⧉';
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(valor);
    } catch {
      window.prompt('Copie manualmente:', valor);
      return;
    }
    b.textContent = '✓';
    b.classList.add('btn-copiar--ok');
    setTimeout(() => { b.textContent = '⧉'; b.classList.remove('btn-copiar--ok'); }, 1200);
  });
  return b;
}

/** Nome (ou e-mail, se não houver nome) em negrito + linha do e-mail com o botão de copiar. */
export function celCliente(nome, email) {
  const div = document.createElement('div');
  const nomeEl = document.createElement('span');
  nomeEl.className = 'cel-forte';
  nomeEl.textContent = nome || email || '—';
  div.append(nomeEl);
  if (email) {
    const linha = document.createElement('div');
    linha.className = 'cel-email-linha';
    const sub = document.createElement('span');
    sub.className = 'cel-sub';
    sub.textContent = email;
    linha.append(sub, botaoCopiar(email, { titulo: `Copiar ${email}` }));
    div.append(linha);
  }
  return div;
}

/* ══════════════════════════════════  KPI  ══════════════════════════════════
   Mesmo desenho do card de Suporte IA (kpi/kpi-topo/kpi-valor/kpi-nota),
   generalizado para as duas telas novas que também precisam de KPIs clicáveis. */

export function kpiCard({
  icone = '●', tom = 'neutro', rotulo, valor, nota = '', onClick = null, ativo = false,
}) {
  const el = document.createElement(onClick ? 'button' : 'div');
  el.className = onClick ? 'kpi kpi--clique' : 'kpi';
  el.dataset.tom = tom;
  if (ativo) el.dataset.ativo = 'sim';
  if (onClick) {
    el.type = 'button';
    el.addEventListener('click', onClick);
  }
  const topo = document.createElement('div');
  topo.className = 'kpi-topo';
  const ico = document.createElement('span'); ico.className = 'kpi-ico'; ico.textContent = icone;
  const rot = document.createElement('span'); rot.className = 'kpi-rotulo'; rot.textContent = rotulo;
  topo.append(ico, rot);
  const val = document.createElement('div'); val.className = 'kpi-valor'; val.textContent = valor;
  const sub = document.createElement('div'); sub.className = 'kpi-nota'; sub.textContent = nota;
  el.append(topo, val, sub);
  return el;
}

/* ═══════════════════════════  barra horizontal  ═══════════════════════════
   Motivos/categorias/áreas/responsáveis/pagamento/plataformas — todas a
   mesma forma: rótulo + número + barra proporcional ao maior valor. */

export function barraHorizontal(container, itens, campo, {
  rotular: fnRotular = (v) => v, onClick = null, vazio = 'Sem dados no período.',
} = {}) {
  container.replaceChildren();
  if (!itens.length) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = vazio;
    container.append(p);
    return;
  }
  const max = Math.max(...itens.map((i) => i.total));
  const ul = document.createElement('ul');
  ul.className = 'sup-ranking';
  for (const item of itens) {
    const chave = item[campo];
    const li = document.createElement('li');
    li.className = 'sup-item';
    if (onClick) {
      li.classList.add('sup-linha-clique');
      li.tabIndex = 0;
      li.addEventListener('click', () => onClick(chave));
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onClick(chave); });
    }
    const rot = document.createElement('span'); rot.className = 'sup-item-rotulo'; rot.textContent = fnRotular(chave);
    const num = document.createElement('span'); num.className = 'sup-item-num'; num.textContent = n(item.total);
    const barra = document.createElement('span'); barra.className = 'sup-item-barra';
    const cheio = document.createElement('span');
    cheio.style.width = `${max > 0 ? Math.max(2, (item.total / max) * 100) : 0}%`;
    barra.append(cheio);
    li.append(rot, num, barra);
    ul.append(li);
  }
  container.append(ul);
}

/* ══════════════════════════  ficha de detalhe (linha → modal)  ═════════════
   Reaproveitada por toda tela que tem "linha representa um registro"
   (lead da régua, ticket, reincidente, reclamante, cliente de risco,
   conversa de suporte) — em vez de espremer tudo numa linha só, o clique
   abre esta grade de campo:valor com o registro inteiro. */

export function renderFicha(container, campos) {
  container.replaceChildren(...campos.filter(Boolean).map(({ rotulo, valor, largo = false }) => {
    const div = document.createElement('div');
    div.className = largo ? 'mf-campo mf-campo--largo' : 'mf-campo';
    const dt = document.createElement('span');
    dt.className = 'mf-campo-rotulo';
    dt.textContent = rotulo;
    const dd = document.createElement('div');
    dd.className = 'mf-campo-valor';
    if (valor instanceof Node) dd.append(valor);
    else dd.textContent = (valor === null || valor === undefined || valor === '') ? '—' : String(valor);
    div.append(dt, dd);
    return div;
  }));
}

/**
 * Modal genérico de ficha (#modal-ficha, único no documento — reaproveitado
 * por qualquer aba, já que todas as abas/diálogos convivem no mesmo HTML).
 * Uso: registro simples, sem lista vinculada (ex.: uma conversa de suporte,
 * um e-mail de "últimos"). Quando o registro tem uma LISTA vinculada (ex.:
 * todos os e-mails de um cliente), as telas de e-mail IA reaproveitam o
 * modal #dt-emails-modal (ver abrirModalEmails em emailDetalhes.js), que já
 * resolve paginação — este aqui é só ficha, sem tabela.
 */
export function abrirFicha({ titulo, subtitulo = '', campos = [] }) {
  $('mf-titulo').textContent = titulo;
  $('mf-subtitulo').textContent = subtitulo;
  renderFicha($('mf-campos'), campos);
  $('modal-ficha').showModal();
}

$('mf-fechar')?.addEventListener('click', () => $('modal-ficha').close());

/* ═══════════════════════════════  tabela genérica  ═════════════════════════ */

export function renderTabela(corpoEl, linhas, colunas, { vazio = 'Nada encontrado.' } = {}) {
  if (!linhas.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colunas.length;
    td.className = 'vazio-suave';
    td.textContent = vazio;
    tr.append(td);
    corpoEl.replaceChildren(tr);
    return;
  }
  corpoEl.replaceChildren(...linhas.map((linha) => {
    const tr = document.createElement('tr');
    if (colunas.aoClicarLinha) {
      tr.classList.add('sup-linha-clique');
      tr.addEventListener('click', () => colunas.aoClicarLinha(linha));
    }
    for (const col of colunas) {
      const td = document.createElement('td');
      if (col.classe) td.className = col.classe;
      const conteudo = col.render(linha);
      if (conteudo instanceof Node) td.append(conteudo);
      else td.textContent = conteudo ?? '';
      tr.append(td);
    }
    return tr;
  }));
}

/* ═══════════════════════════════  paginação  ═══════════════════════════════ */

export function paginar(itens, pagina, porPagina) {
  const totalPaginas = Math.max(1, Math.ceil(itens.length / porPagina));
  const p = Math.min(Math.max(1, pagina), totalPaginas);
  const inicio = (p - 1) * porPagina;
  return { pagina: p, totalPaginas, fatia: itens.slice(inicio, inicio + porPagina) };
}

/** Mesma forma da paginação da régua: .paginacao > #pag-info + .pag-botoes. */
export function montarPaginacao(container, { pagina, totalPaginas, total, rotuloItem = 'item' }, aoTrocar) {
  container.classList.add('paginacao');
  container.replaceChildren();

  const info = document.createElement('span');
  info.textContent = `página ${pagina} de ${totalPaginas} · ${n(total)} ${rotuloItem}${total === 1 ? '' : 's'}`;

  const botoes = document.createElement('div');
  botoes.className = 'pag-botoes';
  const btnAnt = document.createElement('button');
  btnAnt.className = 'btn btn-fantasma'; btnAnt.type = 'button'; btnAnt.textContent = 'Anterior';
  btnAnt.disabled = pagina <= 1;
  btnAnt.addEventListener('click', () => aoTrocar(pagina - 1));
  const btnProx = document.createElement('button');
  btnProx.className = 'btn btn-fantasma'; btnProx.type = 'button'; btnProx.textContent = 'Próxima';
  btnProx.disabled = pagina >= totalPaginas;
  btnProx.addEventListener('click', () => aoTrocar(pagina + 1));
  botoes.append(btnAnt, btnProx);

  container.append(info, botoes);
}

/* ═══════════════════════════════  CSV  ═════════════════════════════════════
   Ponto e vírgula + BOM UTF-8, exatamente como a especificação pede (§3.8, §4.13). */

export function baixarCsv(nomeArquivo, cabecalho, linhas) {
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const corpo = [cabecalho, ...linhas].map((l) => l.map(escapar).join(';')).join('\r\n');
  const blob = new Blob([`﻿${corpo}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════  markdown mínimo (para o chat)  ═══════════════════
   Sem dependência externa: negrito, itálico, código inline, blocos de
   código, links, listas, tabelas e citação — o subconjunto do §5.1. */

export function markdownParaHtml(texto) {
  const escapar = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(s) {
    let out = escapar(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  const linhas = String(texto ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocos = [];
  let i = 0;
  while (i < linhas.length) {
    const linha = linhas[i];

    if (linha.trim().startsWith('```')) {
      const ling = linha.trim().slice(3).trim();
      const codigo = [];
      i += 1;
      while (i < linhas.length && !linhas[i].trim().startsWith('```')) { codigo.push(linhas[i]); i += 1; }
      i += 1;
      blocos.push(`<pre><code${ling ? ` data-lang="${escapar(ling)}"` : ''}>${escapar(codigo.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(linha) && linhas[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(linhas[i + 1])) {
      const linhasTabela = [linha];
      i += 2; // pula a linha separadora (|---|---|)
      while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) { linhasTabela.push(linhas[i]); i += 1; }
      const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [cab, ...corpo] = linhasTabela;
      const th = celulas(cab).map((c) => `<th>${inline(c)}</th>`).join('');
      const trs = corpo.map((l) => `<tr>${celulas(l).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      blocos.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    if (/^\s*>/.test(linha)) {
      const cit = [];
      while (i < linhas.length && /^\s*>/.test(linhas[i])) { cit.push(linhas[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocos.push(`<blockquote>${inline(cit.join(' '))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(linha)) {
      const itens = [];
      while (i < linhas.length && /^\s*[-*]\s+/.test(linhas[i])) {
        itens.push(`<li>${inline(linhas[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      blocos.push(`<ul>${itens.join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(linha)) {
      const itens = [];
      while (i < linhas.length && /^\s*\d+[.)]\s+/.test(linhas[i])) {
        itens.push(`<li>${inline(linhas[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i += 1;
      }
      blocos.push(`<ol>${itens.join('')}</ol>`);
      continue;
    }

    if (!linha.trim()) { i += 1; continue; }

    const paragrafo = [];
    while (i < linhas.length && linhas[i].trim()
      && !/^\s*[-*]\s+|^\s*\d+[.)]\s+|^\s*>|^\s*```|^\s*\|/.test(linhas[i])) {
      paragrafo.push(linhas[i]);
      i += 1;
    }
    blocos.push(`<p>${inline(paragrafo.join(' '))}</p>`);
  }
  return blocos.join('\n');
}
