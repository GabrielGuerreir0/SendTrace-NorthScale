-- ═══════════════════════════════════════════════════════════════════════════
--  093 · SPPL — saúde (cota do 17TRACK, webhook parado, defasagem da Red Rock) numa função só
--
--  public.sppl_saude_problemas() devolve uma linha por problema ATIVO (codigo, gravidade, titulo, detalhe). É a fonte única: o cartão "Saúde do
--  SPPL" do painel e o alerta por e-mail (tipo `sppl_saude`) leem daqui. Sem problema = zero linhas.
--  A cota restante do 17TRACK é gravada em config_disparos (sppl_17track_cota_restante / _em) por quem consulta a API (job de registro e rotina
--  de reconciliação); a função só lê, nunca chama a rede.
--  Também: interruptor da reconciliação do 17TRACK (sppl_17track_reconciliar_ativo, nasce 'true': só consulta, não gasta cota).
--  Só adiciona (1 função, 3 chaves). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES
  ('sppl_17track_reconciliar_ativo', 'true'),
  ('sppl_17track_cota_restante', ''),
  ('sppl_17track_cota_restante_em', '')
ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION public.sppl_saude_problemas()
RETURNS TABLE (codigo text, gravidade text, titulo text, detalhe text) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_cota int; v_cota_em timestamptz; v_reserva int;
  v_em_transito int; v_ultimo_webhook timestamptz;
  v_ultima_consulta timestamptz; v_abertos int; v_defasados int; v_sem_atualizacao int;
BEGIN
  -- 1) cota do 17TRACK baixa (só se foi lida nos últimos 3 dias)
  SELECT nullif(valor, '')::int INTO v_cota FROM config_disparos WHERE chave = 'sppl_17track_cota_restante';
  SELECT nullif(valor, '')::timestamptz INTO v_cota_em FROM config_disparos WHERE chave = 'sppl_17track_cota_restante_em';
  SELECT coalesce(nullif(valor, '')::int, 20) INTO v_reserva FROM config_disparos WHERE chave = 'sppl_17track_cota_reserva';
  IF v_cota IS NOT NULL AND v_cota_em > now() - interval '3 days' AND v_cota <= greatest(coalesce(v_reserva, 20) * 3, 50) THEN
    codigo := 'cota_baixa'; gravidade := CASE WHEN v_cota <= coalesce(v_reserva, 20) THEN 'alta' ELSE 'media' END;
    titulo := 'Cota do 17TRACK baixa'; detalhe := 'Restam ' || v_cota || ' registros. Ao chegar na reserva o registro automático para; compre um pacote.';
    RETURN NEXT;
  END IF;

  -- 2) webhook parado: há códigos em trânsito registrados e nenhum aviso do 17TRACK há mais de 48 h
  SELECT count(*) INTO v_em_transito FROM rastreio_17t_registros
   WHERE situacao_registro = 'aceito' AND coalesce(ultimo_status, '') NOT IN ('Delivered', 'Expired', 'NotFound');
  SELECT max(recebido_em) INTO v_ultimo_webhook FROM rastreio_17t_payloads WHERE origem = 'webhook';
  IF v_em_transito >= 5 AND (v_ultimo_webhook IS NULL OR v_ultimo_webhook < now() - interval '48 hours') THEN
    codigo := 'webhook_parado'; gravidade := 'alta'; titulo := 'O 17TRACK não avisa há mais de 48 horas';
    detalhe := v_em_transito || ' códigos em trânsito, último aviso: ' || coalesce(to_char(v_ultimo_webhook AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca')
            || '. Confira a URL do webhook no 17TRACK e a chave SEVENTEEN_TRACK_API_KEY.';
    RETURN NEXT;
  END IF;

  -- 3) reconciliação da Red Rock sem rodar (a rede de segurança contra a defasagem de status)
  SELECT count(*), max(ultima_consulta_em) INTO v_abertos, v_ultima_consulta FROM rastreio_pedidos
   WHERE provedor = 'redrock' AND status_interno IN ('pending', 'shipped');
  IF v_abertos >= 50 AND (v_ultima_consulta IS NULL OR v_ultima_consulta < now() - interval '6 hours') THEN
    codigo := 'reconciliacao_redrock_parada'; gravidade := 'alta'; titulo := 'A reconsulta da Red Rock não roda há mais de 6 horas';
    detalhe := 'Última: ' || coalesce(to_char(v_ultima_consulta AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca') || '. Confira o cron reconciliar_abertos.py no servidor.';
    RETURN NEXT;
  END IF;

  -- 4) pedidos pending há mais de 48 h que ninguém reconsultou há 24 h (defasagem acumulando)
  SELECT count(*) INTO v_defasados FROM rastreio_pedidos
   WHERE provedor = 'redrock' AND status_interno = 'pending' AND order_created_at < now() - interval '48 hours'
     AND (ultima_consulta_em IS NULL OR ultima_consulta_em < now() - interval '24 hours');
  IF v_defasados >= 20 THEN
    codigo := 'pendentes_defasados'; gravidade := 'media'; titulo := v_defasados || ' pedidos pending sem reconsulta há mais de 24 h';
    detalhe := 'Podem já ter sido enviados na Red Rock. Rode reconciliar_abertos.py --rotina --commit.';
    RETURN NEXT;
  END IF;

  -- 5) códigos registrados que o 17TRACK não atualiza há 3 dias (e não estão entregues)
  SELECT count(*) INTO v_sem_atualizacao FROM rastreio_17t_registros
   WHERE situacao_registro = 'aceito' AND coalesce(ultimo_status, '') NOT IN ('Delivered', 'Expired') AND atualizado_em < now() - interval '3 days';
  IF v_sem_atualizacao >= 50 THEN
    codigo := 'registros_sem_atualizacao'; gravidade := 'media'; titulo := v_sem_atualizacao || ' códigos sem atualização do 17TRACK há 3 dias';
    detalhe := 'A reconciliação diária deveria reconsultá-los. Confira se ela está ligada (sppl_17track_reconciliar_ativo).';
    RETURN NEXT;
  END IF;
  RETURN;
END $$;
