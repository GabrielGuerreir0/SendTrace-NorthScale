/**
 * Reversão indireta pelo terminal (roda DENTRO do container da API, onde DATABASE_URL e ANTHROPIC_API_KEY já existem):
 *
 *   node api/reversaoIndiretaCli.js simular [--limite 50] > planilha.csv    consulta a IA e mostra o que seria feito; NÃO altera nenhum ticket
 *   node api/reversaoIndiretaCli.js aplicar [--limite 50]                   grava nos tickets (use só depois de conferir a simulação)
 *
 * A planilha tem uma linha por ticket candidato (CSV com ";" e acentos, abre no Excel). O trecho da mensagem do agente ajuda a conferir a decisão.
 */
import { pool } from '../server/db.js';
import { rodar } from './reversaoIndireta.js';

const [, , comando, ...args] = process.argv;
const limite = (() => { const i = args.indexOf('--limite'); return i >= 0 ? Number(args[i + 1]) : Infinity; })();
const cel = (v) => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ROT = { classificar: 'Classificar', analisar: 'Analisar (dúvida)', nenhuma: 'Não altera' };

try {
  if (comando !== 'simular' && comando !== 'aplicar') throw new Error('Use: simular | aplicar  [--limite N]');
  const linhas = await rodar({ gravar: comando === 'aplicar', limite, log: (m) => console.error(m) });
  const cab = ['Ticket', 'Tipo de resolução atual', 'Detalhamento atual', 'Dias sem resposta', 'Última mensagem do agente em', 'IA: esperava resposta?', 'Motivo da IA', 'O que seria feito', 'Tipo de resolução novo', 'Detalhamento novo', 'Por que não altera', 'Trecho da mensagem do agente'];
  const DEC = { espera_resposta: 'Sim', nao_espera: 'Não', duvida: 'Dúvida', '': '(não consultada)' };
  const out = linhas.map((l) => [l.caso_id, l.tipo_resolucao, l.detalhamento_motivo || '', l.dias, new Date(l.agente_em).toISOString().slice(0, 16).replace('T', ' '), DEC[l.decisao] ?? l.decisao, l.motivo || '',
    ROT[l.acao] + (comando === 'aplicar' && l.acao !== 'nenhuma' ? (l.gravado ? ' (gravado)' : ' (NÃO gravado)') : ''), l.tipo || '', l.detalhe || (l.acao === 'analisar' ? '(mantém)' : ''), l.acao === 'nenhuma' ? l.porque : '', l.trecho || ''].map(cel).join(';'));
  process.stdout.write('﻿' + [cab.join(';'), ...out].join('\r\n') + '\r\n');
  const cont = (a) => linhas.filter((l) => l.acao === a).length;
  console.error(`candidatos: ${linhas.length} | classificar: ${cont('classificar')} | analisar: ${cont('analisar')} | não altera: ${cont('nenhuma')}${comando === 'aplicar' ? ` | gravados: ${linhas.filter((l) => l.gravado).length}` : ' (simulação, nada gravado)'}`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
