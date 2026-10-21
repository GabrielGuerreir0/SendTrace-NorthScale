/**
 * "Reembolsado pela plataforma" pelo terminal (roda DENTRO do container da API, onde DATABASE_URL e ANTHROPIC_API_KEY já existem):
 *
 *   node api/reembolsoPlataformaCli.js simular [--limite N] [--amostra N] > simulacao.csv   classifica tudo (consulta a IA) e mostra o que seria gravado; NÃO altera ticket
 *   node api/reembolsoPlataformaCli.js aplicar [--limite N]                                  backfill: grava a classificação nos tickets (só depois de conferir a simulação)
 *
 * Os totais saem no terminal (stderr). --amostra N: a planilha só traz N tickets da camada 2 (todos os de confiança "baixa" e "Outros" primeiro).
 * A planilha não leva nome, e-mail nem trecho de mensagem: só número do ticket, contagens, datas e o motivo curto que a IA escreveu.
 */
import { pool } from '../server/db.js';
import { rodar, SEM, EVA, OUT } from './reembolsoPlataforma.js';

const [, , comando, ...args] = process.argv;
const num = (nome) => { const i = args.indexOf(`--${nome}`); return i >= 0 ? Number(args[i + 1]) : null; };
const cel = (v) => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
try {
  if (comando !== 'simular' && comando !== 'aplicar') throw new Error('Use: simular | aplicar  [--limite N] [--amostra N]');
  const linhas = await rodar({ gravar: comando === 'aplicar', limite: num('limite') ?? Infinity, todos: true, log: (m) => console.error(m) });
  const ok = linhas.filter((l) => !l.falhou), falhas = linhas.filter((l) => l.falhou);
  const cont = (s) => ok.filter((l) => l.d.status === s).length;
  let saida = ok;
  const amostra = num('amostra');
  if (amostra) {
    const ia = ok.filter((l) => l.d.origem === 'IA');
    const prioridade = ia.filter((l) => l.d.confianca === 'baixa' || l.d.status === OUT);
    const resto = ia.filter((l) => !prioridade.includes(l)).sort(() => Math.random() - 0.5);
    saida = [...prioridade, ...resto].slice(0, amostra);
  }
  const cab = ['Ticket', 'Resolução atual', 'Como foi decidido', 'Categoria da IA', 'Confiança', 'Motivo', 'Revisar', 'Resolução nova', 'E-mails do cliente', 'Respostas do agente', 'Primeira resposta do agente (BRT)', 'Data do reembolso', 'Data do chargeback'];
  const out = saida.map(({ c, d, gravado }) => [c.caso_id, c.tipo_resolucao, d.origem, d.categoria || '', d.confianca || '', d.motivo, d.revisar ? 'sim' : '', d.status + (comando === 'aplicar' ? (gravado ? ' (gravado)' : ' (sem mudança)') : ''),
    c.n_emails, c.n_resp, c.p_resp ? new Date(new Date(c.p_resp).getTime() - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '', c.dr ? String(c.dr).slice(0, 10) : '', c.dcb ? String(c.dcb).slice(0, 10) : ''].map(cel).join(';'));
  process.stdout.write('﻿' + [cab.join(';'), ...out].join('\r\n') + '\r\n');
  const ia = ok.filter((l) => l.d.origem === 'IA');
  console.error(`tickets avaliados: ${linhas.length} | falhas da IA (ficam como estão): ${falhas.length}`);
  console.error(`SEM atendimento: ${cont(SEM)} | EVASÃO provável: ${cont(EVA)} | OUTROS: ${cont(OUT)}   (esperado pela Késsia: ~1.416 / ~43 / ~34)`);
  console.error(`camada 1 (SQL): ${ok.filter((l) => l.d.origem === 'SQL').length} | camada 2 (IA): ${ia.length} | sem e-mail do cliente: ${ok.filter((l) => l.d.origem === 'REGRA').length} | para revisar (confiança baixa): ${ok.filter((l) => l.d.revisar).length}`);
  console.error(`confiança da IA: alta ${ia.filter((l) => l.d.confianca === 'alta').length} · média ${ia.filter((l) => l.d.confianca === 'media').length} · baixa ${ia.filter((l) => l.d.confianca === 'baixa').length}`);
  if (comando === 'aplicar') console.error(`gravados: ${ok.filter((l) => l.gravado).length}`); else console.error('(simulação: nada foi gravado nos tickets)');
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
