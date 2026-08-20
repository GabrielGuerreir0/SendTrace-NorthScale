/**
 * Central de E-mail IA — Tela 4: Galeria de Imagens. Anexos analisados pela
 * IA (visão computacional) — fotos de produto, defeito, nota fiscal,
 * comprovante, print de tela, documento (§6).
 */
import {
  $, api, debounce, abrirFicha, celCliente,
  rotularTipoConteudo, rotularCategoria, rotularMotivo, rotularArea,
  rotularResponsavel, rotularPagamento, rotularPlataforma,
  chipSentimento, chipUrgencia,
} from './emailComum.js';
import { n, dataHora, truncar } from './format.js';
import { qsFiltroCE, aoMudarFiltroCE } from './emailFiltro.js';

const POR_PAGINA = 24;

let pagina = 1;
let tipoAtivo = null;
let busca = '';

/* ═══════════════════════════════  desenho  ═══════════════════════════════ */

function criarCard(item) {
  const div = document.createElement('article');
  div.className = 'gal-card gal-card--clique';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  div.title = 'Ver detalhes deste anexo';
  div.addEventListener('click', () => abrirDetalheAnexo(item.id));
  div.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrirDetalheAnexo(item.id); }
  });

  const ehImagem = (item.mime_type ?? '').startsWith('image/');
  const capa = document.createElement('div');
  capa.className = ehImagem ? 'gal-card-imagem' : 'gal-card-imagem gal-card-imagem--generico';
  if (ehImagem) {
    const img = document.createElement('img');
    img.src = `/api/imagem/${item.id}`;
    img.alt = item.nome_arquivo ?? '';
    img.loading = 'lazy';
    capa.append(img);
  } else {
    capa.textContent = '📄';
  }
  div.append(capa);

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

/* ═══════════════════════════════  detalhe (modal)  ═════════════════════════ */

function formatarBytes(n2) {
  if (!n2 && n2 !== 0) return '—';
  if (n2 < 1024) return `${n2} B`;
  if (n2 < 1024 * 1024) return `${(n2 / 1024).toFixed(1)} KB`;
  return `${(n2 / (1024 * 1024)).toFixed(1)} MB`;
}

/** A pré-visualização grande, no topo da ficha — trocada ao clicar numa miniatura. */
function montarPreview(anexo) {
  const container = document.createElement('div');
  container.className = 'gd-preview';

  const moldura = document.createElement('div');
  moldura.className = 'gd-preview-moldura';
  const ehImagem = (anexo.mime_type ?? '').startsWith('image/');
  if (ehImagem) {
    const img = document.createElement('img');
    img.src = `/api/imagem/${anexo.id}`;
    img.alt = anexo.nome_arquivo ?? '';
    moldura.append(img);
  } else {
    const ic = document.createElement('span');
    ic.className = 'gd-preview-icone';
    ic.textContent = '📄';
    moldura.append(ic);
  }
  container.append(moldura);

  const rodape = document.createElement('div');
  rodape.className = 'gd-preview-rodape';
  const nomeEl = document.createElement('span');
  nomeEl.textContent = anexo.nome_arquivo ?? '(sem nome)';
  rodape.append(nomeEl);
  if (ehImagem) {
    const link = document.createElement('a');
    link.href = `/api/imagem/${anexo.id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Abrir original em nova aba ↗';
    rodape.append(link);
  }
  container.append(rodape);

  return { container, moldura };
}

/**
 * Miniaturas dos OUTROS anexos do mesmo e-mail (mesmo `.gal-card--mini` da
 * mini-galeria de Mais Detalhes — ver emailDetalhes.js). Clicar troca a
 * pré-visualização grande no lugar, sem fechar/reabrir a ficha; imagem que
 * já está em foco fica marcada.
 */
function montarMiniaturas(anexoPrincipal, outros, moldura) {
  const container = document.createElement('div');
  container.className = 'gal-grade gal-grade--mini';
  if (!outros.length) {
    const p = document.createElement('p');
    p.className = 'vazio-suave';
    p.textContent = 'Nenhum outro anexo neste e-mail.';
    container.append(p);
    return container;
  }

  const todos = [anexoPrincipal, ...outros];
  const marcar = (id) => {
    for (const el of container.children) el.classList.toggle('gal-card--mini-ativo', Number(el.dataset.id) === id);
  };

  for (const item of todos) {
    const ehImagem = (item.mime_type ?? '').startsWith('image/');
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'gal-card gal-card--mini';
    el.dataset.id = item.id;
    el.title = item.nome_arquivo ?? '';
    if (ehImagem) {
      const im = document.createElement('img');
      im.src = `/api/imagem/${item.id}`;
      im.alt = item.nome_arquivo ?? '';
      im.loading = 'lazy';
      el.append(im);
    } else {
      const ic = document.createElement('span');
      ic.className = 'gal-icone';
      ic.textContent = '📄';
      el.append(ic);
    }
    el.addEventListener('click', () => {
      moldura.replaceChildren();
      if (ehImagem) {
        const img = document.createElement('img');
        img.src = `/api/imagem/${item.id}`;
        img.alt = item.nome_arquivo ?? '';
        moldura.append(img);
      } else {
        const ic = document.createElement('span');
        ic.className = 'gd-preview-icone';
        ic.textContent = '📄';
        moldura.append(ic);
      }
      marcar(item.id);
    });
    container.append(el);
  }
  marcar(anexoPrincipal.id);
  return container;
}

async function abrirDetalheAnexo(id) {
  const { ok, dados } = await api(`/api/anexo/${id}`);
  if (!ok) {
    abrirFicha({
      titulo: 'Anexo',
      campos: [{ rotulo: 'Erro', valor: dados?.erro ?? dados?.detail ?? 'Não consegui carregar este anexo.' }],
    });
    return;
  }

  const { anexo, email, pedido, outros_anexos: outros } = dados;
  const { container: preview, moldura } = montarPreview(anexo);
  const miniaturas = montarMiniaturas(anexo, outros, moldura);
  const temPedido = Boolean(pedido?.transacao_id);

  abrirFicha({
    titulo: anexo.nome_arquivo ?? 'Anexo',
    subtitulo: email
      ? `${email.remetente_nome || email.remetente_email} · ${dataHora(email.data_email)}`
      : `Recebido em ${dataHora(anexo.criado_em)}`,
    campos: [
      { rotulo: 'Pré-visualização', valor: preview, largo: true },
      { rotulo: 'Tipo de conteúdo', valor: rotularTipoConteudo(anexo.tipo_conteudo ?? 'sem_analise') },
      { rotulo: 'Defeito visível', valor: anexo.defeito_visivel ? 'Sim' : 'Não' },
      { rotulo: 'Tamanho', valor: formatarBytes(anexo.tamanho_bytes) },
      { rotulo: 'Recebido em', valor: dataHora(anexo.criado_em) },
      anexo.descricao_ia && { rotulo: 'Descrição da IA', valor: anexo.descricao_ia, largo: true },
      anexo.tags?.length && { rotulo: 'Tags', valor: anexo.tags.join(' · '), largo: true },

      email && { rotulo: 'Remetente', valor: celCliente(email.remetente_nome, email.remetente_email) },
      email && { rotulo: 'Assunto', valor: email.assunto },
      email && { rotulo: 'Categoria', valor: rotularCategoria(email.categoria) },
      email?.motivo_devolucao && { rotulo: 'Motivo da devolução', valor: rotularMotivo(email.motivo_devolucao) },
      email?.area_problema && { rotulo: 'Área do problema', valor: rotularArea(email.area_problema) },
      email?.responsavel && { rotulo: 'Responsável', valor: rotularResponsavel(email.responsavel) },
      email?.problema_pagamento && { rotulo: 'Problema de pagamento', valor: rotularPagamento(email.problema_pagamento) },
      email && { rotulo: 'Sentimento', valor: chipSentimento(email.sentimento) },
      email && { rotulo: 'Urgência', valor: chipUrgencia(email.urgencia) },
      email?.numero_pedido && { rotulo: 'Nº do pedido citado', valor: email.numero_pedido },
      email?.produto_mencionado && { rotulo: 'Produto mencionado', valor: email.produto_mencionado },
      email?.resumo && { rotulo: 'Resumo do e-mail (IA)', valor: email.resumo, largo: true },
      email?.corpo_texto && { rotulo: 'Trecho do e-mail', valor: truncar(email.corpo_texto, 600), largo: true },

      temPedido && { rotulo: 'Pedido vinculado', valor: `${pedido.transacao_id}${pedido.produto ? ` — ${pedido.produto}` : ''}` },
      temPedido && pedido.plataforma && { rotulo: 'Plataforma', valor: rotularPlataforma(pedido.plataforma) },
      temPedido && pedido.status_pedido && { rotulo: 'Status do pedido', valor: pedido.status_pedido },
      temPedido && pedido.pedido_em && { rotulo: 'Comprado em', valor: dataHora(pedido.pedido_em) },

      { rotulo: `Outros anexos deste e-mail (${outros.length})`, valor: miniaturas, largo: true },
    ],
  });
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
