/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  A RÉGUA NÃO MORA AQUI — ela vive em DUAS tabelas do banco:          │
 * │                                                                      │
 * │    etapas_regua      QUANDO dispara                                  │
 * │      UPDATE etapas_regua SET espera_h = 24 WHERE etapa = 2;          │
 * │                                                                      │
 * │    mensagens_regua   O QUE diz, por canal                            │
 * │      UPDATE mensagens_regua SET texto = 'Oi {nome}…'                 │
 * │       WHERE etapa = 2 AND canal = 'sms';                             │
 * │                                                                      │
 * │  Assim o painel e o seu workflow do n8n leem a MESMA definição, em   │
 * │  vez de cada um carregar a sua cópia. Rode `npm run setup` para      │
 * │  criar as tabelas (idempotente).                                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * O que sobrou neste arquivo é só vocabulário fixo do painel.
 */

/**
 * Os canais de envio. TODA etapa dispara nos DOIS ao mesmo tempo — não existe
 * "o canal da etapa": existe uma mensagem por canal, e cada uma alcança quem
 * tiver o contato correspondente.
 *
 * `glifo` é desenhado em SVG no nó; `contato` é a coluna da fila que precisa
 * estar preenchida para o canal alcançar o pedido.
 */
export const CANAIS = {
  email: { label: 'E-mail', glifo: 'envelope', contato: 'email',    faltando: 'sem e-mail' },
  sms:   { label: 'SMS',    glifo: 'sms',      contato: 'telefone', faltando: 'sem telefone' },
};

/** Destinos possíveis do botão do e-mail (só documentação para o painel). */
export const DESTINOS = {
  EBOOK: 'E-book gratuito',
  ASSISTENTE: 'Assistente de dúvidas',
};

/**
 * Rótulos amigáveis para a coluna `status` de disparos_pos_venda.
 * Qualquer status que NÃO seja 'ativo' nem 'processando' é tratado pelo painel
 * como terminal (o pedido saiu da régua) e cai no nó "Finalizados".
 */
export const STATUS_LABELS = {
  ativo: 'Ativo',
  processando: 'Processando',
  concluido: 'Concluído',
  concluído: 'Concluído',
  finalizado: 'Finalizado',
  erro: 'Erro',
  cancelado: 'Cancelado',
  pausado: 'Pausado',
};

/**
 * Os cinco estados que o painel calcula. São MUTUAMENTE EXCLUSIVOS e somam
 * exatamente o total de pedidos — é isso que permite desenhar o anel de cada
 * nó como uma parte-do-todo honesta.
 */
export const ESTADOS = [
  { id: 'em_dia',      label: 'Em dia',      icone: '●', descricao: 'Ativo, com disparo agendado para o futuro' },
  { id: 'atrasado',    label: 'Atrasado',    icone: '▲', descricao: 'Ativo, mas o horário do disparo já passou' },
  { id: 'processando', label: 'Processando', icone: '◐', descricao: 'Worker pegou o item agora há pouco' },
  { id: 'travado',     label: 'Travado',     icone: '■', descricao: 'Preso em processando além do tempo limite' },
  { id: 'finalizado',  label: 'Finalizado',  icone: '✓', descricao: 'Saiu da régua (status terminal)' },
];

/**
 * Usada só se `etapas_regua` ainda não existir (antes do `npm run setup`).
 * O painel avisa na tela quando está caindo aqui.
 */
export const REGUA_FALLBACK = [
  { etapa: 0, nome: 'Etapa 0', espera_h: null, offset_h: null, ativo: true, descricao: null, mensagens: [] },
];
