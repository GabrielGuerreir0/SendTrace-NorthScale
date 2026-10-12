/**
 * SPPL — tela das regras (status do 17TRACK e prazos) e dos feriados, no fim da aba "Rastreio de Pedidos".
 * Carrega só quando a seção é aberta (não pesa a aba). Todo mundo com a página vê; só administrador edita
 * (a API também confere). Texto sempre por textContent: nada vindo da API entra como HTML.
 */
import { $, api, usuarioAtual } from './emailComum.js';
import { criarTradutor, idiomaAtual } from './i18n.js';

const DIC = {
  carregando: { en: 'loading…', pt: 'carregando…' },
  spplTitulo: { en: 'SPPL rules', pt: 'Regras do SPPL' },
  spplSub: { en: 'What to do for each 17TRACK status and for orders that stop moving, who owns it and how long it takes. Only admins edit.', pt: 'O que fazer em cada status do 17TRACK e em pedido parado, quem é o responsável e quanto tempo leva. Só administrador edita.' },
  spplPreparacao: { en: 'Being prepared: these rules are not yet applied automatically to orders. You can already review and adjust the deadlines.', pt: 'Em preparação: estas regras ainda não são aplicadas automaticamente aos pedidos. Você já pode revisar e ajustar os prazos.' },
  spplColQuando: { en: 'When', pt: 'Quando' }, spplColTitulo: { en: 'Case', pt: 'Caso' }, spplColAcao: { en: 'Action', pt: 'Ação' },
  spplColResp: { en: 'Owner', pt: 'Responsável' }, spplColPrazo: { en: 'Days', pt: 'Dias' }, spplColPrio: { en: 'Priority', pt: 'Prioridade' }, spplColAtiva: { en: 'On', pt: 'Ligada' },
  spplFDias: { en: 'Days to trigger (empty = immediate)', pt: 'Dias para disparar (vazio = imediato)' }, spplFPrazo: { en: 'Days to resolve', pt: 'Dias para resolver' },
  spplFUteis: { en: 'Business days', pt: 'Dias úteis' }, spplFImediato: { en: 'Immediate (do not wait for 5/10/15 days)', pt: 'Imediata (não espera os 5/10/15 dias)' },
  spplFCliente: { en: 'Contact the customer', pt: 'Contatar o cliente' }, spplSalvar: { en: 'Save', pt: 'Salvar' }, spplCancelar: { en: 'Cancel', pt: 'Cancelar' },
  spplFeriados: { en: 'Holidays (non-business days)', pt: 'Feriados (dias não úteis)' }, spplFeriadosSub: { en: 'Saturdays and Sundays are already skipped. Add US holidays here so deadlines skip them too.', pt: 'Sábado e domingo já são pulados. Cadastre aqui os feriados dos EUA para os prazos pularem também.' },
  spplFerDesc: { en: 'Name (optional)', pt: 'Nome (opcional)' }, spplAdicionar: { en: 'Add', pt: 'Adicionar' }, spplEditar: { en: 'Edit', pt: 'Editar' }, spplRemover: { en: 'Remove', pt: 'Remover' },
  spplImediato: { en: 'immediate', pt: 'imediato' }, spplTempoCompra: { en: 'after purchase', pt: 'após a compra' }, spplTempoEtiqueta: { en: 'after label created', pt: 'após a etiqueta' },
  spplTempoMov: { en: 'without movement', pt: 'sem movimentação' }, spplSemDado: { en: '17TRACK has no data', pt: '17TRACK sem dado' }, spplUteis: { en: 'business days', pt: 'dias úteis' }, spplCorridos: { en: 'calendar days', pt: 'dias corridos' },
  spplEditando: { en: 'Editing rule', pt: 'Editando regra' }, spplSalvo: { en: 'Saved.', pt: 'Salvo.' }, spplErro: { en: 'Could not save: ', pt: 'Não foi possível salvar: ' }, spplSemFeriados: { en: 'No holidays registered.', pt: 'Nenhum feriado cadastrado.' },
  spplMotorTit: { en: 'Engine simulation', pt: 'Simulação do motor' }, spplMotorSub: { en: 'Shows how many alerts the engine would open right now, without opening any. Turn the engine on only after you have seen this number.', pt: 'Mostra quantos alertas o motor abriria agora, sem abrir nenhum. Só ligue o motor depois de ver este número.' },
  spplMotorBtn: { en: 'Simulate now', pt: 'Simular agora' }, spplMotorLigado: { en: 'Engine is ON (max {max} new alerts per round).', pt: 'Motor LIGADO (no máximo {max} alertas novos por rodada).' }, spplMotorDesligado: { en: 'Engine is OFF. Nothing is opened automatically.', pt: 'Motor DESLIGADO. Nada é aberto automaticamente.' },
  spplMotorTotal: { en: 'It would open {total} alerts now:', pt: 'Abriria {total} alertas agora:' }, spplMotorNada: { en: 'It would open no alert now.', pt: 'Não abriria nenhum alerta agora.' },
  sim: { en: 'yes', pt: 'sim' }, nao: { en: 'no', pt: 'não' },
};
const t = criarTradutor(DIC);
const el = (tag, texto, classe) => { const e = document.createElement(tag); if (texto !== undefined) e.textContent = texto; if (classe) e.className = classe; return e; };

let regras = [];
let editando = null;
const ehAdmin = () => Boolean(usuarioAtual()?.admin);

function quando(r) {
  if (r.origem === 'sem_dado') return t('spplSemDado');
  if (r.origem === 'tempo') {
    const ref = { compra: t('spplTempoCompra'), etiqueta: t('spplTempoEtiqueta'), ultima_movimentacao: t('spplTempoMov') }[r.referencia_tempo] ?? r.referencia_tempo;
    return `${r.dias ?? '—'} ${r.dias_uteis ? t('spplUteis') : t('spplCorridos')} ${ref}`;
  }
  const base = r.substatus_17t || r.status_17t || '—';
  return r.imediato ? `${base} · ${t('spplImediato')}` : base;
}

function desenharRegras() {
  const corpo = $('sppl-corpo');
  if (!corpo) return;
  corpo.replaceChildren(...regras.map((r) => {
    const tr = document.createElement('tr');
    if (!r.ativa) tr.style.opacity = '0.5';
    const acao = el('td', r.acao ?? '—'); acao.style.maxWidth = '34ch';
    tr.append(el('td', quando(r)), el('td', r.titulo), acao, el('td', r.responsavel), el('td', r.dias ?? '—'), el('td', r.prioridade), el('td', r.ativa ? t('sim') : t('nao')));
    const ultima = el('td');
    if (ehAdmin()) {
      const b = el('button', t('spplEditar'), 'btn'); b.type = 'button'; b.addEventListener('click', () => abrirForm(r));
      ultima.append(b);
    }
    tr.append(ultima);
    return tr;
  }));
}

function abrirForm(r) {
  editando = r;
  $('sppl-form-titulo').textContent = `${t('spplEditando')}: ${r.titulo}`;
  $('sppl-f-titulo').value = r.titulo ?? ''; $('sppl-f-acao').value = r.acao ?? ''; $('sppl-f-resp').value = r.responsavel ?? '';
  $('sppl-f-dias').value = r.dias ?? ''; $('sppl-f-prazo').value = r.prazo_resolucao_dias ?? ''; $('sppl-f-prio').value = r.prioridade;
  $('sppl-f-uteis').checked = r.dias_uteis; $('sppl-f-imediato').checked = r.imediato; $('sppl-f-cliente').checked = r.contata_cliente; $('sppl-f-ativa').checked = r.ativa;
  $('sppl-form').hidden = false; $('sppl-form').scrollIntoView({ block: 'nearest' });
}

async function carregar() {
  const [reg, fer] = await Promise.all([api('/api/rastreio/sppl/regras'), api('/api/rastreio/sppl/feriados')]);
  if (reg.ok) { regras = reg.dados.regras ?? []; desenharRegras(); } else $('sppl-aviso').textContent = reg.dados?.erro ?? `HTTP ${reg.status}`;
  if (fer.ok) desenharFeriados(fer.dados.feriados ?? []);
  $('sppl-feriado-form').hidden = !ehAdmin();
  $('sppl-motor').hidden = !ehAdmin();
}

function desenharFeriados(lista) {
  const ul = $('sppl-feriados');
  if (!lista.length) { ul.replaceChildren(el('li', t('spplSemFeriados'))); return; }
  ul.replaceChildren(...lista.map((f) => {
    const li = el('li', `${f.data}${f.descricao ? ` — ${f.descricao}` : ''} `);
    if (ehAdmin()) {
      const b = el('button', t('spplRemover'), 'btn'); b.type = 'button';
      b.addEventListener('click', async () => { await api(`/api/rastreio/sppl/feriados/${f.data}`, { metodo: 'DELETE' }); carregar(); });
      li.append(b);
    }
    return li;
  }));
}

async function simularMotor() {
  const r = await api('/api/rastreio/sppl/motor');
  const est = $('sppl-motor-estado'); const ul = $('sppl-motor-saida');
  if (!r.ok) { est.textContent = t('spplErro') + (r.dados?.erro ?? r.status); ul.replaceChildren(); return; }
  const d = r.dados;
  est.textContent = `${d.ativo ? t('spplMotorLigado', { max: d.max_novas_por_rodada }) : t('spplMotorDesligado')} ${d.total ? t('spplMotorTotal', { total: d.total }) : t('spplMotorNada')}`;
  ul.replaceChildren(...(d.simulacao ?? []).map((s) => el('li', `${s.titulo}: ${s.abriria}`)));
}

function ligar() {
  const det = $('sppl-detalhes');
  if (!det) return;
  let carregou = false;
  det.addEventListener('toggle', () => { if (det.open && !carregou) { carregou = true; carregar(); } });
  $('sppl-motor-btn').addEventListener('click', simularMotor);
  $('sppl-f-cancelar').addEventListener('click', () => { $('sppl-form').hidden = true; editando = null; });
  $('sppl-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editando) return;
    const num = (id) => ($(id).value === '' ? null : Number($(id).value));
    const corpo = {
      titulo: $('sppl-f-titulo').value, acao: $('sppl-f-acao').value, responsavel: $('sppl-f-resp').value, dias: num('sppl-f-dias'), prazo_resolucao_dias: num('sppl-f-prazo'),
      prioridade: $('sppl-f-prio').value, dias_uteis: $('sppl-f-uteis').checked, imediato: $('sppl-f-imediato').checked, contata_cliente: $('sppl-f-cliente').checked, ativa: $('sppl-f-ativa').checked,
    };
    const r = await api(`/api/rastreio/sppl/regras/${editando.id}`, { metodo: 'PATCH', corpo });
    if (!r.ok) { $('sppl-aviso').textContent = t('spplErro') + (r.dados?.erro ?? r.status); return; }
    $('sppl-aviso').textContent = t('spplSalvo'); $('sppl-form').hidden = true; editando = null; carregar();
  });
  $('sppl-feriado-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/rastreio/sppl/feriados', { metodo: 'POST', corpo: { data: $('sppl-fer-data').value, descricao: $('sppl-fer-desc').value } });
    if (!r.ok) { $('sppl-aviso').textContent = t('spplErro') + (r.dados?.erro ?? r.status); return; }
    $('sppl-fer-data').value = ''; $('sppl-fer-desc').value = ''; carregar();
  });
  // idioma: reaplica os textos estáticos quando o seletor do Rastreio troca
  document.addEventListener('click', (ev) => { if (ev.target.closest?.('#rst-idioma-seletor')) setTimeout(() => { aplicarEstaticos(); desenharRegras(); }, 0); });
  aplicarEstaticos();
}

function aplicarEstaticos() {
  const raiz = $('sppl-cartao');
  raiz.querySelectorAll('[data-t]').forEach((e) => { const k = e.dataset.t; if (DIC[k]) e.textContent = t(k); });
  raiz.querySelectorAll('[data-t-placeholder]').forEach((e) => { const k = e.dataset.tPlaceholder; if (DIC[k]) e.placeholder = t(k); });
}

ligar();
void idiomaAtual;
