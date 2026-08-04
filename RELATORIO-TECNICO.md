# SendTrace — Relatório técnico da arquitetura, API e front-end

> Documento de referência do sistema: o que cada serviço faz, todas as rotas HTTP,
> de onde cada dado é puxado e como o front-end consome tudo isso.

---

## 1. Visão geral da arquitetura

O repositório contém **três aplicações** que conversam entre si, mais duas peças externas:

```
                         ┌──────────────────────────┐
  navegador ──────────►  │  PAINEL (server/, :4300) │ ──────►  ┌─────────────────────────┐
  (public/ – HTML/JS)    │  BFF: sessão por cookie, │   JWT    │  API SendTrace          │
                         │  agregações, proxy       │          │  (api/, Fastify, :4400) │
                         └────────────┬─────────────┘          └───────────┬─────────────┘
                                      │ webhook (x-token)                  │ SQL (pg)
                                      ▼                                    ▼
                              ┌──────────────┐                    ┌────────────────┐
                              │     n8n      │ ─── escreve ─────► │   PostgreSQL   │
                              │ (envia e-mail│      a fila        │ disparos_pos_  │
                              │  e SMS)      │                    │ venda + régua  │
                              └──────────────┘                    └────────────────┘
                                                                           ▲
                              ┌──────────────────────┐                     │
                              │ Chatbot de suporte   │ ── Bearer (token ───┘
                              │ (NorthSupportCB,     │     de serviço)
                              │  Next.js)            │   via API :4400
                              └──────────────────────┘
```

- **`api/` — a API SendTrace** (Fastify, porta 4400): a única camada que fala SQL com o Postgres. CRUD + métricas + autenticação JWT. Documentada em OpenAPI/Swagger.
- **`server/` — o servidor do painel** (Node `http` puro, porta 4300): o *backend-for-frontend*. Autentica o usuário contra a API, guarda os tokens **só no servidor** (o navegador nunca vê JWT), baixa a fila da API e calcula todas as agregações do painel em JavaScript, e serve os arquivos estáticos de `public/`.
- **`public/` — o front-end** (HTML + ES modules, sem framework e sem build): duas abas — *Suporte IA* e *Régua de pós-venda* — que consomem exclusivamente as rotas do painel (`:4300`), nunca a API `:4400` diretamente.
- **n8n** (externo): quem de fato envia os e-mails/SMS e escreve a fila `disparos_pos_venda`. O painel só fala com ele num ponto: o webhook de troca de linha de copy.
- **Chatbot de suporte** (`NorthSupportCB/`, Next.js): consome a API `:4400` com um token de serviço fixo para ler pedidos/readmes e gravar atendimentos, CSAT e perguntas sem resposta.

**Ponto arquitetural central:** o processo do painel **não abre conexão com o banco** em runtime — tudo entra pela API. O Postgres só é tocado diretamente pela API (`api/`) e pelos CLIs de manutenção (`npm run setup`, `npm run senha`).

---

## 2. A API SendTrace (`api/`)

### 2.1 Stack e subida

- **Fastify 5** (ESM) com `@fastify/jwt`, `@fastify/swagger` e `@fastify/swagger-ui`.
- Sobe com `npm run api` (`api/servidor.js`); porta `API_PORT` (padrão **4400**), host `API_HOST` (padrão `127.0.0.1`; `0.0.0.0` no Docker, publicado só em `127.0.0.1:4400`).
- Pool Postgres compartilhado (`server/db.js`), via `DATABASE_URL`.
- `API_JWT_SEGREDO` é **obrigatório** (mínimo 32 caracteres) — sem ele o processo não sobe.
- Documentação viva: **Swagger UI em `/api/docs`** e contrato OpenAPI em **`GET /api/schema/`** (também é o healthcheck do Docker, porque não toca o banco). Os schemas de `api/esquemas.js` são simultaneamente validação de runtime e fonte do OpenAPI.

### 2.2 Autenticação

Dois caminhos, ambos pelo header `Authorization: Bearer <token>`:

1. **JWT de usuário** — `POST /api/auth/token/` com `{email, password}` devolve `{access, refresh}`. O *access* expira em `API_ACCESS_MIN` minutos (60) e carrega `{user_id, email, nome, admin}`; o *refresh* expira em `API_REFRESH_H` horas (12) e carrega só o id — na renovação o usuário é **relido do banco**, então rebaixar/desativar uma conta vale imediatamente.
2. **Token de serviço** (`API_TOKEN_SERVICO`) — token fixo comparado em tempo constante, usado pelo chatbot. Nunca é admin: lê tudo, mas só escreve resumo de chat, atendimento, pergunta sem resposta e CSAT.

**Autorização:** qualquer conta ativa **lê**; só **admin escreve** o que chega a cliente real (mensagens, etapas, linhas, fila). Erros saem sempre como `{detail: "..."}`; listas saem paginadas no envelope `{count, next, previous, results}` com `?page=` e `?page_size=` (teto 500).

**Defesas:** atraso fixo de 260 ms em falha de login (anti-timing); filtros e `ORDER BY` só por whitelist de colunas (anti-injeção); `bodyLimit` de 512 KB; log sem corpo de requisição; códigos de erro do Postgres traduzidos para mensagens genéricas (409), com detalhe só sob `API_ERROS_DETALHADOS=true`.

### 2.3 Rotas (72 no total)

**Saúde (públicas)**

| Rota | O que faz |
|---|---|
| `GET /api/schema/` | contrato OpenAPI em JSON |
| `GET /api/health/` | `{status, database, latencia_ms}` — faz `SELECT 1` |

**Acesso** (`api/rotas/acesso.js` → tabela `painel_usuarios`)

| Rota | Auth | O que faz |
|---|---|---|
| `POST /api/auth/token/` | pública | login → `{access, refresh}` |
| `POST /api/auth/token/refresh/` | pública | renova o par relendo o usuário do banco |
| `POST /api/auth/senha/` | sessão | troca a própria senha |
| `GET /api/usuarios/` | admin | lista paginada (busca, ordenação, filtros `ativo`/`admin`) |
| `GET /api/usuarios/:id/` | sessão | perfil (não-admin só vê a própria conta) |
| `GET /api/usuarios/eu/` | sessão | o dono do token |
| `POST /api/usuarios/` | admin | cria usuário (409 em e-mail duplicado) |
| `PATCH /api/usuarios/:id/` | admin | `admin`/`ativo`/senha provisória; impede rebaixar a si mesmo ou zerar admins |

**Fila** (`api/rotas/fila.js` → tabela `disparos_pos_venda`)

| Rota | Auth | O que faz |
|---|---|---|
| `GET /api/disparos/` | sessão | lista paginada com filtros (`status`, `transacao_id`, `etapa_atual`, faixas de data, `produto`, `plataforma`, `search`) — **é a rota que alimenta quase todo o painel** |
| `GET /api/disparos/:id/` | sessão | um pedido |
| `GET /api/disparos/pendentes/` | sessão | `status='ativo'` com `proximo_disparo <= now()` (fila de trabalho do robô) |
| `PUT /api/disparos/chat/` | sessão/serviço | grava `chat_resumo` por `transacao_id` ou e-mail |
| `POST/PUT/PATCH/DELETE /api/disparos/…` | admin | CRUD completo |

**Régua e copy** (`api/rotas/regua.js`)

| Rota | Tabela | O que faz |
|---|---|---|
| `GET/POST/PUT/PATCH/DELETE /api/etapas/…` | `etapas_regua` | cadência: `etapa, nome, espera_h, offset_h, ativo` |
| `GET/POST/PUT/PATCH/DELETE /api/mensagens/…` | `mensagens_regua` | copy por PK composta `etapa:canal:linha` (ex.: `1:email:2`); escrita é UPSERT; em SMS, assunto/corpo/botão são forçados a NULL |
| `GET/POST/PATCH/DELETE /api/linhas-copy/…` | `painel_linhas_copy` | as linhas de copy (nome, intuito, ordem) |
| `POST /api/linhas-copy/:linha/copiar/` | + `mensagens_regua` | cria linha nova clonando as mensagens de outra (transação) |
| `GET/PUT /api/linha-ativa/` | `config_disparos` + `painel_linha_mensagens` | qual linha está no ar e quem trocou |
| `GET/POST /api/linha-historico/` | `painel_linha_historico` | histórico de trocas |
| `GET/POST/PUT/PATCH/DELETE /api/config/…` | `config_disparos` | pares chave/valor |

**Produtos IA** (`api/rotas/produtos.js` → `produto_readmes`): CRUD por nome de produto — o "conhecimento" que o chatbot injeta no próprio prompt. Leitura com sessão (o bot usa), escrita admin.

**Suporte** (`api/rotas/atendimentos.js`)

| Rota | O que faz |
|---|---|
| `GET /api/atendimentos/` | conversas por `transacao_id` e/ou `email` (obrigatório pelo menos um) |
| `POST /api/atendimentos/` | grava a conversa (resumo, motivo, desfecho, reembolso, duração…), resolve o tópico em `chat_topicos` e espelha o resumo em `disparos_pos_venda` |
| `POST /api/atendimentos/csat/` | anexa CSAT 1–5 à conversa das últimas 24 h |
| `GET /api/atendimentos/painel/` | drill-down com filtros (`dias`, `motivo`, `resolvido`, `reembolso`, `com_csat`, `produto`, `plataforma`) |
| `GET /api/topicos/` | vocabulário de motivos com contagem |
| `GET /api/atendimentos/motivos/` | ranking cru de motivos |
| `POST /api/perguntas-sem-resposta/` | backlog da base de conhecimento (até 20 por chamada) |

**Métricas** (`api/rotas/metricas.js` — todas com sessão; aceitam `produto`/`plataforma`)

| Rota | O que devolve |
|---|---|
| `GET /api/metricas/estados/` | contadores dos 6 estados + `na_regua`, `com_erro`, `novos_24h`, `prestes` |
| `GET /api/metricas/etapas/` | resumo por etapa (`na_etapa`, `proximo_em`…) |
| `GET /api/metricas/produtos/` · `plataformas/` | catálogos dos seletores |
| `GET /api/metricas/status/` | distribuição crua da coluna `status` |
| `GET /api/metricas/onda/` | disparos agendados por hora (48 h) |
| `GET /api/metricas/entradas/` | pedidos novos por dia (fuso `TZ_PAINEL`) |
| `GET /api/metricas/canais/` | alcance por canal (alcançável × sem contato × com erro) |
| `GET /api/metricas/alertas/` | pedidos com erro, travados ou vencidos |
| `GET /api/metricas/suporte/` | o pacote da aba Suporte IA: KPIs (resolution rate, refund save rate, taxa de reembolso, utilização), motivos, perguntas, régua e tendências 24 h × 24 h |
| `GET /api/metricas/cadencia/` | mediana real de agendamento por etapa vs. configurado |

**Vocabulário SQL compartilhado** (`api/sql.js`): o `CASE` que classifica cada pedido em **um** de 6 estados mutuamente exclusivos (`em_dia`, `atrasado`, `processando`, `travado` — processando há mais de `LOCK_TIMEOUT_MIN` —, `finalizado`, `cancelado`); a normalização de nome de produto (tira código de oferta, embalagem e preço, para "M3 - NeuroMind Pro (6 Bottles)" e "UP1 - …" contarem juntos); e a dedução do canal do erro pelo prefixo de `ultimo_erro`.

---

## 3. O servidor do painel (`server/`)

### 3.1 Stack e papel

- **`node:http` puro**, sem framework; roteamento manual em `server/index.js`. Porta `PORT` (padrão **4300**).
- É um **BFF**: o navegador fala só com ele; ele fala com a API `:4400` levando o JWT do usuário logado (guardado na sessão do servidor e propagado por `AsyncLocalStorage` — nenhum token chega ao navegador).
- Serve os estáticos de `public/` com ETag/304 e trava de path traversal.

Arquivos principais:

| Arquivo | Papel |
|---|---|
| `index.js` | rotas, sessão/cookie, CSRF, snapshot, estáticos, tratador de erros |
| `api.js` | cliente da API: login, refresh automático em 401, paginação com teto `API_FILA_MAX` (flag `truncado`), timeout |
| `dados.js` | **todas as agregações** do painel, calculadas em JS sobre a fila baixada |
| `sessoes.js` | sessões **em memória** (Map por SHA-256 do cookie) — reiniciar o painel desloga todos |
| `linha.js` | troca de linha de copy via webhook n8n |
| `email.js` | convite por e-mail (Nodemailer), opcional |
| `etapas.config.js` | vocabulário fixo: canais, destinos, rótulos de status, os 6 estados |
| `setup.js` / `senha.js` / `auth.js` / `db.js` | CLIs de manutenção (migrações, senha de emergência) — únicos que tocam o Postgres |

### 3.2 Sessão e segurança

- Login: `POST /api/auth/login` repassa `{email, senha}` para a API; o painel **não guarda senha nem hash**. Cookie `painel_sessao`: `HttpOnly`, `SameSite=Strict`, `Secure` quando HTTPS, validade `SESSAO_HORAS` (12 h).
- **Anti-CSRF em duas camadas:** `SameSite=Strict` + header obrigatório `X-Painel: 1` em todo método ≠ GET.
- Freio de força bruta por IP (20 falhas/10 min → 429) + atraso fixo de 260 ms em falha.
- Senha provisória (`trocar_senha`) tranca o painel inteiro até ser trocada.
- Erros da API viram **502** com a explicação no corpo; 401/403 da API derrubam a sessão local.

### 3.3 Rotas do painel (o que o front chama)

| Método | Rota | Auth | O que faz |
|---|---|---|---|
| GET | `/api/vivo` | nenhuma | digital SHA-256 do código (confere versão do deploy) |
| POST | `/api/auth/login` · `logout` · `senha` | — /sessão | ciclo de sessão (proxy da API) |
| GET | `/api/auth/eu` | sessão | quem sou eu (roda antes de qualquer carga) |
| GET | `/api/snapshot` | sessão | **o pacote da aba Régua** (ver 3.4); aceita `etapa`, `canal`, `linha`, `produto`, `plataforma` |
| GET | `/api/pedidos` | sessão | tabela paginada com filtros (`etapa`, `estado` — inclui o pseudo-estado `na_regua` —, `canal`, `problema`, `q`, `ordem`, `limit≤200`) |
| GET | `/api/suporte` | sessão | KPIs, insights, motivos, perguntas e régua da aba Suporte IA |
| GET | `/api/suporte/conversas` | sessão | drill-down de conversas (filtros por KPI/motivo) |
| GET/PUT | `/api/mensagem/:linha/:etapa/:canal` | sessão/admin | ler/salvar copy — o PUT valida com `validarMensagem` **do mesmo arquivo `public/copy.js` servido ao navegador** (uma regra só, nos dois lados) |
| POST/PATCH/DELETE | `/api/linhas[…]` | admin | criar (com `copiarDe`), renomear e apagar linhas de copy |
| GET/POST | `/api/linha` | sessão/admin | linha no ar + **ativação via webhook n8n** |
| GET/POST/PATCH | `/api/usuarios[…]` | admin | gestão de contas (proxy da API + convite por e-mail + contagem de sessões) |
| GET/PUT/DELETE | `/api/produtos-ia[…]` | sessão/admin | readmes que a IA de suporte usa |
| GET | `/api/atendimentos` | sessão | linha do tempo do chatbot por transação/e-mail |
| GET | `/api/health` | sessão | latência da API (503 se caiu) |

### 3.4 O snapshot — o coração do painel

A API é CRUD (não agrega, exceto `/api/metricas/suporte/`), então **"medir a fila é baixá-la"**: `dados.js` baixa `GET /api/disparos/` inteira (com cache de processo de `API_CACHE_MS` = 4 s e teto `API_FILA_MAX` = 20 000 — passou do teto, a flag `truncado` faz o painel avisar na tela que os números descrevem uma parte).

Sobre essa fila, uma passada em JS calcula: rollup por etapa (15 contadores), onda de 48 h global e por etapa (12 baldes de 4 h), entradas por dia (14 dias, no fuso `TZ_PAINEL`), cadência observada (mediana de `proximo_disparo − criado_em`, para detectar deriva vs. a régua escrita), alcance por canal, pedidos sem mensagem cadastrada, pior caso de SMS (maior nome + maior produto da fila — a amostra que o front usa para medir segmentos), status bruto, alertas (top 25) e insights determinísticos (variação ≥ 30 % com volume mínimo — não é LLM).

O `GET /api/snapshot` junta tudo isso em um único JSON: `etapas[]`, `totais`, `linha {exibindo, ativa, resumo}`, `canais`, `destinos`, `porCanal`, `ondaHoraria`, `entradasPorDia`, `alertas`, `statusBruto`, `produtos`, `plataformas`, `piorCasoSms`, `fonte {lidos, truncado…}`.

### 3.5 Troca de linha de copy (n8n)

O `N8N_TOKEN` vive só no servidor. `POST /api/linha` valida a linha contra `/api/linhas-copy/`, chama o webhook `N8N_TROCAR_LINHA_URL` com `x-token`, e **só marca a linha como ativa se o n8n confirmar** — valendo o `linha_ativa` que ele devolve, não o que foi pedido. A "verdade" do que está no ar é `config_disparos.linha_ativa`; a autoria (`painel_linha_mensagens`) só é exibida quando bate com o config.

---

## 4. O banco de dados (migrations `server/migrations/`)

| Tabela | O que guarda |
|---|---|
| `disparos_pos_venda` | **a fila** (criada pelo n8n, não pelas migrations): um registro por pedido, com `status`, `etapa_atual`, `proximo_disparo`, contatos, `ultimo_erro`, `plataforma`, `chat_resumo` |
| `etapas_regua` | a cadência: `etapa` (PK), `nome`, `espera_h` (até a próxima), `offset_h` (desde a compra), `ativo` |
| `mensagens_regua` | a copy, PK composta `(etapa, canal, linha)`: `assunto`, `texto`, `corpo_html`, `botao`, `destino` (EBOOK/ASSISTENTE), `ativo` |
| `painel_linhas_copy` | as linhas de copy: `linha` (PK), `nome`, `intuito`, `ordem` (semeadas: 1 Confiança, 2 Ciência, 3 Emoção) |
| `config_disparos` | chave/valor; `linha_ativa` é a verdade do que está no ar |
| `painel_linha_mensagens` / `painel_linha_historico` | última troca feita pelo painel + histórico |
| `painel_usuarios` / `painel_sessoes` | contas (scrypt) e sessões da pilha legada/CLI |
| `produto_readmes` | conhecimento por produto para a IA de suporte |
| `chat_atendimentos` | uma linha por conversa do chatbot: resumo, motivo/tópico, resolvido, reembolso pedido/evitado, CSAT, duração, etapa da régua |
| `chat_topicos` | vocabulário de motivos (slug, nome, critério de encaixe que a IA lê) |
| `chat_perguntas_sem_resposta` | backlog da base de conhecimento |
| `painel_migracoes` | controle de migrações (cada `.sql` roda uma vez, com advisory lock) |

---

## 5. O front-end (`public/`)

### 5.1 Módulos

Sem framework, sem build: ES modules servidos direto. `index.html` → `app.js`; `login.html` → `login.js`.

| Módulo | Papel |
|---|---|
| `app.js` | orquestrador: estado global, tema claro/escuro, tooltip, ciclo de atualização, aba Régua inteira (herói, KPIs, gráficos, alertas, canais, tabela), editor de copy, janelas modais, boot/autenticação |
| `suporte.js` | aba Suporte IA + controle das abas e do menu lateral |
| `regua.js` | **o fluxo estilo n8n**: nós de e-mail/SMS/espera, tooltips, cliques |
| `previa.js` | janela de pré-visualização: remonta a moldura de e-mail do n8n e a bolha de SMS num `<iframe sandbox="">` (HTML do banco nunca entra no DOM do painel) |
| `copy.js` | regras de copy **compartilhadas com o servidor**: medição GSM-7/segmentos de SMS, erros × avisos |
| `charts.js` | gráficos SVG (colunas com tooltip de ponto-mais-próximo) |
| `format.js` | formatação `Intl` pt-BR (números, datas relativas, durações) |
| `demo.js` | modo demonstração: snapshot e fila sintéticos gerados no navegador |
| `login.js` | login + definição de senha própria no primeiro acesso |

### 5.2 O que cada tela puxa

**Aba Suporte IA** — uma chamada principal: `GET /api/suporte?dias=7|30|90[&produto][&plataforma]` alimenta insights, os 7 KPIs (conversas, taxa de resolução, taxa de reembolso, não resolvidas, tempo médio, CSAT, utilização do chat), o ranking de motivos, as perguntas sem resposta e o gráfico "onde a jornada gera contato". Clicar num KPI ou num motivo chama `GET /api/suporte/conversas` com o filtro correspondente (`resolvido=sim|nao`, `reembolso=consumado`, `com_csat=1`, `motivo=…`) e preenche a tabela de conversas; o resumo do atendimento aparece no hover.

**Aba Régua de pós-venda** — `GET /api/snapshot` alimenta praticamente tudo: número-herói, 6 KPIs clicáveis, o fluxo n8n, a barra de linhas de copy, os dois gráficos temporais (onda 48 h e entradas 14 d), "precisa de atenção", alcance por canal e status bruto. A tabela de pedidos vem à parte de `GET /api/pedidos` (paginada, com filtros próprios).

**Três níveis de filtro:**
1. **Globais** (topo): produto e plataforma — recortam o painel inteiro (snapshot + pedidos + suporte).
2. **Da tabela**: etapa, estado, canal, situação, busca (debounce 260 ms), ordenação — só recarregam `/api/pedidos`.
3. **Dos gráficos**: etapa e canal — só recortam a onda e as entradas (vão como query no snapshot).

**Ciclo de atualização:** intervalo configurável (30 s / **1 min** / 5 min / pausado) recarrega as três fontes juntas. Contra respostas fora de ordem (timer cruzando com busca), cada carga leva um **selo de geração**: ao voltar, só pinta a tela se ainda for a mais recente — inclusive no caminho de erro. Falha de rede mantém os últimos números na tela e escreve o motivo na faixa de erro.

### 5.3 O fluxo estilo n8n (`regua.js`)

Renderizado em HTML (não SVG): texto quebra sozinho, é focável e legível por leitor de tela. Canvas travado — sem pan/zoom; rola na horizontal quando não cabe.

```
[Compra Realizada] ── [ETAPA n: (Enviar E-mail) ─ (Enviar SMS)] ── [⏱ espera] ── … ── [Fim da régua]
```

- **Nó de mensagem** (e-mail azul, SMS violeta): rótulo + prévia da copy com `{nome}/{produto}` substituídos pelo **pior caso real da fila** (para a medição de SMS não mentir). SMS que estoura segmento ganha aviso em cor **e** texto. Mensagem inexistente vira nó tracejado com "+" — clicar abre o editor em branco (o molde `{etapa, canal, linha}` basta para o UPSERT criar o registro).
- **Nó de espera** (relógio laranja): a espera configurada; quando a mediana observada deriva mais de 25 %, aparece a segunda linha "real X" e o nó fica âmbar.
- **Conectores** animam conforme o tráfego (`prestes`: quantos disparam na próxima hora).
- **Dois cliques distintos:** o **nó** abre a mensagem para ver/editar; o **contador "N aqui"** filtra a tabela por aquela etapa (com o pseudo-estado `na_regua`, para o número clicado bater com as linhas mostradas). Tooltips idênticos no hover e no foco de teclado.

### 5.4 O editor de copy (`previa.js` + `copy.js`)

Clique no nó → janela com três modos: **Renderizado** (iframe `sandbox=""` com a moldura idêntica à que o robô monta — botão CTA, bloco de suporte, assinatura, rodapé — ou a bolha de SMS), **Código** e **Editar** (só admin). Cada tecla atualiza o rascunho, revalida com `validarMensagem` e re-mede o SMS; **erros bloqueiam o salvar** (SMS fora do GSM-7, corpo com `<script>`/`<html>`, menção a rastreio/logística — a regra do negócio), avisos não (SMS > 155 chars, falta do "Reply STOP to end", assunto longo). Salvar faz `PUT /api/mensagem/{linha}/{etapa}/{canal}` e a mesma validação roda de novo no servidor — o arquivo `copy.js` é literalmente o mesmo nos dois lados.

**Linhas de copy:** o seletor troca só o que se **vê** (EXIBINDO); **ativar** é um passo à parte, com confirmação, botão desabilitado se a linha estiver incompleta, e o selo "no ar" sempre visível. Criar linha permite copiar as 12 mensagens de outra.

### 5.5 Modo demo e login

- **Demo**: botão no topo gera snapshot e 420 pedidos sintéticos no navegador (RNG com semente que "respira" a cada 20 s), sem tocar rede nem banco — com distorções propositais (etapa com travados, deriva de 45 %, 14 % sem telefone) para exercitar a UI. Os seletores de produto/plataforma são desligados no modo demo.
- **Login**: valida o redirect `?ir=` (só caminho com uma barra — anti-phishing), reaproveita a senha provisória na tela de troca, e o painel chama `/api/auth/eu` **antes** de qualquer carga para redirecionar sem piscar números.

---

## 6. Fluxos ponta a ponta (exemplos)

1. **Login** — navegador → `POST /api/auth/login` (painel) → `POST /api/auth/token/` (API) → painel guarda `{access, refresh}` na sessão em memória e devolve só o cookie `painel_sessao`.
2. **Pintar o painel** — navegador → `GET /api/snapshot` → painel baixa `GET /api/disparos/` (paginado, cache 4 s) + `GET /api/etapas/` + `GET /api/mensagens/` + `GET /api/linhas-copy/` + `GET /api/config/linha_ativa/` → agrega em JS → um JSON para o front.
3. **Editar uma copy** — clique no nó → editor valida a cada tecla (`copy.js`) → `PUT /api/mensagem/2/1/email` (painel) → painel revalida com o mesmo `copy.js` → `PUT /api/mensagens/1:email:2/` (API, UPSERT) → snapshot silencioso atualiza o fluxo atrás da janela.
4. **Ativar a linha 3** — confirmação → `POST /api/linha` (painel) → webhook n8n com `x-token` → n8n confirma → painel grava autoria em `PUT /api/linha-ativa/` (API).
5. **Chatbot atende um cliente** — NorthSupportCB → API com token de serviço: lê `GET /api/disparos/?search=` e os readmes, grava `POST /api/atendimentos/` + `PUT /api/disparos/chat/` + CSAT → esses registros viram os KPIs de `GET /api/metricas/suporte/` → aba Suporte IA.

---

## 7. Variáveis de ambiente (resumo)

| Grupo | Variáveis | Uso |
|---|---|---|
| API externa (painel → API) | `API_URL`, `API_CACHE_MS` (4000), `API_FILA_MAX` (20000), `API_TIMEOUT_MS` (20000) | endereço e limites do cliente |
| Painel | `PORT` (4300), `HOST`, `LOCK_TIMEOUT_MIN` (10), `TZ_PAINEL`, `SESSAO_HORAS` (12), `ERROS_DETALHADOS` | comportamento do BFF |
| API SendTrace | `API_PORT` (4400), `API_HOST`, `API_JWT_SEGREDO` (obrigatório), `API_ACCESS_MIN` (60), `API_REFRESH_H` (12), `API_TOKEN_SERVICO`, `API_LOG`, `API_ERROS_DETALHADOS` | serviço Fastify |
| Banco | `DATABASE_URL` (ou `DB_*`), `DB_SSL_INSECURE` | Postgres (API e CLIs) |
| n8n | `N8N_TROCAR_LINHA_URL`, `N8N_TOKEN` | troca de linha |
| SMTP | `SMTP_HOST/PORT/USUARIO/SENHA/DE/SEGURO`, `NOME_PAINEL`, `PAINEL_URL`, `CONVITE_DIAS` | convites por e-mail (opcional) |
| Setup | `ADMIN_EMAIL`, `ADMIN_SENHA` | admin inicial do `npm run setup` |

---

## 8. Pontos de atenção encontrados no mapeamento

1. **Documentação desatualizada no `.env.example`**: ele afirma que `/api/usuarios/` é somente leitura na API, mas `POST` e `PATCH` existem e funcionam.
2. **Comentários legados em `server/api.js`**: o cabeçalho ainda descreve a API como "Django REST" num IP antigo; hoje é o Fastify local na 4400 (em Docker, `http://api:4400`).
3. **Sessões do painel são em memória**: reiniciar o processo desloga todo mundo (decisão assumida no código).
4. **Duas pilhas de autenticação coexistem**: a ativa (via API + sessões em memória) e a legada em Postgres (`auth.js`/`painel_usuarios`), viva só nos CLIs `setup`/`senha`.
5. **Histórico de tentativas de troca de linha**: como `/api/linha-historico/` da API é somente leitura para o painel, tentativas que falham não são mais registradas — só a última troca bem-sucedida (regressão documentada em `server/linha.js`).
6. **Modo demo tem lacunas conhecidas**: não implementa o filtro `problema` da tabela nem emite `produtos`/`plataformas`/`linha`/`piorCasoSms` (coerente com os seletores desligados); a aba Suporte IA não tem modo demo.
7. **Cache da fila é global, não por usuário** — vale porque a API não recorta a fila por usuário; se um dia recortar, precisa virar cache por credencial (anotado no código).
