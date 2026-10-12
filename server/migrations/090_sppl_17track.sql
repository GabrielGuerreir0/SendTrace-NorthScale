-- ═══════════════════════════════════════════════════════════════════════════
--  090 · SPPL (Sistema de Prevenção de Problemas Logísticos) + histórico do 17TRACK
--
--  Pedido da Késsia (documento "SPPL - NORTHSCALE", 12/10/2026). Vive dentro do Rastreio de Pedidos: não é aba nova.
--  Fonte única de rastreio = 17TRACK; Red Rock/FullStack seguem alimentando só "pedido recebido / etiqueta gerada".
--
--  1) Histórico do 17TRACK
--     rastreio_17t_registros  uma linha por código registrado (aceito, recusado ou sem dado) e o último status
--     rastreio_17t_eventos    eventos normalizados (status e substatus ORIGINAIS preservados), idempotentes pela `chave`
--     rastreio_17t_payloads   payload bruto recebido (auditoria; pode ser limpo por `recebido_em`)
--     Local do evento: só cidade/estado/país (decisão de 12/10 — o CEP e a rua ficam só no payload bruto, nunca na tela pública).
--  2) SPPL
--     sppl_regras        a matriz do PDF, EDITÁVEL no painel (status/substatus ou tempo → categoria, ação, dono, prazo, prioridade)
--     sppl_ocorrencias   uma ocorrência por pedido+categoria enquanto aberta
--     sppl_cobrancas     cobranças à fulfillment/transportadora (v1: só registra, não envia)
--     sppl_feriados      calendário de dias úteis (sábado/domingo já contam como não úteis; feriados da v1 = vazio)
--     rastreio_pedidos.sppl_visto_em  1ª vez que o SPPL viu o pedido — o relógio das etapas conta daqui, não da data da compra,
--                                      para não gerar ~8.400 alertas no primeiro dia.
--
--  Só ADICIONA (tabelas novas, 1 coluna nula, 1 função). Idempotente. Nada é lido nem escrito por código antigo.
--  As prioridades e prazos da matriz são ASSUMIDOS (reversíveis, editáveis na tabela): o PDF não define prioridade por status.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Histórico do 17TRACK ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rastreio_17t_registros (
  numero               text PRIMARY KEY,                    -- código de rastreio (um código pode atender mais de um pedido)
  carrier_17t          integer,                             -- código da transportadora detectada pelo 17TRACK
  situacao_registro    text NOT NULL DEFAULT 'pendente'     -- 'pendente' | 'aceito' | 'recusado' | 'sem_dado'
                       CHECK (situacao_registro IN ('pendente','aceito','recusado','sem_dado')),
  motivo_recusa        text,                                -- ex.: USPS sem pacote pago; "Carrier cannot be detected"
  codigo_erro          integer,
  registrado_em        timestamptz,
  cota_gasta           smallint NOT NULL DEFAULT 0,
  ultimo_status        text,                                -- ex.: Delivered, InTransit, Exception (original 17TRACK)
  ultimo_substatus     text,                                -- ex.: Delivered_Other, Exception_Delayed (original 17TRACK)
  ultimo_evento_em     timestamptz,                         -- data do evento mais recente da transportadora
  atualizado_em        timestamptz,                         -- última vez que o 17TRACK nos disse algo (webhook ou consulta)
  ultima_consulta_em   timestamptz,                         -- última reconciliação ativa (gettrackinfo)
  criado_em            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rastreio_17t_registros_situacao_idx ON rastreio_17t_registros (situacao_registro);
CREATE INDEX IF NOT EXISTS rastreio_17t_registros_status_idx ON rastreio_17t_registros (ultimo_status, ultimo_evento_em);

CREATE TABLE IF NOT EXISTS rastreio_17t_eventos (
  id             bigserial PRIMARY KEY,
  numero         text NOT NULL REFERENCES rastreio_17t_registros(numero) ON DELETE CASCADE,
  chave          text NOT NULL,                             -- md5(numero|momento|status|substatus|descrição): garante idempotência do webhook
  ocorreu_em     timestamptz,                               -- horário do evento na transportadora
  status         text,                                      -- original do 17TRACK
  substatus      text,                                      -- original do 17TRACK
  descricao      text,                                      -- texto da transportadora
  cidade         text,
  estado         text,
  pais           text,
  provedor_17t   text,                                      -- nome da transportadora que reportou o evento
  detectado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (numero, chave)
);
CREATE INDEX IF NOT EXISTS rastreio_17t_eventos_numero_idx ON rastreio_17t_eventos (numero, ocorreu_em DESC);

CREATE TABLE IF NOT EXISTS rastreio_17t_payloads (
  id           bigserial PRIMARY KEY,
  numero       text,
  origem       text NOT NULL CHECK (origem IN ('webhook','consulta','registro')),
  recebido_em  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS rastreio_17t_payloads_numero_idx ON rastreio_17t_payloads (numero, recebido_em DESC);
CREATE INDEX IF NOT EXISTS rastreio_17t_payloads_data_idx ON rastreio_17t_payloads (recebido_em);

-- ── 2) SPPL ────────────────────────────────────────────────────────────────

ALTER TABLE rastreio_pedidos ADD COLUMN IF NOT EXISTS sppl_visto_em timestamptz;

CREATE TABLE IF NOT EXISTS sppl_feriados (
  data       date PRIMARY KEY,
  descricao  text
);

-- Soma N dias úteis (sábado/domingo e feriados cadastrados não contam), no fuso dos EUA. Mantém a hora do dia.
CREATE OR REPLACE FUNCTION sppl_somar_dias_uteis(inicio timestamptz, n integer) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE
  cur timestamp := inicio AT TIME ZONE 'America/New_York';
  falta integer := n;
BEGIN
  WHILE falta > 0 LOOP
    cur := cur + interval '1 day';
    IF extract(isodow FROM cur) < 6 AND NOT EXISTS (SELECT 1 FROM sppl_feriados WHERE data = cur::date) THEN
      falta := falta - 1;
    END IF;
  END LOOP;
  RETURN cur AT TIME ZONE 'America/New_York';
END $f$;

CREATE TABLE IF NOT EXISTS sppl_regras (
  id               serial PRIMARY KEY,
  origem           text NOT NULL CHECK (origem IN ('status_17t','tempo','sem_dado')),
  etapa            smallint,                               -- etapa do PDF (1 a 5), quando existir
  status_17t       text,                                   -- origem = status_17t: status original (NULL = qualquer)
  substatus_17t    text,                                   -- NULL = qualquer substatus do status
  referencia_tempo text,                                   -- origem = tempo: 'compra' | 'etiqueta' | 'ultima_movimentacao'
  categoria        text NOT NULL,                          -- classificação interna (o status original fica em campo próprio)
  titulo           text NOT NULL,
  acao             text,                                   -- NULL = não gera ação
  responsavel      text NOT NULL DEFAULT 'Equipe interna de PPL',
  dias             integer,                                -- gatilho: dias após a referência (NULL = imediato)
  dias_uteis       boolean NOT NULL DEFAULT true,
  prazo_resolucao_dias integer,                            -- prazo para resolver depois de aberta (dias úteis)
  imediato         boolean NOT NULL DEFAULT false,         -- não espera os prazos de 5/10/15
  contata_cliente  boolean NOT NULL DEFAULT false,
  prioridade       text NOT NULL DEFAULT 'P3' CHECK (prioridade IN ('P0','P1','P2','P3')),
  ativa            boolean NOT NULL DEFAULT true,
  ordem            integer NOT NULL DEFAULT 0,
  observacao       text,
  atualizado_por   text,                                   -- quem editou pela tela (e-mail); NULL = semente da migração
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sppl_ocorrencias (
  id                  bigserial PRIMARY KEY,
  transacao_id        text NOT NULL,
  numero              text,                                 -- código de rastreio (NULL em "sem código")
  regra_id            integer REFERENCES sppl_regras(id),
  categoria           text NOT NULL,
  etapa               smallint,
  status_17t          text,                                 -- original (preservado)
  substatus_17t       text,
  prioridade          text NOT NULL DEFAULT 'P3' CHECK (prioridade IN ('P0','P1','P2','P3')),
  situacao            text NOT NULL DEFAULT 'aberta'
                      CHECK (situacao IN ('aberta','em_cobranca','aguardando_cliente','resolvida','cancelada')),
  responsavel         text,                                 -- equipe ou pessoa
  board_id            integer,                              -- agente sorteado (suporte_escalado_boards), se houver
  caso_id             bigint,                               -- card aberto no Suporte Escalado, se a ocorrência exigiu contato
  proxima_acao        text,
  proxima_acao_ate    timestamptz,
  aberta_em           timestamptz NOT NULL DEFAULT now(),
  prazo_ate           timestamptz,
  resolvida_em        timestamptz,
  resultado           text,                                 -- conclusão da investigação e solução aplicada
  criada_por          text NOT NULL DEFAULT 'sistema',
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);
-- no máximo UMA ocorrência aberta por pedido+categoria (o motor é idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS sppl_ocorrencias_aberta_uq ON sppl_ocorrencias (transacao_id, categoria)
  WHERE situacao NOT IN ('resolvida','cancelada');
CREATE INDEX IF NOT EXISTS sppl_ocorrencias_situacao_idx ON sppl_ocorrencias (situacao, prioridade, prazo_ate);
CREATE INDEX IF NOT EXISTS sppl_ocorrencias_transacao_idx ON sppl_ocorrencias (transacao_id);

CREATE TABLE IF NOT EXISTS sppl_cobrancas (
  id               bigserial PRIMARY KEY,
  ocorrencia_id    bigint NOT NULL REFERENCES sppl_ocorrencias(id) ON DELETE CASCADE,
  destino          text NOT NULL CHECK (destino IN ('fulfillment','transportadora','parceiro_logistico','plataforma_de_venda','cliente')),
  canal            text,                                   -- e-mail, portal, telefone...
  mensagem         text,
  cobrado_em       timestamptz NOT NULL DEFAULT now(),
  cobrado_por      text,
  prazo_resposta_ate timestamptz,
  respondida_em    timestamptz,
  resposta         text
);
CREATE INDEX IF NOT EXISTS sppl_cobrancas_ocorrencia_idx ON sppl_cobrancas (ocorrencia_id, cobrado_em DESC);

-- ── Matriz do PDF (semente): só semeia se a tabela estiver vazia, para o admin poder editar/apagar sem a migração repor ─
DO $seed$ BEGIN IF NOT EXISTS (SELECT 1 FROM sppl_regras) THEN

-- Etapas por TEMPO
INSERT INTO sppl_regras (origem, etapa, referencia_tempo, categoria, titulo, acao, responsavel, dias, prazo_resolucao_dias, contata_cliente, prioridade, ordem, observacao) VALUES
 ('tempo',1,'compra','sem_codigo_rastreio','Pedido sem código de rastreio',
  'Abrir ocorrência e cobrar a plataforma de venda e a fulfillment a gerar o código.', 'Plataforma de venda + Fulfillment + Equipe interna de PPL', 3, 1, false,'P2',10,
  'PDF etapa 1: investigar e cobrar no 3º dia útil após a compra; 1 dia útil para resolver.'),
 ('tempo',2,'etiqueta','etiqueta_sem_coleta','Etiqueta gerada sem coleta confirmada',
  'Cobrar a fulfillment a confirmar a entrega do pacote à transportadora.', 'Fulfillment + Transportadora/Parceiro logístico + Equipe interna de PPL', 2, 1, false,'P2',20,
  'PDF etapa 2: etiqueta não é coleta. Cobrar no dia 2 após a geração, 1 dia útil para resolver.'),
 ('tempo',3,'ultima_movimentacao','sem_movimento_5d','Sem movimentação há 5 dias',
  'Investigar junto à transportadora o motivo da ausência de atualização e pedir previsão de normalização.', 'Fulfillment + Transportadora/Parceiro logístico + Equipe interna de PPL', 5, NULL, false,'P3',30,
  'PDF etapa 3 (status InTransit sem alteração).'),
 ('tempo',3,'ultima_movimentacao','sem_movimento_10d','Sem movimentação há 10 dias',
  'Escalar formalmente à transportadora: localização, motivo do atraso e prazo. E-mail ao cliente prometendo retorno em até 2 dias úteis.', 'Fulfillment + Transportadora/Parceiro logístico + Equipe interna de PPL', 10, NULL, true,'P1',40,
  'PDF etapa 3. O e-mail ao cliente depende da copy do CS.'),
 ('tempo',3,'ultima_movimentacao','sem_movimento_15d','Sem movimentação há 15 dias (crítico)',
  'Classificar como crítico e exigir solução prioritária; avaliar reenvio (autorização da gestão) e informar o cliente com o novo rastreio.', 'Fulfillment + Transportadora/Parceiro logístico + Equipe interna de PPL + Gestão', 15, 2, true,'P0',50,
  'PDF etapa 3: até 2 dias úteis para definir e encaminhar a solução.')
;

-- Pedido que o 17TRACK não retorna: ficam os dados da fulfillment e a tela mostra que o 17TRACK não encontrou nada (decisão de 12/10).
INSERT INTO sppl_regras (origem, categoria, titulo, acao, responsavel, prioridade, ordem, observacao) VALUES
 ('sem_dado','sem_dado_17track','Sem dado do 17TRACK',
  'Usar os dados da própria fulfillment e mostrar que o 17TRACK não encontrou nada. Casos: USPS sem pacote pago, transportadora não detectada (códigos GA…), código recusado.',
  'Equipe interna de PPL','P3',60,
  'Teste de 12/10/2026: USPS recusada sem pacote pago; GA… "Carrier cannot be detected".')
;

-- Regras por STATUS do 17TRACK (PDF seção 2). `substatus_17t` NULL = qualquer substatus daquele status.
INSERT INTO sppl_regras (origem, etapa, status_17t, substatus_17t, categoria, titulo, acao, responsavel, imediato, contata_cliente, prioridade, ordem, observacao) VALUES
 -- A. Antes da movimentação física
 ('status_17t',1,'NotFound',NULL,'rastreio_nao_localizado','Rastreio não localizado ou indisponível','Conferir plataforma de venda e fulfillment 3 dias úteis após a compra.','Equipe interna de PPL',false,false,'P2',100,'PDF A. O prazo de 3 dias úteis é o da regra de tempo da etapa 1.'),
 ('status_17t',2,'InfoReceived',NULL,'etiqueta_sem_coleta','Etiqueta criada, sem coleta física confirmada','Conferir 2 dias úteis após a geração da etiqueta (regra de tempo da etapa 2).','Equipe interna de PPL',false,false,'P2',110,'PDF A. Etiqueta não é coleta: a cobrança fica com a fulfillment.'),
 -- B. Coletado e em trânsito
 ('status_17t',3,'InTransit','InTransit_PickedUp','em_transito_normal','Coleta registrada',NULL,'Equipe interna de PPL',false,false,'P3',200,'PDF B: não gera ação.'),
 ('status_17t',3,'InTransit','InTransit_Departure','em_transito_normal','Pacote saiu de uma unidade',NULL,'Equipe interna de PPL',false,false,'P3',210,'PDF B: não gera ação.'),
 ('status_17t',3,'InTransit','InTransit_Arrival','em_transito_normal','Pacote chegou a uma unidade',NULL,'Equipe interna de PPL',false,false,'P3',220,'PDF B: não gera ação.'),
 ('status_17t',3,'InTransit','InTransit_Other','em_transito_normal','Em transporte','Aplicar os prazos de 5, 10 e 15 dias sem movimentação relevante.','Equipe interna de PPL',false,false,'P3',230,'PDF B (InTransit): a ação vem das regras de tempo.'),
 ('status_17t',3,'InTransit','InTransit_CustomsProcessing','alfandega','Processamento alfandegário','Monitorar e verificar pendências sempre que houver esse status.','Equipe interna de PPL',false,false,'P3',240,'PDF B.'),
 ('status_17t',3,'InTransit','InTransit_CustomsRequiringInformation','alfandega','Alfândega exige informação ou documento','Agir imediatamente.','Equipe interna de PPL',true,false,'P1',250,'PDF B.'),
 ('status_17t',3,'InTransit','InTransit_CustomsReleased','alfandega','Liberação alfandegária','Retomar o monitoramento.','Equipe interna de PPL',false,false,'P3',260,'PDF B.'),
 ('status_17t',3,'Expired',NULL,'rastreio_expirado','Rastreamento expirado','Conferir sempre que houver esse status.','Equipe interna de PPL',false,false,'P2',270,'PDF B: rastreamento expirado ou sem atualização prolongada.'),
 -- C. Saída para entrega
 ('status_17t',4,'OutForDelivery',NULL,'saida_para_entrega','Saiu para entrega',NULL,'Equipe interna de PPL',false,false,'P3',300,'PDF C: não gera ação.'),
 ('status_17t',4,'AvailableForPickup',NULL,'retirada','Disponível para retirada','Contatar o cliente e informar que ele precisa retirar o pedido.','Equipe interna de PPL',false,true,'P2',310,'PDF C.'),
 ('status_17t',4,'DeliveryFailure','DeliveryFailure_InvalidAddress','falha_entrega','Endereço inválido ou insuficiente','Contatar o cliente e pedir confirmação do endereço correto.','Equipe interna de PPL',true,true,'P1',320,'PDF C.'),
 ('status_17t',4,'DeliveryFailure','DeliveryFailure_NoBody','falha_entrega','Destinatário ausente ou não localizado','Contatar o cliente, pedir confirmação do endereço e informar que um novo pedido será enviado no endereço confirmado.','Equipe interna de PPL',true,true,'P1',330,'PDF C.'),
 ('status_17t',4,'DeliveryFailure','DeliveryFailure_Rejected','falha_entrega','Entrega recusada','Contatar o cliente, perguntar o motivo da recusa e tentar negociar um novo envio.','Equipe interna de PPL',true,true,'P1',340,'PDF C.'),
 ('status_17t',4,'DeliveryFailure','DeliveryFailure_Security','falha_entrega','Entrega impedida por segurança ou acesso','Identificar a restrição, definir solução e contatar o cliente (novo endereço ou retirada nos correios).','Equipe interna de PPL',true,true,'P1',350,'PDF C.'),
 ('status_17t',4,'DeliveryFailure','DeliveryFailure_Other','falha_entrega','Falha de entrega (outro motivo)','Abrir ocorrência junto à transportadora e contatar o cliente se afetar a entrega.','Equipe interna de PPL',true,true,'P1',360,'Não consta no PDF; adicionada para cobrir o substatus genérico do 17TRACK.'),
 -- D. Exceções e ocorrências críticas (ação imediata, sem esperar 5/10/15 dias)
 ('status_17t',4,'Exception','Exception_Delayed','excecao_grave','Atraso informado','Solicitar motivo e nova previsão; informar o cliente do atraso; escalar conforme a gravidade.','Equipe interna de PPL',true,true,'P1',400,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Rejected','excecao_grave','Recusa ou rejeição','Confirmar a causa, perguntar o motivo ao cliente e tentar negociar um novo envio.','Equipe interna de PPL',true,true,'P1',410,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Returning','excecao_grave','Pacote em devolução','Investigar a causa e avaliar opções; contatar o cliente.','Equipe interna de PPL',true,true,'P1',420,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Returned','excecao_grave','Pacote devolvido','Confirmar o recebimento e definir a solução; contatar o cliente.','Equipe interna de PPL',true,true,'P1',430,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Damage','excecao_grave','Pacote danificado','Solicitar evidências e avaliar reenvio ou solução conforme a política (reenvio exige autorização da gestão).','Equipe interna de PPL',true,true,'P0',440,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Lost','excecao_grave','Pacote perdido','Investigar com prioridade e avaliar a solução autorizada; informar o cliente.','Equipe interna de PPL',true,true,'P0',450,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Destroyed','excecao_grave','Pacote destruído ou inutilizado','Confirmar e avaliar reenvio ou reembolso conforme a política.','Equipe interna de PPL',true,true,'P0',460,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Cancel','excecao_grave','Envio ou operação cancelada','Identificar a causa e verificar nova expedição.','Equipe interna de PPL',true,true,'P1',470,'PDF D.'),
 ('status_17t',4,'Exception','Exception_NoBody','excecao_grave','Destinatário ausente','Conferir o evento e combinar nova tentativa ou solução com o cliente.','Equipe interna de PPL',true,true,'P1',480,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Security','excecao_grave','Impedimento de segurança','Investigar e liberar ou redirecionar; contatar o cliente (novo endereço ou retirada).','Equipe interna de PPL',true,true,'P1',490,'PDF D.'),
 ('status_17t',4,'Exception','Exception_Other','excecao_grave','Exceção (outro motivo)','Abrir ocorrência junto à transportadora e avaliar o contato com o cliente.','Equipe interna de PPL',true,false,'P1',495,'Não consta no PDF; adicionada para cobrir o substatus genérico do 17TRACK.'),
 ('status_17t',4,'Delivered','Delivered_Contestado','entregue_contestado','Entregue, mas o cliente contesta','Solicitar comprovante de entrega à transportadora e investigar; informar o cliente.','Equipe interna de PPL',true,true,'P1',500,'PDF D (Delivered + contestação). Não é substatus do 17TRACK: a contestação vem do ticket do cliente e o motor cria a ocorrência.')
;

END IF; END $seed$;
