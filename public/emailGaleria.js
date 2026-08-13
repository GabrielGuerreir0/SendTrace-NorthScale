/**
 * Central de E-mail IA — Tela 4: Galeria de Imagens. Anexos analisados pela
 * IA (visão computacional) — fotos de produto, defeito, nota fiscal,
 * comprovante, print de tela, documento (§6).
 */
import {
  $, api, debounce, rotularTipoConteudo,
} from './emailComum.js';
import { n, dataHora } from './format.js';
import { qsFiltroCE, aoMudarFiltroCE } from './emailFiltro.js';

const POR_PAGINA = 24;

let pagina = 1;
let tipoAtivo = null;
let busca = '';

/* ═══════════════════════════════  desenho  ═══════════════════════════════ */

function criarCard(item) {
  const div = document.createElement('article');
  div.className = 'gal-card';

  const ehImagem = (item.mime_type ?? '').startsWith('image/');
  const a = document.createElement('a');
  a.className = ehImagem ? 'gal-card-imagem' : 'gal-card-imagem gal-card-imagem--generico';
  if (ehImagem) {
    a.href = `/api/imagem/${item.id}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Abrir imagem original em nova aba';
    const img = document.createElement('img');
    img.src = `/api/imagem/${item.id}`;
    img.alt = item.nome_arquivo ?? '';
    img.loading = 'lazy';
    a.append(img);
  } else {
    a.href = '#';
    a.addEventListener('click', (ev) => ev.preventDefault());
    a.textContent = '📄';
  }
  div.append(a);

  const corpo = document.createElement('div');
  corpo.className = 'gal-card-corpo';

  const chips = document.createElement('div');
  chips.className = 'gal-card-chips';
  const chipTipo = document.createElement('span');
  chipTipo.className = 'gal-chip';
  chipTipo.textContent = rotularTipoConteudo(item.tipo_conteudo ?? 'sem_analise');
  chips.append(chipTipo);
  if (item.defeito_visivel) {
    const chipDefeito = document.createElement('span');
    chipDefeito.className = 'gal-chip gal-chip--defeito';
    chipDefeito.textContent = 'defeito visível';
    chips.append(chipDefeito);
  }
  corpo.append(chips);

  const nome = document.createElement('p');
  nome.className = 'gal-card-nome';
  nome.textContent = item.nome_arquivo ?? '(sem nome)';
  corpo.append(nome);

  if (item.descricao_ia) {
    const desc = document.createElement('p');
    desc.className = 'gal-card-descricao';
    desc.textContent = item.descricao_ia;
    corpo.append(desc);
  }

  if (item.tags?.length) {
    const tags = document.createElement('p');
    tags.className = 'gal-card-tags';
    tags.textContent = item.tags.join(' · ');
    corpo.append(tags);
  }

  const quem = document.createElement('p');
  quem.className = 'gal-card-quem';
  const dataRef = item.data_email ?? item.criado_em;
  quem.textContent = [
    item.remetente_nome || item.remetente_email || 'remetente desconhecido',
    dataRef ? dataHora(dataRef) : null,
    item.assunto,
  ].filter(Boolean).join(' · ');
  corpo.append(quem);

  div.append(corpo);
  return div;
}

function renderChips(tipos) {
  const totalGeral = tipos.reduce((a, t) => a + t.total, 0);
  const container = $('gl-chips');
  container.replaceChildren();

  const todos = document.createElement('button');
  todos.className = 'gal-chip-filtro';
  todos.type = 'button';
  todos.textContent = `Todos (${n(totalGeral)})`;
  todos.setAttribute('aria-pressed', String(!tipoAtivo));
  todos.addEventListener('click', () => { tipoAtivo = null; pagina = 1; carregar(); });
  container.append(todos);

  for (const t of tipos) {
    const b = document.createElement('button');
    b.className = 'gal-chip-filtro';
    b.type = 'button';
    b.textContent = `${rotularTipoConteudo(t.tipo)} (${n(t.total)})`;
    b.setAttribute('aria-pressed', String(tipoAtivo === t.tipo));
    b.addEventListener('click', () => { tipoAtivo = t.tipo; pagina = 1; carregar(); });
    container.append(b);
  }
}

function renderPaginacao(total) {
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const container = $('gl-paginacao');
  container.classList.add('paginacao');
  container.replaceChildren();

  const info = document.createElement('span');
  info.textContent = `página ${pagina} de ${totalPaginas} · ${n(total)} anexo${total === 1 ? '' : 's'}`;

  const botoes = document.createElement('div');
  botoes.className = 'pag-botoes';
  const btnAnt = document.createElement('button');
  btnAnt.className = 'btn btn-fantasma'; btnAnt.type = 'button'; btnAnt.textContent = '‹ Anterior';
  btnAnt.disabled = pagina <= 1;
  btnAnt.addEventListener('click', () => { pagina -= 1; carregar(); });
  const btnProx = document.createElement('button');
  btnProx.className = 'btn btn-fantasma'; btnProx.type = 'button'; btnProx.textContent = 'Próxima ›';
  btnProx.disabled = pagina >= totalPaginas;
  btnProx.addEventListener('click', () => { pagina += 1; carregar(); });
  botoes.append(btnAnt, btnProx);

  container.append(info, botoes);
}

/* ═══════════════════════════════  carregamento  ═══════════════════════════ */

let geracao = 0;

async function carregar() {
  const meu = ++geracao;
  const qs = qsFiltroCE();
  qs.set('pagina', String(pagina));
  qs.set('por_pagina', String(POR_PAGINA));
  if (tipoAtivo) qs.set('tipo', tipoAtivo);
  if (busca) qs.set('q', busca);

  try {
    const { ok, dados } = await api(`/api/galeria?${qs}`);
    if (meu !== geracao) return;
    if (!ok) throw new Error(dados?.erro ?? 'falha ao carregar');

    renderChips(dados.tipos ?? []);

    const grade = $('gl-grade');
    grade.replaceChildren();
    if (!dados.itens?.length) {
      const p = document.createElement('p');
      p.className = 'vazio-suave';
      p.textContent = 'Nenhum anexo encontrado com este filtro.';
      grade.append(p);
    } else {
      grade.append(...dados.itens.map(criarCard));
    }
    renderPaginacao(dados.total ?? 0);
  } catch (err) {
    if (meu !== geracao) return;
    const grade = $('gl-grade');
    grade.replaceChildren();
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = `Não consegui carregar a galeria: ${err.message}`;
    grade.append(p);
  }
}

$('gl-busca').addEventListener('input', debounce((e) => {
  busca = e.target.value.trim();
  pagina = 1;
  carregar();
}, 350));

aoMudarFiltroCE(() => { pagina = 1; carregar(); });

carregar();
