const NUM = new Intl.NumberFormat('pt-BR');
const COMPACTO = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const HORA = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const DATA_HORA = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const DIA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

export const n = (v) => NUM.format(v ?? 0);
export const nc = (v) => (Math.abs(v ?? 0) < 10_000 ? NUM.format(v ?? 0) : COMPACTO.format(v));
export const hora = (d) => HORA.format(new Date(d));
export const dataHora = (d) => DATA_HORA.format(new Date(d));
export const dia = (d) => DIA.format(new Date(d));

/** "em 4 min", "há 2 h", "agora" — sempre com o sinal correto. */
export function relativo(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const futuro = ms >= 0;

  const passos = [
    [60_000, 1000, 's'],
    [3_600_000, 60_000, 'min'],
    [86_400_000, 3_600_000, 'h'],
    [Infinity, 86_400_000, 'd'],
  ];
  if (abs < 45_000) return 'agora';

  for (const [limite, divisor, unidade] of passos) {
    if (abs < limite) {
      const v = Math.round(abs / divisor);
      return futuro ? `em ${v} ${unidade}` : `há ${v} ${unidade}`;
    }
  }
  return '—';
}

/**
 * Duração em horas para leitura humana: 4 h · 1 d · 3 d · 7 d 12 h.
 * Usada nas esperas entre mensagens da régua.
 */
export function duracaoH(h) {
  if (h === null || h === undefined || !Number.isFinite(Number(h))) return '—';
  const horas = Number(h);
  if (horas < 1) return `${Math.round(horas * 60)} min`;

  // Arredondar ANTES de partir em dias+resto. Fazendo o resto separado,
  // 71,9 h vira "2 d 24 h" — porque round(23,9) = 24 e ninguém carrega o dia.
  const umaCasa = Math.round(horas * 10) / 10;
  if (umaCasa < 24) return `${NUM.format(umaCasa)} h`;

  const cheias = Math.round(horas);
  const dias = Math.floor(cheias / 24);
  const resto = cheias % 24;
  return resto === 0 ? `${dias} d` : `${dias} d ${resto} h`;
}

/** Corta texto longo preservando o começo, que é onde está a informação útil. */
export const truncar = (s, max = 60) =>
  !s ? '' : s.length <= max ? s : `${s.slice(0, max - 1)}…`;
