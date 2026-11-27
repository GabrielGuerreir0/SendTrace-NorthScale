/**
 * MONIT-SPPL (Monitoramento Logístico, pedido da Késsia, 26/11/2026) — as TABELAS DE CONFIGURAÇÃO do painel: grupos, classes (24), as 14 regras
 * de texto do 17Track, a tradução dos textos das transportadoras (113 regras), o status do 17Track, os tipos de tratativa e os quadros Q1–Q5.
 *
 * FONTE ÚNICA: as 14 regras daqui geram TANTO o `classificarTexto` (JS: ficha do pedido, testes) QUANTO o SQL da classificação em massa
 * (`api/monit/sqlClassificacao.js`), para o painel e a ficha nunca discordarem. Os termos são literais (sem metacaractere de regex): cada
 * um é escapado antes de virar regex, então o mesmo texto vale para o JS e para o Postgres (`~*`). `^` no início do termo = início do texto.
 */

/* ───────────────────────────────  grupos  ─────────────────────────────── */

export const GRUPOS = [
  { id: 'semrastreio', nome: 'Sem rastreio', dica: 'cobrar fulfillment ou plataforma', cor: '#3A3F5C',
    oQueE: 'Pedidos que ainda não têm código de rastreio, então o 17Track não tem o que acompanhar.',
    comoTratar: 'Cobrar a fulfillment e a plataforma para gerar o código. Os não encontrados precisam ser conferidos na fulfillment.' },
  { id: 'logistica', nome: 'Problema logístico', dica: 'cobrar fulfillment ou transportadora', cor: '#8FA3F2',
    oQueE: 'Problemas que estão com a fulfillment ou com a transportadora: o pacote não saiu, não foi coletado, parou ou atrasou.',
    comoTratar: 'Cobrar a fulfillment ou a transportadora. Falar com o cliente só se o atraso ficar grande.' },
  { id: 'cliente', nome: 'Precisa do cliente', dica: 'contactar cliente', cor: '#C2552C',
    oQueE: 'Casos que só se resolvem com uma ação do cliente: corrigir endereço, retirar o pacote (inclusive quando ele pediu para o correio segurar), pagar taxa, ou entender por que recusou ou não recebeu.',
    comoTratar: 'Mandar o e-mail padrão do motivo o quanto antes, porque a transportadora devolve o pacote em poucos dias.' },
  { id: 'devolucao', nome: 'Devolução', dica: 'desfecho do pedido', cor: '#7A7F8F',
    oQueE: 'Pacotes que voltaram ou estão voltando ao remetente sem que a transportadora tenha informado o motivo.',
    comoTratar: 'Abrir a folha do pedido para entender o que houve e combinar com o cliente reenvio ou reembolso.' },
  { id: 'ok', nome: 'Não é problema', dica: 'monitorar ou dar baixa', cor: '#7FE3A0',
    oQueE: 'Pedidos que estão andando normalmente ou que a transportadora já entregou.',
    comoTratar: 'Nada a fazer além de acompanhar. Os entregues só precisam de baixa no sistema.' },
];
/** Aviso (não é bloco): só conta `nao_encontrado`. Fica fora do total das porcentagens. */
export const GRUPO_VERIFICAR = { id: 'verificar', nome: 'A verificar com o dev', dica: 'possível falha de ligação no SendTrace', cor: '#E0A526' };

/* ───────────────────────────────  classes  ────────────────────────────── */
/* chave, nome, grupo, urgência (etiqueta do card), motivo no Suporte Ativo, como tratar. Ordem = ordem de exibição. */
const MOT_FULF = 'Enviado para fulfillment - Ag. rastreio';
const MOT_PARADO = 'Pedido parado/atrasado pela logística';
const MOT_DEVOL = 'Devolução ao remetente';
export const CLASSES = [
  { chave: 'aguardando_codigo', nome: 'Sem rastreio: há -2d úteis', grupo: 'semrastreio', urgencia: '', motivo: MOT_FULF,
    comoTratar: 'Pedido feito há menos de 2 dias úteis e a fulfillment ainda não gerou o código. É normal: só acompanhar.' },
  { chave: 'sem_codigo_atrasado', nome: 'Sem rastreio: há +2d úteis', grupo: 'semrastreio', urgencia: '', motivo: MOT_FULF,
    comoTratar: 'A fulfillment passou do prazo para gerar o código. Cobrar a fulfillment e a plataforma de venda para gerar o rastreio.' },
  { chave: 'nao_encontrado', nome: 'Não encontrado na fulfillment', grupo: 'semrastreio', urgencia: 'Confirmar com o dev', motivo: MOT_FULF,
    comoTratar: 'Venda aprovada que o SendTrace não ligou a nenhuma fulfillment (FullStack, RedRock ou JetPack). Pode ser falha de ligação do SendTrace, não falta de envio: o dev está conferindo.' },
  { chave: 'etiqueta_cancelada', nome: 'Etiqueta cancelada', grupo: 'logistica', urgencia: 'Cobrar hoje', motivo: MOT_PARADO,
    comoTratar: 'O pedido não saiu. Cobrar a fulfillment para gerar uma nova etiqueta. Não precisa falar com o cliente agora.' },
  { chave: 'avaria', nome: 'Pacote danificado', grupo: 'logistica', urgencia: 'Cobrar hoje', motivo: MOT_PARADO,
    comoTratar: 'Abrir reclamação na transportadora, pedir o reenvio e avisar o cliente.' },
  { chave: 'atraso_transportadora', nome: 'Atraso da transportadora', grupo: 'logistica', urgencia: 'Acompanhar', motivo: '',
    comoTratar: 'Atraso de voo, alfândega, clima ou rota errada. Ainda não é problema: só vira problema se ficar 7 dias sem nova movimentação.' },
  { chave: 'parado_sem_aviso', nome: 'Parado sem aviso', grupo: 'logistica', urgencia: 'Cobrar', motivo: MOT_PARADO,
    comoTratar: 'Em trânsito, sem nenhum aviso de problema e +5 dias sem movimentação. Cobrar a transportadora (veja os quadros Monitorar, Atenção e Críticos).' },
  { chave: 'aguardando_coleta', nome: 'Aguardando coleta · mais de 2 dias úteis', grupo: 'logistica', urgencia: 'Cobrar', motivo: MOT_FULF,
    comoTratar: 'O código foi gerado há mais de 2 dias úteis e a transportadora ainda não recebeu o pacote: cobrar a fulfillment (quadro "Com rastreio, sem despacho").' },
  { chave: 'codigo_nao_rastreavel', nome: 'Código que o 17Track não lê', grupo: 'logistica', urgencia: '', motivo: MOT_PARADO,
    comoTratar: 'O código salvo é da GlobalAccess (GA...), não da transportadora, e o 17Track não consegue rastrear. A situação mostrada vem do texto da RedRock, que pode estar desatualizada: abrir o link do rastreio para ver o status real.' },
  { chave: 'endereco', nome: 'Endereço insuficiente', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: 'Endereço incompleto',
    comoTratar: 'Mandar o e-mail padrão de confirmação de endereço em até 24h e repassar o endereço corrigido à transportadora ou à fulfillment. A transportadora segura o pacote de 5 a 7 dias antes de devolver.' },
  { chave: 'mudou', nome: 'Cliente mudou de endereço', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: 'Cliente mudou de endereço',
    comoTratar: 'E-mail pedindo o endereço novo e preparar o reenvio.' },
  { chave: 'acesso', nome: 'Sem acesso ao local', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: 'Endereço incompleto',
    comoTratar: 'E-mail pedindo código do portão, instruções de entrega ou um endereço alternativo (casos de empresa fechada, local restrito ou sem acesso).' },
  { chave: 'retirada', nome: 'Aguardando retirada', grupo: 'cliente', urgencia: 'Esta semana', motivo: 'Pedido aguardando retirada',
    comoTratar: 'E-mail avisando onde retirar e até quando, com o link do rastreio. Avisos de "Final Notice" e "Reminder" são os mais urgentes.' },
  { chave: 'retido_cliente', nome: 'Retido no correio a pedido do cliente', grupo: 'cliente', urgencia: 'Esta semana', motivo: 'Pedido parado nos Correios (a pedido do cliente)',
    comoTratar: 'O pacote está parado no correio esperando o cliente ir buscar. Mandar o e-mail padrão de retirada com o endereço da agência e o prazo: se ninguém retirar, o correio devolve ao remetente.' },
  { chave: 'recusado', nome: 'Recusado pelo cliente', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: 'Pedido recusado pelo cliente',
    comoTratar: 'E-mail perguntando o motivo da recusa e oferecendo reenvio. Se o cliente desistiu, seguir para retenção ou reembolso.' },
  { chave: 'ausente', nome: 'Ausente na entrega', grupo: 'cliente', urgencia: 'Esperar 2 dias', motivo: 'Ausente para recebimento',
    comoTratar: 'A transportadora costuma tentar de novo. Esperar 2 dias; mandar e-mail só se falhar outra vez ou virar retirada.' },
  { chave: 'taxa', nome: 'Taxa de importação', grupo: 'cliente', urgencia: 'Esta semana', motivo: 'Pedido aguardando retirada',
    comoTratar: 'E-mail explicando a taxa da alfândega e como pagar e retirar o pacote.' },
  { chave: 'devolucao_endereco', nome: 'Devolvido por problema de endereço', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: MOT_DEVOL,
    comoTratar: 'O pacote voltou (ou está voltando) porque o endereço estava incompleto, errado, sem acesso ou o cliente se mudou. Mandar o e-mail padrão pedindo o endereço completo e preparar o reenvio.' },
  { chave: 'devolucao_cliente', nome: 'Devolvido: cliente não recebeu', grupo: 'cliente', urgencia: 'Agir em 24h', motivo: MOT_DEVOL,
    comoTratar: 'O pacote voltou (ou está voltando) porque o cliente recusou, não retirou ou não estava em casa. Falar com o cliente para entender e combinar reenvio ou reembolso.' },
  { chave: 'em_devolucao', nome: 'Em devolução', grupo: 'devolucao', urgencia: 'Preparar reenvio', motivo: MOT_DEVOL,
    comoTratar: 'O pacote está voltando e a transportadora não informou o motivo. Abrir a folha do pedido para ver o histórico e falar com o cliente para deixar o reenvio pronto.' },
  { chave: 'devolvido', nome: 'Devolvido ao remetente', grupo: 'devolucao', urgencia: 'Decidir reenvio', motivo: 'Pedido retornou',
    comoTratar: 'Voltou sem motivo informado pela transportadora. Confirmar com a fulfillment que o pacote chegou e oferecer ao cliente reenvio (com endereço confirmado) ou reembolso.' },
  { chave: 'aguardando_coleta_ok', nome: 'Aguardando coleta · até 2 dias úteis', grupo: 'ok', urgencia: 'Nada a fazer', motivo: MOT_FULF,
    comoTratar: 'Código gerado há até 2 dias úteis: é o prazo normal para a transportadora coletar. Nada a fazer; se passar de 2 dias úteis, o pedido vai sozinho para "Aguardando coleta · mais de 2 dias úteis".' },
  { chave: 'transito_normal', nome: 'Em trânsito normal', grupo: 'ok', urgencia: 'Nada a fazer', motivo: '',
    comoTratar: 'Movimentou nos últimos 5 dias e não tem aviso de problema. Nada a fazer.' },
  { chave: 'entregue_nao_baixado', nome: 'Entregue, falta dar baixa', grupo: 'ok', urgencia: 'Dar baixa', motivo: 'Resolvido - Entregue ao cliente',
    comoTratar: 'A transportadora já entregou. Só dar baixa no sistema.' },
];
export const CLASSE_POR_CHAVE = Object.fromEntries(CLASSES.map((c) => [c.chave, c]));
/** Grupo de uma classe (classe fora do mapa cai em `ok`, como no painel). */
export const grupoDaClasse = (chave) => CLASSE_POR_CHAVE[chave]?.grupo ?? 'ok';
/** Filtro "Causa" da lista (só estas aparecem, como no painel). */
export const CAUSAS_FILTRO = ['endereco', 'recusado', 'acesso', 'ausente', 'mudou', 'retirada', 'retido_cliente'];

/* ─────────────────────  as 14 regras de texto (passo 1)  ───────────────── */
/** Ordem = precedência (a primeira que casar vence). */
export const REGRAS = [
  { classe: 'devolvido', termos: ['To Original Sender', '^Returned to Sender', 'returned to the seller', 'returned and is enroute to the Sender'] },
  { classe: 'em_devolucao', termos: ['Return to Sender', 'Return Initiated', 'Return in Pro', 'Being Returned', 'being returned to sender', 'will be returned to sender', 'returnedToVeho', 'pendingReturnToClient'] },
  { classe: 'recusado', termos: ['refus', 'reject'] },
  { classe: 'taxa', termos: ['Payment of charges', 'duties', 'duty', 'import tax'] },
  { classe: 'mudou', termos: ['Moved, Left', '^Vacant', 'Forward Time Expired', 'Forward Expired'] },
  { classe: 'endereco', termos: ['Insufficient Address', 'Incorrect Address', 'Incorrect/Insufficient', 'No Such Number', 'No Such Street', 'Addressee Unknown', 'additional information to complete', 'Undeliverable'] },
  { classe: 'acesso', termos: ['No Access', 'access code', 'gain access', 'Restricted Address', 'Business Closed', 'business was closed'] },
  { classe: 'retido_cliente', termos: ['At Customer Request'] },
  { classe: 'retirada', termos: ['Final Notice', 'Reminder to Schedule Redelivery', 'Available for Redelivery', 'Available for Pick', 'Collect for Pick Up', 'Notice card left', 'Notice Left', 'Item being held', 'Ready for Collection', 'Ready for Pick', 'available for pickup'] },
  { classe: 'ausente', termos: ['not available', 'No one in attendance', 'Attempted Delivery', 'attempt failed', 'Contact Attempt Failed', 'unable to complete your delivery', 'delivery rescheduled', 'attempt delayed'] },
  { classe: 'avaria', termos: ['Damag', 'Lost', 'Missing'] },
  { classe: 'etiqueta_cancelada', termos: ['Label Cancel'] },
  { classe: 'atraso_transportadora', termos: ['Delay', 'routed incorrectly', 'Missent', 'weather', 'Force Majeure'] },
  { classe: 'entregue', termos: ['^Delivered', 'has been delivered', '^Parcel Delivered', 'Recipient Collected', 'Picked Up at Post Office', 'Picked Up, Smart Parcel Locker', 'successfully delivered', 'Delivered to'] },
];
/** Classes de evento que contam como CAUSA de uma devolução (passo 2). */
export const CLASSES_CAUSA = ['endereco', 'mudou', 'recusado', 'retirada', 'ausente', 'acesso', 'taxa', 'avaria', 'etiqueta_cancelada', 'retido_cliente'];
/** Causa → classe de devolução (passo 3). */
export const CAUSAS_DEVOLUCAO_ENDERECO = ['endereco', 'mudou', 'acesso'];
export const CAUSAS_DEVOLUCAO_CLIENTE = ['recusado', 'retirada', 'retido_cliente', 'ausente', 'taxa'];

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
/** Termo literal → fonte de regex (o `^` inicial vira âncora; o resto é escapado). Sem `\s` nem `\d`: vale igual no JS e no Postgres. */
export function termoParaRegex(termo) {
  const ancora = termo.startsWith('^');
  return (ancora ? '^' : '') + escapar(ancora ? termo.slice(1) : termo).replace(/\\\//g, '/');
}
/** Uma regex por regra (alternância dos termos). */
export const REGEX_DA_REGRA = REGRAS.map((r) => ({ classe: r.classe, fonte: r.termos.map(termoParaRegex).join('|') }));
const REGEX_JS = REGEX_DA_REGRA.map((r) => ({ classe: r.classe, re: new RegExp(r.fonte, 'i') }));

/** Texto do evento para classificar: a parte da descrição antes de " -> ". */
export const textoDoEvento = (descricao) => String(descricao ?? '').split(' -> ')[0];
/** Classe de evento (as 14 regras, primeira que casar vence) ou null. Recebe o texto JÁ cortado em " -> ". */
export function classificarTexto(texto) {
  const t = String(texto ?? '');
  for (const r of REGEX_JS) if (r.re.test(t)) return r.classe;
  return null;
}

/* ───────────────────────  tradução dos textos (12.5)  ──────────────────── */
/** Ordem = precedência (específicas antes das genéricas). [regex (case-insensitive), texto em português]. */
const TRAD_BRUTA = [
  ['^Delivered, To Original Sender', 'Entregue de volta ao remetente'],
  ['^Returned to Sender - Item not collected', 'Devolvido ao remetente: o cliente não retirou'],
  ['^Returned to Sender', 'Devolvido ao remetente'],
  ['returned to the seller', 'Pacote devolvido ao vendedor'],
  ['returned and is enroute to the Sender', 'Pacote devolvido, a caminho do remetente'],
  ['Return to Sender Processed', 'Devolução ao remetente iniciada'],
  ['^Return Initiated', 'Devolução iniciada'],
  ['Return in Pro(gress|cess)', 'Devolução em andamento'],
  ['Unclaimed/Being Returned|Return to Sender - Unclaimed', 'Não foi retirado, voltando ao remetente'],
  ['Return to Sender - Recipient Not at Address', 'Destinatário não está no endereço, voltando ao remetente'],
  ['Return to Sender - Undeliverable|could not be delivered and will be returned', 'Não pôde ser entregue, voltando ao remetente'],
  ['In Transit to USPS', 'Em trânsito para os Correios dos EUA (USPS)'],
  ['Arrived at Delivery Office', 'Chegou à agência de entrega'],
  ['Ready for Pick ?up', 'Pronto para retirada'],
  ['^In Customs', 'Em processamento na alfândega'],
  ['unclaimed by recipient', 'Não retirado pelo destinatário, voltando ao remetente'],
  ['Item refused by recipient', 'Recusado pelo destinatário, voltando ao remetente'],
  ['International item was undeliverable', 'Item internacional não pôde ser entregue, voltando ao remetente'],
  ['^returnedToVeho', 'Devolvido ao centro de distribuição da Veho'],
  ['pendingReturnToClient', 'Aguardando devolução ao remetente'],
  ['Refused by the Recipient, Hold for Instructions', 'Recusado pelo destinatário, aguardando instruções'],
  ['Refused by the Recipient', 'Recusado pelo destinatário'],
  ['refused or requested to be returned', 'Recusado ou devolução solicitada'],
  ['^Refused', 'Recusado pelo destinatário'],
  ['Payment of charges', 'Taxa de importação a pagar: pacote retido, destinatário avisado'],
  ['Moved, Left no Address', 'Destinatário se mudou e não deixou endereço'],
  ['^Vacant', 'Endereço desocupado'],
  ['Incorrect/Insufficient Address, Additional Details Required', 'Endereço incorreto ou incompleto: precisa de mais detalhes para entregar'],
  ['Incorrect/Insufficient Address', 'Endereço incorreto ou incompleto'],
  ['Insufficient Address', 'Endereço incompleto'],
  ['No Such Number', 'O número do endereço não existe'],
  ['No Such Street', 'A rua não existe'],
  ['Addressee Unknown', 'Destinatário desconhecido no endereço'],
  ['additional information to complete your delivery', 'A transportadora precisa de mais informações para concluir a entrega e evitar a devolução'],
  ['Undeliverable - Incorrect Address', 'Não entregável: endereço incorreto'],
  ['Undeliverable', 'Não entregável'],
  ['No Access to Delivery Location', 'Sem acesso ao local de entrega'],
  ['access code', 'Entrega não concluída: falta o código de acesso'],
  ['Unable to gain access', 'Tentativa de entrega: sem acesso ao local'],
  ['Restricted Address', 'Endereço restrito (base militar, correio etc.)'],
  ['business was closed|business closed today', 'Tentativa de entrega: empresa fechada, nova tentativa programada'],
  ['Business Closed', 'Empresa fechada no momento da entrega'],
  ['Held at Post Office, At Customer Request', 'Retido na agência a pedido do cliente'],
  ['Final Notice', 'Último aviso: volta ao remetente se não for retirado no prazo'],
  ['Reminder to Schedule Redelivery', 'Lembrete: agendar nova entrega ou retirar o pacote'],
  ['Available for Redelivery or Pick ?up', 'Disponível para nova entrega ou retirada'],
  ['Collect for Pick ?Up', 'Disponível para retirada no ponto de coleta'],
  ['available for pick ?up', 'Disponível para retirada'],
  ['Notice card left', 'Aviso deixado indicando onde e quando retirar'],
  ['Notice Left \\(No Secure Location', 'Aviso deixado: sem local seguro para deixar o pacote'],
  ['Notice Left \\(Receptacle Full', 'Aviso deixado: caixa de correio cheia ou pacote grande'],
  ['Notice Left', 'Aviso de entrega deixado'],
  ['Attempted Delivery - Item being held', 'Tentativa de entrega: pacote retido, destinatário avisado'],
  ['Ready for Collection', 'Pronto para retirada'],
  ['Redelivery Scheduled', 'Nova entrega agendada para o próximo dia útil'],
  ['Rescheduled to Next Delivery Day', 'Reagendado para o próximo dia de entrega'],
  ['Addressee not available', 'Destinatário ausente: nova tentativa programada'],
  ['No one in attendance', 'Tentativa de entrega: ninguém no local'],
  ['Attempted Delivery Abroad', 'Tentativa de entrega no exterior'],
  ['Attempted Delivery', 'Tentativa de entrega'],
  ['delivery attempt failed', 'A tentativa de entrega falhou, o pacote volta ao depósito'],
  ['Delivery rescheduled|rescheduled to the next', 'Entrega reagendada'],
  ['attempt delayed, timed out or failed', 'Tentativa de entrega atrasada ou sem sucesso'],
  ['unable to complete your delivery', 'Não foi possível concluir a entrega'],
  ['Package Damaged', 'Pacote danificado'],
  ['Label Cancel', 'Etiqueta cancelada'],
  ['Airline (transit )?Delay', 'Atraso no voo'],
  ['Customs Clearance Delay', 'Atraso na alfândega'],
  ['routed incorrectly|re-routed', 'Pacote foi para a rota errada e está sendo redirecionado'],
  ['delayed due to weather', 'Atrasado por causa do clima'],
  ['Force Majeure', 'Entrega não feita por motivo de força maior'],
  ['arrive later than expected', 'Vai chegar depois do previsto, mas segue a caminho'],
  ['Customs Clearance Processing Complete|Cleared Customs|released from Customs|Cleared and awaiting', 'Liberado pela alfândega'],
  ['Inbound Out of Customs', 'Saiu da alfândega'],
  ['Customs Clearance|Into Customs|Arrived at Customs|awaiting clearance|presented for review|clearance facility', 'Em processamento na alfândega'],
  ['^Delivered, In/At Mailbox|community mailbox', 'Entregue na caixa de correio'],
  ['Parcel Locker', 'Entregue no armário de encomendas'],
  ['^Delivered, PO Box', 'Entregue na caixa postal'],
  ['^Delivered, (Front Desk|Reception|Mail Room)', 'Entregue na recepção'],
  ['^Delivered, Left with Individual', 'Entregue a uma pessoa no local'],
  ['^Delivered, (Front Door|Door/Yard)|front door', 'Entregue na porta'],
  ['Individual Picked Up at Post Office|Recipient Collected', 'Retirado pelo destinatário'],
  ['Safe Drop', 'Entregue em local seguro'],
  ['camera icon|Photo available', 'Foto da entrega disponível'],
  ['misdeliver', 'Entregue no endereço errado'],
  ['No Answer - Carded', 'Ninguém atendeu: aviso de entrega deixado'],
  ['PackageHadDeliveryIssue', 'A transportadora informou um problema na entrega'],
  ['Address Corrected', 'Endereço corrigido'],
  ['released by Customs|Out of Customs', 'Liberado pela alfândega'],
  ['delivered', 'Entregue'],
  ['^Out for Delivery|Item out for delivery|Onboard for delivery|Received by postal carrier for delivery', 'Saiu para entrega'],
  ['Tendered to Postal Service', 'Entregue aos Correios dos EUA (USPS) para a entrega final'],
  ['Pre-Shipment Info|Shipment Announced|Manifested for Outbound|Electronic Shipping Info', 'Envio registrado, aguardando o pacote'],
  ['International Dispatch Ready', 'Pronto para o envio internacional'],
  ['Outbound Shipment Pickup', 'Coletado na origem'],
  ['Received in Depot|Processed in Depot|received at', 'Recebido no depósito da transportadora'],
  ['trans-shipment', 'Em trânsito por um país intermediário'],
  ['Shipping Label Created|^Label created|^created$|Data Received|Customer Information Manifested|package data was sent', 'Etiqueta criada, aguardando a transportadora receber o pacote'],
  ['Accepted at USPS|Received item from Sender|droppedOffAtVeho|Parcel Received|Arrived Shipping Partner|has been received and is on its way', 'Recebido pela transportadora'],
  ['USPS in possession', 'Pacote com os Correios dos EUA (USPS)'],
  ['Forward(ed| Processed)', 'Redirecionado para um novo endereço'],
  ['Distribution to PO Box', 'Em distribuição para a caixa postal'],
  ['Arrived at Post Office|Arrival at Post Office', 'Chegou à agência de entrega'],
  ['Origin Post is Preparing', 'Correio de origem preparando o envio'],
  ['International item mailed', 'Item internacional postado no país de origem'],
  ['left originating country|Departed Origin Country', 'Saiu do país de origem'],
  ['Arrived within Destination Country|has arrived in', 'Chegou ao país de destino'],
  ['Collected from the airline', 'Retirado da companhia aérea para processamento'],
  ['Awaiting Delivery', 'Aguardando entrega'],
  ['Loaded on Vehicle|loaded onto a vehicle|pickedUpFromVeho|Ready for Delivery Driver', 'Carregado no veículo de entrega'],
  ['^Arrived|Arrived at|^Arrival at|PackageArrivedAtFacility|received by your local|Item arrived|Checked in at', 'Chegou a uma unidade'],
  ['^Departed|PackageDepartedFromFacility|Item departed|Parcel Shipped', 'Saiu de uma unidade'],
  ['In Transit|in transit|on its way|Processed|processed|Processing|Sorting|Batch|en route|scanned', 'Em trânsito'],
];
const TRAD = TRAD_BRUTA.map(([fonte, pt]) => [new RegExp(fonte, 'i'), pt]);
/** Corta " -> ..." e o sufixo ". For Delivery Issues..." (o texto "limpo" que a tela mostra e a tradução testa). */
export function limparTextoTransportadora(texto) {
  return String(texto ?? '').split(' -> ')[0].replace(/\.?\s*For Delivery Issues.*$/i, '').trim();
}
/** Traduz o texto do evento para o português (primeira regra que casar); sem regra, devolve o texto original (já limpo). */
export function traduzirTexto(texto) {
  const t = limparTextoTransportadora(texto);
  if (!t) return '';
  for (const [re, pt] of TRAD) if (re.test(t)) return pt;
  return t;
}
export const QTD_TRADUCOES = TRAD.length;

/* ─────────────────────────  status do 17Track (12.4)  ──────────────────── */
export const ST17 = {
  Delivered: 'entregue', InTransit: 'em trânsito', NotFound: 'não localizado', InfoReceived: 'etiqueta criada', Exception: 'exceção',
  DeliveryFailure: 'falha na entrega', AvailableForPickup: 'aguardando retirada', OutForDelivery: 'saiu para entrega', Expired: 'expirado',
};
export const rotuloSt17 = (s) => ST17[s] ?? (s ? s : 'sem dados no 17Track');

/* ──────────────────────────  tratativas (seção 10)  ────────────────────── */
export const TIPOS_TRATATIVA = {
  email_cliente: 'E-mail enviado ao cliente',
  plataforma: 'Plataforma de venda cobrada',
  fulfillment: 'Fulfillment cobrada',
  transportadora: 'Transportadora cobrada',
  reenvio: 'Reenvio solicitado',
  endereco: 'Endereço corrigido',
  outro: 'Outra tratativa',
};

/* ───────────────────────  quadros Q1–Q5 (seção 7)  ─────────────────────── */
export const QUADROS = [
  { n: 1, nome: 'Pedidos sem rastreio', regra: 'Mais de 2 dias úteis desde a compra, sem código de rastreio.' },
  { n: 2, nome: 'Com rastreio, sem despacho', regra: 'Código gerado há mais de 2 dias úteis, nenhum movimento real do 17Track e ainda não entregue.' },
  { n: 3, nome: 'Monitorar', regra: 'Movimento real há 5 a 9 dias corridos.' },
  { n: 4, nome: 'Atenção', regra: 'Movimento real há 10 a 14 dias corridos.' },
  { n: 5, nome: 'Críticos', regra: 'Movimento real há 15 dias corridos ou mais.' },
];

/** Plataformas conhecidas (rótulo) e fulfillments (valor interno `jetstream` aparece como JetPack). */
export const ROTULO_FULFILLMENT = { redrock: 'RedRock', fullstack: 'FullStack', jetstream: 'JetPack', 'sem fulfillment': 'Sem fulfillment' };
