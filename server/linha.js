/**
 * Troca qual linha de copy (1, 2 ou 3) está ativa no workflow do n8n.
 *
 * O token do webhook fica SÓ AQUI, no servidor. O navegador nunca o recebe:
 * chama uma rota do próprio painel, e é o painel que fala com o n8n. Qualquer
 * coisa que chegue ao JavaScript da página é legível por quem abrir o
 * DevTools — e este token troca a campanha de todo mundo.
 */
import { query } from './db.js';

const URL_TROCA = process.env.N8N_TROCAR_LINHA_URL || '';
const TOKEN = process.env.N8N_TOKEN || '';

export const linhaConfigurada = Boolean(URL_TROCA && TOKEN);

/** Quais linhas existem — vem do banco, não de uma lista fixa no código. */
export async function linhasValidas() {
  const existe = await query(`SELECT to_regclass('public.painel_linhas_copy') IS NOT NULL AS ok`);
  if (!existe.rows[0].ok) return [];
  const { rows } = await query('SELECT linha FROM painel_linhas_copy ORDER BY ordem, linha');
  return rows.map((r) => r.linha);
}

/**
 * A linha REALMENTE ativa, lida de `config_disparos` — a mesma chave que o
 * webhook grava e que o robô lê a cada disparo.
 *
 * Antes eu guardava a última troca feita pelo painel e avisava na tela que
 * podia estar velha, porque não havia como consultar. Havia: o valor mora no
 * mesmo banco. `painel_linha_mensagens` continua existindo, mas só como
 * registro de QUEM trocou pelo painel — a verdade é o config_disparos.
 */
export async function linhaAtual() {
  const existe = await query(
    `SELECT to_regclass('public.config_disparos')        IS NOT NULL AS cfg,
            to_regclass('public.painel_linha_mensagens') IS NOT NULL AS aud`,
  );
  if (!existe.rows[0].cfg) return null;

  const { rows } = await query(
    `SELECT valor AS linha FROM config_disparos WHERE chave = 'linha_ativa'`,
  );
  if (!rows.length) return null;
  const linha = rows[0].linha;

  // Autoria só quando a troca saiu daqui E ainda corresponde ao que está no ar.
  let quem = null;
  if (existe.rows[0].aud) {
    const a = await query(
      `SELECT l.trocada_em, u.email AS trocada_por
       FROM painel_linha_mensagens l
       LEFT JOIN painel_usuarios u ON u.id = l.trocada_por
       WHERE l.id = 1 AND l.linha = $1`,
      [linha],
    );
    quem = a.rows[0] ?? null;
  }
  return { linha, trocada_em: quem?.trocada_em ?? null, trocada_por: quem?.trocada_por ?? null };
}

export async function historicoLinha(limite = 8) {
  const { rows } = await query(
    `SELECT h.linha, h.em, h.sucesso, h.detalhe, u.email AS por
     FROM painel_linha_historico h
     LEFT JOIN painel_usuarios u ON u.id = h.por
     ORDER BY h.em DESC LIMIT $1`,
    [limite],
  );
  return rows;
}

/**
 * Chama o webhook e registra o resultado.
 *
 * Só grava a linha como ativa se o n8n confirmar. Gravar antes deixaria o
 * painel afirmando uma campanha que talvez não tenha entrado — pior que não
 * saber, porque parece informação.
 */
export async function trocarLinha(linha, usuarioId) {
  const validas = await linhasValidas();
  if (!validas.includes(linha)) {
    return {
      ok: false,
      erro: `Linha desconhecida. Cadastradas: ${validas.join(', ') || 'nenhuma'}.`,
    };
  }
  if (!linhaConfigurada) {
    return { ok: false, erro: 'Troca de linha não configurada: falta N8N_TROCAR_LINHA_URL ou N8N_TOKEN no .env.' };
  }

  let resposta = null;
  let erro = null;

  try {
    // Timeout explícito: sem ele um n8n pendurado prende a requisição do
    // navegador até o limite do sistema operacional.
    const corte = AbortSignal.timeout(15000);
    const r = await fetch(URL_TROCA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
      body: JSON.stringify({ linha }),
      signal: corte,
    });

    const texto = (await r.text()).slice(0, 500);
    try { resposta = JSON.parse(texto); } catch { resposta = { bruto: texto }; }

    if (!r.ok || resposta?.ok === false) {
      erro = resposta?.erro || `o n8n respondeu HTTP ${r.status}`;
    }
  } catch (e) {
    erro = e.name === 'TimeoutError'
      ? 'o n8n não respondeu em 15 s'
      : `não consegui falar com o n8n: ${e.message}`;
  }

  const detalhe = erro ?? JSON.stringify(resposta);
  await query(
    `INSERT INTO painel_linha_historico (linha, por, sucesso, detalhe)
     VALUES ($1, $2, $3, $4)`,
    [linha, usuarioId ?? null, !erro, String(detalhe).slice(0, 500)],
  );

  if (erro) return { ok: false, erro };

  // O webhook devolve `linha_ativa`; usamos a confirmação dele, não o que
  // pedimos — se por algum motivo divergir, o certo é o que ele diz.
  const confirmada = validas.includes(String(resposta?.linha_ativa))
    ? String(resposta.linha_ativa)
    : linha;

  await query(
    `INSERT INTO painel_linha_mensagens (id, linha, trocada_em, trocada_por, resposta)
     VALUES (1, $1, now(), $2, $3)
     ON CONFLICT (id) DO UPDATE
        SET linha = EXCLUDED.linha, trocada_em = now(),
            trocada_por = EXCLUDED.trocada_por, resposta = EXCLUDED.resposta`,
    [confirmada, usuarioId ?? null, JSON.stringify(resposta).slice(0, 500)],
  );

  return { ok: true, linha: confirmada, resposta };
}
