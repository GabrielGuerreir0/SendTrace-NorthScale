/**
 * MONIT-SPPL — e-mail padrão: funções PURAS do navegador (sem DOM), testadas por api/monit/emailTexto.test.js.
 */

const limpa = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/**
 * "Copiar lista para envio" (seção 8, passo 6): tabela separada por tabulação com E-mail, Nome, Pedido, Rastreio, Classificação, Assunto e Texto.
 * O texto (em inglês, um por cliente) vai entre aspas duplas, com as aspas internas dobradas, e mantém as quebras de linha. Quem não tem e-mail fica de fora.
 * `itens`: [{ email, nome, pedido, rastreio, classe_nome, assunto, texto }].
 */
export function listaParaEnvio(itens) {
  const linhas = [['E-mail', 'Nome', 'Pedido', 'Rastreio', 'Classificação', 'Assunto', 'Texto'].join('\t')];
  for (const i of itens ?? []) {
    if (!i.email) continue;
    const texto = `"${String(i.texto ?? '').replace(/\r\n/g, '\n').replace(/"/g, '""')}"`;
    linhas.push([limpa(i.email), limpa(i.nome), limpa(i.pedido), limpa(i.rastreio), limpa(i.classe_nome), limpa(i.assunto), texto].join('\t'));
  }
  return linhas.join('\n');
}

/** O inglês está desatualizado em relação ao português? (o português mudou desde a versão que gerou/validou o inglês) */
export const inglesDesatualizado = ({ ptAtual, ptBase, enRevisadoDepois }) => !enRevisadoDepois && String(ptAtual ?? '').trim() !== String(ptBase ?? '').trim();
