/**
 * Achar um e-mail na caixa real (Hostinger, IMAP) a partir do `message_id`
 * salvo em `email_ia.emails` — usado só para montar o link "abrir na
 * caixa" do kanban de Suporte Escalado (botão ✉ no cartão). Conexão
 * SOMENTE LEITURA: nunca marca como lido, nunca move, nunca apaga.
 *
 * Reaproveita a MESMA caixa/senha do SMTP (ver server/email.js) por
 * padrão — é o mesmo login: a Hostinger não separa credencial de IMAP e
 * de SMTP numa conta de e-mail comum. IMAP_HOST/IMAP_USUARIO/IMAP_SENHA
 * no .env sobrepõem, caso isso um dia deixe de valer.
 */
import { ImapFlow } from 'imapflow';

const {
  IMAP_HOST, IMAP_PORT, IMAP_USUARIO, IMAP_SENHA,
  SMTP_USUARIO, SMTP_SENHA, WEBMAIL_URL,
} = process.env;

const HOST = IMAP_HOST || 'imap.hostinger.com';
const PORTA = Number(IMAP_PORT) || 993;
const USUARIO = IMAP_USUARIO || SMTP_USUARIO;
const SENHA = IMAP_SENHA || SMTP_SENHA;

export const webmailConfigurado = Boolean(USUARIO && SENHA);
export const enderecoWebmail = (WEBMAIL_URL || 'https://mail.hostinger.com').replace(/\/+$/, '');

/**
 * Pastas onde um e-mail pode estar. `organizar_pastas_imap.py` (script à
 * parte, hoje pausado) move mensagens para as três "IA - ..." — a maioria
 * ainda está em INBOX, mas uma antiga pode ter sido movida antes da pausa.
 * `pastaSugerida` (coluna `emails.pasta_imap`) entra primeiro só para
 * economizar uma rodada; se não achar lá, confere as outras — a dica pode
 * estar desatualizada.
 */
const PASTAS_CANDIDATAS = ['INBOX', 'IA - Escalado Suporte', 'IA - Erro', 'IA - Respondido'];

/** Devolve `{ pasta, uid }` do e-mail, ou `null` se não achou em pasta nenhuma. */
export async function acharNoWebmail(messageId, pastaSugerida) {
  if (!webmailConfigurado) {
    throw new Error('IMAP não configurado — falta SMTP_USUARIO/SMTP_SENHA (ou IMAP_USUARIO/IMAP_SENHA) no .env.');
  }
  if (!messageId) return null;

  const ordem = pastaSugerida
    ? [pastaSugerida, ...PASTAS_CANDIDATAS.filter((p) => p !== pastaSugerida)]
    : PASTAS_CANDIDATAS;

  const client = new ImapFlow({
    host: HOST,
    port: PORTA,
    secure: true,
    auth: { user: USUARIO, pass: SENHA },
    logger: false,
  });

  await client.connect();
  try {
    for (const pasta of ordem) {
      let lock;
      try {
        lock = await client.getMailboxLock(pasta);
      } catch {
        continue; // pasta não existe nesta caixa — tenta a próxima candidata
      }
      try {
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        // Busca por Message-ID é sempre 0 ou 1 resultado (é único por definição);
        // o último da lista é só defesa contra um servidor devolver duplicata.
        if (uids?.length) return { pasta, uid: uids[uids.length - 1] };
      } finally {
        lock.release();
      }
    }
    return null;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Monta a URL do webmail no mesmo formato que o Hostinger usa (ver §1 do pedido do usuário). */
export function urlWebmail(pasta, uid) {
  return `${enderecoWebmail}/mailboxes/${encodeURIComponent(pasta)}/${uid}?p=1&c=all`;
}

/* ═══════════════  anexos do e-mail do cliente (4º momento da Késsia, item 2)  ═══════════════
   O sistema só guarda as imagens (email_ia.anexos). PDF e demais arquivos do cliente ficam na caixa: aqui eles são listados e baixados sob demanda
   pelo IMAP (somente leitura). Mesma regra do restante do módulo: nunca marca como lido, nunca move, nunca apaga. */
export const MAX_BYTES_ANEXO_IMAP = 25 * 1024 * 1024;

async function comEmail(messageId, pastaSugerida, fazer) {
  const achado = await acharNoWebmail(messageId, pastaSugerida);
  if (!achado) return null;
  const client = new ImapFlow({ host: HOST, port: PORTA, secure: true, auth: { user: USUARIO, pass: SENHA }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(achado.pasta);
    try { return await fazer(client, achado.uid); } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function partesAnexo(no, saida = []) {
  if (!no) return saida;
  if (no.childNodes?.length) { for (const f of no.childNodes) partesAnexo(f, saida); return saida; }
  const nome = no.dispositionParameters?.filename || no.parameters?.name;
  const tipo = String(no.type || '').toLowerCase();
  const ehTexto = tipo === 'text/plain' || tipo === 'text/html';
  if (nome && !(ehTexto && !no.disposition) && !tipo.startsWith('image/')) saida.push({ parte: no.part, nome, mime_type: tipo, tamanho: no.size ?? null });
  return saida;
}

/** Lista os anexos que NÃO são imagem (PDF, documentos…). `null` = e-mail não achado na caixa. */
export async function listarAnexosNaCaixa(messageId, pastaSugerida) {
  if (!webmailConfigurado) throw new Error('IMAP não configurado.');
  return comEmail(messageId, pastaSugerida, async (client, uid) => {
    const m = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
    return partesAnexo(m?.bodyStructure);
  });
}

/** Baixa um anexo (parte MIME) do e-mail. `null` = não achado. Recusa arquivo acima de 25 MB. */
export async function baixarAnexoDaCaixa(messageId, pastaSugerida, parte) {
  if (!webmailConfigurado) throw new Error('IMAP não configurado.');
  return comEmail(messageId, pastaSugerida, async (client, uid) => {
    const m = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
    const meta = partesAnexo(m?.bodyStructure).find((a) => a.parte === parte);   // só baixa o que a lista oferece
    if (!meta) return null;
    if (meta.tamanho && meta.tamanho > MAX_BYTES_ANEXO_IMAP * 1.4) throw Object.assign(new Error('Arquivo maior que 25 MB.'), { grande: true });
    const { content } = await client.download(uid, parte, { uid: true });
    const pedacos = []; let total = 0;
    for await (const c of content) { total += c.length; if (total > MAX_BYTES_ANEXO_IMAP) throw Object.assign(new Error('Arquivo maior que 25 MB.'), { grande: true }); pedacos.push(c); }
    return { ...meta, conteudo: Buffer.concat(pedacos) };
  });
}
