/**
 * SPPL — Suporte Ativo (2º momento da Késsia): tickets de pedidos selecionados pela equipe, e-mail em massa INDIVIDUAL (cada cliente recebe o seu),
 * atualização de propriedades em massa (sempre com conferência antes), registro das ações e fila de respostas dos clientes SEPARADA da fila normal.
 * Enviar e-mail não fecha nem resolve o ticket: o status só muda por ação da equipe. Tudo em português.
 */
import { api, montarPaginacao } from './emailComum.js';
import { el, fmtDataHora, fmtData, rotPlataforma, campoSelect, campoTexto, criarJanela, mensagem } from './spplComum.js';

const POR_PAGINA = 50;
const ROT_PROP = { status_logistico: 'Status logístico', motivo_problema: 'Motivo do problema', status_suporte: 'Status do suporte', status_ticket: 'Status do ticket', rastreio_reenvio: 'Código de rastreio do reenvio', link_reenvio: 'Link de rastreio do reenvio' };
const ROT_TICKET = { aberto: 'Aberto', resolvido: 'Resolvido', fechado: 'Fechado' };
const estado = { sub: 'tickets', pagina: 1, selecionados: new Set(), itens: [], total: 0, kpis: null, status_ticket: 'abertos', status_logistico: '', motivo_problema: '', status_suporte: '', contato: '', resposta: '', busca: '', carregando: false };
let C = null;       // listas das propriedades (da API)
let raiz = null; let iniciado = false; let msgEl = null; let temporizador = null;

const consulta = (extra = {}) => {
  const q = new URLSearchParams();
  for (const k of ['status_ticket', 'status_logistico', 'motivo_problema', 'status_suporte', 'contato', 'resposta', 'busca']) if (estado[k]) q.set(k, estado[k]);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
};
const erroDe = (r, padrao) => r.dados?.erro || r.dados?.detalhe || r.dados?.detail || padrao;
const opcoes = (lista, vazio = '(não alterar)') => [['', vazio], ...lista.map((x) => [x, ROT_TICKET[x] ?? x])];

/* ═══════════════════════  KPIs e sub-abas  ═══════════════════════ */
function desenharKpis() {
  const caixa = raiz.querySelector('#ativo-kpis'); caixa.replaceChildren(); const k = estado.kpis; if (!k) return;
  const itens = [
    ['Abertos', k.abertos, () => { estado.status_ticket = 'aberto'; estado.resposta = ''; }, estado.status_ticket === 'aberto' && !estado.resposta],
    ['Resolvidos', k.resolvidos, () => { estado.status_ticket = 'resolvido'; estado.resposta = ''; }, estado.status_ticket === 'resolvido'],
    ['Fechados', k.fechados, () => { estado.status_ticket = 'fechado'; estado.resposta = ''; }, estado.status_ticket === 'fechado'],
    ['Respostas pendentes', k.respostas_pendentes, () => { estado.status_ticket = 'abertos'; estado.resposta = 'pendente'; }, estado.resposta === 'pendente', 'alto'],
  ];
  for (const [rotulo, valor, acao, ativo, tom] of itens) {
    const b = el('button', undefined, 'sppl-kpi'); b.type = 'button'; b.setAttribute('aria-pressed', String(Boolean(ativo))); if (tom && valor > 0) b.dataset.tom = tom;
    b.append(el('b', String(valor ?? 0)), document.createTextNode(rotulo));
    b.addEventListener('click', () => { acao(); estado.sub = 'tickets'; estado.pagina = 1; estado.selecionados.clear(); sincronizarFiltros(); desenharSub(); carregarTickets(); });
    caixa.append(b);
  }
}
function desenharSub() {
  for (const [id, nome] of [['ativo-sub-tickets', 'tickets'], ['ativo-sub-respostas', 'respostas']]) raiz.querySelector(`#${id}`)?.setAttribute('aria-selected', String(estado.sub === nome));
  raiz.querySelector('#ativo-vista-tickets').hidden = estado.sub !== 'tickets'; raiz.querySelector('#ativo-vista-respostas').hidden = estado.sub !== 'respostas';
  const bt = raiz.querySelector('#ativo-sub-respostas'); if (bt) bt.textContent = `Respostas dos clientes${estado.kpis?.respostas_pendentes ? ` (${estado.kpis.respostas_pendentes})` : ''}`;
  if (estado.sub === 'respostas') carregarRespostas();
}

/* ═══════════════════════  lista de tickets  ═══════════════════════ */
const celula = (rotulo, conteudo, classe) => { const td = document.createElement('td'); td.dataset.label = rotulo; if (classe) td.className = classe; if (conteudo instanceof Node) td.append(conteudo); else td.textContent = conteudo ?? '—'; return td; };

function linha(t) {
  const tr = document.createElement('tr'); tr.className = 'sup-linha-clique';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = estado.selecionados.has(t.id); cb.setAttribute('aria-label', `Selecionar o ticket do pedido ${t.numero_pedido}`);
  cb.addEventListener('click', (e) => e.stopPropagation()); cb.addEventListener('change', () => { if (cb.checked) estado.selecionados.add(t.id); else estado.selecionados.delete(t.id); atualizarBarra(); });
  const tdCb = document.createElement('td'); tdCb.append(cb);
  const cliente = el('div'); cliente.append(el('strong', t.nome || '—'), el('br'), el('small', t.email || 'sem e-mail', 'cartao-sub'));
  const status = el('div'); status.append(el('span', ROT_TICKET[t.status_ticket] ?? t.status_ticket, 'sppl-selo'));
  if (t.resposta_pendente) status.append(el('br'), el('span', 'Cliente respondeu', 'sppl-selo sppl-selo--p0'));
  const contato = t.enviados ? `${t.enviados} e-mail(s) · último ${fmtDataHora(t.ultimo_envio_em)}` : 'Sem contato ainda';
  tr.append(tdCb, celula('Pedido', el('strong', t.numero_pedido)), celula('Cliente', cliente), celula('Produto', t.produto || '—'), celula('Código de rastreio', t.rastreio_reenvio ? `${t.rastreio_original || '—'} → reenvio ${t.rastreio_reenvio}` : (t.rastreio_original || '—')),
    celula('Status logístico', t.status_logistico), celula('Motivo do problema', t.motivo_problema), celula('Status do suporte', t.status_suporte), celula('Ticket', status), celula('Contato', contato), celula('Selecionado em', fmtData(t.selecionado_em)));
  tr.addEventListener('click', () => abrirDetalhe(t.id));
  return tr;
}
const vazioTr = (texto) => { const tr = document.createElement('tr'); const td = el('td', texto, 'vazio-suave'); td.colSpan = 11; tr.append(td); return tr; };

async function carregarTickets() {
  if (estado.carregando) return; estado.carregando = true;
  try {
    const r = await api(`/api/rastreio/sppl/ativo/tickets?${consulta({ pagina: estado.pagina, tamanho: POR_PAGINA })}`);
    const corpo = raiz.querySelector('#ativo-corpo');
    if (!r.ok) { corpo.replaceChildren(vazioTr(erroDe(r, 'Não foi possível carregar os tickets.'))); return; }
    estado.itens = r.dados.itens; estado.total = r.dados.total; estado.kpis = r.dados.kpis;
    corpo.replaceChildren(...(estado.itens.length ? estado.itens.map(linha) : [vazioTr('Nenhum ticket com os filtros atuais. Para criar tickets, selecione pedidos na aba "Monitoramento logístico".')]));
    montarPaginacao(raiz.querySelector('#ativo-paginacao'), { pagina: estado.pagina, totalPaginas: Math.max(1, Math.ceil(estado.total / POR_PAGINA)), total: estado.total, rotuloItem: 'tickets' }, (p) => { estado.pagina = p; carregarTickets(); });
    desenharKpis(); desenharSub(); atualizarBarra();
  } finally { estado.carregando = false; }
}

function atualizarBarra() {
  const n = estado.selecionados.size; const b = raiz.querySelector('#ativo-barra');
  b.querySelector('#ativo-sel-texto').textContent = n ? `${n} ticket(s) selecionado(s)` : 'Nenhum ticket selecionado';
  for (const id of ['ativo-btn-email', 'ativo-btn-props']) b.querySelector(`#${id}`).disabled = !n;
  b.querySelector('#ativo-btn-limpar').hidden = !n;
  const tf = b.querySelector('#ativo-btn-todos-filtro'); tf.hidden = !(estado.total > estado.itens.length); tf.textContent = `Selecionar os ${estado.total} do filtro`;
  const cab = raiz.querySelector('#ativo-marca-todos'); if (cab) cab.checked = estado.itens.length > 0 && estado.itens.every((t) => estado.selecionados.has(t.id));
}
async function selecionarTodosDoFiltro() {
  const r = await api(`/api/rastreio/sppl/ativo/tickets?${consulta({ so_ids: 1 })}`);
  if (!r.ok) { mensagem(msgEl, erroDe(r, 'Não foi possível buscar os tickets do filtro.'), true); return; }
  for (const id of r.dados.ids) estado.selecionados.add(id);
  for (const cb of raiz.querySelectorAll('#ativo-corpo input[type=checkbox]')) cb.checked = true;
  mensagem(msgEl, r.dados.cortado ? `Selecionados ${r.dados.ids.length} (limite por operação); refine o filtro para os demais.` : `${r.dados.ids.length} ticket(s) selecionado(s).`); atualizarBarra();
}

/* ═══════════════════════  conferir antes de enviar / atualizar  ═══════════════════════ */
function blocoPropriedades(prefixo) {
  // devolve { elemento, ler() } com os seletores das propriedades; vazio = não alterar
  const caixa = el('div', undefined, 'sppl-form-grid'); const campos = {};
  for (const k of ['status_logistico', 'motivo_problema', 'status_suporte', 'status_ticket']) {
    const lista = C[k]; const c = campoSelect(ROT_PROP[k], k === 'status_ticket' ? [['', '(não alterar)'], ...lista.map((x) => [x, ROT_TICKET[x]])] : [['', '(não alterar)'], ...lista.map((x) => [x, x])]); campos[k] = c.select; caixa.append(c.rotulo);
  }
  const r1 = campoTexto(ROT_PROP.rastreio_reenvio, { max: 200, placeholder: 'só se houve reenvio' }); const r2 = campoTexto(ROT_PROP.link_reenvio, { max: 500, placeholder: 'link de acompanhamento do reenvio' });
  campos.rastreio_reenvio = r1.input; campos.link_reenvio = r2.input; caixa.append(r1.rotulo, r2.rotulo);
  return { elemento: caixa, ler: () => Object.fromEntries(Object.entries(campos).map(([k, i]) => [k, i.value.trim()]).filter(([, v]) => v !== '')) };
}
const resumoProps = (p) => Object.entries(p).map(([k, v]) => `${ROT_PROP[k]}: ${k === 'status_ticket' ? ROT_TICKET[v] : v}`);

async function abrirPropriedades(ids) {
  const j = criarJanela('ativo-janela-props'); const corpo = j.refazer('Atualizar propriedades em massa', `${ids.length} ticket(s) selecionado(s)`);
  corpo.append(el('p', 'Só as propriedades que você escolher serão alteradas; as demais ficam como estão. Antes de gravar você confere o que vai mudar.', 'cartao-sub'));
  const bp = blocoPropriedades(); corpo.append(bp.elemento);
  const aviso = el('p', '', 'cartao-sub'); aviso.setAttribute('role', 'status'); const conf = el('div'); corpo.append(conf, aviso);
  const acoes = el('div', undefined, 'sppl-acoes'); const bConf = el('button', 'Conferir', 'btn btn-forte'); bConf.type = 'button'; acoes.append(bConf); corpo.append(acoes);
  bConf.addEventListener('click', async () => {
    const props = bp.ler(); if (!Object.keys(props).length) { mensagem(aviso, 'Escolha pelo menos uma propriedade para alterar.', true); return; }
    const r = await api('/api/rastreio/sppl/ativo/propriedades', { metodo: 'POST', corpo: { ids, propriedades: props, simular: true } });
    if (!r.ok) { mensagem(aviso, erroDe(r, 'Não foi possível conferir.'), true); return; }
    conf.replaceChildren(); const d = r.dados;
    conf.append(el('h3', 'Conferência', 'sppl-secao-titulo'), el('p', `${d.alterariam} de ${d.selecionados} ticket(s) mudariam. Nenhuma alteração foi gravada ainda.`));
    const ul = el('ul'); for (const l of resumoProps(d.propriedades)) ul.append(el('li', l)); conf.append(ul);
    const confirmar = el('button', `Confirmar e atualizar ${d.alterariam} ticket(s)`, 'btn btn-forte'); confirmar.type = 'button'; confirmar.disabled = !d.alterariam;
    confirmar.addEventListener('click', async () => {
      confirmar.disabled = true; const g = await api('/api/rastreio/sppl/ativo/propriedades', { metodo: 'POST', corpo: { ids, propriedades: props, confirmar: true } });
      if (!g.ok) { mensagem(aviso, erroDe(g, 'Não foi possível atualizar.'), true); confirmar.disabled = false; return; }
      j.fechar(); mensagem(msgEl, `${g.dados.alterados} ticket(s) atualizado(s).`); estado.selecionados.clear(); carregarTickets();
    });
    conf.append(confirmar); mensagem(aviso, '');
  });
  j.abrir();
}

async function abrirEnvio(ids, { respondendo = false } = {}) {
  const j = criarJanela('ativo-janela-envio'); const corpo = j.refazer(respondendo ? 'Responder ao cliente' : 'Enviar e-mail aos clientes', `${ids.length} ticket(s) selecionado(s)`);
  corpo.append(el('p', 'Cada cliente recebe o PRÓPRIO e-mail, sem ver os demais destinatários. O envio não fecha nem resolve o ticket; o status só muda quando a equipe alterar. Antes de enviar você confere os destinatários, a mensagem e as propriedades.', 'cartao-sub'));
  const as = campoTexto('Assunto', { max: 200, placeholder: 'Ex.: Update on your order {pedido}', cresce: true }); corpo.append(as.rotulo);
  const lt = el('label', undefined, 'campo campo--cresce'); lt.append(el('span', 'Mensagem'));
  const ta = document.createElement('textarea'); ta.rows = 9; ta.maxLength = 8000; ta.placeholder = 'Hi {nome},\n\nWe are looking into your order {pedido}...'; lt.append(ta); corpo.append(lt);
  const chips = el('div', undefined, 'sppl-acoes'); chips.append(el('span', 'Inserir:', 'cartao-sub'));
  for (const m of C.marcadores) { const b = el('button', `{${m}}`, 'btn'); b.type = 'button'; b.addEventListener('click', () => { const i = ta.selectionStart ?? ta.value.length; ta.setRangeText(`{${m}}`, i, ta.selectionEnd ?? i, 'end'); ta.focus(); }); chips.append(b); }
  corpo.append(chips);
  const det = document.createElement('details'); det.append(el('summary', 'Atualizar propriedades dos tickets neste mesmo envio (opcional)')); const bp = blocoPropriedades(); det.append(bp.elemento); corpo.append(det);
  const aviso = el('p', '', 'cartao-sub'); aviso.setAttribute('role', 'status'); const conf = el('div'); corpo.append(conf, aviso);
  const acoes = el('div', undefined, 'sppl-acoes'); const bConf = el('button', 'Conferir antes de enviar', 'btn btn-forte'); bConf.type = 'button'; acoes.append(bConf); corpo.append(acoes);
  const corpoReq = (extra) => ({ ids, assunto: as.input.value.trim(), texto: ta.value.trim(), ...(Object.keys(bp.ler()).length ? { propriedades: bp.ler() } : {}), ...extra });
  bConf.addEventListener('click', async () => {
    const r = await api('/api/rastreio/sppl/ativo/enviar', { metodo: 'POST', corpo: corpoReq({ simular: true }) });
    if (!r.ok) { mensagem(aviso, erroDe(r, 'Não foi possível conferir.'), true); return; }
    const d = r.dados; conf.replaceChildren(); mensagem(aviso, '');
    conf.append(el('h3', `Conferência: ${d.total} e-mail(s)`, 'sppl-secao-titulo'), el('p', d.aviso, 'cartao-sub'));
    if (d.exemplo) { const ex = el('div'); ex.append(el('p', `Exemplo (primeiro destinatário): para ${d.exemplo.para}`, 'cartao-sub'), el('strong', `Assunto: ${d.exemplo.assunto}`)); const pre = el('pre', d.exemplo.texto); pre.style.whiteSpace = 'pre-wrap'; ex.append(pre); conf.append(ex); }
    if (d.sem_email.length) conf.append(el('p', `Sem e-mail válido (não receberão): ${d.sem_email.map((x) => x.pedido).join(', ')}`, 'sppl-aviso'));
    if (d.ignorados_fechados.length) conf.append(el('p', `Tickets fechados ignorados: ${d.ignorados_fechados.length}`, 'sppl-aviso'));
    if (d.propriedades) { const ul = el('ul'); for (const l of resumoProps(d.propriedades)) ul.append(el('li', l)); conf.append(el('p', 'Propriedades que serão atualizadas junto:', 'cartao-sub'), ul); }
    const det2 = document.createElement('details'); det2.append(el('summary', `Destinatários (${d.destinatarios.length})`)); const ul2 = el('ul'); for (const x of d.destinatarios) ul2.append(el('li', `${x.nome || '—'} <${x.email}> · pedido ${x.pedido}`)); det2.append(ul2); conf.append(det2);
    const enviar = el('button', `Confirmar e enviar ${d.total} e-mail(s)`, 'btn btn-forte'); enviar.type = 'button'; enviar.disabled = !d.total; conf.append(enviar);
    enviar.addEventListener('click', async () => {
      enviar.disabled = true; bConf.disabled = true; const g = await api('/api/rastreio/sppl/ativo/enviar', { metodo: 'POST', corpo: corpoReq({ confirmar: true }) });
      if (!g.ok) { mensagem(aviso, erroDe(g, 'Não foi possível enviar.'), true); enviar.disabled = false; bConf.disabled = false; return; }
      acompanharLote(g.dados.lote, g.dados.enfileirados, conf, aviso, j);
    });
  });
  j.abrir();
}

async function acompanharLote(lote, total, conf, aviso, j) {
  conf.replaceChildren(el('h3', 'Enviando…', 'sppl-secao-titulo')); const prog = el('p', `0 de ${total}`); conf.append(prog);
  for (let i = 0; i < 600; i += 1) {
    const r = await api(`/api/rastreio/sppl/ativo/envios?lote=${encodeURIComponent(lote)}`); if (!r.ok) break;
    const s = r.dados.por_status; const enviados = s.enviado ?? 0; const falhou = s.falhou ?? 0; const pend = (s.fila ?? 0) + (s.enviando ?? 0);
    prog.textContent = `${enviados} de ${total} enviado(s)${falhou ? ` · ${falhou} falharam` : ''}${pend ? ` · ${pend} na fila` : ''}`;
    if (!pend) {
      conf.querySelector('h3').textContent = falhou ? 'Envio concluído com falhas' : 'Envio concluído';
      if (falhou) {
        const ul = el('ul'); for (const f of r.dados.falhas) ul.append(el('li', `${f.para_email}: ${f.erro || 'erro'}`)); conf.append(ul);
        const bt = el('button', 'Tentar de novo os que falharam', 'btn'); bt.type = 'button'; bt.addEventListener('click', async () => { bt.disabled = true; await api('/api/rastreio/sppl/ativo/envios/reenviar', { metodo: 'POST', corpo: { lote } }); acompanharLote(lote, total, conf, aviso, j); }); conf.append(bt);
      }
      estado.selecionados.clear(); carregarTickets(); return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  mensagem(aviso, 'O envio continua em segundo plano; acompanhe pela coluna "Contato" da lista.');
}

/* ═══════════════════════  detalhe de um ticket  ═══════════════════════ */
async function abrirDetalhe(id) {
  const r = await api(`/api/rastreio/sppl/ativo/tickets/${id}`); if (!r.ok) { mensagem(msgEl, erroDe(r, 'Ticket não encontrado.'), true); return; }
  const t = r.dados; const j = criarJanela('ativo-janela-detalhe'); const corpo = j.refazer(`Pedido ${t.numero_pedido}`, `${t.nome || '—'} · ${t.email || 'sem e-mail'} · ${rotPlataforma(t.plataforma)}`);
  const info = el('p', `${t.produto || '—'} · ${t.fulfillment || '—'} · ${t.transportadora || '—'} · rastreio original ${t.rastreio_original || '—'}${t.link_rastreio ? '' : ''}`, 'cartao-sub'); corpo.append(info);
  const acoesTop = el('div', undefined, 'sppl-acoes');
  const bFolha = el('button', 'Abrir folha do pedido', 'btn'); bFolha.type = 'button'; bFolha.addEventListener('click', () => { j.fechar(); document.dispatchEvent(new CustomEvent('rastreio:abrir-pedido', { detail: { transacao_id: t.transacao_id } })); });
  const bMail = el('button', 'Enviar e-mail', 'btn btn-forte'); bMail.type = 'button'; bMail.disabled = t.status_ticket === 'fechado' || !t.email; bMail.addEventListener('click', () => { j.fechar(); abrirEnvio([t.id]); });
  acoesTop.append(bFolha, bMail);
  if (t.resposta_pendente) { const bAt = el('button', 'Marcar resposta como atendida', 'btn'); bAt.type = 'button'; bAt.addEventListener('click', async () => { await api(`/api/rastreio/sppl/ativo/tickets/${t.id}/atender`, { metodo: 'POST', corpo: {} }); j.fechar(); carregarTickets(); }); acoesTop.append(bAt); }
  corpo.append(acoesTop);
  corpo.append(el('h3', 'Propriedades do ticket', 'sppl-secao-titulo'));
  const grade = el('div', undefined, 'sppl-form-grid'); const cs = {};
  for (const k of ['status_logistico', 'motivo_problema', 'status_suporte', 'status_ticket']) { const lista = C[k]; const c = campoSelect(ROT_PROP[k], lista.map((x) => [x, ROT_TICKET[x] ?? x]), t[k]); cs[k] = c.select; grade.append(c.rotulo); }
  const f1 = campoTexto(ROT_PROP.rastreio_reenvio, { valor: t.rastreio_reenvio || '', max: 200 }); const f2 = campoTexto(ROT_PROP.link_reenvio, { valor: t.link_reenvio || '', max: 500 });
  cs.rastreio_reenvio = f1.input; cs.link_reenvio = f2.input; grade.append(f1.rotulo, f2.rotulo); corpo.append(grade);
  corpo.append(el('p', 'O código de rastreio original é preservado mesmo quando há reenvio. Ticket FECHADO sai do monitoramento logístico.', 'cartao-sub'));
  const av = el('p', '', 'cartao-sub'); av.setAttribute('role', 'status');
  const bSalvar = el('button', 'Salvar propriedades', 'btn btn-forte'); bSalvar.type = 'button';
  bSalvar.addEventListener('click', async () => {
    const props = {}; for (const [k, c] of Object.entries(cs)) if ((t[k] ?? '') !== c.value) props[k] = k.endsWith('_reenvio') ? (c.value.trim() || null) : c.value;
    if (!Object.keys(props).length) { mensagem(av, 'Nada foi alterado.'); return; }
    const g = await api(`/api/rastreio/sppl/ativo/tickets/${t.id}`, { metodo: 'PATCH', corpo: { propriedades: props } });
    if (!g.ok) { mensagem(av, erroDe(g, 'Não foi possível salvar.'), true); return; }
    j.fechar(); carregarTickets();
  });
  corpo.append(bSalvar, av);
  const respostas = Array.isArray(t.respostas) ? t.respostas : [];
  corpo.append(el('h3', `Respostas do cliente (${respostas.length})`, 'sppl-secao-titulo'));
  if (!respostas.length) corpo.append(el('p', 'O cliente ainda não respondeu.', 'cartao-sub'));
  for (const x of respostas) { const d = el('div', undefined, 'sppl-destaque'); d.append(el('strong', `${fmtDataHora(x.data_email)} · ${x.assunto || '(sem assunto)'}`)); const pre = el('pre', x.corpo || ''); pre.style.whiteSpace = 'pre-wrap'; d.append(pre); corpo.append(d); }
  corpo.append(el('h3', 'E-mails enviados', 'sppl-secao-titulo'));
  const ul = el('ul'); for (const e of t.envios) ul.append(el('li', `${fmtDataHora(e.enviado_em || e.criado_em)} · ${e.status === 'enviado' ? 'enviado' : e.status} · ${e.assunto}${e.erro ? ` (${e.erro})` : ''}`)); if (!t.envios.length) ul.append(el('li', 'Nenhum e-mail enviado ainda.')); corpo.append(ul);
  corpo.append(el('h3', 'Histórico de ações', 'sppl-secao-titulo'));
  const ul2 = el('ul'); const ROT_ACAO = { selecionado: 'Selecionado para o Suporte Ativo', propriedades: 'Propriedades alteradas', email_enfileirado: 'E-mail na fila', email_enviado: 'E-mail enviado', email_falhou: 'E-mail falhou', atendida: 'Resposta marcada como atendida', fechado: 'Ticket fechado', reaberto: 'Ticket reaberto' };
  for (const a of t.acoes) { const det = a.detalhe && typeof a.detalhe === 'object' && !a.detalhe.lote ? Object.entries(a.detalhe).map(([k, v]) => (v && typeof v === 'object' ? `${ROT_PROP[k] ?? k}: ${v.de ?? '—'} → ${v.para ?? '—'}` : `${k}: ${v}`)).join('; ') : ''; ul2.append(el('li', `${fmtDataHora(a.em)} · ${ROT_ACAO[a.tipo] ?? a.tipo} · ${a.por || ''}${det ? ` · ${det}` : ''}`)); }
  corpo.append(ul2); j.abrir();
}

/* ═══════════════════════  fila de respostas  ═══════════════════════ */
async function carregarRespostas() {
  const alvo = raiz.querySelector('#ativo-respostas-corpo'); alvo.replaceChildren(el('p', 'carregando…', 'cartao-sub'));
  const todas = raiz.querySelector('#ativo-resp-todas')?.checked;
  const r = await api(`/api/rastreio/sppl/ativo/respostas${todas ? '?situacao=todas' : ''}`);
  if (!r.ok) { alvo.replaceChildren(el('p', erroDe(r, 'Não foi possível carregar as respostas.'), 'sppl-aviso')); return; }
  if (!r.dados.itens.length) { alvo.replaceChildren(el('p', todas ? 'Nenhum cliente respondeu ainda.' : 'Nenhuma resposta pendente. 🎉', 'cartao-sub')); return; }
  alvo.replaceChildren(...r.dados.itens.map((t) => {
    const card = el('div', undefined, 'sppl-destaque'); const topo = el('div'); topo.append(el('strong', `${t.nome || '—'} · pedido ${t.numero_pedido}`), el('span', ` · ${fmtDataHora(t.ultima_resposta_em)}`, 'cartao-sub'));
    if (t.resposta_pendente) topo.append(document.createTextNode(' '), el('span', 'Pendente', 'sppl-selo sppl-selo--p0'));
    const assunto = el('p', t.ultima_resposta_assunto || '(sem assunto)', 'cartao-sub'); const pre = el('pre', t.ultima_resposta_texto || ''); pre.style.whiteSpace = 'pre-wrap';
    const acoes = el('div', undefined, 'sppl-acoes');
    const bAbrir = el('button', 'Abrir ticket', 'btn'); bAbrir.type = 'button'; bAbrir.addEventListener('click', () => abrirDetalhe(t.id));
    const bResp = el('button', 'Responder', 'btn btn-forte'); bResp.type = 'button'; bResp.addEventListener('click', () => abrirEnvio([t.id], { respondendo: true }));
    const bAt = el('button', 'Marcar como atendida', 'btn'); bAt.type = 'button'; bAt.addEventListener('click', async () => { await api(`/api/rastreio/sppl/ativo/tickets/${t.id}/atender`, { metodo: 'POST', corpo: {} }); carregarRespostas(); carregarTickets(); });
    acoes.append(bAbrir, bResp, bAt); card.append(topo, assunto, pre, acoes); return card;
  }));
}

/* ═══════════════════════  montagem  ═══════════════════════ */
function sincronizarFiltros() {
  for (const [id, k] of [['ativo-f-ticket', 'status_ticket'], ['ativo-f-logistico', 'status_logistico'], ['ativo-f-motivo', 'motivo_problema'], ['ativo-f-suporte', 'status_suporte'], ['ativo-f-contato', 'contato'], ['ativo-f-resposta', 'resposta']]) { const s = raiz.querySelector(`#${id}`); if (s) s.value = estado[k] ?? ''; }
}
function montar() {
  raiz = document.getElementById('ativo-raiz'); raiz.replaceChildren();
  const cab = el('header', undefined, 'cartao-cabeca'); const quem = el('div');
  quem.append(el('h2', 'Suporte Ativo do SPPL'), el('p', 'Área do contato ativo com clientes de pedidos com problema logístico. Os pedidos chegam aqui só por seleção da equipe (ação "Selecionar para Suporte Ativo" no Monitoramento logístico). Selecione tickets, confira e envie e-mails individuais em massa e atualize as propriedades de uma vez. As respostas dos clientes ficam na fila "Respostas dos clientes", separada da fila normal de suporte.', 'cartao-sub'));
  cab.append(quem); raiz.append(cab);
  const kp = el('div', undefined, 'sppl-kpis'); kp.id = 'ativo-kpis'; raiz.append(kp);
  const abas = el('div', undefined, 'subabas'); abas.setAttribute('role', 'tablist');
  for (const [id, rot, nome] of [['ativo-sub-tickets', 'Tickets', 'tickets'], ['ativo-sub-respostas', 'Respostas dos clientes', 'respostas']]) { const b = el('button', rot, 'subaba-btn'); b.type = 'button'; b.id = id; b.setAttribute('role', 'tab'); b.addEventListener('click', () => { estado.sub = nome; desenharSub(); }); abas.append(b); }
  raiz.append(abas);

  const vt = el('div'); vt.id = 'ativo-vista-tickets';
  const filtros = el('div', undefined, 'sppl-filtros');
  const bs = campoTexto('Buscar', { tipo: 'search', max: 80, placeholder: 'Pedido, cliente, e-mail ou código', cresce: true }); let t0;
  bs.input.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { estado.busca = bs.input.value.trim(); estado.pagina = 1; carregarTickets(); }, 350); });
  const mud = (k) => (v) => { estado[k] = v; estado.pagina = 1; carregarTickets(); };
  const ft = campoSelect('Ticket', [['abertos', 'Abertos e resolvidos'], ['aberto', 'Abertos'], ['resolvido', 'Resolvidos'], ['fechado', 'Fechados'], ['', 'Todos']], 'abertos', mud('status_ticket')); ft.select.id = 'ativo-f-ticket';
  const fl = campoSelect('Status logístico', [['', 'Todos'], ...C.status_logistico.map((x) => [x, x])], '', mud('status_logistico')); fl.select.id = 'ativo-f-logistico';
  const fm = campoSelect('Motivo do problema', [['', 'Todos'], ...C.motivo_problema.map((x) => [x, x])], '', mud('motivo_problema')); fm.select.id = 'ativo-f-motivo';
  const fs = campoSelect('Status do suporte', [['', 'Todos'], ...C.status_suporte.map((x) => [x, x])], '', mud('status_suporte')); fs.select.id = 'ativo-f-suporte';
  const fc = campoSelect('Contato', [['', 'Todos'], ['sem', 'Sem e-mail enviado'], ['com', 'Com e-mail enviado']], '', mud('contato')); fc.select.id = 'ativo-f-contato';
  const fr = campoSelect('Resposta', [['', 'Todas'], ['pendente', 'Cliente respondeu (pendente)']], '', mud('resposta')); fr.select.id = 'ativo-f-resposta';
  filtros.append(bs.rotulo, ft.rotulo, fl.rotulo, fm.rotulo, fs.rotulo, fc.rotulo, fr.rotulo); vt.append(filtros);
  const barra = el('div', undefined, 'sppl-acoes'); barra.id = 'ativo-barra';
  const txt = el('span', 'Nenhum ticket selecionado', 'cartao-sub'); txt.id = 'ativo-sel-texto';
  const mk = (id, rot, cls, fn) => { const b = el('button', rot, cls); b.type = 'button'; b.id = id; b.addEventListener('click', fn); return b; };
  msgEl = el('span', '', 'cartao-sub'); msgEl.setAttribute('role', 'status');
  barra.append(txt, mk('ativo-btn-email', 'Enviar e-mail', 'btn btn-forte', () => abrirEnvio([...estado.selecionados])), mk('ativo-btn-props', 'Atualizar propriedades', 'btn', () => abrirPropriedades([...estado.selecionados])),
    mk('ativo-btn-todos-filtro', 'Selecionar todos do filtro', 'btn', selecionarTodosDoFiltro), mk('ativo-btn-limpar', 'Limpar seleção', 'btn', () => { estado.selecionados.clear(); for (const cb of raiz.querySelectorAll('#ativo-corpo input[type=checkbox]')) cb.checked = false; atualizarBarra(); }), msgEl);
  vt.append(barra);
  const envolve = el('div', undefined, 'tabela-envolve'); const tab = el('table', undefined, 'tabela tabela--empilha tabela--larga'); const thead = document.createElement('thead'); const trh = document.createElement('tr');
  const th0 = document.createElement('th'); const todos = document.createElement('input'); todos.type = 'checkbox'; todos.id = 'ativo-marca-todos'; todos.setAttribute('aria-label', 'Selecionar todos os tickets desta página');
  todos.addEventListener('change', () => { for (const t of estado.itens) { if (todos.checked) estado.selecionados.add(t.id); else estado.selecionados.delete(t.id); } for (const cb of raiz.querySelectorAll('#ativo-corpo input[type=checkbox]')) cb.checked = todos.checked; atualizarBarra(); });
  th0.append(todos); trh.append(th0);
  for (const h of ['Pedido', 'Cliente', 'Produto', 'Código de rastreio', 'Status logístico', 'Motivo do problema', 'Status do suporte', 'Ticket', 'Contato', 'Selecionado em']) { const th = el('th', h); th.scope = 'col'; trh.append(th); }
  thead.append(trh); const tbody = document.createElement('tbody'); tbody.id = 'ativo-corpo'; tbody.append(vazioTr('carregando…')); tab.append(thead, tbody); envolve.append(tab); vt.append(envolve);
  const pag = el('div', undefined, 'paginacao'); pag.id = 'ativo-paginacao'; vt.append(pag); raiz.append(vt);

  const vr = el('div'); vr.id = 'ativo-vista-respostas'; vr.hidden = true;
  vr.append(el('p', 'Respostas dos clientes aos e-mails do Suporte Ativo. Esta fila é separada da fila normal de suporte: a resposta não abre card no Suporte Escalado.', 'cartao-sub'));
  const lab = el('label', undefined, 'campo'); const cbT = document.createElement('input'); cbT.type = 'checkbox'; cbT.id = 'ativo-resp-todas'; cbT.addEventListener('change', carregarRespostas); lab.append(cbT, document.createTextNode(' Mostrar também as já atendidas')); vr.append(lab);
  const corpoR = el('div'); corpoR.id = 'ativo-respostas-corpo'; vr.append(corpoR); raiz.append(vr);
  desenharSub();
}

export async function abrirAtivo() {
  if (!iniciado) {
    const c = await api('/api/rastreio/sppl/ativo/constantes'); if (!c.ok) { document.getElementById('ativo-raiz').textContent = erroDe(c, 'Não foi possível carregar o Suporte Ativo.'); return; }
    C = c.dados; iniciado = true; montar(); await carregarTickets();
  } else { carregarTickets(); }
  clearInterval(temporizador);
  temporizador = setInterval(() => { if (document.hidden || document.getElementById('rst-painel-ativo')?.hidden) return; if (!estado.selecionados.size) carregarTickets(); }, 60_000);
}
export function fecharAtivo() { clearInterval(temporizador); temporizador = null; }
document.addEventListener('sppl:ativo-mudou', () => { if (iniciado) carregarTickets(); });
