-- ═══════════════════════════════════════════════════════════════════════════
--  028 · Alertas por e-mail, opt-in por usuário
--
--  Pedido do usuário (11/09/2026): notificar por e-mail quem aceitar, quando
--  surgir um caso de foto com defeito, e-mail urgente sem resposta, novo caso
--  escalado, chargeback ou reembolso. Granular por tipo — cada pessoa escolhe
--  o que quer receber, ninguém é inscrito por padrão.
--
--  `painel_alertas_enviados` existe pra nunca mandar o mesmo alerta duas
--  vezes nem perder um se o processo reiniciar entre duas checagens — o
--  checador (a cada 5 min) só considera "novo" o que não está aqui ainda.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS painel_alertas_preferencia (
  usuario_id  bigint  NOT NULL REFERENCES painel_usuarios(id) ON DELETE CASCADE,
  -- 'foto_defeito' | 'email_urgente' | 'caso_escalado' | 'chargeback' | 'reembolso'
  tipo        text    NOT NULL,
  ativo       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (usuario_id, tipo)
);

CREATE TABLE IF NOT EXISTS painel_alertas_enviados (
  tipo        text        NOT NULL,
  -- id do registro de origem (anexo, e-mail, caso escalado ou disparo),
  -- sempre como texto pra caber qualquer tipo de chave primária.
  chave       text        NOT NULL,
  enviado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, chave)
);

COMMENT ON TABLE painel_alertas_preferencia IS 'O que cada usuário decidiu receber por e-mail. Sem linha = não recebe (default seguro).';
COMMENT ON TABLE painel_alertas_enviados IS 'Marca de "já notificado" por tipo+registro de origem — evita duplicar e sobrevive a reinício do processo.';

-- ═══════════════════════════════════════════════════════════════════════
--  Pré-carga do backlog — CRÍTICO, não pular.
--
--  No dia em que esta migration roda, já existem 62 fotos com defeito,
--  2.150 e-mails urgentes sem resposta, 293 casos escalados pendentes,
--  3 chargebacks e 1.831 reembolsos no banco (medido em 11/09/2026). Sem
--  isto, a PRIMEIRA pessoa que ativar qualquer um desses alertas em "Meu
--  Perfil" receberia um e-mail com todo esse histórico de uma vez — o
--  checador (`api/rotas/alertas.js`) só sabe que algo é "novo" pela
--  ausência aqui. Marcando tudo que já existe HOJE como "já enviado", só o
--  que surgir A PARTIR DE AGORA gera e-mail de verdade.
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO painel_alertas_enviados (tipo, chave)
  SELECT 'foto_defeito', a.id::text
  FROM email_ia.anexos a
  WHERE a.defeito_visivel = true
UNION ALL
  SELECT 'email_urgente', e.id::text
  FROM email_ia.emails e
  WHERE e.pede_resposta = true AND e.urgencia = 'alta'
    AND e.resposta_enviada_em IS NULL AND e.plataforma_origem IS NULL
UNION ALL
  SELECT 'caso_escalado', s.id::text
  FROM email_ia.suporte_escalado s
  WHERE s.status = 'pendente'
UNION ALL
  SELECT 'chargeback', 'dpv:' || id::text FROM disparos_pos_venda WHERE chargeback_em IS NOT NULL
UNION ALL
  SELECT 'chargeback', 'cud:' || id::text FROM compras_upsell_downsell WHERE chargeback_em IS NOT NULL
UNION ALL
  SELECT 'reembolso', 'dpv:' || id::text FROM disparos_pos_venda WHERE reembolsado_em IS NOT NULL AND chargeback_em IS NULL
UNION ALL
  SELECT 'reembolso', 'cud:' || id::text FROM compras_upsell_downsell WHERE reembolsado_em IS NOT NULL AND chargeback_em IS NULL
ON CONFLICT (tipo, chave) DO NOTHING;
