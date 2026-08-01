# ═══════════════════════════════════════════════════════════════════════════
#  SendTrace — imagem da aplicação
#
#  O BANCO É EXTERNO (Neon). Esta imagem não sobe Postgres nenhum: ela só
#  precisa de DATABASE_URL apontando para o seu banco.
#
#  Duas etapas: a primeira resolve as dependências, a segunda monta a imagem
#  final sem levar junto o cache do npm nem as ferramentas de build.
# ═══════════════════════════════════════════════════════════════════════════

# A MESMA versão que roda em desenvolvimento (node -v), fixada até o patch.
# Uma tag flutuante como `node:24` muda por baixo a cada rebuild, e aí o
# container roda um Node que ninguém testou na máquina de ninguém. Quando
# atualizar o Node local, atualize aqui — é o único lugar.
ARG NODE_VERSAO=24.18.0

# ── etapa 1: dependências ──────────────────────────────────────────────────
FROM node:${NODE_VERSAO}-alpine AS deps

WORKDIR /app

# Só os manifestos primeiro. Enquanto eles não mudarem, o Docker reaproveita
# esta camada e não baixa nada de novo a cada alteração no código.
COPY package.json package-lock.json ./

# `npm ci` (não `install`): instala exatamente o que está no lock, sem
# reescrevê-lo. `--omit=dev` deixa fora o que só serve para desenvolver.
RUN npm ci --omit=dev && npm cache clean --force

# ── etapa 2: imagem final ──────────────────────────────────────────────────
FROM node:${NODE_VERSAO}-alpine

# curl é usado pelo HEALTHCHECK. Sem ele o healthcheck falharia sempre e o
# container seria marcado como não saudável mesmo funcionando.
RUN apk add --no-cache curl

WORKDIR /app

ENV NODE_ENV=production \
    # Dentro do container o servidor PRECISA escutar em todas as interfaces.
    # Com 127.0.0.1 ele só responderia ao loopback do próprio container e o
    # mapeamento de porta não alcançaria nada — o erro nº 1 ao containerizar.
    HOST=0.0.0.0 \
    PORT=4300

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY api ./api
COPY public ./public

# Roda como usuário sem privilégio. A imagem do Node já traz o usuário `node`;
# se algum dia houver execução de código indevida, ela não começa como root.
USER node

EXPOSE 4300

# Testa o sinal de vida, que não consulta o banco. Um healthcheck que
# dependesse do Postgres reiniciaria o container toda vez que o Neon
# hibernasse — e reiniciar não acorda banco nenhum.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/vivo" || exit 1

# A MESMA imagem serve as duas pontas: o padrão sobe o painel (front), e o
# serviço `api` do compose sobrepõe o comando com `npm run api`. Uma imagem
# por processo dobraria o build e o registro para separar o que muda junto.
#
# O processo trata SIGINT/SIGTERM e fecha o pool antes de sair; com `init: true`
# no compose, ele ainda ganha um PID 1 que recolhe processos órfãos.
CMD ["npm", "start"]
