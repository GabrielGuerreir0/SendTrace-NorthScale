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
    motivo: { ...texto(60), description: "Motivo do contato: 'rastreamento', 'reembolso', 'cancelamento', 'pedido_duplicado', 'uso_do_produto', 'cobranca', 'endereco', 'outro'." },
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
    ativo: { type: 'boolean' },
    descricao: texto(600),
    atualizado_em: { ...dataHora, readOnly: true },
  },
  required: ['etapa', 'nome'],
};

export const MensagemRegua = {
  $id: 'MensagemRegua',
  type: 'object',
  description: 'O QUE cada etapa diz, por canal. A chave é (etapa, canal, linha).',
  properties: {
    etapa: { type: 'integer' },
    canal: { type: 'string', enum: ['email', 'sms'] },
    linha: { type: 'string', maxLength: 4, description: 'Qual variação de copy.' },
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

/* ──────────────────────────────  acesso  ──────────────────────────── */

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
  DisparoPosVenda, DisparoEntrada, ProdutoReadme, Atendimento, PerguntaSemResposta,
  EtapaRegua, MensagemRegua, PainelLinhaCopy,
  PainelLinhaMensagens, PainelLinhaHistorico, ConfigDisparo, PainelUsuario,
  Credenciais, ParTokens, PedidoRefresh, Erro,
  ContagemPorEstado, ResumoEtapa, Produto, Balde, EntradaDia, ContagemStatus,
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
