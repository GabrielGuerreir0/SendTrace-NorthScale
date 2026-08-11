import { criarRegua, CORES_ESTADO, CANAIS_META, definirCanais } from './regua.js';
import { criarPrevia } from './previa.js';
// Mesmas regras que o servidor aplica ao salvar — avisam enquanto se digita.
import { validarMensagem, medirSms } from './copy.js';
import { desenharColunas, svgEl } from './charts.js';
import { n, nc, relativo, dataHora, dia, hora, truncar, duracaoH } from './format.js';
import { paraEsperaH, deEsperaH } from './tempo.js';
import { snapshotDemo, pedidosDemo } from './demo.js';
// A aba principal (Suporte IA) vive em módulo próprio; importá-lo também liga
// os botões de aba — de TODAS as abas, régua e Central de E-mail IA incluídas
// (ver suporte.js). Aqui só acoplamos o carregamento aos ciclos do painel.
import { carregarSuporte } from './suporte.js';
// As 4 telas da Central de E-mail IA são autossuficientes: cada uma carrega
// seus próprios dados e mantém seu próprio timer assim que o módulo é
// importado — não precisam de nenhum acoplamento aqui, só do import.
import './emailTickets.js';
import './emailDetalhes.js';
import './emailChat.js';
import './emailGaleria.js';

/* Mesmos traçados usados nos nós do canvas, para o card por canal falar a
   mesma língua visual que o fluxo. */
const GLIFOS_CANAL = {
  envelope: 'M2.2 4h11.6v8H2.2z M2.2 4.4l5.8 4.1 5.8-4.1',
  sms: 'M2.2 3.2h11.6v7.2H7.4L4.4 13v-2.6H2.2z',
  interrogacao: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z M6.4 6.3c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6c0 1.2-1.6 1.1-1.6 2.6 M8 11.2v.1',
};

const $ = (id) => document.getElementById(id);

const ESTADOS = [
  { id: 'em_dia',      label: 'Em dia',      icone: '●' },
  { id: 'atrasado',    label: 'Atrasado',    icone: '▲' },
  { id: 'processando', label: 'Processando', icone: '◐' },
  { id: 'travado',     label: 'Travado',     icone: '■' },
  { id: 'finalizado',  label: 'Finalizado',  icone: '✓' },
  // Cancelado é estado próprio, não um sabor de "finalizado": quem cancelou
  // não concluiu a régua, e contá-lo junto afirmaria o contrário.
  { id: 'cancelado',   label: 'Cancelado',   icone: '✕' },
];
const ROTULO_ESTADO = Object.fromEntries(ESTADOS.map((e) => [e.id, e]));

/* ══════════════════════════════  tema  ══════════════════════════════ */

const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.dataset.theme = temaSalvo;

function temaEfetivo() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function pintarBotaoTema() {
  $('ico-tema').textContent = temaEfetivo() === 'dark' ? '☀' : '☾';
}
$('btn-tema').addEventListener('click', () => {
  const novo = temaEfetivo() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = novo;
  localStorage.setItem('tema', novo);
  pintarBotaoTema();
  redesenharGraficos();      // as cores dos gráficos vêm de variáveis CSS
});
pintarBotaoTema();

/* ════════════════════════════  tooltip  ═════════════════════════════ */

const elTooltip = $('tooltip');
const tooltip = {
  mostrar(html, x, y) {
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
  esconder() { elTooltip.hidden = true; },
};

/* ═════════════════════════════  estado  ═════════════════════════════ */

const estado = {
  usuario: null,
  emailConfigurado: false,
  conviteDias: null,
  versao: null,
  // Linha de copy DESENHADA na tela × linha que está no ar. Podem divergir
  // enquanto alguém confere outra versão antes de ativá-la.
  linhaExibindo: null,
  linhaAtiva: null,
  // De qual produto é a copy exibida no fluxo. '*' = padrão. NÃO confundir com
  // `produto` (abaixo), que recorta a FILA — são perguntas diferentes.
  copyProduto: '*',
  snapshot: null,
  demo: false,
  // De minuto em minuto. Precisa casar com o <option selected> do seletor: se
  // divergirem, a tela diz um intervalo e o timer usa outro.
  intervalo: 60000,
  timer: null,
  filtros: { etapa: null, estado: null, canal: null, problema: null, busca: '', ordem: 'proximo' },
  graficos: { etapa: null, canal: null },
  // Recortes do painel INTEIRO. Diferentes dos filtros acima (que só valem
  // para a tabela) e dos de gráfico (que só valem para os dois temporais).
  // Os dois se combinam: "este produto, nesta plataforma".
  produto: null,
  plataforma: null,
  pagina: { limit: 25, offset: 0, total: 0 },
};

/**
 * Selos de geração. Cada carregamento pega um número; ao voltar, só pinta se
 * ainda for o mais recente. Sem isso duas requisições em voo (o timer de 10 s
 * cruzando com o debounce da busca, ou o clique em Demo) chegam fora de ordem
 * e a resposta velha sobrescreve a nova — a tabela passa a mostrar dados que
 * não correspondem aos filtros que estão na tela.
 */
let geracaoPedidos = 0;
let geracaoSnapshot = 0;

const regua = criarRegua($('canvas-area'), {
  tooltip,
  aoClicarEtapa(item) {
    // 'na_regua' = tudo que não é finalizado. O número que o contador mostra é
    // `na_etapa`, que exclui os finalizados que pararam ali; filtrar só por
    // etapa traria esses de volta e a tabela contradiria o número clicado.
    $('f-etapa').value = item.terminal ? '' : String(item.etapa);
    $('f-estado').value = item.terminal ? 'finalizado' : 'na_regua';
    estado.filtros.etapa = item.terminal ? null : item.etapa;
    estado.filtros.estado = item.terminal ? 'finalizado' : 'na_regua';
    estado.pagina.offset = 0;
    carregarPedidos();
    document.querySelector('.tabela-envolve').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  // Clicar num nó de mensagem abre a janela de pré-visualização/edição —
  // `previa` é declarada mais abaixo, mas o clique só acontece bem depois.
  aoAbrirMensagem: (m, etapa, amostra) => {
    /*
     * A moldura do e-mail (link do e-book, e-mail de suporte) segue a MESMA
     * cascata da copy: primeiro os valores do produto, senão os do padrão
     * '*' — nunca os dois hardcoded do `previa.js`, que são só o último
     * degrau caso a API ainda não tenha a linha '*' cadastrada (deploy em
     * fases). Sem a cascata, a prévia de um produto sem e-book próprio
     * mostraria um link que não é nem o dele nem o que o cliente recebe.
     */
    const meta = m.produto && m.produto !== '*'
      ? (estado.snapshot?.catalogoProdutos ?? []).find((p) => p.slug === m.produto)
      : null;
    const padrao = estado.snapshot?.catalogoPadrao ?? null;
    const marca = {
      ...(meta?.link_ebook || padrao?.link_ebook
        ? { ebook: meta?.link_ebook || padrao?.link_ebook } : {}),
      ...(meta?.email_suporte || padrao?.email_suporte
        ? { suporte: meta?.email_suporte || padrao?.email_suporte } : {}),
    };
    previa.abrir(m, etapa, amostra, {
      // Editar a copy muda o que sai para os clientes; o servidor também exige.
      podeEditar: Boolean(estado.usuario?.admin),
      produtoNome: meta?.nome ?? (m.produto && m.produto !== '*' ? m.produto : null),
      marca: Object.keys(marca).length ? marca : null,
    });
    // "Voltar ao padrão" só faz sentido numa versão de produto que já existe.
    $('ed-padrao').hidden = !(estado.usuario?.admin && m.produto && m.produto !== '*' && !m.novo);
  },
  // Clicar no relógio do fluxo abre a MESMA janela do botão "Tempos", já
  // apontada para a etapa clicada — sem admin, o relógio não abre nada.
  aoAbrirTempo: (origem) => {
    if (!estado.usuario?.admin) return;
    abrirTempos(origem.etapa);
  },
});

/** Redesenha só o fluxo, com a copy do produto escolhido — sem ir à rede. */
function pintarRegua(s) {
  regua.atualizar({
    etapas: s.etapas,
    totais: s.totais,
    canais: s.canais ?? CANAIS_META,
    destinos: s.destinos,
    linha: s.linha,
    piorCaso: s.piorCasoSms,
    copyProduto: estado.copyProduto,
    catalogo: s.catalogoProdutos,
  });
}

/* ── editor de copy, acoplado à janela de pré-visualização ── */

const CAMPOS_COMPARADOS = ['assunto', 'corpo_html', 'botao', 'destino', 'texto'];

const editor = {
  painel: $('previa-editar'),
  botao: $('previa-modo-editar'),

  /** Houve alteração não salva? */
  sujo(rascunho, original) {
    if (!rascunho || !original) return false;
    return CAMPOS_COMPARADOS.some((k) => (rascunho[k] ?? '') !== (original[k] ?? ''));
  },

  /** Preenche o formulário quando a janela abre. */
  carregar(m, etapa) {
    editor.etapa = etapa;
    const eEmail = m.canal === 'email';
    $('editar-campos-email').hidden = !eEmail;
    $('editar-campos-sms').hidden = eEmail;

    $('ed-assunto').value = m.assunto ?? '';
    $('ed-botao').value = m.botao ?? '';
    $('ed-destino').value = m.destino ?? '';
    $('ed-corpo').value = m.corpo_html ?? '';
    $('ed-descricao').value = eEmail ? (m.texto ?? '') : '';
    $('ed-sms').value = eEmail ? '' : (m.texto ?? '');

    editor.avisarSeForPadrao(m, etapa);
    editor.aoMudarRascunho(m, m);
  },

  /**
   * O acidente mais provável do editor: mexer no texto PADRÃO ('*') achando
   * que é a versão de um produto. Só dispara quando existe produto que ainda
   * herda esta etapa+canal — se todos já têm versão própria, editar aqui não
   * afeta mais ninguém além de quem está de fato vendo o padrão.
   */
  avisarSeForPadrao(m, etapa) {
    const aviso = $('ed-aviso-padrao');
    const ehPadrao = !m.produto || m.produto === '*';
    if (!ehPadrao) { aviso.hidden = true; return; }

    const catalogo = estado.snapshot?.catalogoProdutos ?? [];
    const etapaSnap = (estado.snapshot?.etapas ?? []).find((e) => e.etapa === etapa.etapa);
    const proprios = new Set(
      (etapaSnap?.mensagens ?? [])
        .filter((x) => x.canal === m.canal && x.ativo !== false && String(x.produto ?? '*') !== '*')
        .map((x) => String(x.produto)),
    );
    const herdam = catalogo.filter((p) => !proprios.has(p.slug));

    if (!herdam.length) { aviso.hidden = true; return; }
    const nomes = herdam.length <= 3
      ? herdam.map((p) => p.nome).join(', ')
      : `${herdam.slice(0, 2).map((p) => p.nome).join(', ')} e mais ${herdam.length - 2}`;
    aviso.textContent = `⚠ Este texto vale para ${herdam.length} produto${herdam.length > 1 ? 's' : ''} `
      + `(${nomes}). Alterando aqui, todos eles mudam.`;
    aviso.hidden = false;
  },

  /** Reage a cada tecla: mede o SMS e mostra os avisos das regras de copy. */
  aoMudarRascunho(rascunho, original) {
    const { erros, avisos } = validarMensagem(rascunho);
    const alterado = editor.sujo(rascunho, original);

    const el = $('ed-avisos');
    const linhas = [...erros.map((e) => `✖ ${e}`), ...avisos.map((a) => `▲ ${a}`)];
    el.textContent = linhas.join('\n');
    el.hidden = !linhas.length;
    el.dataset.tom = erros.length ? 'erro' : 'aviso';

    if (rascunho.canal === 'sms') {
      const med = medirSms(rascunho.texto ?? '');
      const m = $('ed-medida');
      m.textContent = `${med.unidades}/${med.limite} caracteres · `
        + (med.segmentos === 1 ? '1 segmento' : `${med.segmentos} segmentos · custa o dobro`)
        + (med.unicode ? ' · fora do GSM-7' : '');
      m.dataset.alerta = med.segmentos > 1 || med.unicode ? 'sim' : 'nao';
    }

    $('ed-salvar').disabled = erros.length > 0 || !alterado;
    $('ed-reverter').disabled = !alterado;
    $('ed-estado').textContent = alterado ? 'alterações não salvas' : '';
  },
};

const previa = criarPrevia({
  dialogo: $('janela-previa'),
  caixa: $('previa-quadro-caixa'),
  codigo: $('previa-codigo'),
  titulo: $('previa-tit'),
  sub: $('previa-sub'),
  nota: $('previa-nota'),
  modos: $('previa-modos'),
  fechar: $('fechar-previa'),
  editor,
});

/* Cada campo empurra a mudança para o rascunho; a pré-visualização é montada a
   partir dele, então trocar para "Renderizado" já mostra o texto editado. */
const ligar = (id, campo, transformar = (v) => v) => {
  $(id).addEventListener('input', (e) => previa.aoEditar({ [campo]: transformar(e.target.value) }));
};
ligar('ed-assunto', 'assunto');
ligar('ed-botao', 'botao');
ligar('ed-corpo', 'corpo_html');
ligar('ed-descricao', 'texto');
ligar('ed-sms', 'texto');
$('ed-destino').addEventListener('change', (e) => previa.aoEditar({ destino: e.target.value || null }));

$('ed-reverter').addEventListener('click', () => {
  const m = previa.reverter();
  if (m) editor.carregar(m, editor.etapa);
});

$('previa-editar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const m = previa.rascunhoAtual();
  if (!m) return;

  $('ed-salvar').disabled = true;
  $('ed-estado').textContent = 'salvando…';
  try {
    // O segmento do produto diz DE QUEM é a copy gravada: sem ele, vale '*'.
    const r = await api(`/api/mensagem/${m.linha}/${m.etapa ?? editor.etapa.etapa}/${m.canal}`
      + `/${encodeURIComponent(m.produto ?? '*')}`, {
      metodo: 'PUT',
      corpo: {
        assunto: m.assunto, corpo_html: m.corpo_html, botao: m.botao,
        destino: m.destino || null, texto: m.texto, ativo: m.ativo !== false,
      },
    });
    if (!r.ok) {
      $('ed-estado').textContent = r.dados.erro ?? 'não foi possível salvar';
      $('ed-salvar').disabled = false;
      return;
    }
    previa.marcarSalvo(r.dados.mensagem);
    editor.carregar(previa.rascunhoAtual(), editor.etapa);
    $('ed-estado').textContent = 'salvo — vale no próximo disparo';
    // O fluxo atrás da janela precisa refletir o texto novo.
    carregarSnapshot({ silencioso: true });
  } catch {
    /* 401 já redirecionou */
  }
});

/*
 * "Voltar ao padrão" = desativar a versão do produto, sem apagar o texto.
 * O robô filtra `ativo` no SELECT, então a etapa volta a cair no '*' sozinha —
 * e reativar depois é só salvar a versão de novo.
 */
$('ed-padrao').addEventListener('click', async () => {
  const m = previa.rascunhoAtual();
  if (!m || !m.produto || m.produto === '*') return;

  const nome = (estado.snapshot?.catalogoProdutos ?? [])
    .find((p) => p.slug === m.produto)?.nome ?? m.produto;
  if (!confirm(`Voltar ao padrão?\n\nA versão do ${nome} é desativada (o texto fica guardado) `
    + 'e esta etapa volta a enviar o texto padrão para os clientes dele.')) return;

  $('ed-padrao').disabled = true;
  $('ed-estado').textContent = 'voltando ao padrão…';
  try {
    const r = await api(`/api/mensagem/${m.linha}/${m.etapa ?? editor.etapa.etapa}/${m.canal}`
      + `/${encodeURIComponent(m.produto)}`, {
      metodo: 'PUT',
      corpo: {
        assunto: m.assunto, corpo_html: m.corpo_html, botao: m.botao,
        destino: m.destino || null, texto: m.texto, ativo: false,
      },
    });
    if (!r.ok) {
      $('ed-estado').textContent = r.dados.erro ?? 'não foi possível voltar ao padrão';
      return;
    }
    $('janela-previa').close();
    carregarSnapshot({ silencioso: true });
  } catch {
    /* 401 já redirecionou */
  } finally {
    $('ed-padrao').disabled = false;
  }
});

/* ── seletor "copy do produto" ── */

function renderCopyProduto(s) {
  const campo = $('campo-copy-produto');
  const sel = $('copy-produto-select');
  const catalogo = s.catalogoProdutos ?? [];

  // Sem catálogo (rota ainda não no ar, ou modo demo), o painel funciona como
  // antes: só o padrão, e o controle nem aparece.
  campo.hidden = !catalogo.length;
  if (!catalogo.length) { estado.copyProduto = '*'; return; }

  // Não reconstruir com o dropdown aberto — o refresh fecharia na mão do usuário.
  if (document.activeElement === sel) return;

  // Quantos textos próprios cada produto tem, para o rótulo dizer de graça
  // quem já foi personalizado.
  const proprias = new Map();
  for (const e of s.etapas ?? []) {
    for (const m of e.mensagens ?? []) {
      const p = String(m.produto ?? '*');
      if (p !== '*' && m.ativo !== false) proprias.set(p, (proprias.get(p) ?? 0) + 1);
    }
  }

  /*
   * Volume de leads por produto, para o de maior peso (NeuroMind Pro, hoje a
   * maioria da base) aparecer primeiro em vez de perdido no meio alfabético.
   * `s.produtos` traz o nome já normalizado pela mesma regra que gerou o
   * `slug` (código de oferta e embalagem fora) — comparar as duas formas
   * "sem espaço nem pontuação" é o mesmo critério que o slug já usa.
   */
  const chave = (texto) => String(texto ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const volumePorNome = new Map((s.produtos ?? []).map((p) => [chave(p.produto), p.total]));
  const volumeDe = (p) => volumePorNome.get(p.slug) ?? volumePorNome.get(chave(p.nome)) ?? 0;

  const ordenado = [...catalogo].sort((a, b) => volumeDe(b) - volumeDe(a)
    || a.nome.localeCompare(b.nome));

  sel.replaceChildren(
    Object.assign(document.createElement('option'), {
      value: '*', textContent: 'Padrão (todos os produtos)',
    }),
    ...ordenado.map((p) => Object.assign(document.createElement('option'), {
      value: p.slug,
      textContent: p.nome + (proprias.get(p.slug) ? ` — ${proprias.get(p.slug)} próprias` : ''),
    })),
  );
  if (![...sel.options].some((o) => o.value === estado.copyProduto)) estado.copyProduto = '*';
  sel.value = estado.copyProduto;
}

$('copy-produto-select').addEventListener('change', (ev) => {
  estado.copyProduto = ev.target.value || '*';
  // As mensagens de todos os produtos já vieram no snapshot: trocar a visão
  // é só redesenhar, sem ir à rede.
  if (estado.snapshot) pintarRegua(estado.snapshot);
});

/* ═══════════════════════════  renderização  ═════════════════════════ */

function renderLegenda() {
  const alvo = $('legenda');
  alvo.replaceChildren(...ESTADOS.map((e) => {
    const li = document.createElement('span');
    li.className = 'legenda-item';
    li.setAttribute('role', 'listitem');
    const marca = document.createElement('span');
    marca.className = 'legenda-marca';
    marca.style.background = CORES_ESTADO[e.id];
    const ico = document.createElement('i');
    ico.textContent = e.icone;
    const txt = document.createElement('span');
    txt.textContent = e.label;
    li.append(marca, ico, txt);
    return li;
  }));
}

function renderHeroi(s) {
  $('heroi-valor').textContent = n(s.totais.na_regua);
  // Com um produto ou uma plataforma escolhidos, o número-herói deixa de ser o
  // da operação e passa a ser o daquele recorte. O rótulo precisa dizer isso,
  // senão o mesmo lugar da tela mostra duas grandezas diferentes sem aviso.
  const recorte = [
    estado.produto && truncar(estado.produto, 28),
    estado.plataforma && truncar(estado.plataforma, 20),
  ].filter(Boolean);
  $('heroi-rotulo').textContent = recorte.length
    ? `Na régua agora · ${recorte.join(' · ')}`
    : 'Pedidos na régua agora';

  const partes = [];
  if (s.totais.prestes) partes.push(`${n(s.totais.prestes)} disparam na próxima hora`);
  if (s.totais.novos_24h) partes.push(`${n(s.totais.novos_24h)} entraram em 24 h`);
  if (s.totais.finalizado) partes.push(`${n(s.totais.finalizado)} já finalizados`);
  if (s.totais.cancelado) partes.push(`${n(s.totais.cancelado)} cancelados`);
  $('heroi-nota').textContent = partes.length ? partes.join(' · ') : 'nenhum pedido na fila ainda';
}

function renderKpis(s) {
  const defs = [
    { id: 'em_dia',      nota: 'com disparo futuro' },
    { id: 'atrasado',    nota: 'horário já passou' },
    { id: 'processando', nota: 'nas mãos do worker' },
    { id: 'travado',     nota: `presos > ${s.lockTimeoutMin ?? 10} min` },
    { id: 'finalizado',  nota: 'chegaram ao fim' },
    { id: 'cancelado',   nota: 'saíram cancelados' },
  ];

  $('kpis').replaceChildren(...defs.map((d) => {
    const meta = ROTULO_ESTADO[d.id];
    const b = document.createElement('button');
    b.className = 'kpi';
    b.dataset.tom = d.id;
    b.type = 'button';
    b.title = `Filtrar a tabela por “${meta.label}”`;

    const topo = document.createElement('div');
    topo.className = 'kpi-topo';
    const ico = document.createElement('span');
    ico.className = 'kpi-ico';
    ico.textContent = meta.icone;
    const rot = document.createElement('span');
    rot.className = 'kpi-rotulo';
    rot.textContent = meta.label;
    topo.append(ico, rot);

    const val = document.createElement('div');
    val.className = 'kpi-valor';
    val.textContent = nc(s.totais[d.id]);

    const nota = document.createElement('div');
    nota.className = 'kpi-nota';
    nota.textContent = d.nota;

    b.append(topo, val, nota);
    b.addEventListener('click', () => {
      $('f-estado').value = d.id;
      estado.filtros.estado = d.id;
      estado.pagina.offset = 0;
      carregarPedidos();
      document.querySelector('.tabela-envolve').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return b;
  }));
}

function renderRodapeCanvas(s) {
  const auto = s.etapas.filter((e) => e.autoDetectada).length;
  const inativas = s.etapas.filter((e) => e.ativo === false).length;
  // Mesma regra do servidor: etapa desativada não entra no tempo total.
  const total = s.etapas.reduce(
    (a, e) => a + (e.ativo !== false && Number.isFinite(e.espera_h) ? e.espera_h : 0), 0,
  );

  const partes = [`${s.etapas.length} mensagem${s.etapas.length > 1 ? 's' : ''} na régua`];
  if (inativas) partes.push(`${inativas} desativada${inativas > 1 ? 's' : ''}`);
  if (total > 0) partes.push(`${duracaoH(total)} do início ao fim`);
  if (auto) partes.push(`${auto} etapa${auto > 1 ? 's' : ''} na fila sem cadastro em etapas_regua`);
  $('rodape-etapas').textContent = partes.join(' · ');

  $('canvas-vazio').hidden = s.totais.na_regua > 0 || s.totais.finalizado > 0
    || s.totais.cancelado > 0;

  // A régua não existe ainda: o painel funciona, mas sem nomes nem canais.
  const faixa = $('faixa-regua');
  faixa.hidden = s.reguaOk !== false;

  /*
   * A fila veio pela metade.
   *
   * Como a API não tem rota de agregação, o painel baixa a fila para contá-la.
   * Se ela passar do teto, TODOS os números acima descrevem só o pedaço que
   * coube — e um total que não é total mente com cara de dado. Por isso a
   * faixa fala em número absoluto, não em "alguns registros".
   */
  const parcial = $('faixa-parcial');
  const f = s.fonte;
  parcial.hidden = !f?.truncado;
  if (f?.truncado) {
    parcial.replaceChildren();
    const forte = document.createElement('strong');
    forte.textContent = 'Números parciais.';
    parcial.append(forte, document.createTextNode(
      ` O painel leu ${n(f.lidos)} dos ${n(f.total)} pedidos da fila (teto de `
      + `${n(f.teto)}). Tudo acima descreve só essa parte. Suba API_FILA_MAX ou `
      + 'peça rotas de agregação à API.',
    ));
  }
}

/* ── onda de disparos: 48 baldes horários a partir da hora cheia atual ── */
function dadosOnda(s) {
  const inicio = new Date(); inicio.setMinutes(0, 0, 0);
  const balde = new Array(48).fill(0);
  for (const h of s.ondaHoraria) {
    const i = Math.round((new Date(h.hora).getTime() - inicio.getTime()) / 3600000);
    if (i >= 0 && i < 48) balde[i] += h.total;
  }
  return balde.map((valor, i) => {
    const t = new Date(inicio.getTime() + i * 3600000);
    return {
      valor,
      data: t,
      rotulo: `${dia(t)}, ${hora(t)}`,
      sub: i === 0 ? 'esta hora' : `daqui a ${i} h`,
    };
  });
}

/** Chave local 'YYYY-MM-DD' — casa com o to_char do servidor sem passar por UTC. */
const chaveDia = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dadosEntradas(s) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const mapa = new Map(s.entradasPorDia.map((d) => [String(d.dia).slice(0, 10), d.total]));
  return Array.from({ length: 14 }, (_, i) => {
    const t = new Date(hoje.getTime() - (13 - i) * 86400000);
    return { valor: mapa.get(chaveDia(t)) ?? 0, data: t, rotulo: dia(t), sub: null };
  });
}

function redesenharGraficos() {
  const s = estado.snapshot;
  if (!s) return;

  const onda = dadosOnda(s);
  desenharColunas($('graf-onda'), onda, {
    altura: 200,
    marcarIndice: 0,
    tooltip,
    unidade: 'disparos',
    textoVazio: 'Nenhum disparo agendado para as próximas 48 h',
    rotuloEixoX: (d, i) => (i % 6 === 0 ? `${String(d.data.getHours()).padStart(2, '0')}h` : ''),
  });

  desenharColunas($('graf-entradas'), dadosEntradas(s), {
    altura: 172,
    tooltip,
    unidade: 'pedidos novos',
    barraMax: 24,
    textoVazio: 'Nenhum pedido novo nos últimos 14 dias',
    rotuloEixoX: (d, i) => (i % 2 === 0 ? dia(d.data) : ''),
  });

  const atras = s.totais.atrasado;
  const dest = $('destaque-atraso');
  dest.hidden = atras === 0;
  if (atras > 0) {
    dest.replaceChildren();
    const ico = document.createElement('span');
    ico.textContent = ROTULO_ESTADO.atrasado.icone;
    ico.style.color = CORES_ESTADO.atrasado;
    const txt = document.createElement('span');
    txt.append(document.createTextNode('já vencidos, fora da janela: '));
    const b = document.createElement('b');
    b.textContent = n(atras);
    txt.append(b);
    dest.append(ico, txt);
  }
}

function renderAlertas(s) {
  const alvo = $('lista-alertas');
  const itens = [];

  const resumo = [
    { tom: 'travado',  ico: '■', txt: 'Travados no worker',  val: s.totais.travado },
    { tom: 'atrasado', ico: '▲', txt: 'Disparos atrasados',  val: s.totais.atrasado },
    { tom: 'travado',  ico: '▲', txt: 'Com erro registrado', val: s.totais.com_erro },
    { tom: 'atrasado', ico: '↻', txt: 'Já com retentativa',  val: s.totais.com_retry },
  ].filter((r) => r.val > 0);

  if (!resumo.length && !s.alertas.length) {
    const vazio = document.createElement('li');
    vazio.className = 'vazio-suave';
    vazio.textContent = s.totais.na_regua
      ? 'Nada travado, nada atrasado, nenhum erro. A régua está limpa.'
      : 'Sem pedidos na fila — nada para monitorar ainda.';
    alvo.replaceChildren(vazio);
    return;
  }

  for (const r of resumo) {
    const li = document.createElement('li');
    li.className = 'alerta-linha';
    li.dataset.tom = r.tom;
    const ico = document.createElement('span'); ico.className = 'alerta-ico'; ico.textContent = r.ico;
    const meio = document.createElement('div');
    const t = document.createElement('div'); t.className = 'alerta-txt'; t.textContent = r.txt;
    meio.append(t);
    const v = document.createElement('span'); v.className = 'alerta-val'; v.textContent = n(r.val);
    li.append(ico, meio, v);
    itens.push(li);
  }

  for (const a of s.alertas.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = 'alerta-linha';
    li.dataset.tom = a.estado === 'travado' ? 'travado' : 'atrasado';

    const ico = document.createElement('span');
    ico.className = 'alerta-ico';
    ico.textContent = ROTULO_ESTADO[a.estado]?.icone ?? '▲';

    const meio = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'alerta-txt';
    t.textContent = a.nome || a.transacao_id;
    const sub = document.createElement('div');
    sub.className = 'alerta-sub';
    // O canal do erro vem do prefixo do texto. Mostrá-lo evita que uma falha
    // de SMS seja lida como problema de e-mail.
    const canalErro = a.canal_erro ? `${CANAIS_META[a.canal_erro]?.label ?? a.canal_erro} · ` : '';
    sub.textContent = a.ultimo_erro
      ? `etapa ${a.etapa} · ${canalErro}${truncar(a.ultimo_erro, 46)}`
      : `etapa ${a.etapa} · ${ROTULO_ESTADO[a.estado]?.label ?? a.status}`
        + (a.claimed_at ? ` desde ${relativo(a.claimed_at)}` : '');
    meio.append(t, sub);

    const v = document.createElement('span');
    v.className = 'alerta-val';
    v.textContent = a.tentativas > 0 ? `${a.tentativas}× tent.` : relativo(a.proximo_disparo);

    li.append(ico, meio, v);
    itens.push(li);
  }

  alvo.replaceChildren(...itens);
}

function renderCanais(s) {
  const alvo = $('lista-canais');
  const dados = s.porCanal ?? [];

  if (!dados.length) {
    const vazio = document.createElement('li');
    vazio.className = 'vazio-suave';
    vazio.textContent = s.reguaOk === false
      ? 'Rode `npm run setup` para criar a régua no banco.'
      : 'Nenhum pedido em circulação para medir alcance.';
    alvo.replaceChildren(vazio);
    return;
  }

  const max = Math.max(...dados.map((c) => c.total), 1);
  const linhas = dados.map((c) => {
    const meta = CANAIS_META[c.canal] ?? CANAIS_META.indefinido;
    const alcancavel = c.alcancavel ?? c.total;
    const semContato = c.sem_contato ?? 0;

    const li = document.createElement('li');
    li.className = 'canal-linha';

    const ico = svgEl('svg', { class: 'canal-ico', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    svgEl('path', { d: GLIFOS_CANAL[meta.glifo] ?? GLIFOS_CANAL.interrogacao }, ico);

    const nome = document.createElement('span');
    nome.className = 'canal-nome';
    nome.textContent = meta.label;

    // O número grande é quem o canal alcança — também leva à lista.
    const num = document.createElement('button');
    num.type = 'button';
    num.className = 'canal-num canal-atalho';
    num.textContent = n(alcancavel);
    num.title = `Ver os ${n(alcancavel)} pedidos que ${meta.label} alcança`;
    num.addEventListener('click', () => filtrarTabela({
      canal: c.canal, problema: 'com_contato',
    }));

    // A barra tem DOIS trechos: quem o canal alcança e quem ele perde por
    // falta de contato. É a comparação que importa aqui — o total sozinho
    // esconde que o SMS não chega em quem não deixou telefone.
    const barra = document.createElement('div');
    barra.className = 'canal-barra';
    const pAlcance = document.createElement('span');
    pAlcance.style.width = `${(alcancavel / max) * 100}%`;
    barra.append(pAlcance);
    if (semContato > 0) {
      const pPerda = document.createElement('span');
      pPerda.className = 'canal-perda';
      pPerda.style.width = `${(semContato / max) * 100}%`;
      barra.append(pPerda);
    }

    /*
     * Cada problema vira um botão que filtra a tabela.
     *
     * O número sozinho informa e para aí: para agir você teria que descobrir
     * na mão QUEM são os 3 sem telefone. O clique leva direto à lista.
     */
    const sub = document.createElement('div');
    sub.className = 'canal-sub';

    const atalho = (rotulo, titulo, filtros) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'canal-atalho';
      b.textContent = rotulo;
      b.title = titulo;
      b.addEventListener('click', () => filtrarTabela(filtros));
      return b;
    };

    const botoes = [];
    if (semContato > 0) {
      botoes.push(atalho(
        `○ ${n(semContato)} ${c.faltando ?? 'sem contato'}`,
        `Ver quem está numa etapa que envia ${meta.label} mas não tem o contato`,
        { canal: c.canal, problema: 'sem_contato' },
      ));
    }
    if (c.atrasado > 0) {
      botoes.push(atalho(
        `${ROTULO_ESTADO.atrasado.icone} ${n(c.atrasado)} atrasados`,
        `Ver os atrasados que ${meta.label} alcança`,
        { canal: c.canal, estado: 'atrasado' },
      ));
    }
    if (c.travado > 0) {
      botoes.push(atalho(
        `${ROTULO_ESTADO.travado.icone} ${n(c.travado)} travados`,
        `Ver os travados que ${meta.label} alcança`,
        { canal: c.canal, estado: 'travado' },
      ));
    }
    if (c.com_erro > 0) {
      botoes.push(atalho(
        `▲ ${n(c.com_erro)} com erro`,
        `Ver os pedidos com erro registrado em etapas que enviam ${meta.label}`,
        { canal: c.canal, problema: 'com_erro' },
      ));
    }

    if (botoes.length) sub.append(...botoes);
    else sub.textContent = 'alcança todo mundo na régua';

    li.append(ico, nome, num, barra, sub);
    return li;
  });

  // Quem está numa etapa sem mensagem não aparece em canal nenhum. Some da
  // soma acima, então precisa ser dito em vez de simplesmente faltar.
  if (s.totais?.sem_mensagem > 0) {
    const li = document.createElement('li');
    li.className = 'canal-orfaos';
    li.textContent = `${n(s.totais.sem_mensagem)} em etapa sem mensagem cadastrada — `
      + 'não recebem nada em nenhum canal.';
    linhas.push(li);
  }

  // O erro é atribuído ao canal pelo prefixo do texto ("sms: …"). Sem prefixo
  // não dá para saber, e o registro some do recorte por canal — então a soma
  // dos dois ficaria menor que o total de erros sem explicação.
  if (s.totais?.erro_sem_canal > 0) {
    const li = document.createElement('li');
    li.className = 'canal-orfaos';
    li.append(document.createTextNode(
      `${n(s.totais.erro_sem_canal)} com erro sem canal identificado no texto — `
      + 'não entram na conta de nenhum canal. '));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'canal-atalho';
    b.textContent = 'ver quais';
    b.addEventListener('click', () => filtrarTabela({ problema: 'com_erro' }));
    li.append(b);
    linhas.push(li);
  }

  alvo.replaceChildren(...linhas);
}

/**
 * Aplica um recorte na tabela e rola até ela.
 *
 * Zera os filtros não citados: vindo de um número específico do card, herdar
 * um filtro antigo faria a tabela mostrar menos linhas do que o número
 * prometia — e a discrepância não teria explicação na tela.
 *
 * Os controles são atualizados junto, senão a tabela filtraria sem que nada
 * na interface dissesse por quê.
 */
function filtrarTabela({ etapa = null, estado: est = null, canal = null, problema = null }) {
  estado.filtros = { ...estado.filtros, etapa, estado: est, canal, problema, busca: '' };
  estado.pagina.offset = 0;

  $('f-etapa').value = etapa === null ? '' : String(etapa);
  $('f-estado').value = est ?? '';
  $('f-canal').value = canal ?? '';
  $('f-problema').value = problema ?? '';
  $('f-busca').value = '';

  carregarPedidos();
  document.querySelector('.tabela-envolve').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderStatusBruto(s) {
  const alvo = $('status-bruto');
  if (!s.statusBruto.length) {
    const vazio = document.createElement('li');
    vazio.className = 'vazio-suave';
    vazio.textContent = 'A tabela ainda não tem linhas.';
    alvo.replaceChildren(vazio);
    return;
  }
  const max = Math.max(...s.statusBruto.map((x) => x.total), 1);
  alvo.replaceChildren(...s.statusBruto.map((x) => {
    const li = document.createElement('li');
    li.className = 'status-linha';
    const nome = document.createElement('span');
    nome.className = 'status-nome';
    nome.textContent = x.label ?? x.status;
    const num = document.createElement('span');
    num.className = 'status-num';
    num.textContent = n(x.total);
    const barra = document.createElement('div');
    barra.className = 'status-barra';
    const preenchido = document.createElement('span');
    preenchido.style.width = `${(x.total / max) * 100}%`;
    barra.append(preenchido);
    li.append(nome, num, barra);
    return li;
  }));
}

/**
 * O seletor de produto do topo.
 *
 * A lista vem do snapshot e NÃO obedece ao próprio recorte (escolher um
 * produto deixaria só ele na lista, sem como voltar nem trocar) — mas obedece
 * ao de PLATAFORMA: com uma escolhida, o servidor manda só os produtos que
 * ela vende, com as contagens daquele recorte.
 *
 * O produto escolhido continua na lista mesmo quando some dela (saiu da fila,
 * ou a plataforma escolhida não o vende) — um recorte ativo que desaparece do
 * controle é um filtro invisível pesando sobre todos os números da tela.
 */
let assinaturaProdutos = null;

function renderFiltroProduto(s) {
  const sel = $('sel-produto');
  const lista = s.produtos ?? [];
  const escolhido = estado.produto;

  const rotulos = [['', 'Todos os produtos']];
  for (const p of lista) {
    rotulos.push([p.produto, `${p.produto}${p.total ? ` · ${n(p.total)}` : ''}`]);
  }
  if (escolhido && !lista.some((p) => p.produto === escolhido)) {
    rotulos.push([escolhido, `${escolhido} · 0`]);
  }

  sel.value = escolhido ?? '';
  sel.dataset.ativo = escolhido ? 'sim' : 'nao';

  /*
   * Só refaz a lista quando ela REALMENTE mudou — e nunca com o seletor em
   * foco. O painel se recarrega a cada 10 s e as contagens andam junto: trocar
   * as opções no meio de uma escolha fecharia o dropdown na mão do usuário.
   */
  const assinatura = rotulos.map((r) => r.join('|')).join('\n');
  if (assinatura === assinaturaProdutos || document.activeElement === sel) return;
  assinaturaProdutos = assinatura;

  sel.replaceChildren(...rotulos.map(([value, textContent]) =>
    Object.assign(document.createElement('option'), { value, textContent })));
  sel.value = escolhido ?? '';
}

/**
 * O seletor de plataforma do topo — mesmas regras do de produto: lista sempre
 * completa, escolha que sumiu da fila continua como opção, e a lista só é
 * refeita quando muda de verdade (nunca com o seletor em foco).
 */
let assinaturaPlataformas = null;

function renderFiltroPlataforma(s) {
  const sel = $('sel-plataforma');
  const lista = s.plataformas ?? [];
  const escolhido = estado.plataforma;

  const rotulos = [['', 'Todas as plataformas']];
  for (const p of lista) {
    rotulos.push([p.plataforma, `${p.plataforma}${p.total ? ` · ${n(p.total)}` : ''}`]);
  }
  if (escolhido && !lista.some((p) => p.plataforma === escolhido)) {
    rotulos.push([escolhido, `${escolhido} · 0`]);
  }

  sel.value = escolhido ?? '';
  sel.dataset.ativo = escolhido ? 'sim' : 'nao';

  const assinatura = rotulos.map((r) => r.join('|')).join('\n');
  if (assinatura === assinaturaPlataformas || document.activeElement === sel) return;
  assinaturaPlataformas = assinatura;

  sel.replaceChildren(...rotulos.map(([value, textContent]) =>
    Object.assign(document.createElement('option'), { value, textContent })));
  sel.value = escolhido ?? '';
}

/* Os dois seletores de etapa (tabela e gráficos) saem da mesma lista do
   snapshot — a régua é auto-detectada, então nada aqui é fixo no código. */
function renderFiltrosEtapa(s) {
  for (const id of ['f-etapa', 'g-etapa']) {
    const sel = $(id);
    const atual = sel.value;
    const opcoes = [Object.assign(document.createElement('option'), {
      value: '', textContent: 'Todas',
    })];
    for (const e of s.etapas) {
      opcoes.push(Object.assign(document.createElement('option'), {
        value: String(e.etapa), textContent: `${e.etapa} · ${e.nome}`,
      }));
    }
    sel.replaceChildren(...opcoes);
    sel.value = atual;
  }
}

/* ═════════════════════════════  tabela  ═════════════════════════════ */

function celula(conteudo, classe) {
  const td = document.createElement('td');
  if (classe) td.className = classe;
  if (typeof conteudo === 'string') td.textContent = conteudo;
  else if (conteudo) td.append(conteudo);
  return td;
}

function renderTabela({ pedidos, total }) {
  const corpo = $('tabela-corpo');
  estado.pagina.total = total;

  if (!pedidos.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'vazio-suave';
    const f = estado.filtros;
    const temFiltro = f.busca || f.etapa !== null || f.estado || f.canal || f.problema;
    // Os recortes por produto e plataforma vivem no topo da página: sem
    // citá-los aqui, a tabela pareceria vazia "sem motivo" para quem esqueceu
    // que escolheu um recorte.
    const recorte = [
      estado.produto && `“${estado.produto}”`,
      estado.plataforma && `na ${estado.plataforma}`,
    ].filter(Boolean).join(' ');
    td.textContent = recorte
      ? `Nenhum pedido de ${recorte}${temFiltro ? ' com estes filtros' : ''}.`
      : temFiltro
        ? 'Nenhum pedido corresponde a estes filtros.'
        : 'A tabela `disparos_pos_venda` está vazia.';
    tr.append(td);
    corpo.replaceChildren(tr);
    atualizarPaginacao();
    return;
  }

  corpo.replaceChildren(...pedidos.map((p) => {
    const tr = document.createElement('tr');

    // Duplo clique abre o que o chatbot de suporte registrou deste cliente.
    // Clique simples continua livre para selecionar/copiar texto da linha.
    tr.title = 'Duplo clique: atendimento do suporte';
    tr.addEventListener('dblclick', () => abrirChatCliente(p));

    tr.append(celula(p.transacao_id, 'cel-mono'));

    const cliente = document.createElement('div');
    const nomeEl = document.createElement('span');
    nomeEl.className = 'cel-forte';
    nomeEl.textContent = p.nome || '—';
    const contato = document.createElement('span');
    contato.className = 'cel-sub';
    contato.textContent = [p.email, p.telefone].filter(Boolean).join(' · ') || '';
    cliente.append(nomeEl, contato);
    tr.append(celula(cliente));

    tr.append(celula(truncar(p.produto || '—', 42)));

    const selo = document.createElement('span');
    selo.className = 'selo-etapa';
    const bEtapa = document.createElement('b');
    bEtapa.textContent = String(p.etapa);
    const nomeEtapa = document.createElement('span');
    nomeEtapa.textContent = estado.snapshot?.etapas.find((e) => e.etapa === p.etapa)?.nome ?? '';
    selo.append(bEtapa, nomeEtapa);
    tr.append(celula(selo));

    const meta = ROTULO_ESTADO[p.estado];
    const est = document.createElement('span');
    est.className = 'selo-estado';
    est.dataset.e = p.estado;
    const i = document.createElement('i');
    i.textContent = meta?.icone ?? '·';
    const lab = document.createElement('span');
    lab.textContent = meta?.label ?? p.status;
    est.append(i, lab);
    tr.append(celula(est));

    const quando = document.createElement('div');
    const rel = document.createElement('span');
    rel.textContent = relativo(p.proximo_disparo);
    if (p.estado === 'atrasado') rel.className = 'cel-forte';
    const abs = document.createElement('span');
    abs.className = 'cel-sub';
    abs.textContent = dataHora(p.proximo_disparo);
    quando.append(rel, abs);
    tr.append(celula(quando));

    tr.append(celula(String(p.tentativas ?? 0), 'num'));

    const erro = celula(p.ultimo_erro ? truncar(p.ultimo_erro, 58) : '—',
      p.ultimo_erro ? 'cel-erro' : 'cel-fraca');
    if (p.ultimo_erro) erro.title = p.ultimo_erro;
    tr.append(erro);

    return tr;
  }));

  atualizarPaginacao();
}

function atualizarPaginacao() {
  const { limit, offset, total } = estado.pagina;
  const de = total === 0 ? 0 : offset + 1;
  const ate = Math.min(offset + limit, total);
  $('pag-info').textContent = total
    ? `${n(de)}–${n(ate)} de ${n(total)} pedidos`
    : 'nenhum pedido';
  $('pag-ant').disabled = offset === 0;
  $('pag-prox').disabled = offset + limit >= total;
}

/* ══════════════════════════════  dados  ═════════════════════════════ */

function sinalizar(estadoPilula, texto) {
  $('pilula-live').dataset.estado = estadoPilula;
  $('live-txt').textContent = texto;
}

async function carregarSnapshot({ silencioso = false } = {}) {
  if (!silencioso) document.body.dataset.recarregando = 'sim';
  const meu = ++geracaoSnapshot;

  try {
    const g = estado.graficos;
    const s = estado.demo ? snapshotDemo() : await (async () => {
      const qs = new URLSearchParams();
      if (g.etapa !== null) qs.set('etapa', String(g.etapa));
      if (g.canal) qs.set('canal', g.canal);
      if (estado.produto) qs.set('produto', estado.produto);
      if (estado.plataforma) qs.set('plataforma', estado.plataforma);
      if (estado.linhaExibindo) qs.set('linha', estado.linhaExibindo);
      const resp = await fetch(`/api/snapshot${qs.toString() ? `?${qs}` : ''}`);
      // Sessão perdida (o token desta pessoa na API venceu ou foi revogado):
      // insistir traria erro a cada 10 s. O caminho é entrar de novo.
      if (resp.status === 401) { location.replace('/login'); throw new Error('sem sessão'); }
      if (!resp.ok) {
        // O servidor explica o que houve no corpo ("a API recusou as
        // credenciais", "não consegui falar com a API em …"). Jogar fora essa
        // frase e mostrar só "HTTP 502" transforma um problema de configuração
        // com conserto conhecido num defeito misterioso.
        let motivo = `HTTP ${resp.status}`;
        try {
          const corpo = await resp.json();
          if (corpo?.erro) motivo = corpo.detalhe ? `${corpo.erro} (${corpo.detalhe})` : corpo.erro;
        } catch { /* resposta sem JSON: fica o código mesmo */ }
        throw new Error(motivo);
      }
      return resp.json();
    })();

    // Chegou tarde: outro carregamento já começou depois deste. Pintar agora
    // devolveria a tela para um estado que o usuário já deixou para trás.
    if (meu !== geracaoSnapshot) return;

    estado.snapshot = s;
    $('faixa-erro').hidden = true;
    definirCanais(s.canais);

    renderHeroi(s);
    renderKpis(s);
    renderRodapeCanvas(s);
    renderCanais(s);
    renderStatusBruto(s);
    renderAlertas(s);
    renderFiltrosEtapa(s);
    renderFiltroProduto(s);
    renderFiltroPlataforma(s);
    renderCopyProduto(s);
    pintarRegua(s);
    renderLinha(s);
    redesenharGraficos();

    sinalizar(estado.demo ? 'demo' : 'ok', estado.demo ? 'demonstração' : `atualizado ${hora(s.geradoEm)}`);
    // A digital do código no rodapé: se o container e o `npm start` mostrarem
    // valores diferentes, um dos dois está numa versão antiga.
    const v = estado.versao;
    const carimbo = v?.codigo
      ? ` · versão ${v.codigo}${v.container ? ' (container)' : ''}`
      : '';
    $('rodape-nota').textContent = estado.demo
      ? `Dados simulados no navegador. Nenhuma leitura ou escrita no banco.${carimbo}`
      : `Régua e fila lidas da API${s.fonte?.api ? ` ${s.fonte.api}` : ''} · `
        + `${n(s.fonte?.lidos ?? 0)} pedidos medidos · `
        + `“travado” = processando há mais de ${s.lockTimeoutMin} min.${carimbo}`;
  } catch (err) {
    if (meu !== geracaoSnapshot) return;
    sinalizar('erro', 'sem conexão');
    const faixa = $('faixa-erro');
    faixa.hidden = false;
    faixa.textContent = `Não consegui ler os dados: ${err.message}. `
      + 'O painel continua mostrando os últimos números que recebeu.';
  } finally {
    if (meu === geracaoSnapshot) document.body.dataset.recarregando = 'nao';
  }
}

async function carregarPedidos() {
  const f = estado.filtros;
  const p = estado.pagina;
  const meu = ++geracaoPedidos;

  try {
    if (estado.demo) {
      return renderTabela(pedidosDemo({
        etapa: f.etapa, estado: f.estado, canal: f.canal, problema: f.problema,
        busca: f.busca || null, limit: p.limit, offset: p.offset,
      }));
    }

    const qs = new URLSearchParams({ limit: String(p.limit), offset: String(p.offset), ordem: f.ordem });
    if (f.etapa !== null) qs.set('etapa', String(f.etapa));
    if (f.estado) qs.set('estado', f.estado);
    if (f.canal) qs.set('canal', f.canal);
    if (f.problema) qs.set('problema', f.problema);
    if (f.busca) qs.set('q', f.busca);
    // Os recortes do topo valem para a tabela também — senão o painel inteiro
    // falaria de um produto (ou plataforma) e a lista, de todos.
    if (estado.produto) qs.set('produto', estado.produto);
    if (estado.plataforma) qs.set('plataforma', estado.plataforma);
    // O filtro por canal depende de qual linha tem mensagem cadastrada: sem
    // isto a tabela contaria por uma linha e a tela mostraria outra.
    if (estado.linhaExibindo) qs.set('linha', estado.linhaExibindo);

    const resp = await fetch(`/api/pedidos?${qs}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dados = await resp.json();
    if (meu !== geracaoPedidos) return;   // resposta atrasada: descarta
    renderTabela(dados);
  } catch {
    // Idem no erro: uma requisição que falhou 15 s depois não pode apagar uma
    // tabela boa que chegou no meio tempo.
    if (meu !== geracaoPedidos) return;
    renderTabela({ pedidos: [], total: 0 });
  }
}

/* ═════════════════════════════  controles  ══════════════════════════ */

function reagendar() {
  clearInterval(estado.timer);
  if (estado.intervalo > 0) {
    estado.timer = setInterval(() => {
      carregarSnapshot({ silencioso: true });
      carregarPedidos();
      carregarSuporte();
    }, estado.intervalo);
  }
}

$('sel-intervalo').addEventListener('change', (e) => {
  estado.intervalo = Number(e.target.value);
  reagendar();
  if (estado.intervalo === 0) sinalizar('carregando', 'pausado');
  else carregarSnapshot({ silencioso: true });
});

$('btn-atualizar').addEventListener('click', () => {
  carregarSnapshot();
  carregarPedidos();
  carregarSuporte();
});

$('btn-demo').addEventListener('click', (e) => {
  estado.demo = !estado.demo;
  e.currentTarget.setAttribute('aria-pressed', String(estado.demo));
  $('faixa-demo').hidden = !estado.demo;
  estado.pagina.offset = 0;
  // Os números da demonstração são gerados no navegador em bloco, sem recorte
  // por produto nem plataforma. Deixar os seletores ativos ali faria a tabela
  // filtrar e os KPIs não — dois recortes diferentes na mesma tela.
  if (estado.demo) { estado.produto = null; estado.plataforma = null; }
  const sel = $('sel-produto');
  sel.disabled = estado.demo;
  sel.title = estado.demo
    ? 'Indisponível na demonstração — os números são gerados no navegador'
    : 'Recorta o painel inteiro por produto — as ofertas do mesmo produto contam juntas';
  const selPlat = $('sel-plataforma');
  selPlat.disabled = estado.demo;
  selPlat.title = estado.demo
    ? 'Indisponível na demonstração — os números são gerados no navegador'
    : 'Recorta o painel inteiro por plataforma de venda (DigiStore24, JVZoo, BuyGoods…)';
  carregarSnapshot();
  carregarPedidos();
});

/**
 * Troca o produto do painel INTEIRO.
 *
 * Recarrega snapshot e tabela juntos: são as duas metades da mesma leitura, e
 * atualizar só uma deixaria a tela afirmando duas coisas ao mesmo tempo.
 */
$('sel-produto').addEventListener('change', (e) => {
  estado.produto = e.target.value || null;
  e.target.dataset.ativo = estado.produto ? 'sim' : 'nao';
  estado.pagina.offset = 0;
  carregarSnapshot({ silencioso: true });
  carregarPedidos();
  // O recorte vale para as DUAS seções — a aba de suporte lê o mesmo seletor.
  carregarSuporte();
});

/** Troca a plataforma do painel INTEIRO — mesma mecânica do produto. */
$('sel-plataforma').addEventListener('change', (e) => {
  estado.plataforma = e.target.value || null;
  e.target.dataset.ativo = estado.plataforma ? 'sim' : 'nao';
  estado.pagina.offset = 0;
  carregarSnapshot({ silencioso: true });
  carregarPedidos();
  carregarSuporte();
});

$('f-etapa').addEventListener('change', (e) => {
  estado.filtros.etapa = e.target.value === '' ? null : Number(e.target.value);
  estado.pagina.offset = 0;
  carregarPedidos();
});
$('f-estado').addEventListener('change', (e) => {
  estado.filtros.estado = e.target.value || null;
  estado.pagina.offset = 0;
  carregarPedidos();
});
$('f-canal').addEventListener('change', (e) => {
  estado.filtros.canal = e.target.value || null;
  estado.pagina.offset = 0;
  carregarPedidos();
});
$('f-problema').addEventListener('change', (e) => {
  estado.filtros.problema = e.target.value || null;
  estado.pagina.offset = 0;
  carregarPedidos();
});
$('f-ordem').addEventListener('change', (e) => {
  estado.filtros.ordem = e.target.value;
  carregarPedidos();
});

/* ── filtros dos gráficos (recortam só a onda e as entradas) ── */
function aplicarFiltroGraficos() {
  const partes = [];
  if (estado.graficos.etapa !== null) {
    const nome = estado.snapshot?.etapas.find((e) => e.etapa === estado.graficos.etapa)?.nome;
    partes.push(`etapa ${estado.graficos.etapa}${nome ? ` · ${nome}` : ''}`);
  }
  if (estado.graficos.canal) {
    partes.push(`quem recebe ${CANAIS_META[estado.graficos.canal]?.label ?? estado.graficos.canal}`);
  }
  $('g-nota').textContent = partes.length
    ? `Recorte ativo: ${partes.join(' · ')}. Os nós, os indicadores e o alcance por `
      + 'canal continuam mostrando a régua inteira.'
    : 'O recorte vale para a onda de disparos e as entradas na régua. Os nós, os '
      + 'indicadores e o alcance por canal continuam mostrando a régua inteira.';
  $('g-nota').dataset.ativo = partes.length ? 'sim' : 'nao';
  carregarSnapshot({ silencioso: true });
}

$('g-etapa').addEventListener('change', (e) => {
  estado.graficos.etapa = e.target.value === '' ? null : Number(e.target.value);
  aplicarFiltroGraficos();
});
$('g-canal').addEventListener('change', (e) => {
  estado.graficos.canal = e.target.value || null;
  aplicarFiltroGraficos();
});
$('g-limpar').addEventListener('click', () => {
  estado.graficos = { etapa: null, canal: null };
  $('g-etapa').value = ''; $('g-canal').value = '';
  aplicarFiltroGraficos();
});

let debounce;
$('f-busca').addEventListener('input', (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    estado.filtros.busca = e.target.value.trim();
    estado.pagina.offset = 0;
    carregarPedidos();
  }, 260);
});

$('f-limpar').addEventListener('click', () => {
  estado.filtros = {
    etapa: null, estado: null, canal: null, problema: null, busca: '', ordem: 'proximo',
  };
  estado.pagina.offset = 0;
  $('f-etapa').value = ''; $('f-estado').value = ''; $('f-canal').value = '';
  $('f-problema').value = ''; $('f-ordem').value = 'proximo'; $('f-busca').value = '';
  carregarPedidos();
});

$('pag-ant').addEventListener('click', () => {
  estado.pagina.offset = Math.max(0, estado.pagina.offset - estado.pagina.limit);
  carregarPedidos();
});
$('pag-prox').addEventListener('click', () => {
  estado.pagina.offset += estado.pagina.limit;
  carregarPedidos();
});

// Preenche o seletor de estado a partir da mesma fonte da legenda. 'Na régua'
// é o pseudo-estado que o clique num nó usa: precisa existir aqui, senão o
// controle ficaria em branco mostrando um filtro que está valendo.
$('f-estado').replaceChildren(
  Object.assign(document.createElement('option'), { value: '', textContent: 'Todos' }),
  Object.assign(document.createElement('option'), { value: 'na_regua', textContent: 'Na régua (ainda em circulação)' }),
  ...ESTADOS.map((e) => Object.assign(document.createElement('option'), {
    value: e.id, textContent: e.label,
  })),
);

let debounceResize;
addEventListener('resize', () => {
  clearTimeout(debounceResize);
  debounceResize = setTimeout(redesenharGraficos, 140);
});

/* ═══════════════════════════════  acesso  ═══════════════════════════ */

/* Toda escrita leva este cabeçalho; o servidor recusa sem ele. Um formulário
   de outro site não consegue adicionar cabeçalho próprio sem preflight, então
   isto barra CSRF mesmo onde o SameSite do cookie não pegar. */
async function api(rota, { metodo = 'GET', corpo } = {}) {
  const resp = await fetch(rota, {
    method: metodo,
    headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Painel': '1' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  // Sessão caiu (expirou, foi revogada, conta desativada): volta ao login em
  // vez de deixar a tela mostrando números velhos que não valem mais.
  if (resp.status === 401) { location.replace('/login'); throw new Error('sem sessão'); }
  let dados = {};
  try { dados = await resp.json(); } catch { /* sem corpo */ }
  return { ok: resp.ok, status: resp.status, dados };
}

function renderUsuario(u) {
  estado.usuario = u;
  const inicial = (u.nome || u.email).trim()[0]?.toUpperCase() ?? '·';
  $('usuario-inicial').textContent = inicial;
  $('usuario-nome').textContent = u.nome || u.email;
  $('usuario-nome').title = u.email;
  $('usuario-selo').hidden = !u.admin;
  $('usuario-chip').hidden = false;
  $('btn-usuarios').hidden = !u.admin;
  $('btn-produtos').hidden = !u.admin;
  $('btn-tempos').hidden = !u.admin;
}

$('btn-sair').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { metodo: 'POST' }); } catch { /* sai mesmo assim */ }
  location.replace('/login');
});

/* ── gestão de usuários (administradores) ── */

const janela = $('janela-usuarios');

function msgUsuarios(texto, tom = 'erro', extra) {
  const el = $('usuarios-msg');
  el.replaceChildren(document.createTextNode(texto));
  if (extra) {
    const c = document.createElement('code');
    c.className = 'senha-provisoria';
    c.textContent = extra;
    el.append(c);
  }
  el.dataset.tom = tom;
  el.hidden = false;
}

function senhaSorteada() {
  // Sem O/0 e l/1: esta senha vai ser lida em voz alta ou copiada à mão.
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint32Array(20);
  crypto.getRandomValues(b);
  return [...b].map((x) => alfabeto[x % alfabeto.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Diz o que aconteceu com a senha provisória: se o e-mail saiu, basta avisar;
 * se não saiu, a senha PRECISA aparecer na tela, senão ela se perde e a conta
 * nasce inacessível.
 */
function relatarConvite({ email: envio, conviteDias }, senha, quem) {
  const prazo = conviteDias ? ` Vale ${conviteDias} dias.` : '';
  if (envio?.enviado) {
    msgUsuarios(`Convite enviado para ${quem}.${prazo} A senha provisória foi no e-mail.`, 'ok');
  } else {
    const porque = envio?.motivo ? ` (${envio.motivo})` : '';
    msgUsuarios(
      `E-mail não enviado${porque}. Repasse esta senha provisória de ${quem}:${prazo}`,
      'erro', senha,
    );
  }
}

function renderUsuarios({ usuarios, eu, emailConfigurado, conviteDias, somenteLeitura }) {
  if (emailConfigurado !== undefined) {
    estado.emailConfigurado = emailConfigurado;
    $('n-email-envio-caixa').hidden = !emailConfigurado;
  }
  if (conviteDias) estado.conviteDias = conviteDias;

  /*
   * `somenteLeitura` é a saída de emergência: se o servidor voltar a dizer que
   * a API não aceita escrita, o formulário e os botões somem — um controle que
   * sempre devolve erro é pior que controle nenhum. Hoje ele não é enviado:
   * criar, promover, desativar e emitir senha provisória passam pela API.
   */
  const soLeitura = somenteLeitura === true;
  $('form-novo').hidden = soLeitura;
  const aviso = $('usuarios-leitura');
  aviso.hidden = !soLeitura;
  if (soLeitura) {
    aviso.textContent = 'Esta lista vem da API do SendTrace, que só permite lê-la. '
      + 'Criar conta, promover a administrador, desativar ou trocar senha é feito na API.';
  }

  $('lista-usuarios').replaceChildren(...usuarios.map((u) => {
    const li = document.createElement('li');
    li.className = 'usuario-linha';
    li.dataset.inativo = u.ativo ? 'nao' : 'sim';

    const email = document.createElement('div');
    email.className = 'usuario-email';
    email.textContent = u.nome ? `${u.nome} · ${u.email}` : u.email;
    if (u.id === eu) {
      const selo = document.createElement('span');
      selo.className = 'usuario-eu';
      selo.textContent = 'você';
      email.append(selo);
    }

    const meta = document.createElement('div');
    meta.className = 'usuario-meta';
    const partes = [u.admin ? 'administrador' : 'acesso de leitura'];
    if (!u.ativo) partes.push('desativado');
    if (u.trocar_senha) partes.push('senha provisória pendente');
    partes.push(u.ultimo_acesso ? `último acesso ${relativo(u.ultimo_acesso)}` : 'nunca entrou');
    if (u.sessoes > 0) partes.push(`${u.sessoes} sessão(ões) aberta(s)`);
    if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
      partes.push('bloqueado por tentativas');
    }
    meta.textContent = partes.join(' · ');

    const acoes = document.createElement('div');
    acoes.className = 'usuario-acoes';

    const botao = (rotulo, titulo, aoClicar) => {
      const b = document.createElement('button');
      b.className = 'btn btn-fantasma';
      b.type = 'button';
      b.textContent = rotulo;
      b.title = titulo;
      b.addEventListener('click', aoClicar);
      return b;
    };

    // O próprio usuário não se rebaixa nem se desativa: perderia o acesso à
    // tela que está usando, sem volta se não houver outro admin. O servidor
    // também recusa — isto aqui só evita o clique inútil.
    if (u.id !== eu && !soLeitura) {
      acoes.append(botao(
        u.admin ? 'Remover admin' : 'Tornar admin',
        u.admin ? 'Deixa de administrar usuários' : 'Passa a poder criar e promover usuários',
        () => patchUsuario(u.id, { admin: !u.admin }),
      ));
      acoes.append(botao(
        u.ativo ? 'Desativar' : 'Reativar',
        u.ativo ? 'Bloqueia o acesso e encerra as sessões abertas' : 'Devolve o acesso',
        () => patchUsuario(u.id, { ativo: !u.ativo }),
      ));
    }

    const comEmail = estado.emailConfigurado;
    if (!soLeitura) acoes.append(botao(
      comEmail ? 'Reenviar convite' : 'Nova senha',
      comEmail
        ? 'Gera uma senha provisória, manda por e-mail e encerra as sessões dessa conta'
        : 'Gera uma senha provisória e encerra as sessões dessa conta',
      () => {
        const nova = senhaSorteada();
        patchUsuario(u.id, { senha: nova, enviarEmail: comEmail }, nova, u.email);
      },
    ));

    li.append(email, meta, acoes);
    return li;
  }));
}

/**
 * `senhaEmitida` e `quem` só vêm quando a mudança gerou uma senha provisória.
 * Nesse caso o resultado precisa ser relatado com cuidado: se o e-mail não
 * saiu, a senha tem que aparecer na tela ou a conta fica inacessível.
 */
async function patchUsuario(id, mudanca, senhaEmitida, quem) {
  try {
    const r = await api(`/api/usuarios/${id}`, { metodo: 'PATCH', corpo: mudanca });
    if (!r.ok) return msgUsuarios(r.dados.erro ?? 'Não foi possível aplicar a mudança.');
    renderUsuarios(r.dados);
    if (senhaEmitida) relatarConvite(r.dados, senhaEmitida, quem);
    else $('usuarios-msg').hidden = true;
  } catch { /* 401 já redirecionou */ }
}

async function abrirUsuarios() {
  $('usuarios-msg').hidden = true;
  $('n-senha').value = senhaSorteada();
  try {
    const r = await api('/api/usuarios');
    if (!r.ok) return msgUsuarios(r.dados.erro ?? 'Não foi possível carregar.');
    renderUsuarios(r.dados);
    janela.showModal();
    $('n-email').focus();
  } catch { /* 401 já redirecionou */ }
}

$('btn-usuarios').addEventListener('click', abrirUsuarios);
$('fechar-usuarios').addEventListener('click', () => janela.close());
$('n-sortear').addEventListener('click', () => { $('n-senha').value = senhaSorteada(); });

$('form-novo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const corpo = {
    email: $('n-email').value.trim(),
    nome: $('n-nome').value.trim(),
    senha: $('n-senha').value,
    admin: $('n-admin').checked,
    enviarEmail: estado.emailConfigurado && $('n-email-envio').checked,
  };
  try {
    const r = await api('/api/usuarios', { metodo: 'POST', corpo });
    if (!r.ok) return msgUsuarios(r.dados.erro ?? 'Não foi possível criar o usuário.');

    relatarConvite(r.dados, corpo.senha, corpo.email);
    $('n-email').value = ''; $('n-nome').value = ''; $('n-admin').checked = false;
    $('n-senha').value = senhaSorteada();

    const lista = await api('/api/usuarios');
    if (lista.ok) renderUsuarios(lista.dados);
  } catch { /* 401 já redirecionou */ }
});

/* ── tempo entre etapas da régua (administradores) ── */

const janelaTempos = $('janela-tempos');

function msgTempos(texto, tom = 'erro') {
  const el = $('tempos-msg');
  el.textContent = texto;
  el.dataset.tom = tom;
  el.hidden = false;
}

const UNIDADES_TEMPO = [
  ['minutos', 'minutos'],
  ['horas', 'horas'],
  ['dias', 'dias'],
];

function renderTempos(etapas) {
  $('lista-tempos').replaceChildren(...etapas.map((e) => {
    const li = document.createElement('li');
    li.className = 'tempo-linha';
    li.dataset.editavel = e.editavel ? 'sim' : 'nao';
    li.dataset.etapa = String(e.etapa);

    const rot = document.createElement('div');
    rot.className = 'tempo-rotulo';
    rot.textContent = `Etapa ${e.etapa}${e.nome ? ` · ${e.nome}` : ''}`;
    li.appendChild(rot);

    if (!e.editavel) {
      const nota = document.createElement('div');
      nota.className = 'tempo-nota';
      nota.textContent = e.ativo === false
        ? 'Etapa inativa — ainda não edita pelo painel'
        : 'Última etapa — sem espera';
      li.appendChild(nota);
      return li;
    }

    const { valor, unidade } = deEsperaH(e.espera_h);

    const controles = document.createElement('div');
    controles.className = 'tempo-controles';

    const campoValor = document.createElement('label');
    campoValor.className = 'campo tempo-campo-valor';
    campoValor.append(Object.assign(document.createElement('span'), {
      className: 'sr', textContent: `Tempo até a próxima etapa depois da etapa ${e.etapa}`,
    }));
    const numero = document.createElement('input');
    numero.type = 'number';
    numero.min = '0';
    numero.step = 'any';
    numero.value = valor ?? '';
    numero.className = 'tempo-valor';
    campoValor.appendChild(numero);

    const campoUnidade = document.createElement('label');
    campoUnidade.className = 'campo';
    campoUnidade.append(Object.assign(document.createElement('span'), {
      className: 'sr', textContent: 'Unidade do tempo',
    }));
    const sel = document.createElement('select');
    sel.className = 'tempo-unidade';
    for (const [val, rotuloOpt] of UNIDADES_TEMPO) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = rotuloOpt;
      if (val === unidade) opt.selected = true;
      sel.appendChild(opt);
    }
    campoUnidade.appendChild(sel);

    const preview = document.createElement('span');
    preview.className = 'tempo-preview';

    const atualizarPreview = () => {
      try {
        const h = paraEsperaH(numero.value, sel.value);
        preview.textContent = `= ${duracaoH(h)} no banco`;
        preview.dataset.tom = '';
      } catch (err) {
        preview.textContent = err.message;
        preview.dataset.tom = 'erro';
      }
    };
    numero.addEventListener('input', atualizarPreview);
    sel.addEventListener('change', atualizarPreview);
    atualizarPreview();

    const salvar = document.createElement('button');
    salvar.type = 'button';
    salvar.className = 'btn btn-forte';
    salvar.textContent = 'Salvar';
    salvar.addEventListener('click', async () => {
      salvar.disabled = true;
      $('tempos-msg').hidden = true;
      try {
        const r = await api(`/api/etapas/${e.etapa}`, {
          metodo: 'PATCH',
          corpo: { valor: numero.value, unidade: sel.value },
        });
        if (!r.ok) { msgTempos(r.dados.erro ?? 'Não foi possível salvar.'); return; }
        renderTempos(r.dados.etapas);
        msgTempos(
          'Tempo salvo. Vale a partir do próximo avanço da régua — não remarca disparos já agendados.',
          'ok',
        );
        await carregarSnapshot({ silencioso: true });
      } catch {
        /* 401 já redirecionou */
      } finally {
        salvar.disabled = false;
      }
    });

    controles.append(campoValor, campoUnidade, preview, salvar);
    li.appendChild(controles);
    return li;
  }));
}

/** `focar`: etapa para rolar até e focar assim que a janela abrir — usada
 *  pelo clique no relógio do fluxo; o botão "Tempos" chama sem argumento. */
async function abrirTempos(focar) {
  $('tempos-msg').hidden = true;
  try {
    const r = await api('/api/etapas');
    if (!r.ok) return msgTempos(r.dados.erro ?? 'Não foi possível carregar.');
    renderTempos(r.dados.etapas);
    janelaTempos.showModal();
    if (focar != null) {
      const li = $('lista-tempos').querySelector(`[data-etapa="${focar}"]`);
      li?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li?.querySelector('.tempo-valor')?.focus();
    }
  } catch { /* 401 já redirecionou */ }
}

$('btn-tempos').addEventListener('click', () => abrirTempos());
$('fechar-tempos').addEventListener('click', () => janelaTempos.close());

/* ═══════════════  atendimento do cliente (resumo do chatbot)  ═══════ */

/**
 * O chatbot de suporte grava um registro por conversa encerrada (motivo,
 * humor, o que foi tentado, desfecho). Duplo clique numa linha abre a
 * LINHA DO TEMPO desses atendimentos, do mais novo ao mais antigo — a
 * memória completa do suporte sobre o cliente, vinda do histórico da API.
 */
function itemAtendimento(a) {
  const art = document.createElement('article');
  art.className = 'chat-atendimento';
  const cab = document.createElement('p');
  cab.className = 'cartao-sub';
  cab.textContent = [
    a.criado_em ? dataHora(a.criado_em) : null,
    a.desfecho || null,
    a.risco_chargeback ? '⚠ risco de chargeback' : null,
  ].filter(Boolean).join(' · ');
  const txt = document.createElement('p');
  txt.className = 'chat-resumo-texto';
  txt.textContent = a.resumo;
  art.append(cab, txt);
  return art;
}

const avisoChat = (texto) =>
  Object.assign(document.createElement('p'), { className: 'cel-fraca', textContent: texto });

async function abrirChatCliente(p) {
  $('chat-quem').textContent =
    [p.nome, p.email].filter(Boolean).join(' · ') || p.transacao_id;
  const alvo = $('chat-historico');
  alvo.replaceChildren(avisoChat('Carregando…'));
  $('janela-chat').showModal();

  let historico = [];
  if (p.transacao_id || p.email) {
    // A chave é a TRANSAÇÃO do pedido clicado; o e-mail vai junto para
    // costurar atendimentos antigos, de antes da chave existir.
    const params = new URLSearchParams();
    if (p.transacao_id) params.set('transacao_id', p.transacao_id);
    if (p.email) params.set('email', p.email);
    try {
      const r = await api(`/api/atendimentos?${params}`);
      if (r.ok) historico = r.dados.atendimentos ?? [];
    } catch { /* 401 já redirecionou */ }
  }
  // Resumos de antes do histórico existir vivem só na coluna do pedido —
  // entram como um item único, para não sumirem da tela.
  if (!historico.length && p.chat_resumo) {
    historico = [{
      resumo: p.chat_resumo, criado_em: p.chat_resumo_em,
      desfecho: null, risco_chargeback: false,
    }];
  }

  alvo.replaceChildren(...(historico.length
    ? historico.map(itemAtendimento)
    : [avisoChat('Este cliente ainda não tem atendimento registrado pelo chatbot de suporte.')]));
}

$('fechar-chat').addEventListener('click', () => $('janela-chat').close());

/* ═══════════════  readmes de produto (conhecimento da IA)  ══════════ */

/**
 * O que o chatbot de suporte sabe sobre cada produto mora no banco, editado
 * por aqui. A lista de produtos vem do seletor do topo (a fila real) somada
 * aos readmes já gravados — assim um produto que saiu da fila não some da
 * edição, e um produto novo pode ser digitado antes de vender a 1ª unidade.
 */
const janelaProdutos = $('janela-produtos');
let readmesIa = [];

function msgProdutos(texto) {
  const el = $('produtos-msg');
  el.textContent = texto;
  el.hidden = false;
}

function produtoEscolhidoIa() {
  return $('pr-novo').value.trim() || $('pr-produto').value;
}

function preencherReadme() {
  const r = readmesIa.find((x) => x.produto === produtoEscolhidoIa());
  $('pr-texto').value = r?.readme ?? '';
  $('pr-ativo').checked = r ? r.ativo !== false : true;
  $('pr-apagar').hidden = !r;
  $('pr-meta').textContent = r
    ? `Atualizado em ${new Date(r.atualizado_em).toLocaleString('pt-BR')}`
      + `${r.atualizado_por ? ` por ${r.atualizado_por}` : ''}${r.ativo === false ? ' · DESLIGADO' : ''}.`
    : 'Este produto ainda não tem readme — a IA não sabe nada sobre ele.';
}

function renderSelectProdutosIa() {
  const nomes = new Set(readmesIa.map((r) => r.produto));
  for (const opt of $('sel-produto').options) {
    if (opt.value) nomes.add(opt.value);
  }
  const escolhido = $('pr-produto').value;
  $('pr-produto').replaceChildren(...[...nomes].sort().map((nome) => {
    const tem = readmesIa.some((r) => r.produto === nome);
    return Object.assign(document.createElement('option'), {
      value: nome,
      textContent: tem ? `${nome} · com readme` : `${nome} · sem readme`,
    });
  }));
  if (escolhido && nomes.has(escolhido)) $('pr-produto').value = escolhido;
}

async function abrirProdutos() {
  $('produtos-msg').hidden = true;
  $('pr-novo').value = '';
  try {
    const r = await api('/api/produtos-ia');
    if (!r.ok) return msgProdutos(r.dados.erro ?? 'Não foi possível carregar os readmes.');
    readmesIa = r.dados.readmes ?? [];
    renderSelectProdutosIa();
    preencherReadme();
    janelaProdutos.showModal();
  } catch { /* 401 já redirecionou */ }
}

$('btn-produtos').addEventListener('click', abrirProdutos);
$('fechar-produtos').addEventListener('click', () => janelaProdutos.close());
$('pr-produto').addEventListener('change', () => { $('pr-novo').value = ''; preencherReadme(); });
$('pr-novo').addEventListener('input', preencherReadme);

$('form-readme').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const produto = produtoEscolhidoIa();
  if (!produto) return msgProdutos('Escolha ou digite um produto.');
  const readme = $('pr-texto').value.trim();
  if (!readme) return msgProdutos('Escreva o readme antes de salvar.');

  try {
    const r = await api(`/api/produtos-ia/${encodeURIComponent(produto)}`, {
      metodo: 'PUT',
      corpo: { readme, ativo: $('pr-ativo').checked },
    });
    if (!r.ok) return msgProdutos(r.dados.erro ?? 'Não foi possível salvar.');

    const salvo = r.dados.readme;
    const idx = readmesIa.findIndex((x) => x.produto === salvo.produto);
    if (idx === -1) readmesIa.push(salvo); else readmesIa[idx] = salvo;
    renderSelectProdutosIa();
    $('pr-produto').value = salvo.produto;
    $('pr-novo').value = '';
    preencherReadme();
    msgProdutos(`Salvo. A IA já usa este texto na próxima conversa sobre ${salvo.produto}.`);
  } catch { /* 401 já redirecionou */ }
});

$('pr-apagar').addEventListener('click', async () => {
  const produto = produtoEscolhidoIa();
  if (!produto) return;
  // Apagar tira o conhecimento da IA na hora — merece a pergunta.
  if (!window.confirm(`Apagar o readme de "${produto}"? A IA deixa de saber sobre ele.`)) return;
  try {
    const r = await api(`/api/produtos-ia/${encodeURIComponent(produto)}`, { metodo: 'DELETE' });
    if (!r.ok) return msgProdutos(r.dados.erro ?? 'Não foi possível apagar.');
    readmesIa = readmesIa.filter((x) => x.produto !== produto);
    renderSelectProdutosIa();
    preencherReadme();
    msgProdutos(`Readme de ${produto} apagado.`);
  } catch { /* 401 já redirecionou */ }
});

/* ═══════════════════  linha de mensagens ativa (1·2·3)  ═════════════ */

/**
 * Duas coisas diferentes que a interface precisa distinguir:
 *
 *   EXIBINDO — qual linha de copy está desenhada no fluxo agora
 *   ATIVA    — qual linha o n8n está de fato usando nos envios
 *
 * Clicar numa aba só troca o que você VÊ. Ativar é um segundo passo, com
 * botão próprio e confirmação. Se clicar na aba já trocasse a campanha,
 * conferir o texto da linha 3 mudaria o que milhares de clientes recebem.
 */
function renderLinha(s) {
  const info = s?.linha;
  const barra = $('linha-barra');
  // As abas aparecem sempre: conferir a copy de cada linha é útil mesmo sem o
  // webhook ligado. Só ATIVAR depende do n8n estar configurado.
  barra.hidden = !info;
  if (barra.hidden) return;

  estado.linhaExibindo = info.exibindo;
  estado.linhaAtiva = info.ativa;
  const podeTrocar = Boolean(estado.usuario?.admin) && info.configurado;

  /*
   * A lista sai de `resumo`, que o servidor monta lendo painel_linhas_copy.
   *
   * Dropdown e não abas: com muitas linhas as abas quebram em várias fileiras
   * e empurram o fluxo para baixo. O que as abas mostravam de graça — qual
   * está no ar, quais estão incompletas — não se perde: vai no rótulo de cada
   * opção, e o selo "no ar" ao lado fica visível mesmo quando você seleciona
   * outra.
   *
   * Ordena por `ordem` e, no empate, pelo número — para o 10 não cair entre o
   * 1 e o 2, como aconteceria numa comparação de texto.
   */
  const linhas = Object.values(info.resumo ?? {})
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)
      || (Number(a.linha) || 0) - (Number(b.linha) || 0));

  const numeros = linhas.map((r) => r.linha);
  // A linha no ar entra na lista mesmo se sumir do cadastro — senão o painel
  // deixaria de mostrar justamente a copy que os clientes estão recebendo.
  if (info.ativa && !numeros.includes(info.ativa)) {
    linhas.unshift({ linha: info.ativa, nome: null });
  }
  if (info.exibindo && !numeros.includes(info.exibindo)
      && info.exibindo !== info.ativa) {
    linhas.push({ linha: info.exibindo, nome: null });
  }

  const sel = $('linha-select');
  sel.replaceChildren(...linhas.map((meta) => {
    const n = meta.linha;
    const faltamE = Math.max(0, (meta.etapas_exigidas ?? 6) - (meta.emails_prontos ?? 0));
    const faltamS = Math.max(0, (meta.etapas_exigidas ?? 6) - (meta.sms_prontos ?? 0));

    // O estado vai no TEXTO da opção: num dropdown fechado só se lê o rótulo,
    // então cor ou ícone à parte não sobreviveriam.
    const estadoTxt = n === info.ativa
      ? ' — no ar'
      : (meta.completa === false ? ` — faltam ${faltamE + faltamS}` : '');

    return Object.assign(document.createElement('option'), {
      value: n,
      textContent: `${n} · ${meta.nome ?? `Linha ${n}`}${estadoTxt}`,
    });
  }));
  sel.value = info.exibindo;

  // Selo do que está no ar, à parte da seleção.
  const noAr = $('linha-noar');
  noAr.hidden = !info.ativa;
  if (info.ativa) {
    const metaAtiva = info.resumo?.[info.ativa];
    $('linha-noar-nome').textContent = metaAtiva?.nome
      ? `${info.ativa} · ${metaAtiva.nome}`
      : `linha ${info.ativa}`;
  }

  // Criar e editar não dependem do webhook — só de ser administrador.
  const admin = Boolean(estado.usuario?.admin);
  $('linha-nova').hidden = !admin;
  $('linha-editar').hidden = !admin;

  // O propósito da linha aberta, escrito — é o que permite decidir qual ativar
  // sem precisar ler as seis mensagens de cada uma.
  const intuito = info.resumo?.[info.exibindo]?.intuito;
  const elIntuito = $('linha-intuito');
  elIntuito.textContent = intuito ?? '';
  elIntuito.hidden = !intuito;

  const sub = $('linha-sub');
  const botao = $('linha-ativar');
  const divergindo = info.exibindo !== info.ativa;

  if (divergindo) {
    const vista = info.resumo?.[info.exibindo];
    const incompleta = vista?.completa === false;

    sub.textContent = `Você está vendo a linha ${info.exibindo}. `
      + `Quem está no ar é a linha ${info.ativa} — os clientes recebem os textos dela.`
      + (incompleta
        ? ` A linha ${info.exibindo} está incompleta: ${vista.emails_prontos}/`
          + `${vista.etapas_exigidas} e-mails e ${vista.sms_prontos}/${vista.etapas_exigidas} SMS.`
        : '')
      + (info.configurado ? '' : ' Para trocar, configure N8N_TROCAR_LINHA_URL e N8N_TOKEN no .env.');
    sub.dataset.aviso = 'sim';
    botao.hidden = !podeTrocar;
    // Ativar uma linha incompleta é recusado pelo webhook. Desabilitar aqui
    // evita o clique que só devolve erro.
    botao.disabled = incompleta;
    botao.textContent = incompleta
      ? 'Complete a linha para ativar'
      : `Ativar a linha ${info.exibindo}`;
  } else {
    sub.textContent = 'Esta é a linha no ar. O painel mostra a última troca feita por '
      + 'aqui — não existe consulta no n8n, então se alguém trocou por fora, pode ter mudado.';
    sub.dataset.aviso = 'nao';
    botao.hidden = true;
  }
}
/* ── criar e editar uma linha de copy ── */

const janelaLinha = $('janela-linha');

/* null = criando; um número = editando aquela linha. O mesmo formulário serve
   para os dois: os campos são os mesmos, muda o que pode ser alterado. */
let editandoLinha = null;

function abrirJanelaLinha(numero) {
  const resumo = estado.snapshot?.linha?.resumo ?? {};
  editandoLinha = numero ?? null;
  const meta = numero ? resumo[numero] : null;

  $('linha-msg').hidden = true;
  $('nl-estado').textContent = '';
  $('linha-nova-tit').textContent = numero ? `Editar a linha ${numero}` : 'Nova linha de copy';

  if (numero) {
    $('nl-numero').value = numero;
    $('nl-nome').value = meta?.nome ?? '';
    $('nl-intuito').value = meta?.intuito ?? '';
    $('nl-ordem').value = meta?.ordem ?? '';
  } else {
    const usados = Object.keys(resumo).map(Number).filter(Number.isFinite);
    const proximo = usados.length ? Math.max(...usados) + 1 : 1;
    $('nl-numero').value = String(proximo);
    $('nl-nome').value = '';
    $('nl-intuito').value = '';
    $('nl-ordem').value = String(proximo);
  }

  // O número é a chave que o webhook usa e que as mensagens referenciam:
  // mudá-lo depois quebraria as duas pontas. Só se escolhe na criação.
  $('nl-numero').disabled = Boolean(numero);
  $('nl-dica-numero').textContent = numero
    ? 'Não muda: é a chave que o webhook usa e que as mensagens referenciam.'
    : '1 a 4 dígitos. É por ele que o webhook ativa a linha.';

  // Copiar só faz sentido ao criar.
  $('nl-campo-copiar').hidden = Boolean(numero);
  if (!numero) {
    const sel = $('nl-copiar');
    sel.replaceChildren(Object.assign(document.createElement('option'), {
      value: '', textContent: 'Em branco — escrever as 12 mensagens',
    }));
    for (const [num, m] of Object.entries(resumo)) {
      sel.append(Object.assign(document.createElement('option'), {
        value: num,
        textContent: `Copiar da linha ${num}${m.nome ? ` · ${m.nome}` : ''}`
          + ` (${m.mensagens ?? 0} mensagens)`,
      }));
    }
    sel.value = estado.linhaExibindo ?? '';
  }

  $('nl-criar').textContent = numero ? 'Salvar' : 'Criar linha';
  // Apagar a linha no ar é recusado pelo servidor; esconder aqui evita o
  // clique que só devolveria erro.
  $('nl-apagar').hidden = !numero || numero === estado.linhaAtiva;

  janelaLinha.showModal();
  $('nl-nome').focus();
}

$('linha-nova').addEventListener('click', () => abrirJanelaLinha(null));
$('linha-editar').addEventListener('click', () => abrirJanelaLinha(estado.linhaExibindo));
$('fechar-linha').addEventListener('click', () => janelaLinha.close());

$('linha-select').addEventListener('change', (ev) => verLinha(ev.target.value));

$('nl-apagar').addEventListener('click', async () => {
  const alvo = editandoLinha;
  if (!alvo) return;
  const meta = estado.snapshot?.linha?.resumo?.[alvo];
  const quantas = meta?.mensagens ?? 0;
  if (!confirm(
    `Apagar a linha ${alvo}${meta?.nome ? ` · ${meta.nome}` : ''}?\n\n`
    + `${quantas} mensagens serão apagadas junto. Não dá para desfazer.`,
  )) return;

  try {
    const r = await api(`/api/linhas/${alvo}`, { metodo: 'DELETE' });
    if (!r.ok) {
      const msg = $('linha-msg');
      msg.textContent = r.dados.erro ?? 'Não foi possível apagar.';
      msg.dataset.tom = 'erro';
      msg.hidden = false;
      return;
    }
    janelaLinha.close();
    estado.linhaExibindo = estado.linhaAtiva;
    await carregarSnapshot({ silencioso: true });
    carregarPedidos();
  } catch { /* 401 já redirecionou */ }
});

$('form-linha').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nome = $('nl-nome').value.trim();
  const intuito = $('nl-intuito').value.trim();
  const ordemBruta = Number.parseInt($('nl-ordem').value, 10);
  const ordem = Number.isInteger(ordemBruta) ? ordemBruta : undefined;

  const msg = $('linha-msg');
  const falhar = (t) => { msg.textContent = t; msg.dataset.tom = 'erro'; msg.hidden = false; };
  if (!nome) return falhar('A linha precisa de um nome.');

  const editando = editandoLinha;
  const numero = editando ?? $('nl-numero').value.trim();
  if (!editando && !/^\d{1,4}$/.test(numero)) {
    return falhar('O número deve ter de 1 a 4 dígitos.');
  }

  $('nl-criar').disabled = true;
  $('nl-estado').textContent = editando ? 'salvando…' : 'criando…';
  try {
    const r = editando
      ? await api(`/api/linhas/${editando}`, { metodo: 'PATCH', corpo: { nome, intuito, ordem } })
      : await api('/api/linhas', {
        metodo: 'POST',
        corpo: { linha: numero, nome, intuito, ordem, copiarDe: $('nl-copiar').value || null },
      });

    if (!r.ok) { falhar(r.dados.erro ?? 'Não foi possível salvar.'); return; }

    janelaLinha.close();
    // Abre a linha mexida — é o próximo passo de qualquer jeito, e deixar o
    // usuário procurá-la na lista seria trabalho à toa.
    estado.linhaExibindo = numero;
    await carregarSnapshot({ silencioso: true });
    carregarPedidos();
    if (!editando) {
      document.querySelector('.cartao--canvas')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch {
    /* 401 já redirecionou */
  } finally {
    $('nl-criar').disabled = false;
    $('nl-estado').textContent = '';
  }
});

/** Troca só a visualização. Recarrega o snapshot na linha pedida. */
function verLinha(n) {
  if (n === estado.linhaExibindo) return;
  estado.linhaExibindo = n;
  carregarSnapshot({ silencioso: true });
  carregarPedidos();
}

$('linha-ativar').addEventListener('click', async (ev) => {
  const n = estado.linhaExibindo;
  const b = ev.currentTarget;

  // Muda a copy de toda a operação: merece confirmação explícita.
  const ok = confirm(
    `Ativar a Linha ${n}?\n\n`
    + 'A partir de agora TODOS os e-mails e SMS passam a sair com os textos '
    + `da linha ${n}, até alguém trocar de novo.`,
  );
  if (!ok) return;

  const rotulo = b.textContent;
  b.disabled = true;
  b.textContent = 'Ativando…';
  try {
    const r = await api('/api/linha', { metodo: 'POST', corpo: { linha: n } });
    if (!r.ok) {
      alert(r.dados.erro ?? 'Não foi possível trocar a linha.');
      return;
    }
    // Recarrega tudo: com a linha nova ativa, o alcance por canal e os
    // gráficos filtrados por canal mudam junto.
    await carregarSnapshot({ silencioso: true });
    carregarPedidos();
  } catch {
    /* 401 já redirecionou */
  } finally {
    b.disabled = false;
    b.textContent = rotulo;
  }
});

/* ══════════════════════════════  início  ════════════════════════════ */

/* Identifica quem está usando ANTES de carregar dados: se a sessão não vale
   mais, o redirecionamento acontece sem o painel piscar números na tela. */
(async () => {
  try {
    const r = await api('/api/auth/eu');
    if (!r.ok) return location.replace('/login');
    if (r.dados.usuario.trocar_senha) return location.replace('/login');
    renderUsuario(r.dados.usuario);

    // Digital do código que está servindo esta página. Serve para responder
    // "o container está na mesma versão do npm start?" olhando, em vez de
    // comparando telas.
    try {
      const v = await (await fetch('/api/vivo')).json();
      estado.versao = v;
    } catch { /* sem digital, o rodapé só omite */ }
  } catch {
    return;   // 401 já redirecionou
  }

  renderLegenda();
  carregarSnapshot();   // já traz a linha ativa e desenha o seletor
  carregarPedidos();
  carregarSuporte();    // a aba principal
  reagendar();
})();
