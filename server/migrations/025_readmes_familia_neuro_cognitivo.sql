-- ═══════════════════════════════════════════════════════════════════════════
--  025 · produto_readmes da Família 1 — Neuro/Cognitivo (Regra 7 do documento)
--
--  "Nenhuma família entra no ar sem o campo 'Produtos IA' preenchido para os
--  produtos envolvidos" — 6 dos 7 produtos estavam vazios. Conteúdo baseado
--  no MUP/MUS levantado na Seção 9 do documento do funil, com as mesmas
--  ressalvas que já valiam pra copy da régua (migração 022):
--
--   • NeuroPulsePro é Neuropatia, não Memória — não herda linguagem de
--     Bacopa/alecrim dos demais.
--   • Cognizil cita só o tema comum entre as 5 ofertas (acetilcolina/
--     mensageiros químicos), nunca o mel de cedro/flor de ervilha de uma
--     única VSL.
--   • Memovance PRO é o único com linguagem de "reversão" no MUS original —
--     o readme INSTRUI a IA a nunca herdar essa promessa (mesma blindagem
--     jurídica da Seção 7 do documento).
--   • MindTrex tem só 1 oferta — é seguro citar o mecanismo específico.
--   • NeuroRecallPro e Mind Honey 60 Pro não aparecem no catálogo de ofertas
--     de afiliados (achado crítico da Seção 9) — readme deliberadamente
--     genérico, sem inventar composto/mecanismo.
--
--  `produto` é o NOME oficial (não o slug) — é assim que a tabela é lida
--  (ver api/rotas/visaoGeral.js:220). Garantia mencionada de forma
--  multi-plataforma, não um número fixo — mesma razão da migração 024
--  (JVZoo 60d / DigiStore24 180d / BuyGoods 60d).
--
--  NeuroMind Pro já tinha readme (bem resumido) — não mexido aqui, fica pra
--  quem cuida do catálogo decidir se quer enriquecer no mesmo padrão.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'NeuroPulse Pro',
  $r$NeuroPulse Pro — suplemento em cápsulas focado em NEUROPATIA (desconforto, formigamento e sensibilidade nervosa), não em memória/cognição. Não usar linguagem de "memória", "foco" ou Bacopa/alecrim para este produto — é o único produto da família com narrativa de nervo/sensibilidade, e cruzar essa linguagem contradiz o que o cliente viu na oferta que comprou.

Uso: 2 cápsulas ao dia, no mesmo horário, preferencialmente com uma refeição — isso favorece absorção constante.

Expectativa: é um suporte nutricional de ação gradual, não um alívio imediato. Não prometer resultado individual nem prazo exato — a formulação é estudada para apoiar função e conforto nervoso ao longo do tempo, com efeito cumulativo relatado por muitos usuários entre a 3ª e a 6ª semana de uso consistente.

Garantia: varia pela plataforma de compra — JVZoo 60 dias, Digistore24 180 dias, BuyGoods 60 dias. Confirme a plataforma do pedido antes de informar o prazo exato ao cliente; nunca dificultar ou atrasar um pedido de reembolso legítimo.

Nunca afirmar cura ou reversão de neuropatia — sempre em termos de "suporte" e "observação de padrão" (compliance FTC Dietary Supplement Advertising Guide).$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'Cognizil',
  $r$Cognizil — suplemento em cápsulas da família Memória/Cognitivo. Tema recorrente entre as 5 ofertas ativas do produto: suporte aos mensageiros químicos da memória (acetilcolina) e proteção da absorção — NÃO citar o mecanismo específico de uma única oferta (ex. mel de cedro do Himalaia, flor de ervilha borboleta, tecnologia "NeuroCoat"), porque o produto tem múltiplas VSLs com narrativas diferentes e a IA não sabe qual delas o cliente específico viu.

Uso: 1-2 cápsulas ao dia, no mesmo horário, com alimento — consistência de horário é o fator que mais afeta o resultado percebido.

Expectativa: efeito gradual, não imediato. A maioria dos usuários consistentes relata diferença entre a 3ª e a 6ª semana — nunca prometer resultado individual, é observação de padrão.

Garantia: varia pela plataforma de compra — JVZoo 60 dias, BuyGoods 60 dias (Digistore24 quando aplicável, 180 dias). Confirme a plataforma do pedido antes de informar prazo exato.

Nunca prometer resultado específico de memória (ex. "vai lembrar tudo") — só padrão populacional observado.$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'Memovance Pro',
  $r$Memovance Pro — suplemento em cápsulas da família Memória/Cognitivo, vendido só via JVZoo (4 ofertas ativas).

ATENÇÃO — restrição de linguagem: a VSL original deste produto usa linguagem de "reversão" do problema (inflamação/proteína tau). NUNCA herdar essa promessa em respostas de suporte — dizer que o produto "reverte", "cura" ou "desfaz" qualquer condição viola o FTC Dietary Supplement Advertising Guide citado no Vendor Agreement do JVZoo. Falar sempre em "suporte" e "observação de padrão".

Uso: cápsulas ao dia, no mesmo horário, com alimento, de forma consistente.

Expectativa: efeito gradual. A maioria dos usuários consistentes relata diferença entre a 3ª e a 6ª semana de uso — nunca prometer resultado individual.

Garantia: JVZoo, 60 dias a partir da data da compra. Nunca dificultar ou atrasar um pedido de reembolso legítimo.$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'MindTrex',
  $r$MindTrex — fórmula em pó da família Memória/Cognitivo, com uma única oferta ativa (JVZoo + Digistore24) — por isso, ao contrário dos demais produtos da família, é seguro citar o mecanismo específico da oferta (não há risco de contradizer outra VSL que o cliente tenha visto).

Mecanismo: fórmula em pó ("ritual de café de 7 segundos") formulada para apoiar a neutralização de flúor acumulado e a reposição de acetilcolina, com atuação via NGF (fator de crescimento neural). Falar sempre como "apoio"/"suporte", nunca como remoção garantida ou cura.

Uso: um pacote/dose ao dia, misturado à bebida (café ou similar), no mesmo horário, de forma consistente.

Expectativa: efeito gradual. A maioria dos usuários consistentes relata diferença entre a 3ª e a 6ª semana — nunca prometer resultado individual.

Garantia: varia pela plataforma de compra — JVZoo 60 dias, Digistore24 180 dias. Confirme a plataforma do pedido antes de informar o prazo exato.$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'NeuroRecall Pro',
  $r$NeuroRecall Pro — suplemento da família Memória/Cognitivo. IMPORTANTE: este produto não aparece no catálogo de ofertas do sistema de afiliados (app.thenorthscales.com/produtos) apesar de ter pedidos reais registrados — não há MUP/MUS confirmado. NÃO inventar composto, mecanismo específico ou nome de ingrediente para este produto: usar só linguagem genérica de suporte à memória e clareza mental, no mesmo padrão comum dos demais produtos da família (ex. "suporte aos mensageiros químicos da memória"), sem citar um composto exclusivo.

Uso: conforme instrução da embalagem, no mesmo horário todos os dias, com alimento.

Expectativa: efeito gradual, não imediato — nunca prometer resultado individual, só observação de padrão populacional (ex. "a maioria relata diferença entre a 3ª e a 6ª semana").

Garantia: varia pela plataforma de compra — JVZoo 60 dias, Digistore24 180 dias, BuyGoods 60 dias. Confirme a plataforma do pedido antes de informar o prazo exato.

Pendência: confirmar com o responsável pelo catálogo por que este produto não está no sistema de afiliados — pode liberar um MUP/MUS próprio no futuro.$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();

INSERT INTO produto_readmes (produto, readme, ativo) VALUES (
  'MindHoney 60 Pro',
  $r$MindHoney 60 Pro — suplemento da família Memória/Cognitivo (Digistore24 + BuyGoods). IMPORTANTE: este produto não aparece no catálogo de ofertas do sistema de afiliados apesar de ter pedidos reais registrados — não há MUP/MUS confirmado. NÃO inventar composto, mecanismo específico ou nome de ingrediente para este produto: usar só linguagem genérica de suporte à memória e clareza mental, no mesmo padrão comum dos demais produtos da família, sem citar um composto exclusivo.

Uso: conforme instrução da embalagem, no mesmo horário todos os dias, com alimento.

Expectativa: efeito gradual, não imediato — nunca prometer resultado individual, só observação de padrão populacional (ex. "a maioria relata diferença entre a 3ª e a 6ª semana").

Garantia: varia pela plataforma de compra — Digistore24 180 dias, BuyGoods 60 dias. Confirme a plataforma do pedido antes de informar o prazo exato.

Pendência: confirmar com o responsável pelo catálogo por que este produto não está no sistema de afiliados — pode liberar um MUP/MUS próprio no futuro.$r$,
  true
) ON CONFLICT (produto) DO UPDATE SET readme = EXCLUDED.readme, atualizado_em = now();
