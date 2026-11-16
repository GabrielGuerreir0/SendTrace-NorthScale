/**
 * Pesquisa de motivo de estorno (migração 129) — regras puras, sem banco: quais perguntas aparecem para cada grupo,
 * qual é a próxima e como validar a resposta e a pergunta editada na tela. Usado pela rota pública (/pesquisa) e pelo painel.
 *
 *   grupo do convite: 'reembolso' (REFUND) | 'banco' (ALERT, DISPUTE, CHARGEBACK — o cliente foi ao banco)
 *   pergunta.grupo:   'todos' | 'reembolso' | 'banco'
 *   mostrar_se:       { pergunta, valores } — só aparece se a resposta da pergunta citada estiver em `valores`. Se a pergunta
 *                     citada não é do grupo (ex.: 'reconhece' no reembolso), a condição vale; se é do grupo mas ficou escondida
 *                     pela própria condição, a dependente também some.
 */

export const TIPOS_BANCO = new Set(['ALERT', 'DISPUTE', 'CHARGEBACK']);
export const grupoDoEstorno = (tipo) => (TIPOS_BANCO.has(String(tipo ?? '').toUpperCase()) ? 'banco' : 'reembolso');

const RE_CHAVE = /^[a-z][a-z0-9_]{1,39}$/;
const RE_VALOR = /^[a-z0-9_]{1,40}$/;
export const TEXTO_MAX = 1000;

const doGrupo = (p, grupo) => p.ativa !== false && (p.grupo === 'todos' || p.grupo === grupo);

/** Perguntas que aparecem para o grupo, na ordem, dadas as respostas até agora ({chave: valor|null}). */
export function perguntasVisiveis(perguntas, grupo, respostas = {}) {
  const doG = perguntas.filter((p) => doGrupo(p, grupo)).sort((a, b) => a.ordem - b.ordem || a.chave.localeCompare(b.chave));
  const porChave = new Map(doG.map((p) => [p.chave, p]));
  const visivel = new Map();
  const ve = (p, pilha = new Set()) => {
    if (visivel.has(p.chave)) return visivel.get(p.chave);
    const c = p.mostrar_se;
    let ok = true;
    if (c && c.pergunta) {
      const ref = porChave.get(c.pergunta);
      if (ref && !pilha.has(ref.chave)) {
        pilha.add(p.chave);
        // a citada é do grupo: só aparece se ela apareceu E a resposta está na lista (escondida pela própria condição = não aparece)
        ok = ve(ref, pilha) && Object.hasOwn(respostas, ref.chave) && (c.valores ?? []).includes(respostas[ref.chave]);
      }
    }
    visivel.set(p.chave, ok);
    return ok;
  };
  return doG.filter((p) => ve(p));
}

/** Próxima pergunta ainda não respondida (ou null = terminou). Pergunta pulada conta como respondida (valor null). */
export function proximaPergunta(perguntas, grupo, respostas = {}) {
  return perguntasVisiveis(perguntas, grupo, respostas).find((p) => !Object.hasOwn(respostas, p.chave)) ?? null;
}

/** Progresso para a barra da página: respondidas / visíveis agora (o total pode mudar com as respostas). */
export function progresso(perguntas, grupo, respostas = {}) {
  const vis = perguntasVisiveis(perguntas, grupo, respostas);
  return { feitas: vis.filter((p) => Object.hasOwn(respostas, p.chave)).length, total: vis.length };
}

/** Valida a resposta de uma pergunta. Devolve { ok, valor } (valor normalizado; null = pulou) ou { ok:false, erro }. */
export function validarResposta(p, bruto) {
  const v = bruto === undefined || bruto === null ? '' : String(bruto).trim();
  if (v === '') return p.obrigatoria ? { ok: false, erro: 'Please choose an option.' } : { ok: true, valor: null };
  if (p.tipo === 'unica') {
    return (p.opcoes ?? []).some((o) => o.valor === v) ? { ok: true, valor: v } : { ok: false, erro: 'Please choose an option.' };
  }
  if (p.tipo === 'nota') {
    return /^(10|[0-9])$/.test(v) ? { ok: true, valor: v } : { ok: false, erro: 'Please choose a number from 0 to 10.' };
  }
  return { ok: true, valor: v.slice(0, TEXTO_MAX) };
}

/**
 * Valida a pergunta editada no painel. Devolve { ok, pergunta } (normalizada) ou { ok:false, erros:[...] }.
 * `existentes` = perguntas atuais (para conferir a condição `mostrar_se`).
 */
export function validarPergunta(b, existentes = []) {
  const erros = [];
  const chave = String(b?.chave ?? '').trim();
  if (!RE_CHAVE.test(chave)) erros.push('Chave: só letras minúsculas, números e _, começando por letra (2 a 40).');
  const grupo = String(b?.grupo ?? 'todos');
  if (!['todos', 'reembolso', 'banco'].includes(grupo)) erros.push('Grupo inválido.');
  const tipo = String(b?.tipo ?? 'unica');
  if (!['unica', 'nota', 'texto'].includes(tipo)) erros.push('Tipo inválido.');
  const ordem = Number(b?.ordem);
  if (!Number.isInteger(ordem) || ordem < 0 || ordem > 9999) erros.push('Ordem: número inteiro de 0 a 9999.');
  const texto = String(b?.texto ?? '').trim();
  if (texto.length < 3 || texto.length > 300) erros.push('Texto da pergunta: de 3 a 300 caracteres.');
  const textoBanco = String(b?.texto_banco ?? '').trim() || null;
  if (textoBanco && (textoBanco.length < 3 || textoBanco.length > 300)) erros.push('Texto para quem foi ao banco: de 3 a 300 caracteres.');
  let opcoes = [];
  if (tipo === 'unica') {
    opcoes = (Array.isArray(b?.opcoes) ? b.opcoes : []).map((o) => ({ valor: String(o?.valor ?? '').trim(), rotulo: String(o?.rotulo ?? '').trim() }));
    if (opcoes.length < 2 || opcoes.length > 12) erros.push('Pergunta de marcar: de 2 a 12 opções.');
    const vistos = new Set();
    for (const o of opcoes) {
      if (!RE_VALOR.test(o.valor)) erros.push(`Opção "${o.rotulo || o.valor}": o código só aceita minúsculas, números e _.`);
      if (o.rotulo.length < 1 || o.rotulo.length > 120) erros.push(`Opção "${o.valor}": texto de 1 a 120 caracteres.`);
      if (vistos.has(o.valor)) erros.push(`Código de opção repetido: ${o.valor}.`);
      vistos.add(o.valor);
    }
  }
  let mostrarSe = null;
  if (b?.mostrar_se && b.mostrar_se.pergunta) {
    const ref = existentes.find((p) => p.chave === b.mostrar_se.pergunta);
    const valores = (Array.isArray(b.mostrar_se.valores) ? b.mostrar_se.valores : []).map(String);
    if (!ref || ref.chave === chave) erros.push('Condição: escolha outra pergunta existente.');
    else if (ref.tipo !== 'unica') erros.push('Condição: só pode depender de uma pergunta de marcar.');
    else if (!valores.length || valores.some((v) => !(ref.opcoes ?? []).some((o) => o.valor === v))) erros.push('Condição: marque ao menos uma resposta válida.');
    else if (Number(ref.ordem) >= ordem) erros.push('Condição: a pergunta citada precisa vir antes (ordem menor).');
    mostrarSe = { pergunta: b.mostrar_se.pergunta, valores };
  }
  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    pergunta: { chave, grupo, tipo, ordem, texto, texto_banco: textoBanco, opcoes, mostrar_se: mostrarSe,
      obrigatoria: tipo === 'texto' ? false : b?.obrigatoria !== false, ativa: b?.ativa !== false },
  };
}
