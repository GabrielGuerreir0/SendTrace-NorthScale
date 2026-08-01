# Deploy no VPS

O **painel** em container no VPS, conectado ao **Postgres que já existe lá**
(container `sendtrace-postgres`). O GitHub Actions constrói a imagem e o
servidor só baixa e sobe.

> Este deploy **não cria banco nenhum**. Um segundo Postgres significaria um
> banco vazio paralelo ao verdadeiro — o painel abriria bonito, mostrando zero
> pedidos.

---

## Antes de tudo: troque as senhas

Se as senhas do servidor ou do banco já circularam por chat, e-mail ou
documento compartilhado, considere-as comprometidas. Vale para a senha de root
e para a do Postgres.

```bash
passwd                                    # senha de root, no VPS
# e, dentro do container do banco:
docker exec -it sendtrace-postgres \
  psql -U sendtrace -c "ALTER USER sendtrace WITH PASSWORD 'nova-senha-longa';"
# depois atualize DB_SENHA em /opt/sendtrace/painel/.env e suba de novo
```

---

## 1. No servidor

### 1.1 Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version      # precisa responder
```

### 1.2 Um usuário só para o deploy

**Não use root.** Se o segredo do GitHub vazar — chave ou senha —, o estrago
fica limitado a este usuário em vez de ser a máquina inteira.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
# O /opt/sendtrace já existe (é do banco). Só a subpasta do painel é nova.
mkdir -p /opt/sendtrace/painel && chown -R deploy:deploy /opt/sendtrace/painel
```

### 1.3 Como o GitHub vai entrar no servidor

Escolha **um** dos dois. O workflow aceita os dois e usa o que estiver
preenchido.

| | chave SSH | senha |
|---|---|---|
| configurar | gerar e instalar a chave | colar a senha num segredo |
| login por senha no SSH | pode **desligar** | precisa ficar **ligado** |
| força bruta da internet | não alcança | bate na porta o tempo todo — exige fail2ban |
| revogar | apagar uma linha do `authorized_keys` | trocar a senha (quebra tudo que a usa) |

Nos dois casos, **use o usuário `deploy`, não root**: se o segredo vazar, o
estrago fica num usuário em vez de ser a máquina inteira.

#### Opção A — chave SSH

Gere **no seu computador** (a privada nunca vai para o servidor):

```bash
ssh-keygen -t ed25519 -C "deploy-sendtrace" -f ~/.ssh/sendtrace_deploy -N ""
ssh-copy-id -i ~/.ssh/sendtrace_deploy.pub deploy@SEU_IP
ssh -i ~/.ssh/sendtrace_deploy deploy@SEU_IP "echo funcionou"
```

O conteúdo de `~/.ssh/sendtrace_deploy` (a **privada**, com as linhas
`BEGIN`/`END`) vira o segredo `VPS_SSH_KEY`. **Não crie `VPS_SENHA`.**

#### Opção B — senha

Defina uma senha só para o `deploy` — não reaproveite a de root:

```bash
passwd deploy
```

Ela vira o segredo `VPS_SENHA`. **Não crie `VPS_SSH_KEY`** (se os dois
existirem, a chave é usada e a senha é ignorada).

Confira que entra:

```bash
ssh deploy@SEU_IP "echo funcionou"
```

### 1.4 Proteger o SSH

#### Se você escolheu a chave

Feche a porta que aceita adivinhação:

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
```

```bash
systemctl restart ssh
```

> Confirme que a chave entra **numa segunda janela** antes de fechar a
> primeira. Errar aqui tranca você para fora.

#### Se você escolheu a senha

`PasswordAuthentication` tem que continuar `yes` — é assim que o Actions entra.
Em compensação, o servidor fica exposto a tentativas contínuas, e aí o fail2ban
deixa de ser opcional:

```bash
apt install -y fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled  = true
maxretry = 5
findtime = 10m
# Tempo longo de propósito: quem erra 5 vezes em 10 minutos não é você.
bantime  = 24h
EOF
systemctl enable --now fail2ban
fail2ban-client status sshd
```

E feche pelo menos o root, que é o alvo de 90% das tentativas:

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication yes
```

```bash
systemctl restart ssh
```

> Se um dia quiser migrar para chave: gere pela Opção A, apague o segredo
> `VPS_SENHA` no GitHub, crie `VPS_SSH_KEY` e volte
> `PasswordAuthentication` para `no`. Nada mais muda.

### 1.5 O diretório do painel

O banco **já existe** — o container `sendtrace-postgres`, subido pelo compose de
`/opt/sendtrace`. Este deploy **não** cria outro: sobe só a aplicação e a pluga
naquela rede.

Use uma **subpasta**, não `/opt/sendtrace` direto: o compose do banco tem o
próprio `.env` ali, e dois `.env` no mesmo diretório se atropelam.

```bash
su - deploy
mkdir -p /opt/sendtrace/painel && cd /opt/sendtrace/painel
```

Descubra o nome exato da rede do banco:

```bash
docker network ls | grep sendtrace
# normalmente "sendtrace_default"
```

Crie o `.env` — **só existe no servidor**, nunca no git:

```bash
cat > .env <<'EOF'
# ── banco que JÁ EXISTE no VPS ────────────────────────────────────
# O host é o NOME DO CONTAINER, não 127.0.0.1: dentro de um container
# 127.0.0.1 é ele mesmo, e a conexão nem sai à procura do Postgres.
DB_HOST=sendtrace-postgres
DB_PORTA=5432
DB_NOME=sendtrace
DB_USUARIO=sendtrace
DB_SENHA=<a senha do Postgres>
DOCKER_REDE_BANCO=sendtrace_default

PORT=4300
LOCK_TIMEOUT_MIN=10
TZ_PAINEL=America/Sao_Paulo
SESSAO_HORAS=12
ERROS_DETALHADOS=false

# Link dos convites por e-mail. Preencha quando o domínio existir.
PAINEL_URL=

N8N_TROCAR_LINHA_URL=https://n8n.thenorthscales.com/webhook/trocar-linha
N8N_TOKEN=<token>

IMAGEM=ghcr.io/SEU_USUARIO/sendtrace:latest
EOF
chmod 600 .env
```

> **Não ponha `ADMIN_EMAIL`/`ADMIN_SENHA`.** Eles só valem quando o banco não
> tem usuário nenhum, e o seu já tem os dois que vieram do Neon. Entre com a
> senha que você já usava lá.

Copie o `docker-compose.prod.yml` do repositório para esta pasta.

### 1.6 Firewall

```bash
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable
```

**A porta 5432 já é gerida pelo compose do banco.** Atenção a uma pegadinha:
o `ufw` **não filtra portas publicadas pelo Docker** — ele passa por baixo das
regras. Se a 5432 estiver publicada para o n8n, a proteção precisa estar numa
regra `DOCKER-USER`:

```bash
iptables -I DOCKER-USER -p tcp --dport 5432 ! -s IP_DO_N8N -j DROP
netfilter-persistent save
```

### 1.7 HTTPS na frente

O painel escuta em `127.0.0.1:4300` e **não deve** ser publicado direto: em
HTTP o cookie de sessão viaja em claro e qualquer um na rota o copia.

```bash
apt install -y nginx certbot python3-certbot-nginx
```

```nginx
# /etc/nginx/sites-available/sendtrace
server {
    server_name painel.seudominio.com;
    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # Sem este cabeçalho o painel acha que está em HTTP e não marca o
        # cookie como Secure.
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/sendtrace /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d painel.seudominio.com
```

Depois, no `.env`: `PAINEL_URL=https://painel.seudominio.com` — é o link que
vai nos convites por e-mail.

---

## 2. No GitHub

**Settings → Secrets and variables → Actions → New repository secret:**

| segredo | o que é |
|---|---|
| `VPS_HOST` | IP ou domínio do servidor |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | **opção A** — a chave privada inteira, com as linhas BEGIN/END |
| `VPS_SENHA` | **opção B** — a senha do usuário `deploy`. Crie um OU outro, não os dois. |
| `VPS_PORT` | só se o SSH não for na 22 |
| `VPS_CAMINHO` | `/opt/sendtrace/painel` |

São **quatro obrigatórios** — `VPS_HOST`, `VPS_USER`, um dos dois de
autenticação, e `VPS_CAMINHO`. O `VPS_PORT` só se o SSH não for na 22. O `GITHUB_TOKEN` que publica a imagem é gerado pelo
próprio Actions — não crie. E não há token de registry: o pacote é público
(ver abaixo).

**Settings → Environments → New environment → `producao`.** Marque *Required
reviewers* se quiser aprovar cada ida ao ar.

### Tornar o pacote público — uma vez só

O VPS baixa a imagem **sem credencial nenhuma**, então não há token de registry
para criar, guardar ou renovar.

**A ordem importa:** o pacote só pode ser tornado público **depois de existir**,
e ele nasce no primeiro push. Ou seja:

1. Faça o primeiro `git push` (seção 3). O workflow constrói e publica a
   imagem — essa parte funciona, porque quem publica é o `GITHUB_TOKEN`
   automático.
2. O passo de deploy **vai falhar**, porque o pacote nasce privado e o VPS não
   tem como se autenticar. O log do Actions diz exatamente isso e repete as
   instruções abaixo.
3. Torne o pacote público:

   **GitHub → sua foto → Packages → `sendtrace` → Package settings →
   Danger Zone → Change visibility → Public**

4. Volte ao Actions e clique em **Re-run jobs**.

Da segunda vez em diante, todo deploy funciona direto.

#### O que fica exposto

Público significa que **qualquer pessoa pode baixar a imagem e ler o código**
da aplicação.

O que **não** vai junto, e eu verifiquei no build:

- o `.env` — está no `.dockerignore`, nunca entra na imagem
- a senha do banco, o token do n8n, as credenciais de SMTP — todos vêm de
  variáveis de ambiente em tempo de execução
- o banco e os dados dos clientes — ficam no VPS

Se um dia o código virar segredo comercial, o caminho de volta é: deixar o
pacote privado, criar um Personal Access Token clássico com **apenas**
`read:packages`, guardá-lo no segredo `GHCR_TOKEN` e devolver ao workflow a
linha do `docker login` antes do `pull`.

## 3. Primeiro deploy

```bash
cd "seu-projeto"
git init && git add . && git commit -m "SendTrace"
git branch -M main
git remote add origin git@github.com:SEU_USUARIO/sendtrace.git
git push -u origin main
```

O push dispara o workflow. Acompanhe pela aba **Actions**.

> **O primeiro deploy falha de propósito**, no passo de baixar a imagem: o
> pacote nasce privado. Torne-o público (seção 2) e clique em **Re-run jobs**.
> Acontece uma vez só.

O `setup` roda sozinho no deploy. Ele **não vai criar administrador**: só faz
isso quando o banco está sem usuário nenhum, e o seu já tem os dois que vieram
do Neon. Entre com a senha que você já usava lá.

Se ninguém conseguir entrar, gere uma senha nova pelo servidor:

```bash
cd /opt/sendtrace/painel
docker compose -f docker-compose.prod.yml run --rm painel \
  npm run senha -- seu@email.com
```

---

## 4. Depois

```bash
# ver o que está rodando
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f painel

# qual versão está no ar
curl -s http://127.0.0.1:4300/api/vivo

# voltar para uma versão anterior (a tag é o SHA do commit)
IMAGEM=ghcr.io/SEU_USUARIO/sendtrace:<sha> \
  docker compose -f docker-compose.prod.yml up -d
```

### Backup do banco

O banco é do outro compose — o backup usa o container dele diretamente:

```bash
docker exec sendtrace-postgres pg_dump -U sendtrace sendtrace \
  | gzip > /opt/sendtrace/backups/sendtrace_$(date +%F).sql.gz
```

O cron diário está na sua referência do banco. **Confirme que ele existe antes
do primeiro cliente entrar** — `crontab -l`.

> `docker compose down -v` no diretório do BANCO apaga tudo. No diretório do
> painel é inofensivo (não há volume ali), mas não crie o hábito.

---

## A armadilha do 127.0.0.1

A URL que você recebeu é `postgresql://sendtrace:...@127.0.0.1:5432/sendtrace`.
Ela funciona para um processo rodando **direto no servidor** — e **não funciona
dentro de um container**: ali `127.0.0.1` é o próprio container, e a conexão
nem sai à procura do Postgres.

Por isso o compose monta a URL com **`@db:5432`**, o nome do serviço. Se um dia
o banco passar a rodar no host em vez de em container, o caminho é
`host.docker.internal` com `extra_hosts: ["host.docker.internal:host-gateway"]`.
