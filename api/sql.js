/**
 * As expressões SQL que definem o VOCABULÁRIO do SendTrace.
 *
 * Estão num arquivo só porque cada uma responde a uma pergunta que precisa ter
 * a mesma resposta em toda rota: "este pedido está atrasado?", "qual o nome
 * deste produto?", "de qual canal é este erro?". Duas definições de estado em
 * lugares diferentes viram dois números diferentes na mesma tela.
 */

/**
 * Os status que significam CANCELAMENTO.
 *
 * Sem esta lista eles cairiam no `ELSE` e virariam "finalizado" — quem cancelou
 * contado junto de quem chegou ao fim, afirmando que a comunicação deu certo
 * justamente com quem desistiu. Comparado em minúsculas porque a fila é escrita
 * pelo n8n, e um 'Cancelado' com maiúscula não pode virar outro estado.
 */
export const STATUS_CANCELADO = `('cancelado','cancelada','cancelled','canceled')`;

/**
 * Classifica cada pedido em UM dos seis estados. `$1` é o limite do lock, em
 * minutos. Como não se sobrepõem, a soma deles é sempre o total de pedidos — é
 * isso que permite desenhar cada nó do painel como parte-do-todo honesta.
 *
 * 'travado' inclui `processando` com `claimed_at` nulo: é anomalia (o worker
 * marcou sem registrar o lock) e some se for ignorada.
 */
export const ESTADO = `
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
 * A fila guarda a oferta inteira — "M3 - NeuroMind Pro (6 Bottles)", "UP1 -
 * NeuroMind Pro (6 Bottles)" — e o mesmo produto aparece sob vários códigos e
 * tamanhos. Sem juntá-los, uma pergunta sobre "NeuroMind Pro" responderia sobre
 * uma oferta só, com o resto do produto fora da conta.
 *
 * O corte do código é conservador: só cai com traço (exigindo dígito, senão
 * "Flex-ImmuneGuard" viraria "ImmuneGuard") ou com duas MAIÚSCULAS mais dígito
 * sem traço ("UP2a"). É o que salva "B12 Complex", "D3 Drops" e "CoQ10 Ultra" —
 * cortá-los somaria "B12 Complex" com "D3 Complex" num "Complex" só.
 *
 * Sem contrabarra em regex nenhuma: dentro de template string do JS, `\s`
 * viraria a letra `s` e o padrão casaria errado em silêncio.
 */
export const NOME_PRODUTO = (alias = '') => `coalesce(nullif(btrim(
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
 * O produto SEM a embalagem: "Memovance Pro 12 Bottles", "MemoVance Pro 6 Bottles (Last Chance)" e "Memovance PRO 2 Bottles"
 * viram o mesmo "Memovance Pro". Corta o código da oferta (NOME_PRODUTO) e tudo a partir de "N bottles/potes".
 */
export const BASE_PRODUTO = (alias = '') => `btrim(regexp_replace(${NOME_PRODUTO(alias)},
      '[[:space:]]*[-:]?[[:space:]]*[0-9]+[[:space:]]*(bottles?|potes?|pots?|frascos?)([^[:alpha:]].*)?$', '', 'i'))`;

/**
 * Chave de agrupamento do produto na aba Rastreio: minúscula, sem espaço nem pontuação ("memovancepro"), sem os prefixos de oferta que
 * o NOME_PRODUTO deixa passar ("M3 ", "UP1A ", "DS2.1 - ", "FE - ", "AFF - "). Kits com "+" (e "bundle"/"kit") caem em 'combos' (o "+ 2 Bottles FREE" de bônus não conta); "Produto - Outro Nome" fica só com o primeiro nome; o que sobra sem nome vira
 * 'outros'; pedido sem produto fica NULL. Vale para os pedidos de front e para os de origem da FullStack (rastreio_pedido_d), que não têm slug.
 * Sem contrabarra em regex (template string do JS).
 */
export const CHAVE_PRODUTO = (alias = '') => `CASE
      WHEN nullif(btrim(${alias}produto), '') IS NULL THEN NULL
      WHEN ${BASE_PRODUTO(alias)} LIKE '%+%' THEN 'combos'
      WHEN lower(${alias}produto) ~ '[[:<:]](bundle|kit)[[:>:]]' THEN 'combos'
      ELSE coalesce(nullif(regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(${BASE_PRODUTO(alias)}),
                   '^((m|up|ds|dn|dw)[0-9][0-9a-z.]*|fe|aff)([[:space:]]+-[[:space:]]+|[[:space:]]+)', ''),
                 '^((m|up|ds|dn|dw)[0-9][0-9a-z.]*|fe|aff)([[:space:]]+-[[:space:]]+|[[:space:]]+)', ''),
               '[[:space:]]+-[[:space:]]+.*$', ''),
             '[^a-z0-9]', '', 'g'), ''), 'outros')
    END`;

/** Recorte por produto: compara o NOME, para as ofertas caírem no mesmo número. */
export const DO_PRODUTO = (n, alias = '') =>
  `($${n}::text IS NULL OR ${NOME_PRODUTO(alias)} = $${n}::text)`;

/**
 * Recorte por plataforma de venda (DigiStore24, JVZoo, BuyGoods…).
 *
 * Igualdade exata sobre o valor gravado (aparado de espaços): o catálogo é
 * montado do que existe na fila, então o que se escolhe é o que está lá. Um
 * pedido sem plataforma nunca casa com recorte nenhum.
 */
export const DA_PLATAFORMA = (n, alias = '') =>
  `($${n}::text IS NULL OR btrim(${alias}plataforma) = $${n}::text)`;

/**
 * A qual canal o erro pertence, deduzido do prefixo de `ultimo_erro`.
 *
 * A fila guarda o erro numa coluna de texto só, sem canal — mas o worker
 * escreve o canal na frente: "sms: sem telefone valido". Sem ler esse prefixo,
 * uma falha de SMS apareceria como erro TAMBÉM no e-mail. `[[:>:]]` é a borda
 * de fim de palavra: sem ela, "smtp:" casaria como sms.
 */
export const CANAL_DO_ERRO = (alias = 'd') => `(CASE
      WHEN ${alias}.ultimo_erro ~* '^[[:space:]]*sms[[:>:]]'     THEN 'sms'
      WHEN ${alias}.ultimo_erro ~* '^[[:space:]]*e-?mail[[:>:]]' THEN 'email'
      ELSE NULL
    END)`;
