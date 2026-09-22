-- ═══════════════════════════════════════════════════════════════════════════
--  047 · Área VIP de Hawaiian Harmony, Horse Boost Gelatin e Horse Peak Gelatin
--
--  Pedido (22/09/2026): mesmo desenho da migração 039. O link mora em
--  produtos.area_vip_url e o e-mail D0 do produto (etapa da linha dele,
--  offset 0h — "Confirmação + orientação") ganha um parágrafo com o link,
--  como cópia POR PRODUTO da copy '*' (o Processador prefere a do produto).
--
--  Vigor Rock (4ª URL pedida, https://getvigorrock.com/area-vip/) FICOU DE
--  FORA desta migração: não existe linha em `produtos` pra ele — nenhum
--  pedido real passou pelo webhook ainda (funil em aprovação de plataforma /
--  BuyGoods com account_id placeholder), então a linha (família de copy)
--  dele nunca foi decidida. Aplicar depois, quando o primeiro pedido criar
--  o produto, ou antes disso se o Lucas decidir a família adiantado.
--
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE produtos SET area_vip_url = 'https://gethawaiianharmony.com/area-vip/'   WHERE slug = 'hawaiianharmony';
UPDATE produtos SET area_vip_url = 'https://gethorseboostgelatin.com/area-vip/' WHERE slug = 'horseboostgelatin';
UPDATE produtos SET area_vip_url = 'https://gethorsepeakgelatin.com/area-vip/'  WHERE slug = 'horsepeakgelatin';

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT m.etapa, m.canal, m.linha, v.slug, m.assunto,
       m.corpo_html || E'\n<p>Your order also includes access to the <b>' || v.nome
         || ' VIP Area</b> — exclusive content to help you get the most out of it. <a href="' || v.url
         || '">Open my VIP Area</a>.</p>',
       m.botao, m.destino,
       m.texto || ' [+ link da Área VIP no corpo]', true
FROM (VALUES ('hawaiianharmony',   'Hawaiian Harmony',    'https://gethawaiianharmony.com/area-vip/',   '6', 30),
             ('horseboostgelatin', 'Horse Boost Gelatin', 'https://gethorseboostgelatin.com/area-vip/', '7', 40),
             ('horsepeakgelatin',  'Horse Peak Gelatin',  'https://gethorsepeakgelatin.com/area-vip/',  '7', 40)) AS v(slug, nome, url, linha, etapa)
JOIN mensagens_regua m
  ON m.linha = v.linha AND m.etapa = v.etapa AND m.produto = '*' AND m.canal = 'email'
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── trava: os 3 produtos precisam ter link e cópia do D0 ─────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM produtos
   WHERE slug IN ('hawaiianharmony', 'horseboostgelatin', 'horsepeakgelatin')
     AND area_vip_url LIKE 'https://%/area-vip/';
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 produtos com Área VIP, achei % — nada foi aplicado.', n; END IF;

  SELECT count(*) INTO n FROM mensagens_regua
   WHERE (produto = 'hawaiianharmony' AND etapa = 30 AND canal = 'email')
      OR (produto IN ('horseboostgelatin', 'horsepeakgelatin') AND etapa = 40 AND canal = 'email');
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 cópias de D0 com Área VIP, achei % — nada foi aplicado.', n; END IF;
END $$;

SELECT slug, area_vip_url FROM produtos WHERE area_vip_url IS NOT NULL ORDER BY slug;
