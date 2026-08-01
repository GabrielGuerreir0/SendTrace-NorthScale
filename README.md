# SendTrace

Painel da régua de pós-venda: **o que cada etapa envia**, **em qual etapa cada
pedido está** e **quantos clientes há em cada etapa**.

O canvas é no estilo n8n mas **travado**: os nós não se arrastam, não há zoom
nem pan. O layout se calcula sozinho e sempre cabe na tela — quando a régua não
cabe numa linha, dobra em serpentina, com setas indicando a direção do fluxo.

## Deploy em produção

Painel + Postgres em containers no seu VPS, com o GitHub Actions construindo a
imagem e o servidor só baixando. O passo a passo — servidor, GitHub, HTTPS e
backup — está em **[DEPLOY.md](DEPLOY.md)**.

## Rodar

```bash
npm install
npm run setup     # cria as tabelas, semeia a régua e cria o administrador
npm start         # http://127.0.0.1:4300
```

### Ou em Docker

O banco continua **externo** (Neon) — a imagem não sobe Postgres nenhum, só
precisa de `DATABASE_URL` apontando para o seu.

```bash
cp .env.example .env      # preencha DATABASE_URL
docker compose run --rm painel npm run setup    # tabelas + administrador
docker compose up -d --build                    # http://127.0.0.1:4300
docker compose logs -f painel
```

> **Use sempre `--build`.** A imagem **congela o código no momento em que foi
> construída**: sem reconstruir, `docker compose up` sobe a versão antiga
> enquanto o `npm start` roda a nova, e nada na tela denuncia isso.

### Qual versão está rodando

O rodapé do painel mostra uma **digital do código** (`versão e731768…`), e
`/api/vivo` devolve a mesma coisa sem precisar de sessão:

```bash
curl -s http://127.0.0.1:4300/api/vivo    # npm start
curl -s http://127.0.0.1:4301/api/vivo    # container, se publicado noutra porta
```

Digitais iguais = mesmo código. É um SHA-256 sobre o **conteúdo** dos arquivos
`.js`, `.html`, `.css` e `.sql` — não sobre a data, que muda ao copiar para
dentro da imagem sem que o código mude.

Migrações e senha também rodam por lá:

```bash
docker compose run --rm painel npm run setup
docker compose run --rm painel npm run senha -- alguem@empresa.com
```

O que a imagem faz por segurança, e por quê:

| | |
|---|---|
| **`.env` fora da imagem** | ele tem a senha do banco e o token do n8n. Dentro da imagem viraria uma camada extraível por qualquer um que a tivesse — mesmo que um passo seguinte o apagasse. As variáveis entram em tempo de execução. |
| **usuário sem privilégio** | roda como `node`, não como root. |
| **`read_only` + `tmpfs /tmp`** | o container não escreve em disco fora do que está declarado. |
| **porta só no loopback** | `127.0.0.1:4300:4300`. Para expor na rede, troque por `"4300:4300"` — e ponha HTTPS na frente, porque em HTTP o cookie de sessão viaja em claro. |

> **`HOST=0.0.0.0` dentro do container.** O compose sobrepõe o que estiver no
> `.env`: com `127.0.0.1` o servidor responderia só ao loopback do próprio
> container e o mapeamento de porta não alcançaria nada.

O healthcheck bate em `/api/vivo`, que **não consulta o banco** — um
healthcheck que dependesse do Postgres reiniciaria o container toda vez que o
Neon hibernasse, e reiniciar não acorda banco nenhum.

O `setup` mostra o e-mail e a senha do administrador **uma única vez**. Para
escolher você mesmo, ponha `ADMIN_EMAIL` e `ADMIN_SENHA` no `.env` **antes** do
primeiro `setup`. A senha é sempre provisória: o painel pede uma nova no
primeiro acesso.

Cada migração roda **uma vez só** (registrada em `painel_migracoes`). Rodar
`npm run setup` de novo é seguro e não sobrescreve nada que você tenha editado.

## Acesso

O painel é fechado. Sem sessão válida nada é servido além da tela de login —
nem as APIs, nem o HTML, nem o JavaScript do painel.

| | |
|---|---|
| **Senha** | nunca é guardada. O banco tem `scrypt(senha, salt)` com salt de 16 bytes por usuário e os parâmetros de custo gravados junto, para endurecer o custo depois sem invalidar as senhas existentes. |
| **Sessão** | cookie `HttpOnly` + `SameSite=Strict`, com `Secure` quando a conexão é HTTPS. O banco guarda só o **hash** do token: um vazamento não permite forjar sessão. |
| **Força bruta** | 6 falhas bloqueiam a conta por 15 min. O contador vive no banco, então sobrevive a reinício. Um freio por IP, em memória, pega quem varre muitos e-mails de um mesmo lugar. |
| **Enumeração** | e-mail inexistente e senha errada devolvem a mesma mensagem, no mesmo tempo — um hash descartável é calculado quando a conta não existe, senão daria para descobrir quem tem conta cronometrando a resposta. |
| **CSRF** | `SameSite=Strict` mais a exigência de um cabeçalho `X-Painel` em tudo que muda estado. Nenhum site externo consegue mandar cabeçalho próprio sem um preflight que nunca é autorizado. |

### O administrador inicial

O primeiro `npm run setup` cria **uma** conta de administrador — só se ainda não
existir nenhum usuário. Rodar o setup de novo nunca recria nem ressuscita conta.

| | |
|---|---|
| e-mail | `ADMIN_EMAIL` do `.env`, ou `admin@painel.local` se você não definir |
| senha | `ADMIN_SENHA` do `.env`, ou uma sorteada e impressa **uma única vez** no terminal |
| permissão | administrador |
| primeiro acesso | obrigatoriamente troca a senha antes de o painel abrir |

**A senha não está escrita em lugar nenhum deste repositório, e não deve
estar.** O banco guarda só o hash — não há de onde recuperá-la. Se você perdeu a
que apareceu no terminal, gere outra:

```bash
npm run senha -- admin@painel.local
```

Nesta instalação a conta inicial é **`admin@painel.local`**. Ela existe só para
abrir a porta. O caminho recomendado:

1. Entre com ela e defina uma senha sua.
2. Crie a **sua** conta pelo botão **Usuários**, marcando *administrador*.
3. Entre com a conta nova e **desative** a `admin@painel.local`.

O painel não deixa você ficar sem acesso: só permite desativar a conta inicial
depois que existir outro administrador ativo, e nunca deixa remover o último.

### Usuários

Administradores veem o botão **Usuários** no topo. De lá dá para criar contas,
promover alguém a administrador, desativar e gerar senha provisória nova.

Regras que o servidor impõe (a interface só evita o clique inútil):

- Ninguém remove o próprio acesso de administrador nem desativa a própria conta.
- Sempre sobra pelo menos um administrador ativo.
- Desativar alguém **encerra as sessões abertas dessa pessoa na hora** — sem
  isso ela continuaria dentro do painel até o cookie vencer.
- Trocar a senha derruba as outras sessões da conta.
- Quem cria a conta escolhe uma senha provisória e não continua sabendo a senha
  de ninguém: a pessoa é obrigada a definir a dela no primeiro acesso.

### Convite por e-mail

Se você configurar SMTP no `.env`, criar um usuário manda um e-mail com a senha
provisória e o link do login. **É opcional**: sem SMTP o painel funciona igual e
a senha aparece na tela para você repassar como quiser.

```
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USUARIO=...
SMTP_SENHA=...
SMTP_DE=SendTrace <nao-responda@suaempresa.com>
```

**O link não precisa do domínio decidido.** Enquanto `PAINEL_URL` estiver vazio,
o link sai do endereço por onde você acessou o painel — se você entra por
`https://painel.suaempresa.com`, é para lá que o e-mail aponta. Quando o
endereço estiver definido, fixe em `PAINEL_URL` e pare de depender disso.

> O cabeçalho `Host` vem do cliente, então é validado antes de virar link. Sem
> isso alguém poderia forjar `Host: site-falso.com` e fazer o painel enviar,
> com a sua marca e do seu SMTP, um convite apontando para um login clonado.

A senha provisória **expira em 7 dias** (`CONVITE_DIAS`). Isso existe porque ela
agora mora numa caixa de entrada: sem prazo, uma conta que nunca foi usada
continua aberta indefinidamente com uma senha que já circulou por e-mail.

### Trocar a linha de mensagens (1 · 2 · 3)

No topo de **Etapas de comunicação** há um seletor com **todas as linhas
cadastradas**, lido de `painel_linhas_copy`. A copy vive em `mensagens_regua`
com a coluna `linha`, então cada escolha mostra os textos daquela versão.

É um dropdown, não abas: com muitas linhas as abas quebram em várias fileiras e
empurram a trilha para baixo. O que as abas mostravam de graça não se perde —
cada opção traz o estado escrito no rótulo (`1 · Confiança — no ar`,
`7 · Prova social — faltam 9`), e **o selo "no ar" fica ao lado do seletor**,
visível mesmo quando você seleciona outra linha. Num dropdown fechado só se lê a
opção escolhida; sem esse selo, trocar a visualização faria perder de vista qual
copy os clientes estão recebendo.

A ordem vem da coluna `ordem`, com desempate pelo número — senão o `10`
apareceria entre o `1` e o `2`, como numa comparação de texto.

**Ver e ativar são coisas diferentes.** Trocar no seletor só muda o que está
desenhado na tela. Ativar é um segundo passo, com botão próprio e confirmação —
se a seleção já trocasse a campanha, conferir o texto da linha 3 mudaria o que
milhares de clientes recebem. Enquanto você olha uma linha que não está no ar, a
barra avisa em destaque.

As três não são variações de texto, são **estratégias diferentes** para o mesmo
funil — por isso cada aba mostra o nome e o propósito, não só o número:

| | | |
|---|---|---|
| **1 · Confiança** | retenção / anti-reembolso | Reduz a ansiedade da espera, responde as dúvidas antes de virarem problema, usa a garantia como calmante. |
| **2 · Ciência** | educação / valor percebido | Constrói valor pelo racional: por que gotas, os erros que sabotam resultados, a ciência dos hábitos, o baseline mensurável. |
| **3 · Emoção** | identidade / visão de futuro | Ancora num motivo pessoal, acolhe a dúvida do Dia 2, transforma o uso em ritual, projeta o "eu daqui a 30 dias". |

Os nomes vivem em `painel_linhas_copy` e são editáveis por SQL.

> **Regra fixa da copy:** nenhuma mensagem cita rastreio nem afirma status de
> logística. Nada disso está sob nosso controle, e prometer o que não se
> controla é o que vira reembolso.

Ativar chama o webhook do n8n e passa a valer para **todos os envios**, até
alguém trocar de novo.

```
N8N_TROCAR_LINHA_URL=https://n8n.thenorthscales.com/webhook/trocar-linha
N8N_TOKEN=...
```

**O token nunca chega ao navegador.** A página chama `/api/linha` no próprio
painel, e é o servidor que fala com o n8n com o `x-token`. Qualquer coisa
entregue ao JavaScript é legível por quem abrir o DevTools — e esse token troca
a campanha de todo mundo.

Só administradores trocam, e o painel pede confirmação antes.

A linha ativa é lida de **`config_disparos`** — a mesma chave que o webhook
grava e que o robô consulta a cada disparo. Não é palpite nem memória do painel:
se alguém trocar a linha por fora, o painel mostra o valor novo assim que
recarregar.

`painel_linha_mensagens` continua existindo, mas só para registrar **quem**
trocou pelo painel. A autoria só aparece quando ainda corresponde ao que está no
ar.

Toda troca fica registrada em `painel_linha_historico` com quem fez, quando e se
deu certo. Uma falha (n8n fora do ar, token errado) **não** grava a linha nova:
afirmar uma campanha que talvez não tenha entrado é pior que não saber.

### Esqueci a senha

O painel não manda e-mail, então a recuperação é pelo servidor:

```bash
npm run senha -- alguem@empresa.com                    # sorteia e mostra
npm run senha -- alguem@empresa.com "senha escolhida"  # define
npm run senha -- alguem@empresa.com --admin            # e promove
```

Encerra as sessões daquela conta e exige troca no próximo acesso.

## Os dois canais disparam juntos

**Toda etapa envia e-mail e SMS ao mesmo tempo.** Não existe "o canal da etapa":
existe uma mensagem *por canal*, e cada uma alcança quem tiver o contato
correspondente — o e-mail chega em quem tem `email`, o SMS em quem tem
`telefone`. Quem não tem o contato simplesmente não recebe por aquele canal,
por mais que a etapa mande enviar.

É por isso que o card **Alcance por canal** não fala em "volume do canal" e sim
em quantos cada canal *alcança*, com a perda por falta de contato hachurada ao
lado.

## Três tabelas, três papéis

| tabela | papel | quem escreve |
|---|---|---|
| `etapas_regua` | **a cadência**: quando cada etapa dispara | você (por SQL) |
| `mensagens_regua` | **a copy**: o que cada etapa diz, em cada canal | você (por SQL) |
| `disparos_pos_venda` | **a fila**: onde cada pedido está agora | seu worker / n8n |

O painel só **lê** as três. Não há nenhum `INSERT`, `UPDATE` ou `DELETE` em
lugar nenhum do código da aplicação — as únicas escritas do projeto são as
migrações que criam as duas tabelas da régua, e elas não tocam na fila.

A separação existe porque cadência e copy mudam por motivos diferentes e em
ritmos diferentes: trocar o texto de um SMS não é mexer no ritmo da régua, e
adiar uma etapa não é reescrever a mensagem.

### Editar a régua

Tudo por SQL, sem mexer em código nem reiniciar o painel:

```sql
-- ritmo: quando a etapa dispara
UPDATE etapas_regua
   SET offset_h = 48,     -- horas desde a compra até ESTA etapa disparar
       espera_h = 24      -- horas até a PRÓXIMA etapa (NULL = última)
 WHERE etapa = 2;

-- copy: o que sai em cada canal, em cada LINHA (1, 2 ou 3)
UPDATE mensagens_regua
   SET assunto = '{nome}, your {produto} is on the way',
       texto   = 'Day 2: prepared and ready to ship.',
       botao   = 'Check my order →',
       destino = 'ASSISTENTE'          -- EBOOK | ASSISTENTE
 WHERE etapa = 2 AND canal = 'email' AND linha = '1';

UPDATE mensagens_regua
   SET texto = 'Hi {nome}, your {produto} just shipped. Reply STOP to end'
 WHERE etapa = 2 AND canal = 'sms' AND linha = '1';

-- cadastrar a linha 2 inteira a partir da 1, para editar em cima
INSERT INTO mensagens_regua (etapa, canal, linha, assunto, texto, botao, destino)
SELECT etapa, canal, '2', assunto, texto, botao, destino
  FROM mensagens_regua WHERE linha = '1'
ON CONFLICT (etapa, canal, linha) DO NOTHING;

-- desligar SÓ o SMS de uma etapa, mantendo o e-mail
UPDATE mensagens_regua SET ativo = false
 WHERE etapa = 4 AND canal = 'sms' AND linha = '1';

-- desligar a etapa inteira sem perder quem está parado nela
UPDATE etapas_regua SET ativo = false WHERE etapa = 4;

-- acrescentar uma etapa (precisa das duas tabelas)
INSERT INTO etapas_regua (etapa, nome, offset_h, espera_h)
VALUES (6, 'Cupom de retorno', 168, NULL);

INSERT INTO mensagens_regua (etapa, canal, assunto, texto, botao, destino) VALUES
  (6, 'email', '{nome}, a little something for your next order',
      'Your 10% coupon expires tomorrow.', 'Use my coupon →', 'ASSISTENTE'),
  (6, 'sms', NULL, 'Hi {nome}, your 10% coupon expires tomorrow. Reply STOP to end',
      NULL, NULL);
```

Os marcadores `{nome}`, `{produto}` e `{uso}` são os mesmos do seu nó de Code
no n8n. No painel eles aparecem já substituídos por um exemplo (`Ana`,
`Memopryl`) — mostrar `{nome}` cru obrigaria você a simular a substituição de
cabeça justamente onde o tamanho importa, que é no SMS.

> **A copy que veio na migração é a do seu workflow atual**, transcrita do nó de
> Code. As esperas (`offset_h` / `espera_h`) foram lidas dos comentários do
> mesmo nó — se o worker estiver rodando outra cadência, o painel acusa. É para
> isso que existe a comparação de régua escrita × régua que roda.

Uma etapa que aparece na fila mas não existe em `etapas_regua` ainda é
desenhada, marcada como não cadastrada. E quem estiver numa etapa sem nenhuma
mensagem ativa é contado à parte no card de alcance: essa gente não recebe nada,
em canal nenhum, e some de qualquer recorte por canal se ninguém disser.

### Ver a mensagem como o cliente recebe

**Duplo clique** (ou Enter, com o cartão focado) abre a mensagem renderizada: o
e-mail com a marca, o botão e o rodapé montados, ou o SMS numa bolha de celular.
Há um alternador **Renderizado / Código**.

Os marcadores são preenchidos com o **pior caso da sua fila** — o maior nome e o
maior produto — porque é assim que se descobre que `{produto}` num lugar errado
produz coisas como *"The UP3 - Flex-ImmuneGuard (3 + 3 Bottles) Team at North
Scale"* na assinatura.

> **O banco guarda só o corpo** (`mensagens_regua.corpo_html`). Cabeçalho,
> botão, bloco de suporte e rodapé são idênticos nas 17 mensagens e remontados
> na hora de exibir — guardá-los 17 vezes criaria 17 lugares para desatualizar.
> Em compensação, se você mudar a moldura ou os links no n8n, mude também em
> `public/previa.js`, senão a pré-visualização mente sobre o que está saindo.

O HTML é renderizado num `<iframe sandbox="">`: sem script, sem formulário, sem
acesso à página. É conteúdo vindo do banco — mesmo sendo o seu próprio banco,
jogá-lo direto no DOM transformaria qualquer `UPDATE` numa porta de XSS.

### Criar uma linha nova

Botão **+ Nova linha** ao lado das abas (administradores). Pede número, nome,
intuito e — o campo que importa — **de onde começar**:

- **Copiar de uma linha existente** entrega as 12 mensagens prontas para editar.
  É o caminho normal: a linha já nasce ativável e você mexe só no que quer mudar.
- **Em branco** cria a linha sem mensagem nenhuma. A trilha passa a mostrar um
  **cartão vazio por etapa e canal** — duplo clique em cada um abre o editor
  para escrever. Sem esses cartões o editor ficaria inalcançável justamente
  numa linha nova.

Registro e cópia acontecem **numa transação só**: uma linha registrada com
metade das mensagens copiadas seria pior que nenhuma linha.

A aba mostra **quantas mensagens faltam** enquanto a linha estiver incompleta, e
o botão *Ativar* fica desabilitado — o webhook recusaria de qualquer jeito, e
descobrir isso só depois do clique é trabalho perdido. A regra de completude é a
mesma do webhook: um e-mail conta com assunto **e** corpo; um SMS, com texto.

### Renomear, reordenar e apagar

O botão **Editar linha** abre o mesmo formulário para mudar **nome**, **intuito**
e **ordem** — é assim que se reordena a lista. O **número não muda**: é a chave
que o webhook usa para ativar e que as mensagens referenciam; alterá-lo quebraria
as duas pontas.

Apagar está no mesmo lugar, e leva junto as mensagens da linha. O painel recusa
apagar a linha que está **no ar**, verificando o `config_disparos` dentro da
transação — não o que a tela achava quando carregou.

### Editar a copy pelo painel

Na janela da mensagem há uma aba **Editar** (só para administradores). O que se
digita ali vira um **rascunho**: clicar em *Renderizado* mostra o e-mail já com o
texto novo, antes de salvar. Sem isso o editor seria inútil — você editaria,
pediria pré-visualização e veria a versão antiga.

Salvar grava por `UPSERT` na chave `(etapa, canal, linha)`, o mesmo caminho que
o contrato do robô define para criar e editar. **O robô relê o banco a cada
minuto**, então o próximo disparo já sai com o texto novo — nada a mexer no n8n.

> Por isso: não deixe uma linha **ativa** pela metade. Edite numa linha inativa
> e troque depois, ou revise antes de salvar.

As regras de conteúdo valem no **servidor**, não só na tela — validação de front
é conveniência para quem digita, e um `PUT` direto passaria por cima dela:

| bloqueia (erro) | avisa (não bloqueia) |
|---|---|
| SMS com acento/emoji — derruba o limite de 160 para 70 | SMS acima de ~155 caracteres |
| assunto ou corpo vazios | SMS sem `Reply STOP to end` |
| `<html>`, `<head>`, `<body>` no corpo — o robô monta a moldura | assunto acima de 90 caracteres |
| `<script>` ou atributos de evento | `<style>`/`<link>` (e-mail ignora CSS externo) |
| citar rastreio ou status de logística | botão com rótulo e sem destino |
| destino diferente de `EBOOK`/`ASSISTENTE` | |

A linha precisa existir em `painel_linhas_copy` antes (há chave estrangeira). O
painel traduz o erro do banco para essa frase em vez de mostrar `23503`.

### Tamanho do SMS

Cada mensagem de SMS mostra quantos caracteres ocupa e em quantos **segmentos**
vai ser cobrada. O limite é 160 caracteres por segmento — mas só enquanto o
texto ficar dentro do alfabeto **GSM-7**. Um travessão (`—`), uma aspa curva
(`'`) ou um emoji derrubam a codificação para UCS-2 e o limite despenca para 70,
o que costuma dobrar a conta sem ninguém perceber. Quando isso acontece o painel
avisa em vermelho, com o motivo escrito.

**A medição usa o pior caso real da sua fila** — o maior primeiro nome e o maior
nome de produto que existem hoje — e não uma amostra confortável. `{produto}` é
o que costuma estourar: um nome como `UP3 - Flex-ImmuneGuard (3 + 3 Bottles)`
tem 38 caracteres e sozinho joga vários SMS para o segundo segmento. Passe o
mouse no rodapé da mensagem para ver qual nome e qual produto foram usados.

### Compartilhar com o n8n

Como a régua está no banco, o workflow pode ler dela em vez de carregar a
cadência e os `TEMPLATES` hardcoded nos nós:

```sql
-- a copy dos dois canais de uma etapa
SELECT canal, assunto, texto, botao, destino, corpo_html
FROM mensagens_regua WHERE etapa = $1 AND ativo;
```

E agendar a próxima com o valor da própria tabela:

```sql
UPDATE disparos_pos_venda d
   SET etapa_atual     = d.etapa_atual + 1,
       proximo_disparo = now() + make_interval(mins => (r.espera_h * 60)::int)
  FROM etapas_regua r
 WHERE r.etapa = d.etapa_atual AND d.id = $1 AND r.espera_h IS NOT NULL;
```

`mensagens_regua.corpo_html` está lá vazio de propósito: é onde cabe o HTML
completo do e-mail, se um dia você quiser tirar os `TEMPLATES` do nó de Code. O
painel não renderiza esse campo — ele existe para o n8n.

## Os cinco estados

O painel não usa a coluna `status` crua — ela não distingue um pedido saudável
de um preso no worker. Cada linha é classificada em **um** de cinco estados
mutuamente exclusivos, que por isso somam exatamente o total:

| estado | regra |
|---|---|
| **Em dia** | `status='ativo'` e `proximo_disparo` no futuro |
| **Atrasado** | `status='ativo'` mas o horário já passou |
| **Processando** | `status='processando'` com lock recente |
| **Travado** | `status='processando'` há mais de `LOCK_TIMEOUT_MIN`, **ou** com `claimed_at` nulo (anomalia: o worker marcou sem registrar o lock) |
| **Finalizado** | qualquer outro `status` — o pedido saiu da régua |

O número grande de cada nó é **quem ainda está circulando** naquela etapa (os
quatro primeiros). Uma linha finalizada continua carregando o `etapa_atual` em
que parou, então somá-la ao nó contaria como "nesta etapa" alguém que já saiu —
por isso os finalizados vão para o nó de saída. Clicar num nó filtra a tabela
por *Na régua*, e não só pela etapa, justamente para o número da tabela bater
com o número que você acabou de clicar.

## A qual canal um erro pertence

A fila guarda o erro numa coluna de texto só (`ultimo_erro`), sem campo de
canal. Mas o worker escreve o canal na frente:

```
sms: sem telefone valido
email: hard bounce
```

O painel lê esse prefixo e atribui o erro **só ao canal correspondente**. Sem
isso, uma falha de SMS apareceria como erro também no e-mail, e alguém iria
investigar um problema de e-mail que nunca existiu.

Quando o texto **não** identifica o canal, o registro não é chutado para os dois
lados: fica numa linha à parte, *"N com erro sem canal identificado"*. Se esse
número crescer, vale pedir ao worker que prefixe o canal sempre — a soma dos
dois canais mais os sem canal fecha com o total de erros.

O reconhecimento exige o canal como palavra inteira no começo do texto, então
`smtp: …` ou `emails não enviados` não são classificados por engano.

## Régua escrita × régua que roda

A etiqueta de cada conexão mostra a espera **configurada** (`espera_h`). Quando
a espera **observada** diverge mais de 25%, a etiqueta ganha uma segunda linha
`real X` e fica destacada.

O observado vem da mediana de `proximo_disparo − criado_em` entre as linhas
`ativo` de cada etapa — o atraso acumulado real desde a entrada na fila. A
diferença entre os dois números é a deriva entre o que a régua manda e o que o
worker está fazendo.

> Só linhas `ativo` entram nessa conta: nas demais o `proximo_disparo` é
> resíduo do último agendamento, não uma promessa futura.
>
> **Limite honesto da medida:** a espera observada de uma conexão é a diferença
> entre as medianas de duas populações distintas (quem está na etapa N e quem
> está na N+1), não a mediana das diferenças. Sem histórico de transições na
> tabela não dá para fazer melhor. Serve para apontar deriva grande, não para
> auditar minutos — por isso o alerta só acende acima de 25%.

## O que cada peça mostra

- **Nó** — os dois canais (glifo + palavra), o assunto do e-mail como resumo do
  que a etapa diz, anel com a divisão de estados, o total da etapa e um
  micro-histograma dos **próximos disparos em 48 h**. Clique para filtrar a
  tabela; passe o mouse ou dê Tab para o detalhamento completo.
- **Conexão** — pulsa conforme quantos pedidos da etapa de origem disparam na
  próxima hora. Só conta quem ainda **não** venceu: um pedido atrasado não vai
  andar sozinho, e animar tráfego num cano parado seria mentira.
- **Etapas de comunicação** — a copy inteira de cada etapa, nos dois canais, com
  o CTA do e-mail e o custo em segmentos do SMS.
- **Onda de disparos** e **Entradas na régua** — filtráveis por etapa e por
  canal. O filtro de canal usa o mesmo critério do card de alcance (tem mensagem
  ativa **e** tem contato), então os números batem entre as duas leituras.
- **Alcance por canal** — quantos cada canal alcança e quantos perde por falta
  de contato. Todo número ali é clicável e filtra a tabela.
- **Precisa de atenção** — travados, atrasados, erros e retentativas.
- **Tabela** — a leitura completa e filtrável, inclusive por canal.

> O micro-histograma usa `proximo_disparo`, não `criado_em`. A tabela não guarda
> histórico de transições, então um gráfico de "entradas por etapa" seria
> inventado — `criado_em` é quando o pedido entrou na fila (etapa 0), não quando
> chegou na etapa atual.

Os filtros dos gráficos recortam **só os dois gráficos temporais**. Os nós, os
indicadores e o alcance por canal continuam mostrando a régua inteira: filtrar o
painel todo esconderia justamente o contexto que dá sentido ao recorte.

## Configuração

| variável (`.env`) | para quê |
|---|---|
| `PORT` / `HOST` | `127.0.0.1` deixa o painel só nesta máquina. Use `0.0.0.0` para expor na rede local. |
| `LOCK_TIMEOUT_MIN` | acima de quantos minutos em `processando` um pedido conta como **travado**. Ajuste ao tempo real do seu worker. |
| `TZ_PAINEL` | fuso do corte diário em "Entradas na régua" (padrão `America/Sao_Paulo`). |
| `DB_SSL_INSECURE` | só se o certificado TLS não validar na sua rede. |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | administrador inicial. Só valem no primeiro `setup`, quando ainda não há usuário nenhum. |
| `SESSAO_HORAS` | quanto tempo uma sessão dura (padrão 12). |
| `ERROS_DETALHADOS` | `true` devolve a mensagem crua do Postgres nos erros. Deixe `false` fora do seu computador: ela carrega nome de coluna e trecho de consulta. |

> Se expor o painel além de `127.0.0.1`, ponha **HTTPS na frente** (um proxy
> reverso resolve). Em HTTP o cookie de sessão viaja em claro, e nenhuma das
> proteções acima cobre alguém lendo a rede.

## Modo demonstração

O botão **Demo** preenche o painel com dados sintéticos gerados no navegador,
para avaliar a interface com volume alto. **Não lê nem grava nada no banco.**
Uma faixa amarela fica visível o tempo todo enquanto ligado.

## Acessibilidade e cores

A paleta foi validada com simulação de daltonismo (ΔE em OKLab) contra as duas
superfícies reais do painel. As duas cores de identidade — *em dia* (azul) e
*processando* (verde-água) — passam em todos os pares nos dois temas. Amarelo e
vermelho são tokens de **status**: aparecem sempre com ícone e rótulo, nunca cor
sozinha. O **canal** nunca é comunicado por cor: é glifo + palavra. Na barra de
alcance, a parte não alcançada é hachurada, não só recolorida. Todo valor dos
gráficos também existe na tabela.

O tema segue o sistema e pode ser alternado no botão ☾/☀ (fica salvo).
Animações respeitam `prefers-reduced-motion`.

## Estrutura

```
Dockerfile · .dockerignore
docker-compose.yml              desenvolvimento: constrói local, banco externo
docker-compose.prod.yml         produção: imagem do registry + Postgres junto
.github/workflows/deploy.yml    CI: verifica, publica a imagem, sobe no VPS
DEPLOY.md                       passo a passo do servidor e do GitHub
server/
  index.js                        HTTP, guarda de sessão e todas as rotas
  auth.js                         senhas (scrypt), sessões, freio de força bruta
  email.js                        convite por e-mail (SMTP, opcional)
  linha.js                        troca da linha de copy ativa no n8n
  queries.js                      todo o SQL da régua
  db.js                           pool do Postgres
  etapas.config.js                vocabulário fixo (canais, estados, status)
  setup.js                        migrações + administrador inicial
  senha.js                        redefinição de senha pelo terminal
  versao.js                       digital do código, para comparar versões
  migrations/
    001_etapas_regua.sql          tabela de cadência
    002_mensagens_regua.sql       tabela de copy + semente da régua
    003_copy_retencao.sql         copy de retenção (alinhada ao nó do n8n)
    004_usuarios.sql              usuários e sessões
    005_convite_email.sql         validade da senha provisória
    006_linha_ativa.sql           linha de copy ativa + histórico
    007_copy_por_linha.sql        a copy passa a existir em 3 linhas
    008_tres_linhas.sql           nomes das linhas + copy das 3
    009_corpo_html.sql            corpo dos e-mails, para pré-visualizar
public/
  login.html · login.js           tela de entrada e troca de senha
  previa.js                       pré-visualização do e-mail e do SMS
  index.html
  styles.css                      tokens dos dois temas
  app.js                          orquestração, filtros, tabela, acesso
  flow.js                         canvas travado: serpentina, nós, conexões
  mensagens.js                    trilha da copy por canal, contagem de SMS
  charts.js                       colunas, anel, micro-histograma, quebra de texto
  demo.js                         dados sintéticos do modo demonstração
  format.js                       formatação pt-BR
```
