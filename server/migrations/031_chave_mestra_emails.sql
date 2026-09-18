-- ═══════════════════════════════════════════════════════════════════════════
--  031 · Chave mestra dos e-mails/SMS automáticos de pós-venda
--
--  Pedido (18/09/2026): o Postmark foi adicionado como SMTP mas ainda não
--  foi pago, então NENHUM e-mail/SMS automático de pós-venda pode sair por
--  enquanto. Os 3 fluxos "Reporting" (BuyGoods/JVZoo/Digistore) continuam
--  ligados só pra REGISTRAR as vendas novas em `disparos_pos_venda`.
--
--  `config_disparos.emails_automaticos_ativo` é o interruptor único:
--    'false' (padrão) → nada sai: nem recibo (etapa -1, e-mail e SMS), nem
--                       e-mail de Área VIP (etapa 900), nem recibo completo
--                       (etapa 901). A venda continua sendo gravada.
--    'true'           → os 3 canais laterais dos Reporting voltam a enviar.
--
--  Cada fluxo Reporting lê esta chave logo depois do INSERT da venda e antes
--  de qualquer nó de envio (`emailSend`/Twilio). O `Processador de
--  Disparos` (régua por tempo) NÃO lê esta chave: ele segue controlado só
--  pelo liga/desliga do próprio fluxo no n8n — continua desativado.
--
--  Ligar (só depois de pagar o Postmark e testar):
--    UPDATE config_disparos SET valor = 'true' WHERE chave = 'emails_automaticos_ativo';
--  Desligar de novo:
--    UPDATE config_disparos SET valor = 'false' WHERE chave = 'emails_automaticos_ativo';
--
--  Só dado — segura de aplicar a qualquer hora, sem reimportar fluxo.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO config_disparos (chave, valor) VALUES ('emails_automaticos_ativo', 'false')
ON CONFLICT (chave) DO NOTHING;
