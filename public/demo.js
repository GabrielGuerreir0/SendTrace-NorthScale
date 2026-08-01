/**
 * Modo demonstração — dados sintéticos gerados NO NAVEGADOR.
 * Existe porque a tabela `disparos_pos_venda` ainda está vazia: sem isto não dá
 * para avaliar o painel cheio. Nada aqui toca o banco, em nenhum sentido.
 *
 * A régua real dispara E-MAIL E SMS EM TODA ETAPA — o canal é atributo da
 * mensagem, não da etapa. Por isso cada etapa carrega um array `mensagens` com
 * as duas peças, e as agregações por canal partem do mesmo universo de pedidos.
 */

/* Espelha a semente de etapas_regua: mesma cadência (offset em horas desde a
   compra), mesma copy em inglês — o público é dos EUA. O `base` é só a ordem de
   grandeza do funil, que encolhe a cada etapa. */
const ETAPAS_DEMO = [
  {
    etapa: 0,
    nome: 'Confirmação + e-book',
    descricao: 'Confirma a compra e entrega o brinde digital enquanto a atenção ainda está alta.',
    offset_h: 0.5,
    espera_h: 23.5,
    base: 1200,
    assunto: '{nome}, your {produto} order is confirmed — your free gift is inside',
    email: 'You just made a decision most people never make. Order confirmed, and the Sharp Mind After 40 Guide is yours right now.',
    botao: 'Download Your Free Guide →',
    destino: 'EBOOK',
    sms: '{nome}, you just made a great choice for your brain health! We sent you something important - check your email now. Reply STOP to end',
  },
  {
    etapa: 1,
    nome: 'Logística + formato',
    descricao: 'Situação do pedido no dia 1 e a explicação de por que a fórmula é líquida.',
    offset_h: 24,
    espera_h: 24,
    base: 900,
    assunto: '{nome}, your {produto} order is on track',
    email: 'Where the order stands today, plus why {produto} is a liquid formula and not capsules.',
    botao: 'Open the Free Guide →',
    destino: 'EBOOK',
    sms: 'Hi {nome}, we just sent an update regarding your {produto} order. Check your inbox now! Reply STOP to end',
  },
  {
    etapa: 2,
    nome: 'Logística — Dia 2',
    descricao: 'Pedido separado, etiqueta de envio em processamento.',
    offset_h: 48,
    espera_h: 24,
    base: 640,
    assunto: '{nome}, your {produto} is progressing well',
    email: 'Day 2: prepared and ready to ship, shipping label being processed.',
    botao: 'Check my order →',
    destino: 'ASSISTENTE',
    sms: 'Hi {nome}, we just sent a Day 2 update regarding your {produto} order. Check your inbox now! Reply STOP to end',
  },
  {
    etapa: 3,
    nome: 'Logística — Dia 3',
    descricao: 'Pedido entregue à transportadora, com link de rastreio.',
    offset_h: 72,
    espera_h: 24,
    base: 420,
    assunto: '{nome}, quick update on your {produto} shipment',
    email: 'Day 3: handed to the carrier and on its way — tracking link arriving in your inbox.',
    botao: 'Check my order →',
    destino: 'ASSISTENTE',
    sms: 'Hi {nome}, your {produto} is moving! We just emailed you a Day 3 update - check your inbox. Reply STOP to end',
  },
  {
    etapa: 4,
    nome: 'A caminho + pergunta',
    descricao: 'Em trânsito, com uma pergunta aberta para puxar resposta do cliente.',
    offset_h: 96,
    espera_h: 24,
    base: 260,
    assunto: '{nome}, your {produto} is on its way — one question for you',
    email: 'Day 4: in transit. And a question — what moment are you most looking forward to?',
    botao: 'Check my order →',
    destino: 'ASSISTENTE',
    sms: "Hi {nome}, your {produto} is getting closer! Our team just emailed you and we'd love your feedback - check your inbox. Reply STOP to end",
  },
  {
    etapa: 5,
    nome: 'Guia de uso completo',
    descricao: 'Última peça da régua: como tomar e o que esperar semana a semana.',
    offset_h: 120,
    espera_h: null,
    base: 150,
    assunto: '{nome}, read this before your {produto} arrives',
    email: 'The complete usage guide: why liquid drops, how to take it, and the honest week-by-week timeline.',
    botao: 'Questions? Talk to us →',
    destino: 'ASSISTENTE',
    sms: 'Hi {nome}, great news! {produto} is almost there. Check your inbox for an important update to read before it arrives. Reply STOP to end',
  },
];

/* Catálogo curto de suplementos, no espírito do produto real (Memopryl). */
const PRODUTOS = ['Memopryl', 'Neurovance Drops', 'Clarivance', 'Vitalmind Pro',
  'Focustra Liquid', 'Cognilift'];

/* Público dos EUA: nomes norte-americanos. */
const NOMES = ['James Whitaker', 'Linda Carver', 'Robert Halloran', 'Patricia Nolan',
  'Michael Boyd', 'Barbara Sutton', 'William Deacon', 'Susan Kirkland',
  'David Mercer', 'Margaret Fenwick', 'Richard Ashby', 'Nancy Holloway',
  'Charles Redding', 'Dorothy Langston', 'Thomas Ellery', 'Carol Winslow',
  'Daniel Prescott', 'Sandra Beaumont', 'Kenneth Marlowe', 'Betty Sinclair'];

/* Falhas plausíveis dos dois canais que existem aqui — nada de WhatsApp. */
const ERROS = [
  'timeout ao chamar o provedor de SMS',
  'e-mail devolvido (hard bounce)',
  'número de telefone inválido para SMS',
  'rate limit do provedor de e-mail atingido (429)',
  'contato optou por não receber (STOP)',
  'caixa de entrada cheia — devolução temporária',
  'carrier rejeitou o SMS (landline)',
  'domínio de e-mail inexistente (NXDOMAIN)',
  'rate limit do gateway de SMS atingido (429)',
  'e-mail marcado como spam pelo destinatário',
];

/* Fatia de pedidos sem telefone: o SMS simplesmente não alcança essa gente.
   É o que dá efeito visível ao filtro por canal e à coluna "sem contato". */
const SEM_TELEFONE = 0.14;

const ESTADOS_DEMO = [
  { id: 'em_dia', label: 'Em dia', icone: '●', descricao: 'Aguardando o disparo dentro do prazo configurado.' },
  { id: 'atrasado', label: 'Atrasado', icone: '▲', descricao: 'O horário de disparo já passou e nada saiu.' },
  { id: 'processando', label: 'Processando', icone: '◐', descricao: 'Um worker pegou o registro e está enviando.' },
  { id: 'travado', label: 'Travado', icone: '■', descricao: 'Preso em processamento além do timeout do lock.' },
  { id: 'finalizado', label: 'Finalizado', icone: '✓', descricao: 'Concluiu a régua ou foi encerrado.' },
];

const CANAIS_DEMO = {
  email: { label: 'E-mail', glifo: 'envelope', contato: 'email', faltando: 'sem e-mail' },
  sms: { label: 'SMS', glifo: 'sms', contato: 'telefone', faltando: 'sem telefone' },
};

const DESTINOS_DEMO = { EBOOK: 'E-book gratuito', ASSISTENTE: 'Assistente de dúvidas' };

/* Gerador congruente linear: variação suave entre atualizações, sem pular. */
function rng(semente) {
  let s = semente >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** A semente troca a cada 20 s: os números respiram sem virar ruído. */
const semente = () => Math.floor(Date.now() / 20000);

/** Chave de dia no fuso LOCAL — o painel casa as barras por data local, não UTC. */
function chaveDia(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Monta as duas mensagens da etapa. O SMS não tem assunto, botão nem destino. */
function mensagensDa(e) {
  return [
    { canal: 'email', assunto: e.assunto, texto: e.email, botao: e.botao, destino: e.destino, ativo: true },
    { canal: 'sms', assunto: null, texto: e.sms, botao: null, destino: null, ativo: true },
  ];
}

export function snapshotDemo() {
  const r = rng(semente());
  const agora = Date.now();

  const etapas = ETAPAS_DEMO.map((e, i) => {
    // Quem ainda está VIVO na etapa. Os quatro estados abaixo particionam isto.
    const na_etapa = Math.round(e.base * (0.9 + r() * 0.2));
    const atrasado = Math.round(na_etapa * (0.02 + r() * 0.055));
    const processando = Math.round(na_etapa * (0.005 + r() * 0.02));
    // A etapa 2 concentra travamento de propósito, para o realce ter o que mostrar.
    const travado = i === 2 ? 2 + Math.floor(r() * 6) : Math.floor(r() * 2.2);
    const em_dia = Math.max(na_etapa - atrasado - processando - travado, 0);
    // Recompõe a partir das partes: garante na_etapa === soma dos quatro mesmo
    // quando o clamp acima corta alguém.
    const vivos = em_dia + atrasado + processando + travado;

    // Quem já passou por aqui e seguiu adiante. É maior nas etapas iniciais,
    // porque o funil inteiro atravessou a etapa 0 em algum momento. O jitter é
    // estreito de propósito: largo demais, uma etapa posterior ultrapassaria a
    // anterior e o funil deixaria de ser um funil.
    const finalizado = Math.round(e.base * (1.5 + r() * 0.4));

    // "Prestes" é só quem dispara na PRÓXIMA HORA e ainda não venceu — logo sai
    // do bolo de em_dia, nunca dos atrasados.
    const prestes = Math.min(em_dia, Math.round(em_dia * (0.02 + r() * 0.05)));

    // 12 baldes de 4 h cobrindo as próximas 48 h; a crista anda com a etapa,
    // porque cada etapa tem um offset diferente desde a compra.
    const onda48h = Array.from({ length: 12 }, (_, b) => {
      const crista = Math.exp(-(((b - 1 - i * 1.4) ** 2) / 7));
      return Math.round(vivos * 0.12 * crista * (0.6 + r() * 0.8));
    });

    // Observado ≈ configurado, com desvio pequeno. Na etapa 3 o desvio é de ~45%
    // de propósito (72 h → ~104 h), para exercitar o realce de deriva do painel.
    const desvio = i === 3 ? 1.42 + r() * 0.06 : 0.94 + r() * 0.13;
    const observado_h = Math.round(e.offset_h * desvio * 10) / 10;

    return {
      etapa: e.etapa,
      nome: e.nome,
      descricao: e.descricao,
      ativo: true,
      espera_h: e.espera_h,
      offset_h: e.offset_h,
      mensagens: mensagensDa(e),
      total: vivos + finalizado,
      em_dia,
      atrasado,
      processando,
      travado,
      finalizado,
      com_erro: Math.round(vivos * (0.004 + r() * 0.012)),
      com_retry: Math.round(vivos * (0.01 + r() * 0.03)),
      novos_24h: Math.round(vivos * (0.06 + r() * 0.12)),
      prestes,
      proximo_em: vivos > 0 ? new Date(agora + (2 + r() * 90) * 60000).toISOString() : null,
      max_tentativas: 1 + Math.floor(r() * 5),
      na_etapa: vivos,
      onda48h,
      espera_acumulada_h: e.offset_h,
      observado_h,
      observado_amostra: vivos > 0 ? Math.max(1, Math.round(vivos * (0.4 + r() * 0.5))) : 0,
    };
  });

  const soma = (k) => etapas.reduce((a, e) => a + e[k], 0);
  const totais = {
    total: soma('total'),
    em_dia: soma('em_dia'),
    atrasado: soma('atrasado'),
    processando: soma('processando'),
    travado: soma('travado'),
    finalizado: soma('finalizado'),
    com_erro: soma('com_erro'),
    com_retry: soma('com_retry'),
    novos_24h: soma('novos_24h'),
    prestes: soma('prestes'),
    na_regua: soma('na_etapa'),
    sem_mensagem: 0, // toda etapa tem e-mail e SMS cadastrados
  };

  /* Como TODA etapa dispara nos dois canais, o universo de cada canal é a régua
     inteira. O que muda é o alcance: e-mail sempre existe, telefone não. */
  const porCanal = ['email', 'sms'].map((canal) => {
    const meta = CANAIS_DEMO[canal];
    const total = totais.na_regua;
    const sem_contato = canal === 'sms' ? Math.round(total * SEM_TELEFONE) : 0;
    // Desloca um punhado de em_dia para atrasado no SMS (e o contrário no
    // e-mail): o SMS erra mais o horário. A soma dos estados não se mexe.
    const desloca = Math.min(Math.round(totais.atrasado * 0.12), totais.em_dia);
    const sinal = canal === 'sms' ? 1 : -1;
    return {
      canal,
      total,
      alcancavel: total - sem_contato,
      sem_contato,
      em_dia: totais.em_dia - sinal * desloca,
      atrasado: totais.atrasado + sinal * desloca,
      processando: totais.processando,
      travado: totais.travado,
      com_erro: canal === 'sms'
        ? Math.round(totais.com_erro * 0.62)
        : totais.com_erro - Math.round(totais.com_erro * 0.62),
      label: meta.label,
      faltando: meta.faltando,
    };
  }).sort((a, b) => b.total - a.total);

  const statusBruto = [
    { status: 'ativo', label: 'Ativo', total: totais.em_dia + totais.atrasado },
    { status: 'processando', label: 'Processando', total: totais.processando + totais.travado },
    { status: 'concluido', label: 'Concluído', total: totais.finalizado },
  ];

  /* Próximas 48 h a partir da hora cheia atual. Curva diurna mais uma crista
     larga por volta da 14ª hora — sem um pico visível o gráfico não diz nada. */
  const inicioHora = new Date(agora);
  inicioHora.setMinutes(0, 0, 0);
  const ondaHoraria = Array.from({ length: 48 }, (_, h) => {
    const hora = new Date(inicioHora.getTime() + h * 3600000);
    const diurno = Math.max(0.05, Math.sin(((hora.getHours() - 6) / 24) * Math.PI * 2) * 0.5 + 0.55);
    const pico = 1 + 2.2 * Math.exp(-(((h - 14) ** 2) / 12));
    return { hora: hora.toISOString(), total: Math.round(diurno * pico * (24 + r() * 46)) };
  });

  /* Últimos 14 dias, chave em fuso local. Fim de semana entra menos gente. */
  const entradasPorDia = Array.from({ length: 14 }, (_, d) => {
    const dia = new Date(agora - (13 - d) * 86400000);
    const fds = dia.getDay() === 0 || dia.getDay() === 6 ? 0.45 : 1;
    return { dia: chaveDia(dia), total: Math.round((70 + r() * 110) * fds) };
  });

  /* A fila de alertas mistura travados (com lock preso) e atrasados com erro —
     são os dois casos que o painel destaca no topo. */
  const alertas = Array.from({ length: 25 }, (_, i) => {
    const e = etapas[Math.floor(r() * etapas.length)];
    const preso = i < 8;
    return {
      id: 90000 + i,
      transacao_id: `TX-${100000 + Math.floor(r() * 899999)}`,
      nome: NOMES[Math.floor(r() * NOMES.length)],
      produto: PRODUTOS[Math.floor(r() * PRODUTOS.length)],
      etapa: e.etapa,
      status: preso ? 'processando' : 'ativo',
      estado: preso ? 'travado' : 'atrasado',
      tentativas: 1 + Math.floor(r() * 4),
      ultimo_erro: preso ? null : ERROS[Math.floor(r() * ERROS.length)],
      proximo_disparo: new Date(agora - (5 + r() * 900) * 60000).toISOString(),
      claimed_at: preso ? new Date(agora - (12 + r() * 240) * 60000).toISOString() : null,
      criado_em: new Date(agora - r() * 12 * 86400000).toISOString(),
    };
  });

  return {
    geradoEm: new Date().toISOString(),
    lockTimeoutMin: 10,
    reguaOk: true,
    filtros: { etapa: null, canal: null },
    etapas,
    totais,
    estados: ESTADOS_DEMO,
    canais: CANAIS_DEMO,
    destinos: DESTINOS_DEMO,
    porCanal,
    statusBruto,
    ondaHoraria,
    entradasPorDia,
    alertas,
  };
}

/* Distribuição dos pedidos do universo entre os estados: a maioria em dia, uma
   cauda de problemas e um bloco já finalizado. */
const SORTEIO_ESTADO = ['em_dia', 'em_dia', 'em_dia', 'em_dia', 'em_dia', 'em_dia',
  'atrasado', 'atrasado', 'processando', 'travado', 'finalizado', 'finalizado'];

/* Peso de cada etapa no funil — mesma ordem de grandeza da régua. */
const PESO_ETAPA = [1200, 900, 640, 420, 260, 150];

/** Sorteia uma etapa respeitando o funil, em vez de espalhar uniformemente. */
function sortearEtapa(u) {
  const somaPesos = PESO_ETAPA.reduce((a, p) => a + p, 0);
  let alvo = u * somaPesos;
  for (let i = 0; i < PESO_ETAPA.length; i += 1) {
    alvo -= PESO_ETAPA[i];
    if (alvo <= 0) return i;
  }
  return PESO_ETAPA.length - 1;
}

/**
 * Universo de pedidos da demonstração. É gerado SEM olhar para os filtros: os
 * filtros são aplicados depois, senão o total nunca muda e a paginação mente.
 */
function universoDemo(agora) {
  const r = rng(semente() + 7);
  return Array.from({ length: 420 }, (_, i) => {
    const estado = SORTEIO_ESTADO[Math.floor(r() * SORTEIO_ESTADO.length)];
    const etapa = sortearEtapa(r());
    const nome = NOMES[Math.floor(r() * NOMES.length)];
    const vencido = estado === 'atrasado' || estado === 'travado';
    // Uma fatia não tem telefone: para essa gente só o e-mail alcança.
    const temTelefone = r() > SEM_TELEFONE;
    const usuario = nome.toLowerCase().replace(/[^a-z]+/g, '.');
    return {
      id: 1000 + i,
      transacao_id: `TX-${100000 + Math.floor(r() * 899999)}`,
      nome,
      email: `${usuario}${i}@example.com`,
      telefone: temTelefone
        ? `+1 ${200 + Math.floor(r() * 700)} ${100 + Math.floor(r() * 900)}-${1000 + Math.floor(r() * 9000)}`
        : null,
      produto: PRODUTOS[Math.floor(r() * PRODUTOS.length)],
      etapa,
      status: estado === 'finalizado' ? 'concluido'
        : estado === 'processando' || estado === 'travado' ? 'processando' : 'ativo',
      estado,
      tentativas: estado === 'travado' ? 1 + Math.floor(r() * 4) : Math.floor(r() * 1.4),
      ultimo_erro: r() > 0.85 ? ERROS[Math.floor(r() * ERROS.length)] : null,
      proximo_disparo: estado === 'finalizado'
        ? null
        : new Date(agora + (vencido ? -1 : 1) * (5 + r() * 4000) * 60000).toISOString(),
      claimed_at: estado === 'travado' || estado === 'processando'
        ? new Date(agora - (3 + r() * 240) * 60000).toISOString()
        : null,
      criado_em: new Date(agora - r() * 20 * 86400000).toISOString(),
    };
  });
}

/**
 * `estado` aceita os cinco estados reais e mais o pseudo-estado `na_regua`,
 * que significa "tudo que ainda não terminou" — é o que o clique no total do
 * cabeçalho manda.
 */
function casaEstado(pedido, estado) {
  if (!estado) return true;
  if (estado === 'na_regua') return pedido.estado !== 'finalizado';
  return pedido.estado === estado;
}

/** O canal casa por CONTATO disponível: e-mail exige email, SMS exige telefone. */
function casaCanal(pedido, canal) {
  if (!canal) return true;
  if (canal === 'email') return Boolean(pedido.email);
  if (canal === 'sms') return Boolean(pedido.telefone);
  return true;
}

export function pedidosDemo({ etapa, estado, canal, busca, limit, offset } = {}) {
  const agora = Date.now();
  const universo = universoDemo(agora);

  const alvo = busca ? String(busca).toLowerCase() : null;
  const filtrado = universo.filter((p) => {
    if (etapa !== null && etapa !== undefined && p.etapa !== etapa) return false;
    if (!casaEstado(p, estado)) return false;
    if (!casaCanal(p, canal)) return false;
    if (!alvo) return true;
    return [p.transacao_id, p.nome, p.email, p.telefone, p.produto]
      .some((c) => c && String(c).toLowerCase().includes(alvo));
  });

  // `total` é a contagem ANTES do recorte, senão a paginação não fecha.
  const inicio = Number.isFinite(offset) ? offset : 0;
  const fatia = Number.isFinite(limit) ? limit : filtrado.length;
  return { pedidos: filtrado.slice(inicio, inicio + fatia), total: filtrado.length };
}
