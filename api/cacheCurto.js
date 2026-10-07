/**
 * Cache em memória de vida curta para consultas pesadas e muito repetidas (fila, painel da equipe): vários agentes abrem as mesmas telas e a tela
 * recarrega sozinha. Junta chamadas simultâneas (uma consulta só) e é limpo por `invalidar()` quando alguém muda um ticket (resposta, ficha,
 * transferência, mesclagem), então o agente vê o efeito do que acabou de fazer sem esperar o prazo.
 * O cache vem DEPOIS da checagem de permissão em cada rota — a chave nunca substitui a autorização.
 */
const guardado = new Map();   // chave → { ate, valor } | { promessa }

export async function memo(chave, ttlMs, calcular) {
  const agora = Date.now();
  const item = guardado.get(chave);
  if (item?.valor !== undefined && item.ate > agora) return item.valor;
  if (item?.promessa) return item.promessa;
  const promessa = (async () => {
    try {
      const valor = await calcular();
      guardado.set(chave, { valor, ate: Date.now() + ttlMs });
      return valor;
    } catch (err) {
      guardado.delete(chave);
      throw err;
    }
  })();
  guardado.set(chave, { promessa });
  return promessa;
}

/** Limpa tudo que começa com `prefixo` (sem argumento, tudo). */
export function invalidar(prefixo = '') {
  for (const k of guardado.keys()) if (k.startsWith(prefixo)) guardado.delete(k);
}
