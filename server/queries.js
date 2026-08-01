// `pool` além de `query`: criar/apagar linha mexe em duas tabelas e precisa de
// transação, o que exige uma conexão dedicada.
import { pool, query, LOCK_TIMEOUT_MIN } from './db.js';

/**
 * Os status que significam CANCELAMENTO.
 *
 * Precisam ser reconhecidos por nome: sem esta lista eles caíam no `ELSE` do
 * ESTADO_SQL e viravam "finalizado" — quem cancelou era contado junto de quem
 * chegou ao fim da régua, e o painel afirmava que a comunicação terminou bem
 * para exatamente as pessoas em que ela não terminou.
 *
 * Comparado em minúsculas e sem espaços, porque a fila é escrita pelo n8n e
 * um 'Cancelado' com maiúscula não pode virar outro estado.
 */
const STATUS_CANCELADO = `('cancelado','cancelada','cancelled','canceled')`;

/**
 * Expressão que classifica cada linha em UM dos seis estados mutuamente
 * exclusivos. `$1` é o LOCK_TIMEOUT_MIN (minutos). Como os estados não se
 * sobrepõem, a soma deles é sempre igual ao total de pedidos — condição
 * necessária para o anel de cada nó representar parte-do-todo corretamente.
 *
 * Observação sobre 'travado': status='processando' com claimed_at NULL é uma
 * anomalia (o worker marcou como processando sem registrar o lock), então
 * também entra como travado em vez de ser silenciosamente ignorado.
 */
const ESTADO_SQL = `
  CASE
    WHEN status = 'ativo'       AND proximo_disparo <= now() THEN 'atrasado'
    WHEN status = 'ativo'                                    THEN 'em_dia'
    WHEN status = 'processando'
         AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1::int))
                                                             THEN 'travado'
    WHEN status = 'processando'                              THEN 'processando'
    WHEN lower(btrim(status)) IN ${STATUS_CANCELADO}         THEN 'cancelado'
    ELSE 'finalizado'
  END`;

/**
 * O NOME do produto, sem o código da oferta e sem a embalagem.
 *
 * A fila guarda a oferta inteira — "UP2 - NightCalm (6 Bottles)", "M3 -
 * NeuroMind Pro (6 Bottles)", "M1 - NeuroMind Pro (2 Bottles)" — e o MESMO
 * produto aparece sob meia dúzia de códigos e tamanhos. Filtrar pelo texto cru
 * obrigaria a escolher uma oferta por vez, e o painel nunca responderia "como
 * está o NeuroMind Pro": só "como está a oferta M3 dele", com os outros 42
 * pedidos do mesmo produto fora da conta.
 *
 * Três tesouras, nesta ordem: o código na frente, qualquer parêntese
 * (`(6 Bottles)`, `(3 + 3 Bottles)`) e o preço no fim (`$174`). Se não sobrar
 * nada, fica o texto original — um nome feio é melhor que um produto sem nome.
 *
 * O CÓDIGO SÓ CAI EM DOIS CASOS, e a restrição é o ponto:
 *
 *   com traço   `M1 - NeuroMind`, `BF2024 - NightCalm` — o traço já diz que o
 *               que vem antes é código. Ainda assim exige dígito no código:
 *               sem isso "Flex-ImmuneGuard" viraria "ImmuneGuard".
 *   sem traço   `UP2a Lumicept` — aqui exige DUAS letras MAIÚSCULAS antes dos
 *               dígitos. É o que salva "B12 Complex", "D3 Drops", "CoQ10 Ultra"
 *               e "Omega3 Gold": num negócio de suplemento esses são nomes de
 *               produto, não códigos de oferta, e cortá-los somaria "B12
 *               Complex" com "D3 Complex" num "Complex" só — dois produtos
 *               diferentes escondidos atrás de um número que não é de nenhum.
 *
 * O que a regra não reconhece (`PROMO - X`, `X 6 Bottles` sem parêntese) fica
 * inteiro e aparece como opção própria no seletor: erra visível e para cima,
 * nunca fundindo produtos em silêncio.
 *
 * Sem contrabarra em regex nenhuma: dentro de template string do JS, `\s`
 * viraria a letra `s` e o padrão casaria errado em silêncio. As classes POSIX
 * dizem o mesmo sem escape — é o que o resto do arquivo já usa.
 */
const NOME_PRODUTO = (alias = '') => `coalesce(nullif(btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(${alias}produto,
              '^[[:space:]]*([A-Za-z]{1,4}[0-9]+[A-Za-z]?[[:space:]]*[-:][[:space:]]*'
              || '|[A-Z]{2,4}[0-9]+[a-z]?[[:space:]]+)', ''),
            '[[:space:]]*[(][^()]*[)][[:space:]]*', ' ', 'g'),
          '[[:space:]]*[$][0-9.,]+[[:space:]]*$', ''),
        '[[:space:]]+', ' ', 'g')
    ), ''), btrim(${alias}produto))`;

/**
 * Recorte por produto, aplicado ao painel INTEIRO quando alguém escolhe um na
 * barra do topo. Nulo = todos os produtos.
 *
 * Compara o NOME (acima), não o texto cru: é assim que as ofertas do mesmo
 * produto entram no mesmo número. Igualdade exata e não ILIKE — parcial faria
 * "NeuroMind" arrastar junto qualquer "NeuroMind Sleep" que apareça amanhã.
 */
const DO_PRODUTO = (n, alias = '') =>
  `($${n}::text IS NULL OR ${NOME_PRODUTO(alias)} = $${n}::text)`;

/**
 * Predicado "esta linha recebe mensagem no canal X".
 *
 * Duas condições, e as duas importam: a etapa precisa ter mensagem ATIVA
 * naquele canal, e o pedido precisa ter o contato daquele canal. Um pedido sem
 * telefone simplesmente não recebe o SMS, por mais que a etapa mande enviar.
 *
 * `$n` é o canal ('email' | 'sms'); `alias` é o alias da fila na consulta.
 */
const RECEBE_NO_CANAL = (n, linhaN, alias = 'd') => `EXISTS (
    SELECT 1 FROM mensagens_regua m
     WHERE m.etapa = ${alias}.etapa_atual AND m.canal = $${n}::text AND m.ativo
       AND m.linha = $${linhaN}::text
       AND CASE $${n}::text
             WHEN 'email' THEN ${alias}.email    IS NOT NULL AND ${alias}.email    <> ''
             ELSE              ${alias}.telefone IS NOT NULL AND ${alias}.telefone <> ''
           END)`;

/**
 * A qual canal o erro se refere, deduzido do prefixo de `ultimo_erro`.
 *
 * A fila guarda o erro numa coluna de texto só, sem canal — mas o worker
 * escreve o canal na frente: "sms: sem telefone valido". Sem ler esse prefixo,
 * uma falha de SMS apareceria como erro TAMBÉM no e-mail, e alguém iria
 * investigar um problema de e-mail que não existe.
 *
 * Devolve NULL quando o texto não identifica o canal, e esses casos são
 * contados à parte em vez de chutados para os dois lados. `[[:>:]]` é a borda
 * de fim de palavra: sem ela, "smtp:" ou "emails não enviados" casariam.
 */
const CANAL_DO_ERRO = (alias = 'd') => `(CASE
      WHEN ${alias}.ultimo_erro ~* '^[[:space:]]*sms[[:>:]]'     THEN 'sms'
      WHEN ${alias}.ultimo_erro ~* '^[[:space:]]*e-?mail[[:>:]]' THEN 'email'
      ELSE NULL
    END)`;

/**
 * "A etapa deste pedido ENVIA neste canal" — sem olhar se ele tem contato.
 *
 * Separado de RECEBE_NO_CANAL porque as duas condições precisam ser
 * combinadas de formas opostas: quem o canal alcança é `envia AND tem
 * contato`; quem ele perde é `envia AND NÃO tem contato`. Com um predicado só
 * não dá para pedir o segundo grupo.
 */
const ENVIA_NO_CANAL = (n, linhaN, alias = 'd') => `EXISTS (
    SELECT 1 FROM mensagens_regua m
     WHERE m.etapa = ${alias}.etapa_atual AND m.canal = $${n}::text AND m.ativo
       AND m.linha = $${linhaN}::text)`;

const TEM_CONTATO = (n, alias = 'd') => `(CASE $${n}::text
        WHEN 'email' THEN (${alias}.email    IS NOT NULL AND ${alias}.email    <> '')
        WHEN 'sms'   THEN (${alias}.telefone IS NOT NULL AND ${alias}.telefone <> '')
        -- sem canal escolhido, "tem contato" = tem os dois
        ELSE (${alias}.email    IS NOT NULL AND ${alias}.email    <> ''
          AND ${alias}.telefone IS NOT NULL AND ${alias}.telefone <> '')
      END)`;

/**
 * A régua completa: cadência (etapas_regua) + copy por canal (mensagens_regua).
 * Fonte única, compartilhável com o n8n.
 *
 * Cada etapa dispara E-MAIL E SMS ao mesmo tempo, então `mensagens` vem como
 * lista — não existe "o canal da etapa". Se as tabelas ainda não existem
 * (antes do `npm run setup`), devolvemos null em vez de estourar: o painel
 * avisa na tela e cai na descoberta automática.
 */
export async function reguaDefinicao(linha = '1') {
  const existe = await query(
    `SELECT to_regclass('public.etapas_regua')    IS NOT NULL AS etapas,
            to_regclass('public.mensagens_regua') IS NOT NULL AS mensagens`,
  );
  if (!existe.rows[0].etapas) return null;

  const temMensagens = existe.rows[0].mensagens;
  const { rows } = await query(
    `SELECT e.etapa::int AS etapa, e.nome, e.descricao, e.ativo,
            e.espera_h::float8 AS espera_h,
            ${temMensagens ? 'e.offset_h::float8' : 'NULL::float8'} AS offset_h,
            ${temMensagens ? `coalesce((
              SELECT json_agg(json_build_object(
                       'canal', m.canal, 'assunto', m.assunto, 'texto', m.texto,
                       'botao', m.botao, 'destino', m.destino, 'ativo', m.ativo,
                       'linha', m.linha, 'corpo_html', m.corpo_html)
                     ORDER BY m.canal)
              FROM mensagens_regua m
              WHERE m.etapa = e.etapa AND m.linha = $1::text
            ), '[]'::json)` : `'[]'::json`} AS mensagens
     FROM etapas_regua e
     ORDER BY e.etapa`,
    temMensagens ? [String(linha)] : [],
  );
  return rows;
}

/**
 * Nome, propósito e volume de copy de cada linha — alimenta as abas.
 *
 * O nome importa: "Linha 2" não diz nada a quem precisa escolher qual ativar,
 * "Ciência" diz. Cada linha é uma estratégia diferente para o mesmo funil, não
 * uma variação de texto.
 */
export async function resumoLinhas() {
  const existe = await query(
    `SELECT to_regclass('public.mensagens_regua')   IS NOT NULL AS msgs,
            to_regclass('public.painel_linhas_copy') IS NOT NULL AS rotulos`,
  );
  if (!existe.rows[0].msgs) return {};

  if (!existe.rows[0].rotulos) {
    const { rows } = await query(
      `SELECT linha, NULL::text AS nome, NULL::text AS intuito,
              count(*)::int AS mensagens, count(DISTINCT etapa)::int AS etapas
       FROM mensagens_regua WHERE ativo GROUP BY linha ORDER BY linha`,
    );
    return Object.fromEntries(rows.map((r) => [r.linha, r]));
  }

  /*
   * `prontos` usa a MESMA regra do webhook para decidir se a linha pode ser
   * ativada: um e-mail só conta com assunto E corpo preenchidos; um SMS, com
   * texto. Repetir a regra aqui é o que permite o painel avisar "faltam 2
   * e-mails" antes de você clicar e levar um 400 do n8n.
   */
  const { rows } = await query(
    `SELECT l.linha, l.nome, l.intuito, l.ordem,
            (SELECT count(*)::int FROM mensagens_regua m
              WHERE m.linha = l.linha AND m.ativo) AS mensagens,
            (SELECT count(DISTINCT m.etapa)::int FROM mensagens_regua m
              WHERE m.linha = l.linha AND m.ativo) AS etapas,
            (SELECT count(*)::int FROM mensagens_regua m
              WHERE m.linha = l.linha AND m.canal = 'email' AND m.ativo
                AND coalesce(m.assunto, '') <> '' AND coalesce(m.corpo_html, '') <> ''
            ) AS emails_prontos,
            (SELECT count(*)::int FROM mensagens_regua m
              WHERE m.linha = l.linha AND m.canal = 'sms' AND m.ativo
                AND coalesce(m.texto, '') <> ''
            ) AS sms_prontos,
            (SELECT count(*)::int FROM etapas_regua e WHERE e.ativo) AS etapas_exigidas
     FROM painel_linhas_copy l
     ORDER BY l.ordem, l.linha`,
  );
  return Object.fromEntries(rows.map((r) => [r.linha, {
    ...r,
    completa: r.emails_prontos >= r.etapas_exigidas && r.sms_prontos >= r.etapas_exigidas,
  }]));
}

/**
 * Registra uma linha nova e, opcionalmente, copia a copy de outra.
 *
 * Copiar é o caminho normal: uma linha em branco são 12 mensagens para
 * escrever do zero antes de poder ativar. Partindo de uma existente, você
 * edita o que quer mudar — e a linha já nasce completa.
 *
 * Tudo numa transação: uma linha registrada com metade das mensagens copiadas
 * seria pior que nenhuma linha.
 */
export async function criarLinha({ linha, nome, intuito, ordem, copiarDe }) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    await cliente.query(
      `INSERT INTO painel_linhas_copy (linha, nome, intuito, ordem)
       VALUES ($1::text, $2, $3, $4::smallint)`,
      [String(linha), nome, intuito || null, ordem],
    );

    let copiadas = 0;
    if (copiarDe) {
      const r = await cliente.query(
        `INSERT INTO mensagens_regua
           (etapa, canal, linha, assunto, corpo_html, botao, destino, texto, ativo, atualizado_em)
         SELECT etapa, canal, $1::text, assunto, corpo_html, botao, destino, texto, ativo, now()
         FROM mensagens_regua WHERE linha = $2::text
         ON CONFLICT (etapa, canal, linha) DO NOTHING`,
        [String(linha), String(copiarDe)],
      );
      copiadas = r.rowCount;
    }

    await cliente.query('COMMIT');
    return { linha: String(linha), copiadas };
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

/**
 * Edita nome, intuito e ordem de uma linha. NÃO mexe no número: ele é a chave
 * que o webhook usa para ativar e que as mensagens referenciam.
 */
export async function editarLinha(linha, { nome, intuito, ordem }) {
  const { rows } = await query(
    `UPDATE painel_linhas_copy
        SET nome    = coalesce($2, nome),
            intuito = coalesce($3, intuito),
            ordem   = coalesce($4::smallint, ordem)
      WHERE linha = $1::text
      RETURNING linha, nome, intuito, ordem`,
    [String(linha), nome ?? null, intuito ?? null,
      Number.isInteger(ordem) ? ordem : null],
  );
  return rows[0] ?? null;
}

/**
 * Apaga uma linha e as mensagens dela.
 *
 * Recusa a linha ATIVA: apagá-la deixaria o robô lendo uma copy que não existe
 * mais, e o próximo disparo sairia vazio ou falharia. A verificação é feita
 * dentro da transação, contra o config_disparos — não contra o que a tela
 * achava que estava ativo quando carregou.
 */
export async function apagarLinha(linha) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const { rows } = await cliente.query(
      `SELECT valor FROM config_disparos WHERE chave = 'linha_ativa'`,
    );
    if (rows[0]?.valor === String(linha)) {
      await cliente.query('ROLLBACK');
      return { ok: false, erro: 'Esta é a linha que está no ar. Ative outra antes de apagá-la.' };
    }

    await cliente.query('DELETE FROM mensagens_regua WHERE linha = $1::text', [String(linha)]);
    const r = await cliente.query(
      'DELETE FROM painel_linhas_copy WHERE linha = $1::text', [String(linha)],
    );
    await cliente.query('COMMIT');

    if (!r.rowCount) return { ok: false, erro: 'Linha não encontrada.' };
    return { ok: true };
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

/** As etapas ativas da régua — o que uma linha precisa cobrir para ser ativável. */
export async function etapasDaRegua() {
  const { rows } = await query(
    `SELECT etapa::int AS etapa, nome, offset_h::float8 AS offset_h, ativo
     FROM etapas_regua ORDER BY etapa`,
  );
  return rows;
}

/** Uma mensagem específica, com tudo que o editor precisa. */
export async function mensagem(linha, etapa, canal) {
  const { rows } = await query(
    `SELECT m.etapa::int AS etapa, m.canal, m.linha, m.assunto, m.corpo_html,
            m.botao, m.destino, m.texto, m.ativo, m.atualizado_em,
            e.nome AS nome_etapa, e.offset_h::float8 AS offset_h
     FROM mensagens_regua m
     JOIN etapas_regua e ON e.etapa = m.etapa
     WHERE m.linha = $1::text AND m.etapa = $2::smallint AND m.canal = $3::text`,
    [String(linha), etapa, canal],
  );
  return rows[0] ?? null;
}

/**
 * Grava uma mensagem. UPSERT pela chave (etapa, canal, linha) — o mesmo
 * caminho serve para criar e para editar, que é como o contrato do robô
 * define. `atualizado_em` sempre recebe now().
 *
 * ATENÇÃO: a linha precisa existir em painel_linhas_copy (há FK). O erro de
 * chave estrangeira é traduzido na camada da rota.
 */
export async function salvarMensagem({
  linha, etapa, canal, assunto, corpo_html: corpo, botao, destino, texto, ativo,
}) {
  const eEmail = canal === 'email';
  const { rows } = await query(
    `INSERT INTO mensagens_regua
       (etapa, canal, linha, assunto, corpo_html, botao, destino, texto, ativo, atualizado_em)
     VALUES ($1::smallint, $2::text, $3::text, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (etapa, canal, linha) DO UPDATE SET
       assunto = EXCLUDED.assunto,
       corpo_html = EXCLUDED.corpo_html,
       botao = EXCLUDED.botao,
       destino = EXCLUDED.destino,
       texto = EXCLUDED.texto,
       ativo = EXCLUDED.ativo,
       atualizado_em = now()
     RETURNING etapa::int AS etapa, canal, linha, assunto, corpo_html,
               botao, destino, texto, ativo, atualizado_em`,
    [
      etapa, canal, String(linha),
      // No SMS estes campos não existem: gravar string vazia deixaria lixo que
      // depois conta como "preenchido" em qualquer verificação.
      eEmail ? (assunto ?? null) : null,
      eEmail ? (corpo ?? null) : null,
      eEmail ? (botao ?? null) : null,
      eEmail ? (destino ?? null) : null,
      texto ?? '',
      ativo !== false,
    ],
  );
  return rows[0];
}

/**
 * Cadência OBSERVADA: mediana de (proximo_disparo − criado_em) por etapa, em
 * horas. É o atraso acumulado real desde a entrada na fila até a mensagem
 * daquela etapa — o que o worker está de fato fazendo.
 *
 * Comparada com a soma dos `espera_h` configurados, revela deriva entre a
 * régua que está escrita e a régua que está rodando. Só linhas 'ativo' entram:
 * nas demais o `proximo_disparo` é resíduo do último agendamento.
 */
export async function cadenciaObservada(produto = null) {
  const { rows } = await query(
    `
    SELECT etapa_atual::int AS etapa,
           count(*)::int    AS amostra,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM (proximo_disparo - criado_em)) / 3600.0
           ) AS mediana_h
    FROM disparos_pos_venda
    WHERE status = 'ativo'
      AND ${DO_PRODUTO(1)}
    GROUP BY 1
    ORDER BY 1
    `,
    [produto],
  );
  return rows;
}

/**
 * O catálogo de produtos que existe na fila, com quantos pedidos cada um tem.
 *
 * Agrupa pelo NOME: as quatro ofertas de NeuroMind Pro viram uma opção só, com
 * os pedidos das quatro somados. O seletor lista produtos, não SKUs — quem olha
 * o painel quer saber do produto.
 *
 * Sai da própria `disparos_pos_venda`: não existe cadastro de produtos em lugar
 * nenhum, e uma lista fixa no código envelheceria no primeiro lançamento.
 * Deliberadamente NÃO respeita o filtro de produto — é a lista de onde se
 * escolhe, e filtrá-la deixaria só a opção já escolhida.
 */
export async function produtosDaFila() {
  const { rows } = await query(
    `SELECT nome AS produto, count(*)::int AS total
     FROM (
       SELECT ${NOME_PRODUTO()} AS nome
       FROM disparos_pos_venda
       WHERE produto IS NOT NULL AND btrim(produto) <> ''
     ) t
     GROUP BY nome
     ORDER BY count(*) DESC, nome
     LIMIT 300`,
  );
  return rows;
}

/**
 * ALCANCE por canal. Como toda etapa dispara e-mail e SMS ao mesmo tempo, a
 * pergunta deixou de ser "qual o canal desta etapa" e passou a ser: no próximo
 * disparo, quantos este canal de fato ALCANÇA?
 *
 * Duas perdas diferentes, contadas separadamente porque se resolvem de formas
 * diferentes:
 *   sem_contato    o pedido não tem e-mail / telefone → falta dado do comprador
 *   sem_mensagem   a etapa não tem copy ativa no canal → falta cadastro na régua
 *
 * O JOIN multiplica cada pedido por canal, e isso é o certo aqui: um pedido na
 * etapa 2 gera uma linha de e-mail e uma de SMS. Cada canal fecha sozinho.
 */
export async function porCanal(linha = '1', produto = null) {
  const existe = await query(`SELECT to_regclass('public.mensagens_regua') IS NOT NULL AS ok`);
  if (!existe.rows[0].ok) return [];

  const TEM_CONTATO = `CASE c.canal
        WHEN 'email' THEN d.email    IS NOT NULL AND d.email    <> ''
        ELSE              d.telefone IS NOT NULL AND d.telefone <> ''
      END`;

  // CROSS JOIN com a lista fixa de canais + EXISTS, em vez de JOIN direto na
  // mensagens_regua. Com três linhas por (etapa, canal), o JOIN multiplicaria
  // cada pedido por três e TODAS as contagens sairiam infladas.
  const { rows } = await query(
    `
    SELECT c.canal,
           count(*)::int                                             AS total,
           count(*) FILTER (WHERE ${TEM_CONTATO})::int                AS alcancavel,
           count(*) FILTER (WHERE NOT ${TEM_CONTATO})::int            AS sem_contato,
           count(*) FILTER (WHERE ${ESTADO_SQL} = 'em_dia')::int      AS em_dia,
           count(*) FILTER (WHERE ${ESTADO_SQL} = 'atrasado')::int    AS atrasado,
           count(*) FILTER (WHERE ${ESTADO_SQL} = 'processando')::int AS processando,
           count(*) FILTER (WHERE ${ESTADO_SQL} = 'travado')::int     AS travado,
           -- Só os erros DESTE canal. Uma falha de SMS não é problema do
           -- e-mail, e contá-la nos dois mandaria alguém caçar um defeito de
           -- e-mail que nunca existiu.
           count(*) FILTER (WHERE ${CANAL_DO_ERRO('d')} = c.canal)::int AS com_erro
    FROM disparos_pos_venda d
    CROSS JOIN (VALUES ('email'), ('sms')) AS c(canal)
    WHERE d.status IN ('ativo', 'processando')
      AND ${DO_PRODUTO(3, 'd.')}
      AND EXISTS (
        SELECT 1 FROM mensagens_regua m
         WHERE m.etapa = d.etapa_atual AND m.canal = c.canal
           AND m.ativo AND m.linha = $2::text)
    GROUP BY c.canal
    ORDER BY total DESC, c.canal
    `,
    [LOCK_TIMEOUT_MIN, String(linha), produto],
  );
  return rows;
}

/**
 * Quantos estão parados numa etapa que não tem NENHUMA mensagem ativa
 * cadastrada — some do recorte por canal, então precisa aparecer em algum
 * lugar. É o caso do n8n ter avançado para uma etapa fora da régua, ou de
 * alguém ter desativado as duas mensagens com gente parada ali.
 */
/**
 * Erros cujo texto não diz a qual canal pertencem.
 *
 * Somem do recorte por canal, então precisam aparecer em algum lugar — senão
 * a soma dos dois canais fica menor que o total de erros e ninguém entende por
 * quê. Se este número crescer, vale pedir ao worker que prefixe o canal.
 */
export async function errosSemCanal(produto = null) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
     FROM disparos_pos_venda d
     WHERE d.status IN ('ativo', 'processando')
       AND d.ultimo_erro IS NOT NULL
       AND ${DO_PRODUTO(1, 'd.')}
       AND ${CANAL_DO_ERRO('d')} IS NULL`,
    [produto],
  );
  return rows[0].n;
}

export async function semMensagem(linha = '1', produto = null) {
  const existe = await query(`SELECT to_regclass('public.mensagens_regua') IS NOT NULL AS ok`);
  if (!existe.rows[0].ok) return 0;

  const { rows } = await query(
    `SELECT count(*)::int AS n
     FROM disparos_pos_venda d
     WHERE d.status IN ('ativo', 'processando')
       AND ${DO_PRODUTO(2, 'd.')}
       AND NOT EXISTS (
         SELECT 1 FROM mensagens_regua m
          WHERE m.etapa = d.etapa_atual AND m.ativo AND m.linha = $1::text)`,
    [String(linha), produto],
  );
  return rows[0].n;
}

/** Consolidado por etapa — é o que alimenta os nós do canvas. */
export async function etapasRollup(produto = null) {
  const { rows } = await query(
    `
    SELECT
      etapa_atual::int                                              AS etapa,
      count(*)::int                                                 AS total,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'em_dia')::int         AS em_dia,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'atrasado')::int       AS atrasado,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'processando')::int    AS processando,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'travado')::int        AS travado,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'finalizado')::int     AS finalizado,
      count(*) FILTER (WHERE ${ESTADO_SQL} = 'cancelado')::int      AS cancelado,
      count(*) FILTER (WHERE ultimo_erro IS NOT NULL)::int          AS com_erro,
      count(*) FILTER (WHERE tentativas > 0)::int                   AS com_retry,
      count(*) FILTER (WHERE criado_em >= now() - interval '24 hours')::int AS novos_24h,
      -- quantos desta etapa disparam na próxima hora: é o que "vai andar" para
      -- a etapa seguinte, e o que define a intensidade da conexão animada.
      -- O piso "> now()" é essencial: sem ele todo vencido entraria aqui, e com
      -- o worker parado o painel diria "N disparam na próxima hora" ao lado do
      -- KPI "N atrasados, horário já passou" — os mesmos N, duas afirmações
      -- incompatíveis, com a conexão animando tráfego máximo num cano parado.
      count(*) FILTER (
        WHERE status = 'ativo'
          AND proximo_disparo >  now()
          AND proximo_disparo <= now() + interval '1 hour'
      )::int                                                        AS prestes,
      min(proximo_disparo) FILTER (WHERE status = 'ativo')          AS proximo_em,
      coalesce(max(tentativas), 0)::int                             AS max_tentativas
    FROM disparos_pos_venda
    WHERE ${DO_PRODUTO(2)}
    GROUP BY etapa_atual
    ORDER BY etapa_atual
    `,
    [LOCK_TIMEOUT_MIN, produto],
  );
  return rows;
}

/**
 * Micro-histograma por etapa: distribuição dos próximos disparos em 12 baldes
 * de 4h ao longo das próximas 48h. Mostra a ONDA FUTURA de cada etapa.
 *
 * Deliberadamente NÃO usamos criado_em aqui: criado_em é quando o pedido
 * entrou na fila (etapa 0), não quando entrou na etapa atual — a tabela não
 * guarda histórico de transições, então um "entradas por etapa" seria mentira.
 */
export async function ondaPorEtapa(produto = null) {
  const { rows } = await query(
    `
    SELECT
      etapa_atual::int AS etapa,
      width_bucket(
        extract(epoch FROM (proximo_disparo - now())) / 3600.0, 0, 48, 12
      )::int AS balde,
      count(*)::int AS total
    FROM disparos_pos_venda
    WHERE status = 'ativo'
      AND proximo_disparo >  now()
      AND proximo_disparo <= now() + interval '48 hours'
      AND ${DO_PRODUTO(1)}
    GROUP BY 1, 2
    ORDER BY 1, 2
    `,
    [produto],
  );
  return rows;
}

/**
 * Onda global de disparos, hora a hora, nas próximas 48h.
 *
 * Filtrável por etapa e por canal. O filtro de canal é o que responde "quando
 * sai SMS": não basta a etapa mandar enviar, o pedido precisa ter telefone —
 * é o mesmo predicado do card de alcance, então os dois números batem.
 */
export async function ondaHoraria({
  etapa = null, canal = null, linha = '1', produto = null,
} = {}) {
  const { rows } = await query(
    `
    SELECT date_trunc('hour', d.proximo_disparo) AS hora, count(*)::int AS total
    FROM disparos_pos_venda d
    WHERE d.status = 'ativo'
      AND d.proximo_disparo >= date_trunc('hour', now())
      AND d.proximo_disparo <  now() + interval '48 hours'
      AND ($1::int  IS NULL OR d.etapa_atual = $1::int)
      AND ($2::text IS NULL OR ${RECEBE_NO_CANAL(2, 3)})
      AND ${DO_PRODUTO(4, 'd.')}
    GROUP BY 1
    ORDER BY 1
    `,
    [etapa, canal, String(linha), produto],
  );
  return rows;
}

/**
 * Entradas na régua por dia (últimos 14 dias).
 *
 * O corte do dia é feito no fuso do painel, não no do banco: o Neon roda em
 * UTC, então sem `AT TIME ZONE` tudo que entrasse entre 21h e 00h no Brasil
 * seria contado no dia seguinte. Devolvemos 'YYYY-MM-DD' como texto para o
 * navegador não reinterpretar a data e deslocá-la de novo.
 */
export async function entradasPorDia({
  etapa = null, canal = null, linha = '1', produto = null,
} = {}) {
  const tz = process.env.TZ_PAINEL || 'America/Sao_Paulo';
  const { rows } = await query(
    `
    SELECT to_char(date_trunc('day', d.criado_em AT TIME ZONE $1), 'YYYY-MM-DD') AS dia,
           count(*)::int AS total
    FROM disparos_pos_venda d
    WHERE d.criado_em >= date_trunc('day', (now() AT TIME ZONE $1) - interval '13 days') AT TIME ZONE $1
      AND ($2::int  IS NULL OR d.etapa_atual = $2::int)
      AND ($3::text IS NULL OR ${RECEBE_NO_CANAL(3, 4)})
      AND ${DO_PRODUTO(5, 'd.')}
    GROUP BY 1
    ORDER BY 1
    `,
    [tz, etapa, canal, String(linha), produto],
  );
  return rows;
}

/**
 * O nome e o produto MAIS LONGOS da fila.
 *
 * Serve para medir o SMS pelo pior caso real em vez de por uma amostra
 * otimista. Como o comprimento cresce junto com o que entra no lugar do
 * marcador, o maior nome + o maior produto dão o teto — e é esse teto que
 * decide se a mensagem vira dois segmentos e custa o dobro.
 *
 * Um nome curto e um produto curto fariam o painel dizer "1 segmento" para
 * uma mensagem que, no cliente real, sai em dois.
 */
export async function piorCasoSms(produto = null) {
  const { rows } = await query(
    `SELECT
       (SELECT split_part(trim(nome), ' ', 1) FROM disparos_pos_venda
         WHERE nome IS NOT NULL AND trim(nome) <> ''
           AND ${DO_PRODUTO(1)}
         ORDER BY length(split_part(trim(nome), ' ', 1)) DESC LIMIT 1) AS nome,
       (SELECT produto FROM disparos_pos_venda
         WHERE produto IS NOT NULL AND trim(produto) <> ''
           AND ${DO_PRODUTO(1)}
         ORDER BY length(produto) DESC LIMIT 1) AS produto`,
    [produto],
  );
  return {
    nome: rows[0]?.nome ?? null,
    produto: rows[0]?.produto ?? null,
  };
}

/** Distribuição bruta de status — descobre valores que não conhecemos de antemão. */
export async function statusBruto(produto = null) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS total
     FROM disparos_pos_venda
     WHERE ${DO_PRODUTO(1)}
     GROUP BY status ORDER BY total DESC, status`,
    [produto],
  );
  return rows;
}

/** Fila de problemas: erros registrados e itens presos no worker. */
export async function alertas(produto = null) {
  const { rows } = await query(
    `
    SELECT id, transacao_id, nome, produto, etapa_atual::int AS etapa, status,
           tentativas, ultimo_erro, proximo_disparo, claimed_at, criado_em,
           ${ESTADO_SQL} AS estado,
           ${CANAL_DO_ERRO('disparos_pos_venda')} AS canal_erro
    FROM disparos_pos_venda
    WHERE ${DO_PRODUTO(2)}
      AND (ultimo_erro IS NOT NULL
        OR (status = 'processando'
            AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1::int)))
        OR (status = 'ativo' AND proximo_disparo <= now() - interval '1 hour'))
    ORDER BY tentativas DESC, proximo_disparo ASC
    LIMIT 25
    `,
    [LOCK_TIMEOUT_MIN, produto],
  );
  return rows;
}

/**
 * Drill-down paginado com filtros.
 *
 * `estado` aceita os seis estados e mais o pseudo-estado 'na_regua' = tudo que
 * ainda circula. Ele existe porque o número que o nó exibe é `na_etapa`; filtrar
 * só por etapa traria junto os finalizados e os cancelados que pararam ali, e a
 * tabela contradiria o número que acabou de ser clicado.
 */
export async function listarPedidos({
  etapa, estado, canal, problema, busca, limit, offset, ordem, linha = '1',
  produto = null,
}) {
  const ORDENS = {
    proximo: 'proximo_disparo ASC NULLS LAST',
    recente: 'criado_em DESC',
    tentativas: 'tentativas DESC, proximo_disparo ASC',
  };
  const orderBy = ORDENS[ordem] ?? ORDENS.proximo;

  // $1 lock · $2 etapa · $3 estado · $4 busca · $5 canal · $6 linha
  // · $7 problema · $8 produto · $9 limit · $10 offset
  const params = [LOCK_TIMEOUT_MIN, etapa, estado, busca, canal, String(linha),
    problema, produto, limit, offset];

  const base = `
    FROM (
      SELECT *, ${ESTADO_SQL} AS estado
      FROM disparos_pos_venda
    ) t
    WHERE ($2::int  IS NULL OR t.etapa_atual = $2::int)
      -- 'na_regua' = ainda em circulação. Cancelado sai daqui junto com o
      -- finalizado: os dois saíram da régua, só que por motivos opostos.
      AND ($3::text IS NULL
           OR ($3::text = 'na_regua' AND t.estado NOT IN ('finalizado', 'cancelado'))
           OR t.estado = $3::text)
      AND ${DO_PRODUTO(8, 't.')}
      AND ($4::text IS NULL OR (
              t.transacao_id ILIKE '%' || $4 || '%'
           OR t.nome         ILIKE '%' || $4 || '%'
           OR t.email        ILIKE '%' || $4 || '%'
           OR t.telefone     ILIKE '%' || $4 || '%'
           OR t.produto      ILIKE '%' || $4 || '%'))
      -- O canal significa "a etapa ENVIA neste canal", sem exigir contato —
      -- a MESMA definição que o card de alcance usa para contar. Com a
      -- definição antiga ("alcança"), clicar em "1 com erro" no card do SMS
      -- devolvia 0 quando o pedido com erro não tinha telefone: o card
      -- prometia um número e a tabela entregava outro.
      AND ($5::text IS NULL OR ${ENVIA_NO_CANAL(5, 6, 't')})

      -- "IS DISTINCT FROM", e não "=" negado: com $7 nulo, uma comparação
      -- comum devolve NULL, o WHERE trata NULL como falso, e a tabela SEM
      -- FILTRO NENHUM esconderia quase todas as linhas.
      -- Com um canal escolhido, só os erros DAQUELE canal — a mesma regra que
      -- o card usa para contar, senão o número clicado e a lista divergem.
      AND ($7::text IS DISTINCT FROM 'com_erro'
           OR (t.ultimo_erro IS NOT NULL
               AND ($5::text IS NULL OR ${CANAL_DO_ERRO('t')} = $5::text)))
      AND ($7::text IS DISTINCT FROM 'com_contato' OR ${TEM_CONTATO(5, 't')})
      AND ($7::text IS DISTINCT FROM 'sem_contato' OR NOT ${TEM_CONTATO(5, 't')})`;

  const [dados, cont] = await Promise.all([
    query(
      `SELECT t.id, t.transacao_id, t.nome, t.email, t.telefone, t.produto,
              t.etapa_atual::int AS etapa, t.status, t.estado, t.tentativas,
              t.ultimo_erro, t.proximo_disparo, t.claimed_at, t.criado_em
       ${base}
       ORDER BY ${orderBy}
       LIMIT $9::int OFFSET $10::int`,
      params,
    ),
    // A contagem não usa limit/offset: passa só até o último `$` que o `base`
    // referencia ($8 = produto), senão o Postgres recusa parâmetro sobrando.
    query(`SELECT count(*)::int AS n ${base}`, params.slice(0, 8)),
  ]);

  return { pedidos: dados.rows, total: cont.rows[0].n };
}
