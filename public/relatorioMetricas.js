/**
 * Aba "Relatório de Métricas" — Parte 2 do plano de tracking, sem NPS nem
 * taxa de devolução física (decisão do usuário 20/08/2026: fica pra depois).
 *
 * Diferente das outras abas, NÃO entra no polling automático do painel: as
 * consultas somam 12 queries em paralelo no servidor — pedir isso a cada
 * poucos segundos, para uma tela que ninguém está olhando, seria desperdício.
 * Busca de novo só ao trocar o período ou reabrir a aba.
 */
import { $, api, kpiCard, barraHorizontal, tooltip, rotularCategoria, rotularMotivo, rotularTipoConteudo } from './emailComum.js';
import { n, dia } from './format.js';
import { desenharColunas } from './charts.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);

let carregando = false;

function renderKpis(m) {
  const totalReembolsoEmail = m.email.motivos_reembolso.reduce((a, r) => a + r.total, 0);
  $('rel-kpis').replaceChildren(
    kpiCard({
      icone: '●', tom: 'neutro', rotulo: 'Contatos no chat',
      valor: n(m.chat.contatos_total), nota: `iniciados em ${m.periodo_dias} dias`,
    }),
    kpiCard({
      icone: '✉', tom: 'bom', rotulo: 'Abertura — resposta automática',
      valor: pct(m.abertura.resposta_automatica.taxa),
      nota: `${n(m.abertura.resposta_automatica.abertos)} de ${n(m.abertura.resposta_automatica.enviados)} no período`,
    }),
    kpiCard({
      icone: '↩', tom: 'ruim', rotulo: 'E-mails com problema de pagamento',
      valor: n(totalReembolsoEmail), nota: `no período, excluindo "sem problema"`,
    }),
    kpiCard({
      icone: '⚠', tom: 'medio', rotulo: 'Fotos com defeito visível',
      valor: n(m.fotos.com_defeito),
      nota: `de ${n(m.fotos.total_analisadas)} anexos analisados (acumulado)`,
    }),
  );
}

function renderGraficoContatos(m) {
  const dados = m.chat.contatos_serie.map((r) => ({
    valor: r.total, rotulo: dia(r.dia), sub: null, data: new Date(r.dia),
  }));
  desenharColunas($('rel-graf-contatos'), dados, {
    altura: 180, unidade: 'conversas', barraMax: 24, tooltip,
    textoVazio: 'Nenhuma conversa iniciada no período.',
    rotuloEixoX: (d, i) => (i % Math.ceil(dados.length / 10 || 1) === 0 ? d.rotulo : ''),
  });
}

function renderGraficoBuckets(container, itens, unidade) {
  const dados = itens.map((r) => ({ valor: r.total, rotulo: r.bucket, sub: null }));
  desenharColunas(container, dados, {
    altura: 170, unidade, barraMax: 34, tooltip,
    textoVazio: 'Sem dados no período.',
    rotuloEixoX: (d) => d.rotulo,
  });
}

function renderAberturaRegua(m) {
  const container = $('rel-abertura-regua');
  container.replaceChildren();
  const ul = document.createElement('ul');
  ul.className = 'sup-ranking';
  for (const r of m.abertura.regua_por_etapa) {
    const li = document.createElement('li');
    li.className = 'sup-item';
    const rot = document.createElement('span');
    rot.className = 'sup-item-rotulo';
    rot.textContent = `Etapa ${r.etapa} — ${r.nome}`;
    const num = document.createElement('span');
    num.className = 'sup-item-num';
    num.textContent = `${pct(r.taxa)} (${n(r.abertos)}/${n(r.enviados_aprox)})`;
    const barra = document.createElement('span');
    barra.className = 'sup-item-barra';
    const cheio = document.createElement('span');
    cheio.style.width = `${r.taxa ? Math.max(2, r.taxa * 100) : 0}%`;
    barra.append(cheio);
    li.append(rot, num, barra);
    ul.append(li);
  }
  container.append(ul);
}

async function carregar() {
  if (carregando) return;
  carregando = true;
  const dias = $('rel-dias').value || '30';

  const { ok, dados } = await api(`/api/relatorio/metricas?dias=${encodeURIComponent(dias)}`);
  carregando = false;
  if (!ok) return;

  renderKpis(dados);
  renderGraficoContatos(dados);
  renderAberturaRegua(dados);
  barraHorizontal($('rel-motivos-chat'), dados.chat.motivos, 'label');
  barraHorizontal($('rel-jornada'), dados.chat.jornada, 'nome');
  renderGraficoBuckets($('rel-graf-reembolso-email'), dados.reembolsos_por_dia.email, 'e-mails');
  renderGraficoBuckets($('rel-graf-reembolso-chat'), dados.reembolsos_por_dia.chat, 'conversas');
  barraHorizontal($('rel-motivos-email'), dados.email.motivos_categoria, 'categoria', { rotular: rotularCategoria });
  barraHorizontal($('rel-motivos-reembolso'), dados.email.motivos_reembolso, 'motivo_devolucao', { rotular: rotularMotivo });
  barraHorizontal($('rel-fotos'), dados.fotos.por_tipo, 'tipo_conteudo', { rotular: rotularTipoConteudo });
}

$('rel-dias')?.addEventListener('change', carregar);

/*
 * "Baixar PDF" e "receber por e-mail" são o MESMO clique (pedido do
 * usuário): a API já dispara o envio ao gerar o PDF, então aqui só falta
 * baixar os bytes — fetch cru, não o `api()` de JSON, porque o corpo é
 * binário.
 */
$('rel-baixar-pdf')?.addEventListener('click', async () => {
  const btn = $('rel-baixar-pdf');
  const status = $('rel-pdf-status');
  const dias = $('rel-dias').value || '30';

  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Gerando o PDF e enviando uma cópia para o seu e-mail…';

  try {
    const resp = await fetch(`/api/relatorio/pdf?dias=${encodeURIComponent(dias)}`);
    if (resp.status === 401) { location.replace('/login'); return; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-metricas-${dias}d.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    status.textContent = 'PDF baixado — uma cópia também foi enviada para o seu e-mail (se o SMTP estiver configurado).';
  } catch (err) {
    status.textContent = `Falha ao gerar o PDF: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Primeira carga — a troca de aba não recarrega (mesma mecânica das outras
// telas: todas ficam no DOM, só escondidas).
carregar();
