-- ═══════════════════════════════════════════════════════════════════════════
--  039 · Área VIP de RetraBurn, EvoSlim e Thermo Burn Pro
--
--  Pedido (19/09/2026): os produtos da linha 5 também têm Área VIP. Mesmo desenho da migração 036:
--  o link mora em produtos.area_vip_url e o e-mail D0 do produto (etapa 20 da linha 5) ganha um
--  parágrafo com o link, como cópia POR PRODUTO da copy '*' (o Processador prefere a do produto).
--  GlycoEden já tinha o link (030/036); repetido aqui só pra garantir, sem efeito se já estiver igual.
--  Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE produtos SET area_vip_url = 'https://getretraburn.com/area-vip/'  WHERE slug = 'retraburn';
UPDATE produtos SET area_vip_url = 'https://getevoslimpro.com/area-vip/' WHERE slug = 'evoslim';
UPDATE produtos SET area_vip_url = 'https://getthermoburn.com/area-vip/' WHERE slug = 'thermoburnpro';
UPDATE produtos SET area_vip_url = 'https://getglycoeden.com/area-vip/'  WHERE slug = 'glycoeden';

INSERT INTO mensagens_regua (etapa, canal, linha, produto, assunto, corpo_html, botao, destino, texto, ativo)
SELECT m.etapa, m.canal, m.linha, v.slug, m.assunto,
       m.corpo_html || E'\n<p>Your order also includes access to the <b>' || v.nome
         || ' VIP Area</b> — exclusive content to help you get the most out of it. <a href="' || v.url
         || '">Open my VIP Area</a>.</p>',
       m.botao, m.destino,
       m.texto || ' [+ link da Área VIP no corpo]', true
FROM (VALUES ('retraburn',     'RetraBurn',       'https://getretraburn.com/area-vip/',  '5', 20),
             ('evoslim',       'EvoSlim',         'https://getevoslimpro.com/area-vip/', '5', 20),
             ('thermoburnpro', 'Thermo Burn Pro', 'https://getthermoburn.com/area-vip/', '5', 20)) AS v(slug, nome, url, linha, etapa)
JOIN mensagens_regua m
  ON m.linha = v.linha AND m.etapa = v.etapa AND m.produto = '*' AND m.canal = 'email'
ON CONFLICT (etapa, canal, linha, produto) DO NOTHING;

-- ── trava: os 3 produtos precisam ter link e cópia do D0 ─────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM produtos
   WHERE slug IN ('retraburn', 'evoslim', 'thermoburnpro') AND area_vip_url LIKE 'https://%/area-vip/';
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 produtos com Área VIP, achei % — nada foi aplicado.', n; END IF;
  SELECT count(*) INTO n FROM mensagens_regua
   WHERE produto IN ('retraburn', 'evoslim', 'thermoburnpro') AND etapa = 20 AND canal = 'email';
  IF n <> 3 THEN RAISE EXCEPTION 'Esperava 3 cópias de D0 (etapa 20) com Área VIP, achei % — nada foi aplicado.', n; END IF;
END $$;

SELECT slug, area_vip_url FROM produtos WHERE area_vip_url IS NOT NULL ORDER BY slug;
