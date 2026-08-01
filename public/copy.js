/**
 * Regras de conteúdo da copy.
 *
 * Ficam AQUI, no servidor, e não só na tela: validação de front é conveniência
 * para quem digita, não garantia. Um POST direto na API passaria por cima dela.
 *
 * O front importa as mesmas funções para avisar enquanto se escreve — mesma
 * regra nos dois lados, um lugar só para corrigir.
 */

/* Alfabeto GSM-7. Fora dele a operadora troca para UCS-2 e o limite do SMS
   cai de 160 para 70 caracteres, dobrando a conta sem avisar. */
const GSM = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXT = new Set('^{}\\[~]|€');

/** Comprimento cobrado e nº de segmentos de um SMS. */
export function medirSms(texto) {
  const t = String(texto ?? '');
  let unicode = false;
  let unidades = 0;
  for (const ch of t) {
    if (GSM.has(ch)) unidades += 1;
    else if (GSM_EXT.has(ch)) unidades += 2;
    else { unicode = true; break; }
  }
  if (unicode) unidades = [...t].length;
  const limite = unicode ? 70 : 160;
  const concat = unicode ? 67 : 153;
  return {
    unidades, unicode, limite,
    segmentos: unidades <= limite ? 1 : Math.ceil(unidades / concat),
  };
}

/** Os caracteres que estouram o GSM-7, para a mensagem de erro apontar quais. */
export function forasDoGsm(texto) {
  const fora = new Set();
  for (const ch of String(texto ?? '')) {
    if (!GSM.has(ch) && !GSM_EXT.has(ch)) fora.add(ch);
  }
  return [...fora];
}

/* Termos que prometem status de logística. A regra do workflow é não citar
   rastreio: nada disso está sob nosso controle, e prometer o que não se
   controla é o que vira pedido de reembolso. */
const PROIBIDOS = [
  'tracking number', 'tracking code', 'track your order', 'tracking link',
  'rastreio', 'rastreamento', 'código de rastr', 'codigo de rastr',
  'shipped', 'dispatched', 'out for delivery', 'label created', 'postado',
];

function acharProibidos(texto) {
  const t = String(texto ?? '').toLowerCase();
  return PROIBIDOS.filter((p) => t.includes(p));
}

/**
 * Valida uma mensagem inteira. Devolve `{ erros, avisos }`.
 *
 * ERRO impede salvar; AVISO não. A separação importa: bloquear por causa de um
 * SMS com 158 caracteres — que funciona — só faria alguém contornar a
 * ferramenta. Bloqueio fica para o que quebra de verdade.
 */
export function validarMensagem(m) {
  const erros = [];
  const avisos = [];
  const canal = m?.canal;

  if (canal !== 'email' && canal !== 'sms') {
    return { erros: ['Canal precisa ser email ou sms.'], avisos: [] };
  }

  if (canal === 'sms') {
    const texto = String(m.texto ?? '').trim();
    if (!texto) erros.push('O SMS precisa de texto.');

    const med = medirSms(texto);
    if (med.unicode) {
      const fora = forasDoGsm(texto).slice(0, 8).join(' ');
      erros.push(
        `O SMS tem caractere fora do GSM-7 (${fora}). Isso derruba o limite de `
        + '160 para 70 e dobra o custo. Troque por equivalentes sem acento.',
      );
    }
    // 155 e não 160: {nome} e {produto} são substituídos no envio e o texto
    // final é maior que este. A folga evita estourar só na hora do disparo.
    if (med.unidades > 155) {
      avisos.push(
        `${med.unidades} caracteres antes de substituir {nome} e {produto}. `
        + 'Acima de ~155 o texto final tende a passar de 160 e virar 2 segmentos.',
      );
    }
    if (!/reply\s+stop\s+to\s+end\s*$/i.test(texto)) {
      avisos.push('O SMS deveria terminar com "Reply STOP to end".');
    }
    const p = acharProibidos(texto);
    if (p.length) erros.push(`O SMS cita status de logística: ${p.join(', ')}.`);
  }

  if (canal === 'email') {
    const assunto = String(m.assunto ?? '').trim();
    const corpo = String(m.corpo_html ?? '').trim();

    if (!assunto) erros.push('O e-mail precisa de assunto.');
    if (!corpo) erros.push('O e-mail precisa de corpo.');

    // Só o miolo: a moldura é montada pelo robô. Um <html> aqui viraria
    // documento dentro de documento.
    if (/<\s*(html|head|body|!doctype)/i.test(corpo)) {
      erros.push('O corpo deve ser só o miolo — sem <html>, <head> ou <body>.');
    }
    if (/<\s*script/i.test(corpo) || /\son\w+\s*=/i.test(corpo)) {
      erros.push('O corpo não pode ter <script> nem atributos de evento (onclick, onerror…).');
    }
    if (/<\s*link|<\s*style/i.test(corpo)) {
      avisos.push('Cliente de e-mail ignora CSS externo e <style> é irregular — use estilo inline.');
    }
    if (m.destino && m.destino !== 'EBOOK' && m.destino !== 'ASSISTENTE') {
      erros.push('O destino do botão deve ser EBOOK ou ASSISTENTE.');
    }
    if (m.botao && !m.destino) {
      avisos.push('O botão tem rótulo mas não tem destino — vai apontar para o suporte.');
    }
    if (assunto.length > 90) {
      avisos.push(
        `Assunto com ${assunto.length} caracteres. Celular corta perto de 60 — `
        + 'e ele ainda cresce quando {nome} e {produto} forem substituídos.',
      );
    }

    const p = [...acharProibidos(assunto), ...acharProibidos(corpo)];
    if (p.length) erros.push(`O e-mail cita status de logística: ${[...new Set(p)].join(', ')}.`);
  }

  return { erros, avisos };
}
