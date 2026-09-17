/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Estes objetos são UMA COISA SÓ: o contrato que o Fastify valida em   │
 * │  tempo de execução E o que aparece no Swagger.                        │
 * │                                                                      │
 * │  Não existe um "arquivo da documentação" para manter em dia — o que   │
 * │  está escrito aqui é o que a rota aceita e devolve. Documentação que  │
 * │  mora à parte do código diverge dele, e quem lê descobre tarde.       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * As formas espelham as tabelas do SendTrace. Onde o Postgres devolve
 * `numeric`, o campo é STRING no JSON ("23.50"): é como o driver entrega e é o
 * que preserva a precisão decimal — virar float aqui arredondaria escondido.
 */

const dataHora = { type: 'string', format: 'date-time' };
const decimal = { type: ['string', 'null'], description: 'Número decimal em texto, para não perder precisão. Ex.: "23.50"' };
const texto = (max) => ({ type: ['string', 'null'], maxLength: max });

/* ─────────────────────────────  a fila  ────────────────────────────── */

export const DisparoPosVenda = {
  $id: 'DisparoPosVenda',
  type: 'object',
  description: 'Um pedido na régua de pós-venda.',
  properties: {
    id: { type: 'integer', readOnly: true },
    transacao_id: { type: 'string', maxLength: 120 },
    nome: texto(200),
    email: texto(200),
    telefone: texto(40),
    produto: texto(300),
    plataforma: { ...texto(60), description: "Plataforma de venda: 'DigiStore24', 'JVZoo', 'BuyGoods'… Nulo = não informada." },
    etapa_atual: { type: 'integer', description: 'Em que etapa da régua o pedido está.' },
    proximo_disparo: dataHora,
    status: { type: 'string', maxLength: 40, description: "'ativo', 'processando', 'cancelado', 'concluido'…" },
    tentativas: { type: 'integer' },
    ultimo_erro: texto(500),
    claimed_at: { type: ['string', 'null'], format: 'date-time', description: 'Quando o worker pegou o item. Nulo = ninguém o tem.' },
    criado_em: { ...dataHora, readOnly: true },
    chat_resumo: { type: ['string', 'null'], maxLength: 10_000, description: 'Resumo do atendimento, gravado pelo chatbot de suporte. Nulo = nunca houve chat.' },
    chat_resumo_em: { type: ['string', 'null'], format: 'date-time', readOnly: true, description: 'Quando o resumo foi gravado/atualizado pela última vez.' },
  },
  required: ['id', 'transacao_id', 'proximo_disparo', 'criado_em'],
};

export const DisparoEntrada = {
  $id: 'DisparoEntrada',
  type: 'object',
  properties: {
    transacao_id: { type: 'string', maxLength: 120 },
    nome: texto(200),
    email: texto(200),
    telefone: texto(40),
    produto: texto(300),
    plataforma: texto(60),
    etapa_atual: { type: 'integer' },
    proximo_disparo: dataHora,
    status: { type: 'string', maxLength: 40 },
    tentativas: { type: 'integer' },
    ultimo_erro: texto(500),
    claimed_at: { type: ['string', 'null'], format: 'date-time' },
    chat_resumo: { type: ['string', 'null'], maxLength: 10_000 },
  },
  required: ['transacao_id'],
};

export const CompraUpsellDownsell = {
  $id: 'CompraUpsellDownsell',
  type: 'object',
  description: 'Um upsell/downsell comprado pelo mesmo lead/cliente, à parte da régua de '
    + 'pós-venda (não dispara e-mail/SMS — só fica registrado). Gravado pelos 3 fluxos de '
    + 'Reporting (BuyGoods/DigiStore24/JVZoo), um por transação de upsell/downsell.',
  properties: {
    id: { type: 'integer', readOnly: true },
    transacao_id: { type: 'string', maxLength: 120 },
    nome: texto(200),
    email: texto(200),
    telefone: texto(40),
    produto: texto(300),
    tag_produto: { ...texto(120), description: "Como a plataforma sinalizou (ex.: prefixo 'UPx', '(Upgrade)', '(Last Chance)')." },
    etapa_funil: { type: 'string', maxLength: 20, description: "'upsell', 'downsell' ou 'outro'." },
    plataforma: { type: 'string', maxLength: 60 },
    criado_em: { ...dataHora, readOnly: true },
    reembolsado_em: { type: ['string', 'null'], format: 'date-time' },
    chargeback_em: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'transacao_id', 'etapa_funil', 'plataforma', 'criado_em'],
};

/* ───────────────────  atendimentos do chatbot de suporte  ──────────────── */

export const Atendimento = {
  $id: 'Atendimento',
  type: 'object',
  description: 'Uma conversa de suporte encerrada: o resumo que o chatbot gravou, '
    + 'o desfecho e se houve risco de chargeback. Chaveada pelo ID DE TRANSAÇÃO '
    + 'do pedido; informe transacao_id ou email — a rota resolve o que faltar '
    + 'consultando a fila.',
  properties: {
    id: { type: 'integer', readOnly: true },
    transacao_id: { ...texto(120), description: 'O pedido a que a conversa pertence — a chave preferida.' },
    email: { ...texto(200), description: 'E-mail do cliente. Opcional; preenchido a partir do pedido quando ausente.' },
    resumo: { type: 'string', maxLength: 10_000, description: 'Motivo, humor, o que foi tentado e desfecho — escrito pela IA.' },
    desfecho: { ...texto(120), description: "Ex.: 'resolvido (cliente retido)', 'escalado para humano'." },
    risco_chargeback: { type: 'boolean', default: false, description: 'O detector de risco disparou nesta conversa.' },
    motivo: { ...texto(60), description: 'O slug do tópico do contato. A API resolve/cria o tópico correspondente em chat_topicos e liga via topico_id.' },
    topico_id: { type: ['integer', 'null'], readOnly: true, description: 'O tópico relacionado — resolvido pela API a partir do motivo.' },
    topico_nome: { ...texto(120), description: 'Ao criar tópico NOVO: o rótulo humano (com acentos). Ignorado quando o tópico já existe.' },
    topico_descricao: { ...texto(500), description: 'Ao criar tópico NOVO: o que cabe nele — o critério que a IA lerá nas próximas conversas.' },
    resolvido: { type: ['boolean', 'null'], description: 'true = a IA fechou sozinha; false = escalada para humano.' },
    reembolso_pedido: { type: 'boolean', default: false, description: 'O cliente pediu reembolso nesta conversa.' },
    reembolso_evitado: { type: ['boolean', 'null'], description: 'Dos que pediram: a IA reverteu? Nulo quando não houve pedido.' },
    csat: { type: ['integer', 'null'], minimum: 1, maximum: 5, description: 'Nota de satisfação (1–5 estrelas). Nulo = não avaliou.' },
    duracao_s: { type: ['integer', 'null'], minimum: 0, description: 'Duração da conversa em segundos.' },
    iniciado_em: { type: ['string', 'null'], format: 'date-time', description: 'Quando a conversa COMEÇOU. É por isto que o filtro de tempo do dashboard recorta.' },
    etapa_regua: { type: ['integer', 'null'], readOnly: true, description: 'Etapa da régua do pedido no momento do contato — resolvida pela API.' },
    criado_em: { ...dataHora, readOnly: true },
  },
  required: ['resumo'],
};

export const PerguntaSemResposta = {
  $id: 'PerguntaSemResposta',
  type: 'object',
  description: 'Uma pergunta que a IA não soube responder — o backlog da base de conhecimento.',
  properties: {
    id: { type: 'integer', readOnly: true },
    pergunta: { type: 'string', maxLength: 500, description: 'A pergunta como o cliente fez.' },
    transacao_id: texto(120),
    email: texto(200),
    produto: texto(300),
    criado_em: { ...dataHora, readOnly: true },
  },
  required: ['pergunta'],
};

/* ─────────────────────  conhecimento da IA de suporte  ─────────────────── */

export const ProdutoReadme = {
  $id: 'ProdutoReadme',
  type: 'object',
  description: 'O que a IA de suporte sabe sobre um produto. Escrito no painel; '
    + 'o chatbot lê pela API e injeta no próprio prompt.',
  properties: {
    produto: { type: 'string', maxLength: 300, description: 'Nome do produto como o painel mostra (sem código de oferta).' },
    readme: { type: 'string', maxLength: 100_000, description: 'O texto que a IA recebe: o que é, como usar, prazos, FAQ, política.' },
    ativo: { type: 'boolean', default: true, description: 'false = a IA deixa de receber este readme, sem apagar o texto.' },
    atualizado_em: { ...dataHora, readOnly: true },
    atualizado_por: texto(200),
  },
  required: ['produto', 'readme'],
};

/* ────────────────────────────  a régua  ───────────────────────────── */

export const EtapaRegua = {
  $id: 'EtapaRegua',
  type: 'object',
  description: 'QUANDO cada etapa dispara.',
  properties: {
    etapa: { type: 'integer' },
    nome: { type: 'string', maxLength: 120 },
    espera_h: { ...decimal, description: 'Horas até a PRÓXIMA etapa.' },
    offset_h: { ...decimal, description: 'Horas desde a compra até esta etapa disparar.' },
    linha: {
      type: ['string', 'null'], pattern: '^[0-9]{1,4}$',
      description: 'A qual linha/família esta etapa pertence. NULL = compartilhada entre '
        + 'linhas (hoje só a etapa -1, o recibo).',
    },
    ativo: { type: 'boolean' },
    descricao: texto(600),
    atualizado_em: { ...dataHora, readOnly: true },
  },
  required: ['etapa', 'nome'],
};

export const MensagemRegua = {
  $id: 'MensagemRegua',
  type: 'object',
  description: 'O QUE cada etapa diz, por canal. A chave é (etapa, canal, linha, produto). '
    + "O robô procura a copy do produto do lead e, se não houver, cai na do produto '*'.",
  properties: {
    etapa: { type: 'integer' },
    canal: { type: 'string', enum: ['email', 'sms'] },
    linha: { type: 'string', maxLength: 4, description: 'Qual variação de copy.' },
    // Se `produto` não estiver AQUI, a coluna existe no banco, a query traz o
    // valor e o fast-json-stringify o REMOVE da resposta em silêncio.
    produto: {
      type: 'string', maxLength: 40, default: '*',
      pattern: '^(\\*|[a-z0-9]{2,40})$',
      description: "Slug do produto dono desta copy. '*' é o padrão, herdado por todo produto sem copy própria.",
    },
    assunto: texto(300),
    texto: { type: 'string', description: 'Corpo do SMS; no e-mail, a descrição interna.' },
    botao: texto(120),
    destino: { type: ['string', 'null'], enum: ['EBOOK', 'ASSISTENTE', null] },
    corpo_html: { type: ['string', 'null'], description: 'Só o miolo do e-mail, em HTML com estilo inline.' },
    ativo: { type: 'boolean' },
    atualizado_em: { ...dataHora, readOnly: true },
  },
  required: ['etapa', 'canal', 'linha', 'texto'],
};

export const PainelLinhaCopy = {
  $id: 'PainelLinhaCopy',
  type: 'object',
  description: 'Uma linha é um conjunto completo de mensagens — uma estratégia inteira.',
  properties: {
    linha: { type: 'string', maxLength: 4 },
    nome: { type: 'string', maxLength: 60 },
    intuito: texto(600),
    ordem: { type: 'integer' },
  },
  required: ['linha', 'nome'],
};

export const PainelLinhaMensagens = {
  $id: 'PainelLinhaMensagens',
  type: 'object',
  description: 'Registro da última troca de linha feita pelo painel.',
  properties: {
    linha: { type: 'string', maxLength: 4 },
    trocada_em: { ...dataHora, readOnly: true },
    trocada_por: { type: ['integer', 'null'], readOnly: true },
    resposta: texto(500),
  },
  required: ['linha'],
};

export const PainelLinhaHistorico = {
  $id: 'PainelLinhaHistorico',
  type: 'object',
  description: 'Toda tentativa de troca de linha — inclusive as que falharam.',
  properties: {
    id: { type: 'integer', readOnly: true },
    linha: { type: 'string', maxLength: 4 },
    em: { ...dataHora, readOnly: true },
    por: { type: ['integer', 'null'] },
    sucesso: { type: 'boolean' },
    detalhe: texto(500),
  },
  required: ['id', 'linha', 'sucesso'],
};

export const ConfigDisparo = {
  $id: 'ConfigDisparo',
  type: 'object',
  description: 'Chave/valor que o robô lê. `linha_ativa` é a que decide a copy no ar.',
  properties: {
    chave: { type: 'string', maxLength: 60 },
    valor: { type: 'string' },
  },
  required: ['chave', 'valor'],
};

/* ─────────────────────  catálogo canônico de produtos  ─────────────────── */

export const ProdutoCatalogo = {
  $id: 'ProdutoCatalogo',
  type: 'object',
  description: "O catálogo canônico: um slug por produto, mais a linha '*' (o padrão). "
    + 'É daqui que saem o nome de exibição, o link do e-book e o e-mail de suporte '
    + 'usados na copy de cada produto.',
  properties: {
    slug: {
      type: 'string', maxLength: 40, pattern: '^(\\*|[a-z0-9]{2,40})$',
      description: "Nome normalizado, sem espaço nem pontuação: 'neuromindpro'. '*' é o único fora do padrão.",
    },
    nome: { type: 'string', maxLength: 300, description: 'Nome de exibição.' },
    nome_sms: { ...texto(60), description: 'Versão curta para SMS — cada caractere custa.' },
    forma: texto(60),
    uso: texto(200),
    link_ebook: { ...texto(500), description: 'Destino do botão EBOOK nos e-mails deste produto.' },
    email_suporte: { ...texto(200), description: 'Remetente/contato de suporte usado na moldura do e-mail.' },
    linha: {
      type: 'string', pattern: '^[0-9]{1,4}$', default: '1',
      description: 'Linha de copy (família) que este produto usa na régua de pós-venda — '
        + "ver /api/linhas-copy/ pras linhas cadastradas. Produto sem família específica fica na '1' (Confiança).",
    },
    ativo: { type: 'boolean', default: true },
    atualizado_em: { ...dataHora, readOnly: true },
  },
  required: ['slug', 'nome'],
};

export const ProdutoAlias = {
  $id: 'ProdutoAlias',
  type: 'object',
  description: 'Exceção de nomenclatura que a normalização automática não pega: '
    + 'liga um nome cru da plataforma ao slug canônico.',
  properties: {
    alias: { type: 'string', maxLength: 300 },
    produto_slug: { type: 'string', maxLength: 40 },
    criado_em: { ...dataHora, readOnly: true },
  },
  required: ['alias', 'produto_slug'],
};

/* ──────────────────────────────  acesso  ──────────────────────────── */

/* ─────────────────────  rastreamento de pedidos (Red Rock)  ────────────── */

export const RastreioPedido = {
  $id: 'RastreioPedido',
  type: 'object',
  description: 'Snapshot atual do rastreio de um pedido, gravado pelo script de polling '
    + '(nunca pelo painel). Ver PLANO.md em "Rastreamento de Disparo" pro desenho completo.',
  properties: {
    transacao_id: { type: 'string', maxLength: 120 },
    nome: texto(200),
    produto: texto(300),
    plataforma: texto(60),
    provedor: { type: ['string', 'null'], description: "'redrock' ou 'fullstack' quando encontrado; nulo enquanto não achado em nenhum provedor." },
    status_interno: {
      type: 'string',
      enum: ['pendente_consulta', 'nao_encontrado', 'pending', 'shipped', 'delivered', 'cancelled', 'exception', 'desconhecido'],
    },
    status_bruto: texto(60),
    order_number: texto(120),
    order_created_at: { type: ['string', 'null'], format: 'date-time' },
    total: decimal,
    currency: texto(10),
    fully_fulfilled: { type: ['boolean', 'null'] },
    fully_fulfilled_at: { type: ['string', 'null'], format: 'date-time' },
    tracking_number: texto(120),
    carrier_code: texto(60),
    tracking_url: texto(500),
    tracking_status: texto(300),
    shipped_at: { type: ['string', 'null'], format: 'date-time' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' },
    ultima_consulta_em: { type: ['string', 'null'], format: 'date-time' },
    ultimo_erro: texto(500),
    criado_em: { ...dataHora, readOnly: true },
    atualizado_em: { ...dataHora, readOnly: true },
  },
  required: ['transacao_id', 'status_interno'],
};

export const RastreioEvento = {
  $id: 'RastreioEvento',
  type: 'object',
  description: 'Uma mudança de status detectada — o histórico que a Red Rock não entrega pronto.',
  properties: {
    id: { type: 'integer', readOnly: true },
    status_anterior: texto(60),
    status_novo: { type: 'string', maxLength: 60 },
    fonte: { type: 'string', enum: ['backfill', 'backfill-email', 'tracking-updates'] },
    detectado_em: { ...dataHora, readOnly: true },
  },
  required: ['id', 'status_novo', 'fonte', 'detectado_em'],
};

/** Compartilhado entre RastreioDetalhe e RastreioPublico — ver comentário em api/rotas/rastreio.js. */
const marcos = {
  type: 'object',
  description: 'Os 3 carimbos que já temos de graça — criação (da própria plataforma de venda), envio e entrega.',
  properties: {
    criado_em: { type: ['string', 'null'], format: 'date-time' },
    enviado_em: { type: ['string', 'null'], format: 'date-time' },
    entregue_em: { type: ['string', 'null'], format: 'date-time' },
  },
};
const checkpointsTransportadora = {
  type: ['array', 'null'],
  items: { type: 'string' },
  description: "Histórico bruto de `tracking_delivery_exceptions` da Red Rock, quando a "
    + 'transportadora manda (hoje só visto em remessas USPS — GOFO, a mais comum nos nossos '
    + "pedidos, não preenche). Sem data por evento — é texto livre da transportadora, não "
    + 'um provedor de tracking granular (isso é a Parcels API v4, ver PLANO.md seção 13).',
};
const parado = {
  parado: { type: 'boolean', description: 'Sem NENHUMA mudança de status há mais que o limite (3 dias em pending, 7 em shipped).' },
  dias_sem_mudanca: { type: ['integer', 'null'] },
};

export const RastreioDetalhe = {
  $id: 'RastreioDetalhe',
  type: 'object',
  allOf: [
    { $ref: 'RastreioPedido#' },
    {
      type: 'object',
      properties: {
        tracking: { type: ['array', 'null'], description: 'Array tracking[] cru da Red Rock — cobre reenvio/superseded.' },
        cancellation: { type: ['object', 'null'] },
        eventos: { type: 'array', items: { $ref: 'RastreioEvento#' } },
        marcos,
        checkpoints_transportadora: checkpointsTransportadora,
        ...parado,
      },
    },
  ],
};

export const ResumoRastreio = {
  $id: 'ResumoRastreio',
  type: 'object',
  properties: {
    total: { type: 'integer' },
    pendente_consulta: { type: 'integer' },
    nao_encontrado: { type: 'integer', description: 'Não é erro — pedido de outro fulfillment center.' },
    pending: { type: 'integer' },
    shipped: { type: 'integer' },
    delivered: { type: 'integer' },
    cancelled: { type: 'integer' },
    exception: { type: 'integer' },
    desconhecido: { type: 'integer' },
    sem_codigo_rastreio: {
      type: 'integer',
      description: 'Já encontrado num provedor (pending/shipped/delivered/cancelled) mas ainda sem tracking_number.',
    },
    taxa_entrega: { type: ['number', 'null'], description: 'delivered / (shipped + delivered), em %.' },
  },
};

/**
 * Saúde do rastreio — cruza `disparos_pos_venda`/`rastreio_pedidos`/
 * `rastreio_eventos` pra responder "isso está funcionando bem?", não só
 * "quantos tem em cada status" (isso já é o `ResumoRastreio`). Toda média/
 * mediana aqui EXCLUI `fonte = 'backfill-email'` (o backfill retroativo por
 * e-mail rodado uma vez em 15/09/2026) — misturado, ele infla a velocidade
 * real de detecção em até 1000x (pedido antigo "achado" só hoje conta como
 * se tivesse demorado meses).
 */
export const SaudeRastreio = {
  $id: 'SaudeRastreio',
  type: 'object',
  properties: {
    tempo_para_encontrar: {
      type: 'array',
      description: 'Horas entre a compra (disparos_pos_venda.criado_em) e o primeiro '
        + 'registro em rastreio_eventos, por plataforma. Só detecção orgânica (polling), '
        + 'nunca backfill.',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), amostras: { type: 'integer' },
          media_horas: { type: ['number', 'null'] }, mediana_horas: { type: ['number', 'null'] },
        },
      },
    },
    nao_encontrados: {
      type: 'array',
      description: 'Pedidos com status_interno=nao_encontrado, por plataforma — e há quanto '
        + 'tempo a compra foi feita sem aparecer na Red Rock ainda.',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), total: { type: 'integer' },
          media_dias_desde_compra: { type: ['number', 'null'] },
          compra_mais_antiga: { type: ['string', 'null'], format: 'date-time' },
          compra_mais_recente: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
    transicoes_status: {
      type: 'array',
      description: 'Quanto tempo um pedido fica num status antes de passar pro próximo '
        + '(ex.: pending → shipped). Cada linha é uma transição observada de verdade — só '
        + 'aparece aqui depois que o pedido faz essa transição enquanto o polling está de olho '
        + 'nele, então uma transição rara (ex.: shipped → delivered) pode demorar a acumular '
        + 'amostra mesmo já havendo pedidos entregues (ver tempo_transporte/tempo_total, que não '
        + 'dependem de captura ao vivo).',
      items: {
        type: 'object',
        properties: {
          status_anterior: texto(60), status_novo: texto(60), amostras: { type: 'integer' },
          media_horas: { type: ['number', 'null'] }, mediana_horas: { type: ['number', 'null'] },
        },
      },
    },
    tempo_transporte: {
      type: 'array',
      description: 'Horas entre despacho (shipped_at) e entrega (delivered_at), por plataforma — '
        + 'calculado direto dos timestamps que a Red Rock devolve, não depende de termos '
        + 'capturado a transição ao vivo (por isso tem amostra bem maior que a linha '
        + 'shipped→delivered de transicoes_status).',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), amostras: { type: 'integer' },
          media_horas: { type: ['number', 'null'] }, mediana_horas: { type: ['number', 'null'] },
        },
      },
    },
    tempo_total: {
      type: 'array',
      description: 'Horas entre a compra (disparos_pos_venda.criado_em) e a entrega '
        + '(delivered_at), por plataforma — ciclo completo, inclui o tempo de preparação antes '
        + 'do despacho, não só o transporte.',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), amostras: { type: 'integer' },
          media_horas: { type: ['number', 'null'] }, mediana_horas: { type: ['number', 'null'] },
        },
      },
    },
    distribuicao_entrega: {
      type: 'array',
      description: 'Quantos pedidos entregues caem em cada faixa de tempo total (compra → '
        + 'entrega), por plataforma — faixas fixas, pra responder "quantos pedidos demoraram '
        + 'muito", não só a média/mediana de tempo_total.',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), ordem: { type: 'integer' }, faixa: texto(60),
          faixa_min_dias: { type: 'integer' }, faixa_max_dias: { type: ['integer', 'null'] },
          total: { type: 'integer' },
        },
      },
    },
    sem_codigo_rastreio: {
      type: 'array',
      description: 'Já encontrado num provedor (pending/shipped/delivered/cancelled) mas ainda '
        + 'sem tracking_number — normal em pending recém-criado, estranho se persistir.',
      items: {
        type: 'object',
        properties: { status_interno: texto(60), plataforma: texto(60), total: { type: 'integer' } },
      },
    },
    funil_por_plataforma: {
      type: 'array',
      description: 'O mesmo corte do ResumoRastreio, mas quebrado por plataforma — pra achar '
        + 'de cara qual plataforma está com a saúde de rastreio pior.',
      items: {
        type: 'object',
        properties: {
          plataforma: texto(60), total: { type: 'integer' },
          pendente_consulta: { type: 'integer' }, nao_encontrado: { type: 'integer' },
          pending: { type: 'integer' }, shipped: { type: 'integer' },
          delivered: { type: 'integer' }, cancelled: { type: 'integer' },
        },
      },
    },
    provedores: {
      type: 'array',
      description: "Quantos pedidos cada provedor de rastreio já cobre — hoje pode ser "
        + "'redrock' ou 'fullstack' (desde 18/09/2026).",
      items: {
        type: 'object',
        properties: { provedor: texto(60), total: { type: 'integer' } },
      },
    },
  },
};

export const RastreioDetalheLinha = {
  $id: 'RastreioDetalheLinha',
  type: 'object',
  description: 'Um pedido por trás de uma linha agregada de Saúde do rastreio — usado no '
    + 'drill-down ao clicar numa linha de qualquer uma das tabelas de cruzamento.',
  properties: {
    transacao_id: { type: 'string', maxLength: 120 },
    nome: texto(200),
    produto: texto(300),
    plataforma: texto(60),
    status_interno: texto(60),
    tracking_number: texto(120),
    criado_em: { ...dataHora, readOnly: true },
    shipped_at: { type: ['string', 'null'], format: 'date-time' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' },
    duracao_horas: {
      type: ['number', 'null'],
      description: 'Só presente quando a métrica clicada é de tempo (deteccao/transporte/'
        + 'total/transicao) — null nas tabelas que são só contagem (ex.: provedores).',
    },
  },
};

export const SerieSaudeRastreio = {
  $id: 'SerieSaudeRastreio',
  type: 'object',
  description: 'Série diária de uma métrica de tempo (deteccao/transporte/total/transicao), '
    + 'por plataforma — insumo do gráfico de linha em Evolução no tempo.',
  properties: {
    pontos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dia: { type: 'string', description: 'YYYY-MM-DD.' },
          plataforma: texto(60), amostras: { type: 'integer' },
          media_horas: { type: ['number', 'null'] }, mediana_horas: { type: ['number', 'null'] },
        },
      },
    },
  },
};

export const RastreioPublico = {
  $id: 'RastreioPublico',
  type: 'object',
  description: 'Resposta da consulta pública (sem login) — deliberadamente sem PII: '
    + 'nunca endereço, e-mail ou telefone.',
  properties: {
    encontrado: { type: 'boolean' },
    produto: texto(300),
    status_interno: texto(60),
    status_rotulo: texto(120),
    carrier_code: texto(60),
    tracking_number: texto(120),
    tracking_url: texto(500),
    tracking_status: texto(300),
    shipped_at: { type: ['string', 'null'], format: 'date-time' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' },
    eventos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          em: { type: 'string', format: 'date-time' },
        },
      },
    },
    marcos,
    checkpoints_transportadora: checkpointsTransportadora,
    ...parado,
  },
  required: ['encontrado'],
};

export const PainelUsuario = {
  $id: 'PainelUsuario',
  type: 'object',
  description: 'Usuário do painel. O hash da senha NUNCA é exposto.',
  properties: {
    id: { type: 'integer', readOnly: true },
    email: { type: 'string', format: 'email' },
    nome: texto(120),
    admin: { type: 'boolean' },
    ativo: { type: 'boolean' },
    trocar_senha: { type: 'boolean' },
    criado_em: { ...dataHora, readOnly: true },
    criado_por: { type: ['integer', 'null'] },
    ultimo_acesso: { type: ['string', 'null'], format: 'date-time' },
    falhas: { type: 'integer' },
    bloqueado_ate: { type: ['string', 'null'], format: 'date-time' },
    senha_expira_em: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'email'],
};

export const Credenciais = {
  $id: 'Credenciais',
  type: 'object',
  description: 'E-mail e senha de um usuário do painel.',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string' },
  },
  required: ['email', 'password'],
};

export const ParTokens = {
  $id: 'ParTokens',
  type: 'object',
  properties: {
    access: { type: 'string', description: 'Vale por pouco tempo. Vai no cabeçalho: Authorization: Bearer <access>' },
    refresh: { type: 'string', description: 'Troca por um access novo em /api/auth/token/refresh/.' },
  },
  required: ['access', 'refresh'],
};

export const PedidoRefresh = {
  $id: 'PedidoRefresh',
  type: 'object',
  properties: { refresh: { type: 'string' } },
  required: ['refresh'],
};

export const Erro = {
  $id: 'Erro',
  type: 'object',
  properties: {
    detail: { type: 'string', description: 'O que houve, em português e sem jargão de framework.' },
  },
};

/* ═══════════════════════════  agregações  ═══════════════════════════ */

/**
 * O painel não precisa baixar a fila inteira para contar.
 *
 * Sem estas rotas, medir 100 mil pedidos significaria trafegar 100 mil pedidos
 * a cada minuto para exibir seis números. O SQL responde isso numa passada.
 */
export const ContagemPorEstado = {
  $id: 'ContagemPorEstado',
  type: 'object',
  description: 'Os seis estados são mutuamente exclusivos e somam o total.',
  properties: {
    em_dia: { type: 'integer', description: 'Ativo, com disparo no futuro.' },
    atrasado: { type: 'integer', description: 'Ativo, mas o horário já passou.' },
    processando: { type: 'integer', description: 'Worker pegou agora há pouco.' },
    travado: { type: 'integer', description: 'Preso em processando além do limite.' },
    finalizado: { type: 'integer', description: 'Chegou ao fim da régua.' },
    cancelado: { type: 'integer', description: 'Saiu sem concluir. NUNCA somado a finalizado.' },
  },
};

export const ResumoEtapa = {
  $id: 'ResumoEtapa',
  type: 'object',
  properties: {
    etapa: { type: 'integer' },
    total: { type: 'integer' },
    em_dia: { type: 'integer' },
    atrasado: { type: 'integer' },
    processando: { type: 'integer' },
    travado: { type: 'integer' },
    finalizado: { type: 'integer' },
    cancelado: { type: 'integer' },
    na_etapa: { type: 'integer', description: 'Quem ainda circula aqui (os quatro estados vivos).' },
    com_erro: { type: 'integer' },
    com_retry: { type: 'integer' },
    novos_24h: { type: 'integer' },
    prestes: { type: 'integer', description: 'Dispara na próxima hora e ainda não venceu.' },
    proximo_em: { type: ['string', 'null'], format: 'date-time' },
    max_tentativas: { type: 'integer' },
  },
};

export const Produto = {
  $id: 'Produto',
  type: 'object',
  description: 'Produtos agrupados pelo NOME: as ofertas do mesmo produto contam juntas.',
  properties: {
    produto: { type: 'string', description: 'Sem o código da oferta e sem a embalagem.' },
    total: { type: 'integer' },
  },
};

export const Balde = {
  $id: 'Balde',
  type: 'object',
  properties: {
    inicio: { type: 'string', format: 'date-time' },
    total: { type: 'integer' },
  },
};

export const EntradaDia = {
  $id: 'EntradaDia',
  type: 'object',
  properties: {
    dia: { type: 'string', description: 'YYYY-MM-DD no fuso do painel.' },
    total: { type: 'integer' },
  },
};

export const ContagemStatus = {
  $id: 'ContagemStatus',
  type: 'object',
  properties: {
    status: { type: 'string' },
    total: { type: 'integer' },
  },
};

/** Todos, na ordem em que o Swagger vai listá-los. */
export const TODOS = [
  DisparoPosVenda, DisparoEntrada, CompraUpsellDownsell, ProdutoReadme, Atendimento, PerguntaSemResposta,
  EtapaRegua, MensagemRegua, PainelLinhaCopy, ProdutoCatalogo, ProdutoAlias,
  PainelLinhaMensagens, PainelLinhaHistorico, ConfigDisparo, PainelUsuario,
  Credenciais, ParTokens, PedidoRefresh, Erro,
  ContagemPorEstado, ResumoEtapa, Produto, Balde, EntradaDia, ContagemStatus,
  RastreioPedido, RastreioEvento, RastreioDetalhe, ResumoRastreio, SaudeRastreio, RastreioDetalheLinha,
  SerieSaudeRastreio, RastreioPublico,
];

/**
 * A casca de toda lista paginada.
 *
 * Mesma forma do Django REST — `count`, `next`, `previous`, `results` — porque
 * é o que os clientes deste contrato já sabem percorrer.
 */
export const paginado = (ref) => ({
  type: 'object',
  properties: {
    count: { type: 'integer', description: 'Total de registros, não desta página.' },
    next: { type: ['string', 'null'], description: 'URL da próxima página, ou null.' },
    previous: { type: ['string', 'null'] },
    results: { type: 'array', items: { $ref: `${ref}#` } },
  },
});

/** Parâmetros de paginação que toda lista aceita. */
export const paginacaoParams = {
  page: { type: 'integer', minimum: 1, default: 1, description: 'Página, a partir de 1.' },
  page_size: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Registros por página (teto de 500).' },
};
