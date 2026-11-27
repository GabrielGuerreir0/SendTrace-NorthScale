/**
 * MONIT-SPPL — "Preparar e-mail padrão" (spec seção 8): editor aberto a partir dos pedidos selecionados na lista (Classificação ou Tratativas).
 *   1. o modelo vem escolhido pela classe mais frequente da seleção (MODELO_POR_CLASSE); pedidos sem e-mail ficam de fora;
 *   2. a equipe lê e edita em PORTUGUÊS; o cliente recebe o INGLÊS (assinatura "Customer Care Team"); se o português mudar, o inglês fica DESATUALIZADO
 *      (prévia em inglês, cópia, marcação e envio bloqueados) até "Traduzir para inglês" (IA, revisão obrigatória), editar o inglês à mão ou "Voltar ao texto do modelo";
 *   3. a prévia mostra um pedido por vez, em português ou inglês, já com os campos do cliente;
 *   4. "Copiar lista para envio" (tabulação), "Marcar como enviados" (contato feito fora do sistema) ou "Simular envio" → "Confirmar envio" (um e-mail por cliente
 *      pela fila do Suporte Ativo; cria/atualiza o ticket e registra a tratativa). Nada sai sem a conferência e a confirmação.
 * Todo texto da API entra por textContent.
 */
import { api } from './emailComum.js';
import { el, fmtDataHora, campoSelect, campoTexto, criarJanela, mensagem, copiarTexto } from './spplComum.js';
import { listaParaEnvio, inglesDesatualizado } from './monitEmailTexto.js';

const BASE = '/api/rastreio/monit/email';
const MAX_ENVIO = 200;
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const msgDe = (r, padrao) => r.dados?.detail ?? r.dados?.erro ?? padrao;
const CSS = `
.me-area { width: 100%; min-height: 150px; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px 10px; border: 1px solid var(--borda); border-radius: 8px; background: var(--superficie); color: var(--tinta); resize: vertical; }
.me-colunas { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin: 0 0 12px; }
.me-col { border: 1px solid var(--borda); border-radius: 10px; padding: 10px 12px; background: var(--superficie-2, var(--superficie)); }
.me-col h3 { margin: 0 0 6px; font-size: 13px; }
.me-previa { border: 1px solid var(--borda); border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; background: var(--superficie); }
.me-previa pre { margin: 6px 0 0; white-space: pre-wrap; font: inherit; font-size: 13px; overflow-wrap: anywhere; }
.me-nav { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 6px; font-size: 12.5px; }
.me-aviso { border: 1px solid var(--st-atrasado); border-radius: 8px; padding: 8px 10px; margin: 0 0 10px; font-size: 12.5px; background: color-mix(in srgb, var(--st-atrasado) 14%, var(--superficie)); }
.me-conf { border: 1px solid var(--borda); border-radius: 10px; padding: 10px 12px; margin: 12px 0 0; }
.me-conf ul { margin: 4px 0 8px 18px; padding: 0; font-size: 12.5px; }
.me-conf label.me-ok { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; margin: 8px 0; }
`;

function campoArea(rotulo, valor, max, linhas = 8) {
  const l = el('label', undefined, 'campo campo--cresce'); l.append(el('span', rotulo));
  const a = document.createElement('textarea'); a.className = 'me-area'; a.rows = linhas; a.maxLength = max; a.value = valor ?? ''; l.append(a);
  return { rotulo: l, area: a };
}

/** O carregador de módulos do Monitoramento chama `iniciar` uma vez; o editor monta tudo só quando é aberto. */
export function iniciar() { /* nada a montar antes */ }

/** Abre o editor para os pedidos `ids`. `aoFinalizar(resultado)` roda depois de marcar ou enviar (a lista se recarrega). */
export async function abrirEditor(ids, aoFinalizar) {
  if (!document.getElementById('monit-email-css')) { const s = document.createElement('style'); s.id = 'monit-email-css'; s.textContent = CSS; document.head.append(s); }
  const j = criarJanela('mon-email');
  const corpo0 = j.refazer('Preparar e-mail padrão', `${n(ids.length)} pedido(s) selecionado(s).`); corpo0.append(el('p', 'carregando…', 'mon-vazio')); j.abrir();
  const r = await api(`${BASE}/preparar`, { metodo: 'POST', corpo: { pedidos: ids, idioma: 'en' } });
  if (!r.ok) { corpo0.replaceChildren(el('p', msgDe(r, 'Não foi possível preparar o e-mail.'), 'mon-vazio')); return; }
  montar(j, ids, r.dados, aoFinalizar);
}

function montar(j, ids, prep0, aoFinalizar) {
  let prep = prep0;
  const S = { modelo: null, pt: { assunto: '', texto: '' }, ptBase: { assunto: '', texto: '' }, en: { assunto: '', texto: '' }, ia: false, idx: 0, lang: 'en', ocupado: false };
  const juntar = (x) => `${x.assunto}\n${x.texto}`;
  const carregarModelo = (m) => {
    S.modelo = m; S.pt = { assunto: m?.assunto_pt ?? '', texto: m?.corpo_pt ?? '' }; S.ptBase = { ...S.pt }; S.en = { assunto: m?.assunto_en ?? '', texto: m?.corpo_en ?? '' }; S.ia = false;
  };
  carregarModelo(prep.modelo);
  const desatualizado = () => inglesDesatualizado({ ptAtual: juntar(S.pt), ptBase: juntar(S.ptBase), enRevisadoDepois: false });
  const editado = () => juntar(S.pt) !== juntar({ assunto: S.modelo?.assunto_pt ?? '', texto: S.modelo?.corpo_pt ?? '' }) || juntar(S.en) !== juntar({ assunto: S.modelo?.assunto_en ?? '', texto: S.modelo?.corpo_en ?? '' });

  const corpo = j.refazer('Preparar e-mail padrão', `${n(prep.total)} pedido(s) selecionado(s) · ${n(prep.com_email)} com e-mail do cliente · ${n(prep.sem_email.length)} sem e-mail (ficam de fora).`);
  const msg = el('p', '', 'cartao-sub'); msg.setAttribute('role', 'status');

  /* ── modelo ── */
  const topo = el('div', undefined, 'sppl-filtros');
  const sm = campoSelect('Modelo', prep.modelos.map((m) => [m.id, `${m.nome}${m.id === prep.modelo_sugerido ? ' (sugerido pela classe)' : ''}`]), S.modelo?.id ?? '', async (id) => {
    if (editado() && !confirm('Trocar de modelo descarta o texto que você editou. Continuar?')) { sm.select.value = S.modelo?.id ?? ''; return; }
    const x = await api(`${BASE}/preparar`, { metodo: 'POST', corpo: { pedidos: ids, modelo_id: id, so_pedido: prep.lista[0]?.pedido_id } });
    if (!x.ok) { mensagem(msg, msgDe(x, 'Não foi possível trocar o modelo.'), true); sm.select.value = S.modelo?.id ?? ''; return; }
    prep = { ...prep, ...x.dados, lista: prep.lista }; carregarModelo(x.dados.modelo); S.idx = 0; preencher(); atualizar();
  });
  topo.append(sm.rotulo); corpo.append(topo);
  if (prep.modelo?.descricao_pt) corpo.append(el('p', `Este modelo: ${prep.modelo.descricao_pt}`, 'cartao-sub'));
  const aviso = el('div', undefined, 'me-aviso'); aviso.hidden = true; corpo.append(aviso);

  /* ── texto em português (equipe) e em inglês (cliente) ── */
  const cols = el('div', undefined, 'me-colunas');
  const cPt = el('div', undefined, 'me-col'); cPt.append(el('h3', 'Português (o que a equipe lê e edita)'));
  const ptA = campoTexto('Assunto', { max: 200 }); const ptT = campoArea('Texto', '', 8000);
  const bVoltar = el('button', 'Voltar ao texto do modelo', 'btn'); bVoltar.type = 'button';
  cPt.append(ptA.rotulo, ptT.rotulo, bVoltar);
  const cEn = el('div', undefined, 'me-col'); cEn.append(el('h3', 'Inglês americano (o que o cliente recebe)'));
  const enA = campoTexto('Assunto', { max: 200 }); const enT = campoArea('Texto', '', 8000);
  const bTrad = el('button', 'Traduzir para inglês', 'btn'); bTrad.type = 'button';
  cEn.append(enA.rotulo, enT.rotulo, bTrad); const dicaIa = el('p', '', 'cartao-sub'); cEn.append(dicaIa);
  cols.append(cPt, cEn); corpo.append(cols);
  const campos = el('p', 'Campos que cada cliente recebe preenchidos: {nome} {pedido} {rastreio} {link_rastreio} {transportadora} {endereco} {produto} {assinatura}. A assinatura padrão é "Customer Care Team".', 'cartao-sub'); corpo.append(campos);

  function preencher() { ptA.input.value = S.pt.assunto; ptT.area.value = S.pt.texto; enA.input.value = S.en.assunto; enT.area.value = S.en.texto; }
  ptA.input.addEventListener('input', () => { S.pt.assunto = ptA.input.value; atualizar(); });
  ptT.area.addEventListener('input', () => { S.pt.texto = ptT.area.value; atualizar(); });
  // editar o inglês à mão com o português já mudado: a pessoa assume o inglês (o português passa a ser a nova base); a revisão continua obrigatória no envio
  const aoEditarIngles = () => { S.en = { assunto: enA.input.value, texto: enT.area.value }; if (desatualizado()) S.ptBase = { ...S.pt }; atualizar(); };
  enA.input.addEventListener('input', aoEditarIngles); enT.area.addEventListener('input', aoEditarIngles);
  bVoltar.addEventListener('click', () => { carregarModelo(S.modelo); preencher(); mensagem(msg, 'Texto do modelo restaurado.'); atualizar(); });
  bTrad.addEventListener('click', async () => {
    bTrad.disabled = true; mensagem(msg, 'Traduzindo…');
    const x = await api(`${BASE}/traduzir`, { metodo: 'POST', corpo: { assunto: S.pt.assunto, texto: S.pt.texto } });
    if (!x.ok) { mensagem(msg, `${msgDe(x, 'Não foi possível traduzir.')} Você pode escrever o inglês à mão.`, true); atualizar(); return; }
    S.en = { assunto: x.dados.assunto, texto: x.dados.corpo }; S.ptBase = { ...S.pt }; S.ia = true; preencher();
    mensagem(msg, 'Tradução pronta. Ela é um rascunho da IA: leia o inglês antes de enviar.'); atualizar();
  });

  /* ── prévia (um pedido por vez) ── */
  const previa = el('div', undefined, 'me-previa'); const nav = el('div', undefined, 'me-nav');
  const bAnt = el('button', '◀ Anterior', 'btn'); bAnt.type = 'button'; const bProx = el('button', 'Próximo ▶', 'btn'); bProx.type = 'button';
  const rot = el('span'); const segLang = el('div', undefined, 'mon-seg'); segLang.setAttribute('role', 'group'); segLang.setAttribute('aria-label', 'Idioma da prévia');
  for (const [v, t] of [['en', 'Inglês'], ['pt', 'Português']]) { const b = el('button', t); b.type = 'button'; b.dataset.v = v; b.addEventListener('click', () => { S.lang = v; atualizar(); }); segLang.append(b); }
  nav.append(bAnt, rot, bProx, segLang);
  const pAss = el('b'); const pTxt = el('pre'); const pPara = el('div', undefined, 'cartao-sub');
  previa.append(el('h3', 'Prévia (um cliente por vez)'), nav, pPara, pAss, pTxt); corpo.append(previa);
  bAnt.addEventListener('click', () => { S.idx = Math.max(0, S.idx - 1); atualizar(); }); bProx.addEventListener('click', () => { S.idx = Math.min(prep.lista.length - 1, S.idx + 1); atualizar(); });
  let tokenPrevia = 0; let t0;
  function desenharPrevia() {
    const l = prep.lista[S.idx];
    for (const b of segLang.children) b.setAttribute('aria-pressed', String(b.dataset.v === S.lang));
    bAnt.disabled = S.idx <= 0; bProx.disabled = S.idx >= prep.lista.length - 1;
    if (!l) { rot.textContent = 'Nenhum cliente com e-mail.'; pPara.textContent = ''; pAss.textContent = ''; pTxt.textContent = ''; return; }
    rot.textContent = `Pedido ${l.pedido} (${n(S.idx + 1)} de ${n(prep.lista.length)})`;
    if (S.lang === 'en' && desatualizado()) { pPara.textContent = ''; pAss.textContent = 'Tradução desatualizada'; pTxt.textContent = 'O texto em português mudou. Clique em "Traduzir para inglês", edite o inglês à mão ou volte ao texto do modelo para ver a prévia em inglês.'; return; }
    clearTimeout(t0); const meu = ++tokenPrevia;
    t0 = setTimeout(async () => {
      const x = await api(`${BASE}/preparar`, { metodo: 'POST', corpo: { pedidos: ids, so_pedido: l.pedido_id, idioma: S.lang, assunto: (S.lang === 'en' ? S.en : S.pt).assunto, texto: (S.lang === 'en' ? S.en : S.pt).texto } });
      if (meu !== tokenPrevia) return;
      if (!x.ok) { pPara.textContent = ''; pAss.textContent = ''; pTxt.textContent = msgDe(x, 'Não foi possível montar a prévia.'); return; }
      const it = x.dados.itens[0]; pPara.textContent = it ? `Para: ${it.nome ? `${it.nome} · ` : ''}${it.email}` : ''; pAss.textContent = it?.assunto ?? ''; pTxt.textContent = it?.texto ?? '';
    }, 400);
  }

  /* ── ações ── */
  const acoes = el('div', undefined, 'sppl-acoes');
  const bCopiar = el('button', 'Copiar lista para envio', 'btn'); bCopiar.type = 'button';
  const bMarcar = el('button', 'Marcar como enviados', 'btn'); bMarcar.type = 'button';
  const bSim = el('button', 'Simular envio', 'btn btn-forte'); bSim.type = 'button';
  acoes.append(bCopiar, bMarcar, bSim); corpo.append(acoes, msg);
  const conf = el('div'); corpo.append(conf);
  const bloqueio = () => (!prep.com_email ? 'Nenhum dos pedidos selecionados tem e-mail do cliente.' : desatualizado() ? 'O inglês está desatualizado: traduza de novo, edite à mão ou volte ao texto do modelo.' : (!S.en.assunto.trim() || S.en.texto.trim().length < 5) ? 'Preencha o assunto e o texto em inglês.' : '');
  const textosEn = () => ({ assunto: S.en.assunto, texto: S.en.texto });

  bCopiar.addEventListener('click', async () => {
    bCopiar.disabled = true; mensagem(msg, 'Montando a lista…');
    const x = await api(`${BASE}/preparar`, { metodo: 'POST', corpo: { pedidos: ids, modelo_id: S.modelo?.id, idioma: 'en', ...textosEn() } });
    if (!x.ok) { mensagem(msg, msgDe(x, 'Não foi possível montar a lista.'), true); atualizar(); return; }
    const ok = await copiarTexto(listaParaEnvio(x.dados.itens));
    mensagem(msg, ok ? `Lista copiada: ${n(x.dados.itens.length)} e-mail(s), um por cliente. Cole numa planilha ou na ferramenta de envio.` : 'O navegador não deixou copiar. Tente de novo (a janela precisa estar em foco).', !ok); atualizar();
  });

  bMarcar.addEventListener('click', async () => {
    if (!confirm(`Registrar que ${n(prep.com_email)} cliente(s) já receberam o e-mail "${S.modelo?.nome ?? 'padrão'}"?\n\nIsso NÃO envia nada: só guarda no histórico de cada pedido o modelo e o assunto.`)) return;
    bMarcar.disabled = true; mensagem(msg, 'Gravando…');
    const x = await api(`${BASE}/marcar`, { metodo: 'POST', corpo: { pedidos: ids, modelo_id: S.modelo?.id, assunto: S.en.assunto } });
    if (!x.ok) { mensagem(msg, msgDe(x, 'Não foi possível marcar como enviados.'), true); atualizar(); return; }
    S.ocupado = true; mensagem(msg, `${n(x.dados.gravadas)} pedido(s) marcado(s) como enviado(s).`); aoFinalizar?.({ tipo: 'marcados', ...x.dados }); atualizar();
  });

  bSim.addEventListener('click', async () => {
    bSim.disabled = true; conf.replaceChildren(); mensagem(msg, 'Conferindo…');
    const x = await api(`${BASE}/simular`, { metodo: 'POST', corpo: { pedidos: ids, modelo_id: S.modelo?.id, ...textosEn() } });
    if (!x.ok) { mensagem(msg, msgDe(x, 'Não foi possível simular o envio.'), true); atualizar(); return; }
    mensagem(msg, ''); desenharConferencia(x.dados); atualizar();
  });

  function desenharConferencia(d) {
    conf.replaceChildren(); const c = el('div', undefined, 'me-conf'); conf.append(c);
    c.append(el('h3', 'Conferência do envio (nada foi enviado ainda)'));
    c.append(el('p', `${n(d.total)} e-mail(s) individuais serão enfileirados${d.sem_email.length ? ` · ${n(d.sem_email.length)} pedido(s) sem e-mail ficam de fora` : ''}. ${d.aviso}`, 'cartao-sub'));
    if (d.ja_contatados) {
      c.append(el('p', `Atenção: ${n(d.ja_contatados)} cliente(s) já foram contatados nos últimos 90 dias.`, 'me-aviso'));
      const ul = el('ul'); for (const x of d.destinatarios.filter((y) => y.contatos_anteriores.length).slice(0, 8)) { const k = x.contatos_anteriores[0]; ul.append(el('li', `Pedido ${x.pedido}: ${k.tipo === 'envio' ? 'e-mail' : 'ticket'} em ${fmtDataHora(k.quando)}${k.por ? ` por ${k.por}` : ''}${k.assunto ? ` — ${k.assunto}` : ''}`)); }
      c.append(ul);
    }
    if (d.sem_dados.length) c.append(el('p', `Faltam dados em ${n(d.sem_dados.length)} pedido(s) (o campo sai vazio): ${d.sem_dados.slice(0, 6).map((x) => `${x.pedido} (${x.faltando.join(', ')})`).join('; ')}${d.sem_dados.length > 6 ? '…' : ''}.`, 'me-aviso'));
    if (d.exemplo) { const e = el('div', undefined, 'me-previa'); e.append(el('div', `Exemplo — para ${d.exemplo.para}`, 'cartao-sub'), el('b', d.exemplo.assunto), el('pre', d.exemplo.texto)); c.append(e); }
    const lab = el('label', undefined, 'me-ok'); const cb = document.createElement('input'); cb.type = 'checkbox';
    lab.append(cb, el('span', S.ia ? 'Revisei o texto em inglês (veio de tradução por IA) e conferi os destinatários.' : 'Conferi os destinatários e o texto em inglês.'));
    const ok = el('button', `Confirmar envio de ${n(d.total)} e-mail(s)`, 'btn btn-forte'); ok.type = 'button'; ok.disabled = true; const cancela = el('button', 'Cancelar', 'btn'); cancela.type = 'button';
    cb.addEventListener('change', () => { ok.disabled = !cb.checked || !d.total; });
    cancela.addEventListener('click', () => { conf.replaceChildren(); });
    ok.addEventListener('click', async () => {
      ok.disabled = true; cancela.disabled = true; mensagem(msg, 'Enfileirando…');
      const x = await api(`${BASE}/enviar`, { metodo: 'POST', corpo: { pedidos: ids, modelo_id: S.modelo?.id, ...textosEn(), traducao_ia: S.ia, revisado: cb.checked, confirmar: true } });
      if (!x.ok) { mensagem(msg, msgDe(x, 'Não foi possível enviar.'), true); ok.disabled = false; cancela.disabled = false; return; }
      conf.replaceChildren(); S.ocupado = true;
      mensagem(msg, `${n(x.dados.enfileirados)} e-mail(s) enfileirado(s) (lote ${x.dados.lote}). Eles saem aos poucos, um por cliente; acompanhe no Suporte Ativo.${x.dados.aviso ? ` ${x.dados.aviso}` : ''}`);
      aoFinalizar?.({ tipo: 'enviados', ...x.dados }); atualizar();
    });
    const lin = el('div', undefined, 'sppl-acoes'); lin.append(ok, cancela); c.append(lab, lin);
  }

  function atualizar() {
    const b = bloqueio(); const stale = desatualizado();
    aviso.hidden = !b; aviso.textContent = b;
    bTrad.disabled = !stale || !prep.traducao_ia || !S.pt.assunto.trim() || !S.pt.texto.trim();
    bTrad.title = prep.traducao_ia ? 'Traduz o português para inglês americano por IA (rascunho: revise antes de enviar)' : 'A tradução por IA não está configurada neste servidor (ANTHROPIC_API_KEY). Escreva o inglês à mão.';
    dicaIa.textContent = prep.traducao_ia ? (S.ia ? 'Inglês gerado por IA: leia antes de enviar.' : '') : 'Tradução por IA indisponível neste servidor: escreva ou ajuste o inglês à mão (os modelos já vêm com o inglês pronto).';
    bCopiar.disabled = Boolean(b) || S.ocupado; bMarcar.disabled = Boolean(b) || S.ocupado;
    bSim.disabled = Boolean(b) || S.ocupado || prep.com_email > MAX_ENVIO;
    bSim.title = prep.com_email > MAX_ENVIO ? `O envio direto aceita até ${MAX_ENVIO} clientes por vez: selecione menos pedidos (copiar e marcar aceitam mais).` : '';
    desenharPrevia();
  }

  if (prep.sem_email.length) { const d = el('details'); d.append(el('summary', `${n(prep.sem_email.length)} pedido(s) sem e-mail do cliente (fora da lista de envio)`), el('p', prep.sem_email.slice(0, 30).map((x) => x.pedido).join(', ') + (prep.sem_email.length > 30 ? '…' : ''), 'cartao-sub')); corpo.append(d); }
  if (prep.modelo_sugerido && Object.keys(prep.por_modelo ?? {}).length) corpo.append(el('p', `Modelo sugerido pela classe mais frequente: ${prep.modelos.find((m) => m.id === prep.modelo_sugerido)?.nome ?? prep.modelo_sugerido}. Pedidos por modelo: ${Object.entries(prep.por_modelo).map(([k, v]) => `${prep.modelos.find((m) => m.id === k)?.nome ?? k} ${n(v)}`).join(', ')}.`, 'cartao-sub'));
  preencher(); atualizar();
}
