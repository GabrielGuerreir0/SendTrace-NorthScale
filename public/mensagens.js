/**
 * Trilha de comunicação: o que cada etapa DIZ, nos dois canais.
 *
 * O canvas de cima responde "quantos pedidos estão em cada etapa". Este
 * responde a outra pergunta — "o que essa pessoa vai receber, e quando". São
 * as duas metades da régua, e misturar as duas num nó só espremeria a copy a
 * ponto de não dar para ler.
 *
 * Feito em HTML, não em SVG, de propósito: aqui o conteúdo é TEXTO de tamanho
 * variável. Em HTML ele quebra sozinho, é selecionável, é lido por leitor de
 * tela e cresce sem recalcular geometria. Travado como o outro — sem arrastar,
 * sem zoom; a única interação é rolar quando não cabe.
 */
import { svgEl } from './charts.js';
import { n, duracaoH } from './format.js';
// Medidor compartilhado com o editor e com o servidor: uma regra de SMS só.
import { medirSms } from './copy.js';

const GLIFOS = {
  envelope: 'M2.2 4h11.6v8H2.2z M2.2 4.4l5.8 4.1 5.8-4.1',
  sms: 'M2.2 3.2h11.6v7.2H7.4L4.4 13v-2.6H2.2z',
  interrogacao: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z M6.4 6.3c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6c0 1.2-1.6 1.1-1.6 2.6 M8 11.2v.1',
};

/* Os marcadores viram um exemplo concreto. Mostrar "{nome}" cru obrigaria o
   leitor a simular a substituição de cabeça para julgar o tamanho da mensagem —
   e no SMS o tamanho é o que decide quantos segmentos são cobrados.

   O exemplo é o PIOR CASO REAL da fila: o maior nome e o maior produto que
   existem hoje. Uma amostra confortável ("Ana", "Memopryl") faria o painel
   dizer "1 segmento" para mensagens que, no cliente de verdade, saem em dois
   e custam o dobro. */
const AMOSTRA_PADRAO = { nome: 'Ana', produto: 'Memopryl', uso: 'as directed' };
let amostra = { ...AMOSTRA_PADRAO };

const preencher = (t) =>
  String(t ?? '').replace(/\{(nome|produto|uso)\}/g, (_, chave) => amostra[chave] ?? `{${chave}}`);

const el = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
};

function iconeCanal(glifo) {
  const svg = svgEl('svg', { class: 'msg-ico', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svgEl('path', { d: GLIFOS[glifo] ?? GLIFOS.interrogacao }, svg);
  return svg;
}

/** Quando esta etapa dispara, contado da compra. */
function quandoDispara(e) {
  if (!Number.isFinite(e.offset_h)) return 'momento não declarado';
  if (e.offset_h === 0) return 'na hora da compra';
  return `${duracaoH(e.offset_h)} após a compra`;
}

function cartaoMensagem(m, canaisMeta, destinos, aoAbrir, etapa) {
  const meta = canaisMeta[m.canal] ?? { label: m.canal, glifo: 'interrogacao' };
  const card = el('div', 'msg');
  card.dataset.canal = m.canal;
  card.dataset.ativo = m.ativo === false ? 'nao' : 'sim';

  /*
   * Duplo clique abre a mensagem renderizada. Duplo clique sozinho seria uma
   * função invisível e inalcançável pelo teclado, então o cartão também é
   * focável e responde a Enter, e o rodapé diz que dá para abrir.
   */
  if (aoAbrir) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = 'Duplo clique para ver a mensagem como o cliente recebe';
    card.addEventListener('dblclick', () => aoAbrir(m, etapa));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); aoAbrir(m, etapa); }
    });
  }

  const topo = el('div', 'msg-topo');
  topo.append(iconeCanal(meta.glifo), el('span', 'msg-canal', meta.label));
  if (m.ativo === false) topo.append(el('span', 'msg-off', 'desativada'));
  card.append(topo);

  if (m.assunto) card.append(el('p', 'msg-assunto', preencher(m.assunto)));
  card.append(el('p', 'msg-texto', preencher(m.texto)));

  if (m.botao) {
    const cta = el('div', 'msg-cta');
    cta.append(el('span', 'msg-cta-rot', preencher(m.botao)));
    if (m.destino) cta.append(el('span', 'msg-cta-dest', destinos?.[m.destino] ?? m.destino));
    card.append(cta);
  }

  // Só o SMS ganha a régua de tamanho: no e-mail o comprimento não custa nada,
  // no SMS cada segmento é uma cobrança a mais.
  if (m.canal === 'sms') {
    const med = medirSms(preencher(m.texto));
    const rod = el('div', 'msg-medida');
    rod.dataset.alerta = med.segmentos > 1 || med.unicode ? 'sim' : 'nao';

    const partes = [`${n(med.unidades)}/${med.limite} caracteres`];
    partes.push(med.segmentos === 1 ? '1 segmento' : `${med.segmentos} segmentos · custa o dobro`);
    if (med.unicode) partes.push('fora do GSM-7: limite cai para 70');
    rod.textContent = partes.join(' · ');

    const base = med.unicode
      ? 'Há caractere fora do alfabeto GSM-7 (travessão, aspa curva, emoji…). '
        + 'A operadora passa a codificar em UCS-2 e cada segmento cai de 160 para 70 caracteres.'
      : 'Um SMS acima de 160 caracteres é quebrado em segmentos, e cada segmento é cobrado.';
    // Dizer QUEM causa o estouro transforma o aviso em algo acionável: dá para
    // ver que o culpado é o nome do produto e encurtá-lo só no SMS.
    rod.title = `${base}\n\nMedido pelo pior caso da sua fila: `
      + `nome "${amostra.nome}" e produto "${amostra.produto}".`;
    card.append(rod);
  }

  return card;
}

function cartaoEtapa(e, canaisMeta, destinos, aoAbrir, linhaAtual) {
  const art = el('article', 'trilha-etapa');
  art.dataset.inativa = e.ativo === false ? 'sim' : 'nao';

  const cab = el('header', 'trilha-cab');
  cab.append(el('span', 'trilha-idx', String(e.etapa)));

  const meio = el('div', 'trilha-meio');
  meio.append(el('h3', 'trilha-nome', e.nome));
  meio.append(el('p', 'trilha-quando', quandoDispara(e)));
  cab.append(meio);

  // Liga a copy à fila: quantos vão receber ESTA mensagem a seguir.
  const qtd = el('span', 'trilha-qtd');
  qtd.append(el('b', null, n(e.na_etapa ?? 0)));
  qtd.append(el('i', null, 'aqui agora'));
  cab.append(qtd);
  art.append(cab);

  if (e.ativo === false) art.append(el('p', 'trilha-aviso', 'Etapa desativada na régua.'));

  /*
   * Um cartão por CANAL, sempre — mesmo quando a mensagem não existe.
   *
   * Uma linha recém-criada não tem mensagem nenhuma; sem os cartões vazios não
   * haveria onde clicar para escrever a primeira, e o editor ficaria
   * inalcançável justamente quando é mais necessário. O vazio também é a
   * informação: aquela etapa não envia nada naquele canal.
   */
  const existentes = new Map((e.mensagens ?? []).map((m) => [m.canal, m]));
  for (const canal of ['email', 'sms']) {
    const m = existentes.get(canal);
    art.append(m
      ? cartaoMensagem(m, canaisMeta, destinos, aoAbrir, e)
      : cartaoVazio(canal, canaisMeta, aoAbrir, e, linhaAtual));
  }

  return art;
}

/** Lugar de uma mensagem que ainda não existe. Clicar abre o editor em branco. */
function cartaoVazio(canal, canaisMeta, aoAbrir, etapa, linha) {
  const meta = canaisMeta[canal] ?? { label: canal, glifo: 'interrogacao' };
  const card = el('div', 'msg msg--vazia');
  card.dataset.canal = canal;

  const topo = el('div', 'msg-topo');
  topo.append(iconeCanal(meta.glifo), el('span', 'msg-canal', meta.label));
  topo.append(el('span', 'msg-off', 'não cadastrada'));
  card.append(topo);

  card.append(el('p', 'msg-texto',
    `Esta etapa não envia ${meta.label} na linha ${linha ?? '—'}.`));

  if (aoAbrir) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = `Criar a mensagem de ${meta.label} desta etapa`;
    card.append(el('p', 'msg-criar', 'Duplo clique para escrever'));

    // Molde vazio com a identidade certa: o editor grava por (etapa, canal,
    // linha), então basta isso para o UPSERT criar o registro.
    const molde = {
      etapa: etapa.etapa, canal, linha,
      assunto: null, corpo_html: null, botao: null, destino: null,
      texto: '', ativo: true, novo: true,
    };
    card.addEventListener('dblclick', () => aoAbrir(molde, etapa));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); aoAbrir(molde, etapa); }
    });
  }
  return card;
}

export function criarTrilha(container, { aoAbrirMensagem } = {}) {
  return {
    atualizar(etapas, canaisMeta, destinos, linha, piorCaso) {
      // Sem fila ainda, cai na amostra padrão: melhor um exemplo confortável
      // que um marcador cru.
      amostra = {
        nome: piorCaso?.nome || AMOSTRA_PADRAO.nome,
        produto: piorCaso?.produto || AMOSTRA_PADRAO.produto,
        uso: AMOSTRA_PADRAO.uso,
      };

      const vivas = (etapas ?? []).filter((e) => !e.terminal);
      if (!vivas.length) {
        container.replaceChildren(el('p', 'vazio-suave', 'Nenhuma etapa cadastrada na régua.'));
        return;
      }

      // A amostra usada nos marcadores é a mesma da medição de SMS, para o que
      // se lê no cartão e o que se vê na pré-visualização não divergirem.
      const abrir = aoAbrirMensagem
        ? (m, etapa) => aoAbrirMensagem(m, etapa, amostra)
        : null;

      const partes = [];
      vivas.forEach((e, i) => {
        partes.push(cartaoEtapa(e, canaisMeta, destinos, abrir, linha?.exibindo));

        const prox = vivas[i + 1];
        if (!prox) return;
        const seta = el('div', 'trilha-seta');
        seta.setAttribute('aria-hidden', 'true');
        seta.append(el('span', 'trilha-seta-linha'));
        seta.append(el('span', 'trilha-seta-txt',
          Number.isFinite(e.espera_h) ? duracaoH(e.espera_h) : '—'));
        partes.push(seta);
      });

      // Fecho: deixa explícito que a régua ACABA, em vez de a última etapa
      // simplesmente terminar e parecer que o desenho foi cortado.
      const fim = el('div', 'trilha-fim');
      fim.append(el('span', 'trilha-fim-ico', '✓'));
      fim.append(el('span', 'trilha-fim-txt', 'fim da régua'));
      partes.push(fim);

      container.replaceChildren(...partes);
    },
  };
}
