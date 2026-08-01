/**
 * Impressão digital do código que está rodando.
 *
 * Existe porque uma imagem Docker congela o código no momento do build: dá
 * para ter o container servindo uma versão e o `npm start` outra, sem nada na
 * tela dizendo isso. Comparar telas para descobrir é lento e enganoso.
 *
 * O cálculo é sobre o CONTEÚDO dos arquivos, não sobre data de modificação —
 * copiar o projeto para dentro da imagem muda as datas mas não o código, e uma
 * digital que mudasse nessa hora não serviria para comparar nada.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Arquivos que compõem o comportamento do painel. */
async function listar(dir, aceitar) {
  const saida = [];
  let entradas = [];
  try {
    entradas = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return saida;
  }
  for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...await listar(completo, aceitar));
    else if (aceitar(e.name)) saida.push(completo);
  }
  return saida;
}

let digital = null;

export async function versao() {
  if (digital) return digital;

  const aceitar = (n) => /\.(js|html|css|sql)$/i.test(n);
  const arquivos = [
    ...await listar(path.join(RAIZ, 'server'), aceitar),
    ...await listar(path.join(RAIZ, 'public'), aceitar),
  ];

  const h = crypto.createHash('sha256');
  for (const f of arquivos) {
    // O caminho relativo entra no hash: renomear um arquivo é mudança, mesmo
    // que o conteúdo total continue idêntico.
    h.update(path.relative(RAIZ, f).replace(/\\/g, '/'));
    h.update(await fs.readFile(f));
  }

  digital = {
    codigo: h.digest('hex').slice(0, 12),
    arquivos: arquivos.length,
    node: process.version,
    // Em container isto é `true`; ajuda a explicar uma divergência de versão.
    container: process.env.NODE_ENV === 'production' && Boolean(process.env.HOSTNAME),
  };
  return digital;
}
