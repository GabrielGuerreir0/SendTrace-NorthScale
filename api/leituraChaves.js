/**
 * Chaves de LEITURA (migração 115) — uma por pessoa, formato `str_ro_<43 caracteres>`.
 *
 * Só o hash SHA-256 fica no banco; o token aparece UMA vez, na criação. Uma chave dessas só lê: `exigirSessao` recusa qualquer método que não
 * seja GET (exceto POST /api/leitura/sql, que roda numa transação READ ONLY com outro usuário do banco). Cada chamada é gravada em
 * `leitura_auditoria`.
 */
import crypto from 'node:crypto';

import { query } from '../server/db.js';

export const PREFIXO_TOKEN = 'str_ro_';
const RE_TOKEN = /^str_ro_[A-Za-z0-9_-]{43}$/;

export const ehTokenLeitura = (bruto) => typeof bruto === 'string' && bruto.startsWith(PREFIXO_TOKEN);
const hashDe = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Cria a chave e devolve `{ id, token }` — o token não é recuperável depois. */
export async function criarChave({ dono, descricao = null, mascararPii = false, criadaPor = null, editaPropriedades = false }) {
  if (!String(dono ?? '').trim()) throw new Error('Informe o dono da chave.');
  const token = PREFIXO_TOKEN + crypto.randomBytes(32).toString('base64url');
  const { rows } = await query(
    `INSERT INTO chaves_leitura (dono, descricao, prefixo, hash, mascarar_pii, criada_por, edita_propriedades)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [String(dono).trim(), descricao, token.slice(0, PREFIXO_TOKEN.length + 6), hashDe(token), Boolean(mascararPii), criadaPor, Boolean(editaPropriedades)],
  );
  return { id: rows[0].id, token };
}

/** Devolve a chave ativa (`{ id, dono, mascarar_pii }`) ou null. Não distingue "não existe" de "revogada" para quem chama. */
export async function validarChave(token, { contar = true } = {}) {
  if (!RE_TOKEN.test(token ?? '')) return null;
  if (!contar) {
    const { rows } = await query('SELECT id, dono, mascarar_pii, edita_propriedades FROM chaves_leitura WHERE hash = $1 AND revogada_em IS NULL', [hashDe(token)]);
    return rows[0] ?? null;
  }
  const { rows } = await query(
    `UPDATE chaves_leitura SET ultimo_uso_em = now(), usos = usos + 1
      WHERE hash = $1 AND revogada_em IS NULL
  RETURNING id, dono, mascarar_pii, edita_propriedades`,
    [hashDe(token)],
  );
  return rows[0] ?? null;
}

/** Liga/desliga (122) a exceção que deixa a chave editar as Propriedades dos tickets. Devolve true se achou uma chave ativa. */
export async function definirEditaPropriedades(id, valor) {
  const { rowCount } = await query('UPDATE chaves_leitura SET edita_propriedades = $2 WHERE id = $1 AND revogada_em IS NULL', [id, Boolean(valor)]);
  return rowCount > 0;
}

export async function revogarChave(id) {
  const { rowCount } = await query('UPDATE chaves_leitura SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL', [id]);
  return rowCount > 0;
}

export async function listarChaves() {
  const { rows } = await query(
    `SELECT id, dono, descricao, prefixo, mascarar_pii, edita_propriedades, criada_em, criada_por, revogada_em, ultimo_uso_em, usos
       FROM chaves_leitura ORDER BY id`,
  );
  return rows;
}

/** Grava uma linha de auditoria; nunca lança (auditar não pode derrubar a resposta). */
export async function auditar(a) {
  try {
    await query(
      `INSERT INTO leitura_auditoria (chave_id, dono, metodo, rota, consulta, sql, status, ms, linhas, ip, erro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [a.chaveId, a.dono, a.metodo, a.rota, a.consulta?.slice(0, 2000) ?? null, a.sql?.slice(0, 20000) ?? null, a.status, a.ms, a.linhas ?? null, a.ip ?? null, a.erro?.slice(0, 500) ?? null],
    );
  } catch (err) {
    console.error('[leitura] falha ao gravar auditoria:', err.message);
  }
}

/* ─────────────────────  limite por chave (em memória)  ───────────────────── */

const JANELA_MS = 60_000;
const MAX_POR_JANELA = 120;
const contagem = new Map();

/** true = pode seguir; false = estourou o limite (120 chamadas por minuto, por chave). */
export function dentroDoLimite(chaveId) {
  const agora = Date.now();
  const c = contagem.get(chaveId);
  if (!c || agora - c.inicio > JANELA_MS) {
    contagem.set(chaveId, { inicio: agora, n: 1 });
    return true;
  }
  c.n += 1;
  return c.n <= MAX_POR_JANELA;
}

/* ──────────────────────────  máscara de dados pessoais  ────────────────────── */

const RE_COLUNA_PII = /(^|_)(email|e_mail|nome|name|telefone|phone|celular|cpf|endereco|address|rua|cep|zip|cidade|city|remetente|destinatario|from|to)(_|$)/i;

/** Troca por um hash curto os valores de colunas que parecem dado pessoal (nome, e-mail, telefone, endereço), mantendo o resto. */
export function mascararLinhas(linhas) {
  const h = (v) => `pii_${crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 10)}`;
  return linhas.map((l) => {
    const o = {};
    for (const [k, v] of Object.entries(l)) o[k] = v != null && typeof v !== 'object' && RE_COLUNA_PII.test(k) ? h(v) : v;
    return o;
  });
}
