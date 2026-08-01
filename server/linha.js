/**
 * Troca qual linha de copy está ativa no workflow do n8n.
 *
 * O token do webhook fica SÓ AQUI, no servidor. O navegador nunca o recebe:
 * chama uma rota do próprio painel, e é o painel que fala com o n8n. Qualquer
 * coisa que chegue ao JavaScript da página é legível por quem abrir o DevTools
 * — e este token troca a campanha de todo mundo.
 *
 * Os dados vêm da API (config, linha-ativa, histórico, linhas-copy); só a
 * chamada ao n8n continua sendo daqui para fora.
 */
import { obter, substituir, listarTudo, ErroApi } from './api.js';

const URL_TROCA = process.env.N8N_TROCAR_LINHA_URL || '';
const TOKEN = process.env.N8N_TOKEN || '';

export const linhaConfigurada = Boolean(URL_TROCA && TOKEN);

/** Quais linhas existem — vem da API, não de uma lista fixa no código. */
export async function linhasValidas() {
  const { itens } = await listarTudo('/api/linhas-copy/');
  return itens
    .slice()
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)
      || String(a.linha).localeCompare(String(b.linha)))
    .map((l) => String(l.linha));
}

/**
 * A linha REALMENTE ativa, lida de `config_disparos` pela API — a mesma chave
 * que o webhook grava e que o robô lê a cada disparo.
 *
 * `/api/linha-ativa/` guarda quem trocou PELO PAINEL; a verdade do que está no
 * ar é o config. Quando os dois divergem, vale o config e a autoria é omitida:
 * dizer "fulano trocou" ao lado de uma linha que fulano não colocou seria
 * atribuir a ele uma campanha que não é dele.
 */
export async function linhaAtual() {
  let linha = null;
  try {
    const cfg = await obter('/api/config/linha_ativa/');
    linha = cfg?.valor ? String(cfg.valor) : null;
  } catch (err) {
    if (!(err instanceof ErroApi && err.status === 404)) throw err;
  }
  if (!linha) return null;

  let registro = null;
  try {
    registro = await obter('/api/linha-ativa/');
  } catch { /* sem registro de troca pelo painel */ }

  const combina = registro && String(registro.linha) === linha;
  return {
    linha,
    trocada_em: combina ? registro.trocada_em ?? null : null,
    trocada_por: combina ? registro.trocada_por ?? null : null,
  };
}

export async function historicoLinha(limite = 8) {
  const { itens } = await listarTudo('/api/linha-historico/', { ordering: '-em' });
  return itens.slice(0, limite).map((h) => ({
    linha: String(h.linha),
    em: h.em,
    sucesso: h.sucesso,
    detalhe: h.detalhe,
    por: h.por,
  }));
}

/**
 * Chama o webhook e registra o resultado.
 *
 * Só marca a linha como ativa se o n8n confirmar. Marcar antes deixaria o
 * painel afirmando uma campanha que talvez não tenha entrado — pior que não
 * saber, porque parece informação.
 *
 * ATENÇÃO, mudou com a migração para a API: `/api/linha-historico/` é somente
 * leitura, então as TENTATIVAS não são mais registradas — nem as que falham.
 * O que fica gravado é só a última troca bem-sucedida, em `/api/linha-ativa/`.
 * Para o histórico voltar, a API precisa expor POST nessa rota.
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
    const r = await fetch(URL_TROCA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
      body: JSON.stringify({ linha }),
      signal: AbortSignal.timeout(15000),
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

  if (erro) return { ok: false, erro };

  // O webhook devolve `linha_ativa`; vale a confirmação dele, não o que
  // pedimos — se divergir, o certo é o que ele diz.
  const confirmada = validas.includes(String(resposta?.linha_ativa))
    ? String(resposta.linha_ativa)
    : linha;

  try {
    await substituir('/api/linha-ativa/', {
      linha: confirmada,
      resposta: JSON.stringify(resposta).slice(0, 500),
    });
  } catch (e) {
    // A campanha JÁ trocou — o n8n confirmou. Falhar aqui só significa que o
    // painel não conseguiu anotar quem foi; esconder a troca seria pior.
    console.error('[linha] troca feita, mas não consegui registrar na API:', e.message);
  }

  return { ok: true, linha: confirmada, resposta, usuarioId };
}
