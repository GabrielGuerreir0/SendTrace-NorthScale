/**
 * Pesquisa de estorno (migração 130) — monta o e-mail do convite e do lembrete. Puro, sem banco e sem rede (testado em pesquisaEstorno.test.js).
 *
 * Copy aprovada pelo Lucas em 15/11/2026 (EN): versão reembolso, versão banco (alerta/chargeback) e lembrete. A primeira pergunta vai no
 * corpo como botões; cada botão abre /pesquisa?t=TOKEN&r=valor, que só PRÉ-MARCA a opção (quem grava é o clique em "Next" na página —
 * robôs de segurança abrem links sozinhos). Sem cupom, sem pedir para cancelar a disputa, sem urgência.
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Neuro Mind Pro 6 Bottles (Last Chance)" → "Neuro Mind Pro". Kit com "+" não tem nome único: null (o texto usa "your order"). */
export function nomeProduto(bruto) {
  let s = String(bruto ?? '').trim();
  if (!s || s.includes('+')) return null;
  s = s.replace(/^M\d+\s*-\s*/i, '').replace(/\([^)]*\)/g, ' ')
    .replace(/\s*-?\s*\d+\s+(additional\s+)?bottles?\b.*$/i, '').replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();
  return s.length >= 2 ? s : null;
}

const primeiroNome = (nome) => {
  const p = String(nome ?? '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}'-]{2,30}$/u.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
};

const botao = (href, rotulo) => '<tr><td style="padding:0 0 10px"><a href="' + esc(href) + '" style="display:block;padding:13px 16px;'
  + 'border:1px solid #c9d2f7;border-radius:8px;background:#eef1fd;color:#1f2430;text-decoration:none;font-weight:600;font-size:15px">'
  + esc(rotulo) + '</a></td></tr>';

/**
 * Devolve { assunto, html, texto } do convite (`lembrete = false`) ou do lembrete.
 *   c:        { token, grupo: 'reembolso'|'banco', nome, produto, transacao_id }
 *   pergunta: a primeira pergunta do grupo (da tabela, versão atual) — { texto, texto_banco, opcoes: [{valor, rotulo}] }
 *   base:     endereço público do painel (https://sendtrace.thenorthscales.com)
 *   descadastro: URL de descadastro do e-mail (descadastro_url) ou ''
 */
export function montarEmail({ c, pergunta, base, descadastro = '', suporte, lembrete = false }) {
  const prod = nomeProduto(c.produto);
  const doProd = prod ? `your ${prod} order` : 'your order';
  const equipe = prod ? `The ${prod} Team` : 'Our Support Team';
  const nome = primeiroNome(c.nome);
  const oi = nome ? `Hi ${nome},` : 'Hi,';
  const pedido = c.transacao_id ? ` (order ${c.transacao_id})` : '';
  const banco = c.grupo === 'banco';
  const textoPergunta = (banco && pergunta.texto_banco) || pergunta.texto;
  const link = (v) => `${base}/pesquisa?t=${encodeURIComponent(c.token)}${v ? `&r=${encodeURIComponent(v)}` : ''}`;

  let assunto; let paragrafos;
  if (lembrete) {
    assunto = prod ? `30 seconds to help us? (${prod})` : '30 seconds to help us?';
    paragrafos = [banco ? `${oi} we'd still love to hear from you about ${doProd}. One click is enough:`
      : `${oi} we'd still love to hear why you asked for a refund. One click is enough:`];
  } else if (banco) {
    assunto = prod ? `About your ${prod} order` : 'About your order';
    paragrafos = [oi, `We noticed that ${doProd}${pedido} was disputed with your bank. We're sorry something didn't go as expected.`];
  } else {
    assunto = prod ? `Quick question about your ${prod} refund` : 'Quick question about your refund';
    paragrafos = [oi, `Your refund for ${prod || 'your order'}${pedido} has been processed.`, "We'd really like to understand what happened."];
  }
  const depois = lembrete ? [] : banco
    ? ['Your answer helps us find what went wrong. If you need help with your order, just reply to this email.']
    : ['It takes less than 30 seconds, and your answer goes straight to our team.', "If you still have any issue with your order, just reply to this email and we'll help."];
  // primeira pergunta sem opções (nota ou texto, se alguém reordenar na tela): um botão só, que abre a página
  const opcoes = Array.isArray(pergunta.opcoes) && pergunta.opcoes.length ? pergunta.opcoes : [{ valor: '', rotulo: 'Answer (30 seconds)' }];

  const p = (t) => '<p style="margin:0 0 14px">' + esc(t) + '</p>';
  const preview = lembrete ? 'One click is enough.' : 'One click is enough, and it helps us improve.';
  const html = '<div style="display:none;max-height:0;overflow:hidden">' + esc(preview) + '</div>'
    + '<div style="background:#eef0f4;padding:24px 12px"><div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f2430">'
    + '<div style="background:#ffffff;border-radius:10px;padding:30px 26px">'
    + paragrafos.map(p).join('')
    + '<p style="margin:18px 0 12px;font-weight:700">' + esc(textoPergunta) + '</p>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + opcoes.map((o) => botao(link(o.valor), o.rotulo)).join('') + '</table>'
    + depois.map(p).join('')
    + '<p style="margin:18px 0 0">Thank you,<br>' + esc(equipe) + '</p>'
    + '</div>'
    + '<div style="padding:18px 24px;text-align:center;font-size:12px;color:#9aa0ab;line-height:1.6">'
    + '<p style="margin:0">You\'re receiving this email because you made a purchase on our platform.</p>'
    + '<p style="margin:6px 0 0">' + esc(suporte) + '</p>'
    + (descadastro ? '<p style="margin:10px 0 0">Don\'t want these emails? <a href="' + esc(descadastro) + '" style="color:#9aa0ab;text-decoration:underline">Unsubscribe</a>.</p>' : '')
    + '</div></div></div>';

  const texto = [...paragrafos, '', textoPergunta, ...opcoes.map((o) => `- ${o.rotulo}: ${link(o.valor)}`), '', ...depois, '', 'Thank you,', equipe, '',
    suporte, descadastro ? `Unsubscribe: ${descadastro}` : ''].join('\n').trim();
  return { assunto, html, texto };
}
