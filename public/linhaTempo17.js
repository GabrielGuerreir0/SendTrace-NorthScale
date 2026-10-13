/**
 * Linha do tempo do 17TRACK (SPPL): janela com TODOS os eventos da transportadora de um pedido — etapas (etiqueta → trânsito → saída p/ entrega → entregue),
 * eventos agrupados por dia, avisos de "N dias sem movimento", exceções em destaque e um botão para copiar o resumo (para o Slack).
 * Usada pelo cartão do alerta e pela ficha do pedido. Todo texto que vem da transportadora entra por textContent (nunca como HTML).
 */
import { api } from './emailComum.js';
import { dataHora } from './format.js';
import { criarTradutor } from './i18n.js';

const DIC = {
  titulo: { en: '17TRACK timeline', pt: 'Linha do tempo do 17TRACK' },
  fechar: { en: 'Close', pt: 'Fechar' },
  carregando: { en: 'Loading the timeline…', pt: 'Carregando a linha do tempo…' },
  erro: { en: 'Could not load the timeline.', pt: 'Não consegui carregar a linha do tempo.' },
  semCodigo: { en: 'This order has no tracking code yet, so there is nothing to look up at 17TRACK.', pt: 'Este pedido ainda não tem código de rastreio, então não há o que consultar no 17TRACK.' },
  vazio: { en: '17TRACK has not returned any information for this order. The fulfillment center data is on the order card.', pt: 'O 17TRACK não retornou informação para este pedido. Os dados da fulfillment estão na ficha do pedido.' },
  motivo: { en: 'Reason: {motivo}', pt: 'Motivo: {motivo}' },
  ultimo: { en: 'Last event', pt: 'Último evento' },
  ha: { en: '{n} day(s) ago', pt: 'há {n} dia(s)' },
  hoje: { en: 'today', pt: 'hoje' },
  eventos: { en: '{n} events', pt: '{n} eventos' },
  emDias: { en: 'over {n} day(s)', pt: 'em {n} dia(s)' },
  transportadora: { en: 'Carrier', pt: 'Transportadora' },
  codigo: { en: 'Tracking code', pt: 'Código' },
  maisRecentes: { en: 'Newest first', pt: 'Mais recentes primeiro' },
  maisAntigos: { en: 'Oldest first', pt: 'Mais antigos primeiro' },
  copiar: { en: 'Copy summary', pt: 'Copiar resumo' },
  copiado: { en: 'Copied ✓', pt: 'Copiado ✓' },
  semMov: { en: '{n} days without movement', pt: '{n} dias sem movimento' },
  alertaExc: { en: 'The carrier reported a problem with this package.', pt: 'A transportadora registrou um problema com este pacote.' },
  etapa0: { en: 'Label created', pt: 'Etiqueta criada' }, etapa1: { en: 'In transit', pt: 'Em trânsito' },
  etapa2: { en: 'Out for delivery', pt: 'Saiu para entrega' }, etapa3: { en: 'Delivered', pt: 'Entregue' },
  fonte: { en: 'Source: 17TRACK · updated {quando}', pt: 'Fonte: 17TRACK · atualizado {quando}' },
  verCompleta: { en: 'View the full timeline ({n} events)', pt: 'Ver a linha do tempo completa ({n} eventos)' },
};
const t = criarTradutor(DIC);

/** status do 17TRACK → rótulo, tom (cor) e etapa (0–3, ou -1 = fora do fluxo normal). */
const STATUS = {
  NotFound: { pt: 'Não encontrado', en: 'Not found', tom: 'cinza', etapa: -1, icone: '?' },
  InfoReceived: { pt: 'Etiqueta criada', en: 'Label created', tom: 'cinza', etapa: 0, icone: '◔' },
  InTransit: { pt: 'Em trânsito', en: 'In transit', tom: 'azul', etapa: 1, icone: '→' },
  AvailableForPickup: { pt: 'Disponível para retirada', en: 'Available for pickup', tom: 'ambar', etapa: 2, icone: '⌂' },
  OutForDelivery: { pt: 'Saiu para entrega', en: 'Out for delivery', tom: 'ciano', etapa: 2, icone: '➜' },
  Delivered: { pt: 'Entregue', en: 'Delivered', tom: 'verde', etapa: 3, icone: '✓' },
  DeliveryFailure: { pt: 'Falha na entrega', en: 'Delivery failure', tom: 'vermelho', etapa: -1, icone: '!' },
  Exception: { pt: 'Exceção', en: 'Exception', tom: 'vermelho', etapa: -1, icone: '⚠' },
  Expired: { pt: 'Expirado (sem atualização)', en: 'Expired (no updates)', tom: 'ambar', etapa: -1, icone: '⌛' },
};
const SUB = {
  Exception_Returned: ['Devolvido ao remetente', 'Returned to sender'], Exception_Returning: ['Em devolução', 'Being returned'], Exception_AddressIssue: ['Problema no endereço', 'Address issue'],
  Exception_Delayed: ['Atrasado', 'Delayed'], Exception_Damaged: ['Danificado', 'Damaged'], Exception_Held: ['Retido', 'Held'], Exception_Rejected: ['Recusado', 'Rejected'],
  Exception_Lost: ['Extraviado', 'Lost'], Exception_Other: ['Outra exceção', 'Other exception'], InTransit_PickedUp: ['Coletado', 'Picked up'], InTransit_Departure: ['Saiu da unidade', 'Departed'],
  InTransit_Arrival: ['Chegou à unidade', 'Arrived'], InTransit_CustomsProcessing: ['Em desembaraço', 'Customs processing'], InTransit_CustomsReleased: ['Liberado na alfândega', 'Customs released'],
  InTransit_CustomsRequiringInformation: ['Alfândega pede informação', 'Customs needs information'], InTransit_Other: ['Em movimento', 'Moving'],
  DeliveryFailure_NoBody: ['Ninguém para receber', 'Nobody to receive'], DeliveryFailure_Security: ['Segurança / local fechado', 'Security / closed'], DeliveryFailure_Rejected: ['Recusado pelo destinatário', 'Rejected by recipient'],
  DeliveryFailure_InvalidAddress: ['Endereço inválido', 'Invalid address'], DeliveryFailure_Other: ['Outra falha', 'Other failure'], Delivered_Other: ['Entregue', 'Delivered'],
  AvailableForPickup_Other: ['Aguardando retirada', 'Awaiting pickup'], OutForDelivery_Other: ['Com o carteiro', 'With the courier'], NotFound_InvalidCode: ['Código inválido', 'Invalid code'],
  NotFound_Other: ['Sem informação ainda', 'No information yet'], Expired_Other: ['Sem atualização', 'No updates'],
};
const idioma = () => (localStorage.getItem('idioma') === 'pt' ? 'pt' : 'en');
const infoStatus = (s) => STATUS[s] ?? { pt: s || '—', en: s || '—', tom: 'cinza', etapa: -1, icone: '•' };
const rotuloStatus = (s) => infoStatus(s)[idioma()];
/** O 17TRACK manda o status do evento vazio ou com o "estágio" (PickedUp, Returning…); o substatus sempre vem como "Principal_Detalhe" — dele sai o status de verdade. */
const statusEvento = (e) => String(e.substatus || '').split('_')[0] || e.status || '';
/** Detalhe a mostrar ao lado do status; "…_Other" não acrescenta nada (fica só o status). */
const detalheEvento = (e) => { const sub = String(e.substatus || ''); if (!sub.includes('_') || /^(InTransit|Delivered|OutForDelivery|AvailableForPickup|NotFound|Expired)_Other$/.test(sub)) return ''; return rotuloSub(sub); };
const rotuloSub = (sub) => { const x = SUB[sub]; return x ? x[idioma() === 'pt' ? 0 : 1] : String(sub || '').replace(/^[A-Za-z]+_/, '').replace(/([a-z])([A-Z])/g, '$1 $2'); };
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const dia = (iso) => { const x = new Date(iso).toLocaleDateString(idioma() === 'pt' ? 'pt-BR' : 'en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }); return x.charAt(0).toUpperCase() + x.slice(1); };
const hora = (iso) => new Date(iso).toLocaleTimeString(idioma() === 'pt' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
const DIA_MS = 86_400_000;

let janela = null;
function garantirJanela() {
  if (janela) return janela;
  janela = document.createElement('dialog');
  janela.className = 'janela janela--lt17'; janela.id = 'linha17-modal'; janela.setAttribute('aria-labelledby', 'lt17-titulo');
  janela.addEventListener('click', (e) => { if (e.target === janela) janela.close(); });
  document.body.append(janela);
  return janela;
}

function resumoTexto(d, eventos) {
  const linhas = [`${d.transacao_id ?? ''} · ${d.tracking_number ?? ''}`.trim(), ...eventos.slice(0, 8).map((e) => `${dataHora(e.ocorreu_em)} — ${rotuloStatus(statusEvento(e))}${e.descricao ? `: ${e.descricao}` : ''}${[e.cidade, e.estado, e.pais].filter(Boolean).length ? ` (${[e.cidade, e.estado, e.pais].filter(Boolean).join(', ')})` : ''}`)];
  return linhas.join('\n');
}

/** Pílula do status atual + resumo + etapas + aviso de exceção. Usado na janela completa e no resumo compacto da ficha do pedido. */
function blocoResumo(d, eventos) {
  const frag = document.createDocumentFragment();
  const registro = d.registro_17track;
  const agora = Date.now();
  const ultimo = eventos[0];
  const topo = el('div', 'lt17-topo');
  const info = infoStatus(registro?.ultimo_status ?? statusEvento(ultimo));
  const pilula = el('span', `lt17-pilula lt17-tom--${info.tom}`); pilula.append(el('span', 'lt17-icone', info.icone), document.createTextNode(` ${info[idioma()]}`));
  const quando = ultimo ? Math.floor((agora - new Date(ultimo.ocorreu_em).getTime()) / DIA_MS) : null;
  const meta = el('div', 'lt17-meta');
  const sub = registro?.ultimo_substatus ? ` · ${rotuloSub(registro.ultimo_substatus)}` : '';
  meta.append(el('strong', `${rotuloStatus(registro?.ultimo_status ?? statusEvento(ultimo))}${sub}`));
  if (ultimo) meta.append(el('span', `${t('ultimo')}: ${dataHora(ultimo.ocorreu_em)} (${quando === 0 ? t('hoje') : t('ha', { n: quando })})`));
  const primeiro = eventos[eventos.length - 1];
  const span = primeiro && ultimo ? Math.max(1, Math.round((new Date(ultimo.ocorreu_em) - new Date(primeiro.ocorreu_em)) / DIA_MS)) : 0;
  const prov = (() => { const c = {}; for (const e of eventos) if (e.provedor_17t) c[e.provedor_17t] = (c[e.provedor_17t] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; })();
  meta.append(el('span', `${t('eventos', { n: eventos.length })} ${t('emDias', { n: span })}${prov ? ` · ${t('transportadora')}: ${prov}` : ''}${d.tracking_number ? ` · ${t('codigo')}: ${d.tracking_number}` : ''}`));
  topo.append(pilula, meta);
  frag.append(topo);
  const atingida = Math.max(-1, ...eventos.map((e) => infoStatus(statusEvento(e)).etapa));
  const etapas = el('ol', 'lt17-etapas');
  for (let i = 0; i < 4; i += 1) {
    const li = el('li', `lt17-etapa${i <= atingida ? ' lt17-etapa--ok' : ''}${i === atingida ? ' lt17-etapa--atual' : ''}`);
    li.append(el('span', 'lt17-etapa__bolinha', i <= atingida ? '✓' : String(i + 1)), el('span', 'lt17-etapa__rotulo', t(`etapa${i}`)));
    etapas.append(li);
  }
  frag.append(etapas);
  if (['Exception', 'DeliveryFailure'].includes(registro?.ultimo_status ?? statusEvento(ultimo))) {
    const aviso = el('p', 'lt17-aviso', `⚠ ${t('alertaExc')}${registro?.ultimo_substatus ? ` ${rotuloSub(registro.ultimo_substatus)}.` : ''}`); aviso.setAttribute('role', 'alert'); frag.append(aviso);
  }
  return frag;
}

/** Resumo compacto para a ficha do pedido: status, etapas, os 3 últimos eventos e o botão da linha do tempo completa (a lista longa NÃO fica na ficha). */
export function montarResumo17(d, aoAbrir) {
  const eventos = (d.historico_17track ?? []).filter((e) => e.ocorreu_em);
  const caixa = el('div', 'lt17-resumo');
  caixa.append(blocoResumo(d, eventos));
  const mini = el('ol', 'lt17-mini');
  for (const e of eventos.slice(0, 3)) {
    const si = infoStatus(statusEvento(e));
    const li = el('li', `lt17-tom--${si.tom}`);
    const local = [e.cidade, e.estado].filter(Boolean).join(', ');
    li.append(el('span', 'lt17-mini__ponto', si.icone), el('time', undefined, dataHora(e.ocorreu_em)),
      el('strong', undefined, `${rotuloStatus(statusEvento(e))}${detalheEvento(e) ? ` · ${detalheEvento(e)}` : ''}`),
      el('span', 'lt17-mini__txt', [e.descricao, local].filter(Boolean).join(' · ')));
    mini.append(li);
  }
  caixa.append(mini);
  const botao = el('button', 'btn btn-forte', t('verCompleta', { n: String(eventos.length) })); botao.type = 'button'; botao.addEventListener('click', aoAbrir);
  caixa.append(botao);
  return caixa;
}

function desenhar(corpo, d, eventos, ordemNovos) {
  corpo.replaceChildren();
  const registro = d.registro_17track;
  corpo.append(blocoResumo(d, eventos));

  // 2) controles
  const barra = el('div', 'lt17-barra');
  const ordem = el('button', 'btn', ordemNovos ? t('maisAntigos') : t('maisRecentes')); ordem.type = 'button';
  ordem.addEventListener('click', () => desenhar(corpo, d, eventos, !ordemNovos));
  const copiar = el('button', 'btn', t('copiar')); copiar.type = 'button';
  copiar.addEventListener('click', async () => { try { await navigator.clipboard.writeText(resumoTexto(d, eventos)); copiar.textContent = t('copiado'); setTimeout(() => { copiar.textContent = t('copiar'); }, 1500); } catch { window.prompt(t('copiar'), resumoTexto(d, eventos)); } });
  barra.append(ordem, copiar);
  corpo.append(barra);

  // 3) linha do tempo agrupada por dia, com aviso de lacunas
  const lista = ordemNovos ? eventos : [...eventos].reverse();
  const trilha = el('ol', 'lt17-linha');
  let diaAtual = '', anterior = null;
  for (const e of lista) {
    if (!e.ocorreu_em) continue;
    const dk = new Date(e.ocorreu_em).toDateString();
    if (dk !== diaAtual) { diaAtual = dk; const h = el('li', 'lt17-dia', dia(e.ocorreu_em)); h.setAttribute('role', 'presentation'); trilha.append(h); }
    if (anterior) {
      const dias = Math.floor(Math.abs(new Date(anterior).getTime() - new Date(e.ocorreu_em).getTime()) / DIA_MS);
      if (dias >= 3) trilha.append(el('li', 'lt17-lacuna', `⏸ ${t('semMov', { n: dias })}`));
    }
    anterior = e.ocorreu_em;
    const si = infoStatus(statusEvento(e));
    const li = el('li', `lt17-evento lt17-tom--${si.tom}`);
    li.append(el('span', 'lt17-ponto', si.icone));
    const card = el('div', 'lt17-cartao');
    const cab = el('div', 'lt17-cartao__cab');
    cab.append(el('strong', undefined, `${rotuloStatus(statusEvento(e))}${detalheEvento(e) ? ` · ${detalheEvento(e)}` : ''}`), el('time', undefined, hora(e.ocorreu_em)));
    card.append(cab);
    if (e.descricao) card.append(el('p', 'lt17-desc', e.descricao));
    const local = [e.cidade, e.estado, e.pais].filter(Boolean).join(', ');
    if (local || e.provedor_17t) { const rod = el('p', 'lt17-local'); rod.textContent = [local ? `📍 ${local}` : null, e.provedor_17t || null].filter(Boolean).join(' · '); card.append(rod); }
    li.append(card); trilha.append(li);
  }
  corpo.append(trilha);
  if (registro?.atualizado_em) corpo.append(el('p', 'lt17-fonte', t('fonte', { quando: dataHora(registro.atualizado_em) })));
}

/** Abre a janela com a linha do tempo do pedido. `subtitulo` é só o texto de apoio do cabeçalho. */
export async function abrirLinhaTempo17({ transacaoId, subtitulo = '' }) {
  const j = garantirJanela();
  j.replaceChildren();
  const cab = el('header', 'janela-cabeca');
  const bloco = el('div'); const h = el('h2', undefined, t('titulo')); h.id = 'lt17-titulo';
  bloco.append(h, el('p', 'cartao-sub', subtitulo || transacaoId));
  const x = el('button', 'btn btn-icone'); x.type = 'button'; x.title = t('fechar'); x.append(el('span', undefined, '✕')); x.firstChild.setAttribute('aria-hidden', 'true'); x.append(el('span', 'sr', t('fechar')));
  x.addEventListener('click', () => j.close());
  cab.append(bloco, x);
  const corpo = el('div', 'janela-corpo lt17-corpo'); corpo.append(el('p', 'cartao-sub', t('carregando')));
  j.append(cab, corpo);
  if (!j.open) j.showModal();
  const { ok, dados } = await api(`/api/rastreio/${encodeURIComponent(transacaoId)}`);
  if (!ok) { corpo.replaceChildren(el('p', 'cartao-sub', dados?.erro ?? t('erro'))); return; }
  const eventos = (dados.historico_17track ?? []).filter((e) => e.ocorreu_em);
  if (!eventos.length) {
    corpo.replaceChildren(el('p', 'cartao-sub', !dados.tracking_number ? t('semCodigo') : `${t('vazio')}${dados.registro_17track?.motivo_recusa ? ` ${t('motivo', { motivo: dados.registro_17track.motivo_recusa })}` : ''}`));
    return;
  }
  desenhar(corpo, { ...dados, transacao_id: transacaoId }, eventos, true);
}
