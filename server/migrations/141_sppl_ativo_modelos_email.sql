-- ═══════════════════════════════════════════════════════════════════════════
--  141 · Suporte Ativo: biblioteca de MODELOS de e-mail (português para a equipe, inglês americano para o cliente) + assinatura padrão
--
--  A equipe lê/edita em português; o cliente recebe `assunto_en`/`corpo_en`. Carga inicial = modelos de fábrica da seção 12.3 do PDF do MONIT-SPPL
--  (endereco, acesso, mudou, retirada, taxa, recusado, ausente, devolucao, atraso). Marcadores do PDF → marcadores do SendTrace:
--      {first_name}→{nome}  {order}→{pedido}  {tracking}→{rastreio}  {tracking_link}→{link_rastreio}  {carrier}→{transportadora}
--      {address}→{endereco}  {signature}→{assinatura}  {product}→{produto}
--  `fabrica` guarda o texto original (jsonb) para o botão "Voltar ao texto original"; modelo criado pela equipe tem fabrica NULL.
--  A carga é ON CONFLICT DO NOTHING: nunca sobrescreve modelo que a equipe já editou. Assinatura padrão em config_disparos.
--
--  Só ADICIONA. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sppl_ativo_modelos (
  id             text PRIMARY KEY,                 -- chave textual (slug): endereco, atraso, ...
  nome           text NOT NULL,
  descricao_pt   text,                             -- "o que diz" (para a equipe escolher)
  assunto_pt     text,
  corpo_pt       text,
  assunto_en     text NOT NULL,                    -- o que o cliente recebe
  corpo_en       text NOT NULL,
  ativo          boolean NOT NULL DEFAULT true,
  ordem          int NOT NULL DEFAULT 100,
  fabrica        jsonb,                            -- texto de fábrica (NULL = modelo criado pela equipe)
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por text
);

INSERT INTO config_disparos (chave, valor) VALUES ('sppl_ativo_assinatura', 'Customer Care Team') ON CONFLICT (chave) DO NOTHING;

INSERT INTO sppl_ativo_modelos (id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en, ordem, fabrica, atualizado_por)
SELECT v.id, v.nome, v.descricao_pt, v.assunto_pt, v.corpo_pt, v.assunto_en, v.corpo_en, v.ordem,
       jsonb_build_object('nome', v.nome, 'descricao_pt', v.descricao_pt, 'assunto_pt', v.assunto_pt, 'corpo_pt', v.corpo_pt, 'assunto_en', v.assunto_en, 'corpo_en', v.corpo_en),
       'fábrica (MONIT-SPPL 12.3)'
FROM (VALUES

($m$endereco$m$, $m$Confirmar endereço$m$,
 $m$Pede ao cliente o endereço completo (número, apto, cidade, estado, ZIP) em até 48h, antes que a transportadora devolva o pacote.$m$,
 $m$Ação necessária: confirme seu endereço de entrega (Pedido {pedido})$m$,
 $m$Olá {nome},

A transportadora tentou entregar seu pedido {pedido}, mas informou que o endereço de entrega está incompleto ou incorreto:

{endereco}

Você pode responder este e-mail com seu endereço completo (número, apartamento ou unidade, cidade, estado e CEP) nas próximas 48 horas? Vamos atualizar a transportadora na hora para que seu pacote não seja devolvido.

Código de rastreio: {rastreio}
Acompanhe seu pacote: {link_rastreio}

Obrigado,
{assinatura}$m$,
 $m$Action needed: please confirm your shipping address (Order {pedido})$m$,
 $m$Hi {nome},

The carrier tried to deliver your order {pedido}, but they reported that the shipping address is incomplete or incorrect:

{endereco}

Could you reply to this email with your full address (street number, apartment or unit, city, state and ZIP code) within the next 48 hours? We will update the carrier right away so your package is not returned.

Tracking number: {rastreio}
Track your package: {link_rastreio}

Thank you,
{assinatura}$m$, 10),

($m$acesso$m$, $m$Instruções de acesso$m$,
 $m$Pede código do portão, instruções de entrega ou um endereço alternativo, porque a transportadora não conseguiu acessar o local.$m$,
 $m$Instruções de entrega necessárias para seu pedido {pedido}$m$,
 $m$Olá {nome},

A transportadora ({transportadora}) tentou entregar seu pedido {pedido}, mas não conseguiu acessar o local de entrega (código do portão, estabelecimento fechado ou área restrita).

Responda com o código de acesso do portão ou do prédio, instruções de entrega ou um endereço alternativo onde alguém possa receber o pacote. Vamos repassar para a transportadora na hora.

Código de rastreio: {rastreio}
Acompanhe seu pacote: {link_rastreio}

Obrigado,
{assinatura}$m$,
 $m$Delivery instructions needed for your order {pedido}$m$,
 $m$Hi {nome},

The carrier ({transportadora}) tried to deliver your order {pedido} but could not access the delivery location (gate code, closed business or restricted area).

Please reply with a gate or building access code, delivery instructions, or an alternative address where someone can receive the package. We will pass this on to the carrier right away.

Tracking number: {rastreio}
Track your package: {link_rastreio}

Thank you,
{assinatura}$m$, 20),

($m$mudou$m$, $m$Novo endereço$m$,
 $m$O correio informou que o cliente se mudou. Pede o endereço novo para fazer o reenvio.$m$,
 $m$Envie seu novo endereço (Pedido {pedido})$m$,
 $m$Olá {nome},

O correio nos avisou que o endereço do seu pedido {pedido} não é mais válido (mudança ou imóvel desocupado):

{endereco}

Responda com seu endereço de entrega atual e vamos garantir que o pedido chegue até você.

Obrigado,
{assinatura}$m$,
 $m$Please share your new address (Order {pedido})$m$,
 $m$Hi {nome},

The post office let us know that the address on your order {pedido} is no longer valid (moved or vacant):

{endereco}

Please reply with your current shipping address and we will make sure your order reaches you.

Thank you,
{assinatura}$m$, 30),

($m$retirada$m$, $m$Retirar o pedido$m$,
 $m$Avisa que o pacote está esperando na agência ou ponto de coleta e que volta ao remetente se não for retirado.$m$,
 $m$Seu pacote está esperando retirada (Pedido {pedido})$m$,
 $m$Olá {nome},

Boa notícia: seu pedido {pedido} chegou e está esperando você retirar na agência do correio ou no ponto de coleta da transportadora ({transportadora}).

Retire o quanto antes. Se não for retirado a tempo, a transportadora vai devolvê-lo para nós.

Veja o local e o horário de retirada aqui:
{link_rastreio}

Código de rastreio: {rastreio}

Obrigado,
{assinatura}$m$,
 $m$Your package is waiting for pickup (Order {pedido})$m$,
 $m$Hi {nome},

Good news: your order {pedido} has arrived and is waiting for you to pick it up at the post office or carrier pickup point ({transportadora}).

Please pick it up as soon as possible. If it is not collected in time, the carrier will return it to us.

You can see the pickup location and hours here:
{link_rastreio}

Tracking number: {rastreio}

Thank you,
{assinatura}$m$, 40),

($m$taxa$m$, $m$Taxa de importação$m$,
 $m$Explica que a alfândega cobrou uma taxa e que o cliente precisa pagar para liberar e retirar o pacote.$m$,
 $m$Taxa de importação para liberar seu pacote (Pedido {pedido})$m$,
 $m$Olá {nome},

Seu pedido {pedido} chegou ao seu país, mas o serviço postal local está segurando o pacote até que a taxa de importação seja paga. Você deve ter recebido um aviso deles com o valor e a forma de pagamento.

Depois que a taxa for paga, você pode retirar ou receber seu pacote. Os detalhes estão aqui:
{link_rastreio}

Código de rastreio: {rastreio}

Se tiver qualquer dúvida, é só responder este e-mail.

Obrigado,
{assinatura}$m$,
 $m$Import charges to release your package (Order {pedido})$m$,
 $m$Hi {nome},

Your order {pedido} has arrived in your country, but the local postal service is holding it until the import charges are paid. You should have received a notice from them with the amount and how to pay.

Once the charges are paid, you can pick up or receive your package. Details are available here:
{link_rastreio}

Tracking number: {rastreio}

If you have any questions, just reply to this email.

Thank you,
{assinatura}$m$, 50),

($m$recusado$m$, $m$Entender a recusa$m$,
 $m$Pergunta por que a entrega foi recusada e oferece reenviar o pedido.$m$,
 $m$Sobre seu pedido {pedido}: a entrega não foi concluída$m$,
 $m$Olá {nome},

A transportadora informou que seu pedido {pedido} não pôde ser entregue (foi recusado, não foi retirado ou não havia ninguém para receber) e pode ser devolvido para nós.

Queremos garantir que você receba seu pedido. Pode nos contar o que aconteceu? Se foi um engano, responda com o melhor endereço e vamos providenciar uma nova entrega.

Código de rastreio: {rastreio}

Obrigado,
{assinatura}$m$,
 $m$About your order {pedido}: the delivery was not completed$m$,
 $m$Hi {nome},

The carrier reported that your order {pedido} could not be delivered (it was refused, not picked up or no one was available) and it may be returned to us.

We want to make sure you get your order. Could you let us know what happened? If it was a mistake, reply with the best address and we will arrange a new delivery.

Tracking number: {rastreio}

Thank you,
{assinatura}$m$, 60),

($m$ausente$m$, $m$Ausente na entrega$m$,
 $m$Avisa que a transportadora tentou entregar e não encontrou ninguém, e sugere acompanhar a nova tentativa.$m$,
 $m$Tentamos entregar seu pedido {pedido}$m$,
 $m$Olá {nome},

A transportadora tentou entregar seu pedido {pedido}, mas não havia ninguém para receber. Ela vai tentar de novo ou deixar o pacote disponível para retirada.

Acompanhe a próxima tentativa de entrega aqui:
{link_rastreio}

Se quiser atualizar o endereço ou incluir instruções de entrega, é só responder este e-mail.

Obrigado,
{assinatura}$m$,
 $m$We tried to deliver your order {pedido}$m$,
 $m$Hi {nome},

The carrier tried to deliver your order {pedido}, but no one was available to receive it. They will try again or leave it available for pickup.

You can follow the next delivery attempt here:
{link_rastreio}

If you would like to update the address or add delivery instructions, just reply to this email.

Thank you,
{assinatura}$m$, 70),

($m$devolucao$m$, $m$Reenvio após devolução$m$,
 $m$Avisa que o pacote voltou ou está voltando e pede para confirmar o endereço para reenviar.$m$,
 $m$Seu pedido {pedido} voltou para nós: vamos enviá-lo de novo$m$,
 $m$Olá {nome},

Seu pedido {pedido} não pôde ser entregue e está sendo devolvido para nós pela transportadora.

Queremos enviá-lo para você de novo. Responda confirmando seu endereço completo (número, apartamento ou unidade, cidade, estado e CEP):

{endereco}

Obrigado,
{assinatura}$m$,
 $m$Your order {pedido} was returned to us: let's get it to you$m$,
 $m$Hi {nome},

Your order {pedido} could not be delivered and is being returned to us by the carrier.

We would like to send it to you again. Please reply to confirm your full shipping address (street number, apartment or unit, city, state and ZIP code):

{endereco}

Thank you,
{assinatura}$m$, 80),

($m$atraso$m$, $m$Atraso na entrega$m$,
 $m$Avisa o cliente de um atraso da transportadora e que a equipe está acompanhando.$m$,
 $m$Uma atualização sobre seu pedido {pedido}$m$,
 $m$Olá {nome},

Percebemos que seu pedido {pedido} está demorando mais do que o esperado com a transportadora ({transportadora}). Estamos acompanhando de perto e já entramos em contato com ela.

Acompanhe seu pacote aqui:
{link_rastreio}

Vamos te manter informado. Obrigado pela paciência.

{assinatura}$m$,
 $m$An update on your order {pedido}$m$,
 $m$Hi {nome},

We noticed that your order {pedido} is taking longer than expected with the carrier ({transportadora}). We are following it closely and have contacted them.

You can track your package here:
{link_rastreio}

We will keep you posted. Thank you for your patience.

{assinatura}$m$, 90)

) AS v(id, nome, descricao_pt, assunto_pt, corpo_pt, assunto_en, corpo_en, ordem)
ON CONFLICT (id) DO NOTHING;
