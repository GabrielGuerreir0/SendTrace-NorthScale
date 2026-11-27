/**
 * Suporte Humano — botão "Novo ticket" (migração 143): a equipe abre um ticket para mandar um e-mail pontual a um cliente (por e-mail ou nº do pedido),
 * com mensagem própria ou modelo pronto, para um cliente ou vários de uma vez (um ticket e um e-mail por cliente; ninguém vê os dados de outro).
 * Sempre confere antes de enviar. O ticket nasce "iniciado pela equipe", sem prazo de resposta; se o cliente responder, a resposta entra no mesmo ticket.
 * Todo texto vindo da API entra por textContent (nada de innerHTML com dado externo).
 */
import { api } from './emailComum.js';
import { el, campoSelect, campoTexto, criarJanela, mensagem, fmtDataHora } from './spplComum.js';

const ROT_SITUACAO = {
  novo: 'Vai abrir o ticket', ticket_existente: 'Já tem ticket (não abre outro)', isolado_no_ativo: 'Em contato pelo Suporte Ativo (a resposta não chegaria aqui)',
  nao_encontrado: 'Pedido não encontrado', invalido: 'Entrada inválida', sem_email: 'Pedido sem e-mail', repetido: 'Repetido (ignorado)',
};
const ROT_CONTATO = { envio: 'E-mail do Suporte Ativo', ticket: 'Ticket do Suporte Ativo', email_equipe: 'E-mail da equipe', resposta_agente: 'Resposta de um agente' };
const erroDe = (r, padrao) => r.dados?.erro || r.dados?.detalhe || r.dados?.message || padrao;

function listaContatos(contatos) {
  const ul = el('ul'); ul.style.margin = '2px 0 4px 18px';
  for (const c of contatos) {
    const partes = [ROT_CONTATO[c.tipo] ?? c.tipo, c.por ? `por ${c.por}` : null, c.quando ? fmtDataHora(c.quando) : null, c.modelo_nome ? `modelo "${c.modelo_nome}"` : null, c.assunto ? `"${c.assunto}"` : null].filter(Boolean);
    ul.append(el('li', partes.join(' · '), 'cartao-sub'));
  }
  return ul;
}

/** Botão que abre a janela. `boardAtual()` devolve o board aberto na tela (id ou 'todos'); `aoCriar()` recarrega a fila. */
export function botaoNovoTicket({ boardAtual, aoCriar }) {
  const b = el('button', '✉ Novo ticket', 'btn btn-forte');
  b.type = 'button'; b.id = 'sh-btn-novo-ticket';
  b.title = 'Abrir um ticket para enviar um e-mail ao cliente (um ou vários)';
  b.addEventListener('click', () => abrirNovoTicket({ boardAtual, aoCriar }));
  return b;
}

async function abrirNovoTicket({ boardAtual, aoCriar }) {
  const j = criarJanela('sh-janela-novo-ticket');
  const corpo = j.refazer('Novo ticket', 'Envie um e-mail ao cliente e deixe tudo registrado no ticket');
  const rm = await api('/api/suporte-escalado/novo-ticket/modelos');
  if (!rm.ok) { corpo.append(el('p', erroDe(rm, 'Não consegui carregar os modelos.'), 'sppl-aviso')); j.abrir(); return; }
  const { modelos, marcadores, boards, meu_board_id: meuBoard, max_clientes: maxClientes } = rm.dados;
  if (!boards.length) { corpo.append(el('p', 'Você não tem um board para receber tickets. Peça a um gestor.', 'sppl-aviso')); j.abrir(); return; }

  corpo.append(el('p', 'O ticket nasce marcado como "Iniciado pela equipe" e sem prazo de resposta: o prazo só passa a contar se o cliente responder, e a resposta entra neste mesmo ticket. Cada cliente recebe o PRÓPRIO e-mail. Nada é enviado antes de você conferir e confirmar.', 'cartao-sub'));

  // 1) cliente(s): um ou vários
  let vario = false;
  const abas = el('div', undefined, 'esc-fila-abas'); abas.setAttribute('role', 'tablist');
  const bUm = el('button', 'Um cliente', 'subaba-btn'); const bVarios = el('button', 'Vários clientes', 'subaba-btn');
  for (const x of [bUm, bVarios]) { x.type = 'button'; x.setAttribute('role', 'tab'); }
  abas.append(bUm, bVarios); corpo.append(abas);
  const lt = el('label', undefined, 'campo campo--cresce'); const ltTitulo = el('span'); lt.append(ltTitulo);
  const ta = document.createElement('textarea'); ta.maxLength = 40000; lt.append(ta); corpo.append(lt);
  const modo = (v) => {
    vario = v; bUm.setAttribute('aria-selected', String(!v)); bVarios.setAttribute('aria-selected', String(v));
    ta.rows = v ? 7 : 2;
    ltTitulo.textContent = v ? `E-mails e/ou números de pedido (um por linha; até ${maxClientes})` : 'E-mail do cliente ou número do pedido';
    ta.placeholder = v ? 'cliente@exemplo.com\n1234567\noutro@exemplo.com, 7654321' : 'cliente@exemplo.com  ou  1234567';
  };
  bUm.addEventListener('click', () => modo(false)); bVarios.addEventListener('click', () => modo(true)); modo(false);

  // 2) board (agente dono do ticket)
  const padrao = Number.isInteger(Number(boardAtual())) && boards.some((x) => x.id === Number(boardAtual())) ? Number(boardAtual()) : (meuBoard ?? boards[0].id);
  const sb = campoSelect('Agente responsável pelo ticket', boards.map((x) => [String(x.id), x.nome]), String(padrao));
  if (boards.length > 1) corpo.append(sb.rotulo);

  // 3) mensagem: modelo + idioma + assunto + texto
  const sm = campoSelect('Modelo de e-mail', [['', '(escrever na hora)'], ...modelos.map((m) => [m.id, m.nome])], '');
  const si = campoSelect('Idioma do e-mail', [['en', 'Inglês (padrão)'], ['pt', 'Português']], 'en');
  const linhaModelo = el('div', undefined, 'sppl-acoes'); linhaModelo.append(sm.rotulo, si.rotulo); corpo.append(linhaModelo);
  const refPt = document.createElement('details'); refPt.hidden = true;
  const refResumo = el('summary'); const refTexto = el('pre'); refTexto.style.whiteSpace = 'pre-wrap'; refPt.append(refResumo, refTexto); corpo.append(refPt);
  const as = campoTexto('Assunto', { max: 200, placeholder: 'Ex.: An update on your order {pedido}', cresce: true }); corpo.append(as.rotulo);
  const lm = el('label', undefined, 'campo campo--cresce'); lm.append(el('span', 'Mensagem'));
  const tm = document.createElement('textarea'); tm.rows = 10; tm.maxLength = 8000; tm.placeholder = 'Hi {nome},\n\n...'; lm.append(tm); corpo.append(lm);
  let editado = false;   // a pessoa mexeu no texto: trocar o idioma não apaga
  as.input.addEventListener('input', () => { editado = true; }); tm.addEventListener('input', () => { editado = true; });
  const aplicarModelo = () => {
    const m = modelos.find((x) => x.id === sm.select.value) ?? null; refPt.hidden = !m;
    if (!m) return;
    const pt = si.select.value === 'pt';
    as.input.value = (pt ? m.assunto_pt : m.assunto_en) || m.assunto_en; tm.value = (pt ? m.corpo_pt : m.corpo_en) || m.corpo_en; editado = false;
    refResumo.textContent = `O que diz (em português, só para você): ${m.descricao_pt || m.nome}`; refTexto.textContent = `${m.assunto_pt || ''}\n\n${m.corpo_pt || ''}`;
  };
  sm.select.addEventListener('change', aplicarModelo);
  si.select.addEventListener('change', () => { if (sm.select.value && !editado) aplicarModelo(); });
  const chips = el('div', undefined, 'sppl-acoes'); chips.append(el('span', 'Inserir:', 'cartao-sub'));
  for (const m of marcadores) {
    const bt = el('button', `{${m}}`, 'btn'); bt.type = 'button';
    bt.addEventListener('click', () => { const i = tm.selectionStart ?? tm.value.length; tm.setRangeText(`{${m}}`, i, tm.selectionEnd ?? i, 'end'); tm.focus(); editado = true; });
    chips.append(bt);
  }
  corpo.append(chips);
  const mot = campoTexto('Motivo do contato (opcional, só para o registro)', { max: 300, placeholder: 'Ex.: confirmar endereço, pacote retido, atraso', cresce: true }); corpo.append(mot.rotulo);

  const aviso = el('p', '', 'cartao-sub'); aviso.setAttribute('role', 'status');
  const conf = el('div'); corpo.append(conf, aviso);
  const acoes = el('div', undefined, 'sppl-acoes'); const bConf = el('button', 'Conferir antes de enviar', 'btn btn-forte'); bConf.type = 'button'; acoes.append(bConf); corpo.append(acoes);

  const pedido = (extra) => ({
    entradas: ta.value, assunto: as.input.value.trim(), mensagem: tm.value.trim(), idioma: si.select.value, motivo_contato: mot.input.value.trim(), board_id: Number(sb.select.value),
    ...(sm.select.value ? { modelo_id: sm.select.value } : {}), ...extra,
  });

  bConf.addEventListener('click', async () => {
    const qtd = ta.value.split(/[\s,;]+/).filter(Boolean).length;
    if (!qtd) { mensagem(aviso, 'Informe o e-mail ou o número do pedido.', true); return; }
    if (!vario && qtd > 1) { mensagem(aviso, 'Para mais de um cliente use a aba "Vários clientes".', true); return; }
    bConf.disabled = true; mensagem(aviso, 'Conferindo…');
    const r = await api('/api/suporte-escalado/novo-ticket', { metodo: 'POST', corpo: pedido({ simular: true }) });
    bConf.disabled = false;
    if (!r.ok) { conf.replaceChildren(); mensagem(aviso, erroDe(r, 'Não foi possível conferir.'), true); return; }
    mensagem(aviso, ''); desenharConferencia(r.dados);
  });

  function desenharConferencia(d) {
    const { resumo, itens } = d;
    conf.replaceChildren(el('h3', 'Conferência', 'sppl-secao-titulo'));
    const partes = [`${resumo.novos} ticket(s) para abrir`];
    if (resumo.ticket_existente) partes.push(`${resumo.ticket_existente} já com ticket`);
    if (resumo.isolado_no_ativo) partes.push(`${resumo.isolado_no_ativo} em contato pelo Suporte Ativo`);
    if (resumo.nao_encontrados) partes.push(`${resumo.nao_encontrados} não encontrado(s)`);
    if (resumo.invalidos) partes.push(`${resumo.invalidos} inválido(s)`);
    if (resumo.sem_email) partes.push(`${resumo.sem_email} sem e-mail`);
    if (resumo.repetidos) partes.push(`${resumo.repetidos} repetido(s)`);
    conf.append(el('p', `${resumo.entradas} entrada(s): ${partes.join(', ')}. Nada foi enviado ainda.`), el('p', d.aviso, 'cartao-sub'));
    if (resumo.sem_pedido) conf.append(el('p', `${resumo.sem_pedido} cliente(s) sem pedido encontrado: o ticket abre só com o e-mail e os dados do pedido ficam vazios no texto.`, 'sppl-aviso'));
    if (resumo.com_contato_anterior) conf.append(el('p', `Atenção: ${resumo.com_contato_anterior} cliente(s) já foram contatados nos últimos 90 dias (detalhes abaixo). Não bloqueia: você decide.`, 'sppl-aviso'));
    if (d.sem_dados?.length) conf.append(el('p', `Atenção: ${d.sem_dados.length} cliente(s) sem dado para algum campo usado no texto (a mensagem sairia com lacuna): ${d.sem_dados.slice(0, 6).map((x) => `${x.email} (${x.faltando.join(', ')})`).join('; ')}${d.sem_dados.length > 6 ? '…' : ''}`, 'sppl-aviso'));
    if (d.exemplo) {
      const ex = el('div'); ex.append(el('p', `Pré-visualização (primeiro cliente): para ${d.exemplo.para}`, 'cartao-sub'), el('strong', `Assunto: ${d.exemplo.assunto}`));
      const pre = el('pre', d.exemplo.texto); pre.style.whiteSpace = 'pre-wrap'; ex.append(pre); conf.append(ex);
    }
    const ul = el('ul');
    for (const i of itens) {
      const li = el('li'); const quem = i.email ? `${i.nome || '—'} <${i.email}>${i.numero_pedido ? ` · pedido ${i.numero_pedido}` : ''}${i.produto ? ` · ${i.produto}` : ''}` : i.entrada;
      li.append(el('strong', `${ROT_SITUACAO[i.situacao] ?? i.situacao}${i.ticket_id ? ` (#${i.ticket_id}${i.ticket_agente ? `, ${i.ticket_agente}` : ''})` : ''}: `), document.createTextNode(quem));
      if (i.pedidos_encontrados > 1) li.append(el('small', ` · ${i.pedidos_encontrados} pedidos deste cliente; usando o mais recente`, 'cartao-sub'));
      if (i.contatos_anteriores?.length) li.append(listaContatos(i.contatos_anteriores));
      ul.append(li);
    }
    const det = document.createElement('details'); det.open = itens.length <= 12; det.append(el('summary', `Clientes (${itens.length})`), ul); conf.append(det);
    const enviar = el('button', `Confirmar e enviar ${resumo.novos} e-mail(s)`, 'btn btn-forte'); enviar.type = 'button'; enviar.disabled = !resumo.novos; conf.append(enviar);
    enviar.addEventListener('click', async () => {
      enviar.disabled = true; bConf.disabled = true;
      const g = await api('/api/suporte-escalado/novo-ticket', { metodo: 'POST', corpo: pedido({ confirmar: true }) });
      if (!g.ok) { mensagem(aviso, erroDe(g, 'Não foi possível enviar.'), true); enviar.disabled = false; bConf.disabled = false; return; }
      acompanhar(g.dados.lote, g.dados.enfileirados);
    });
  }

  async function acompanhar(lote, total) {
    conf.replaceChildren(el('h3', 'Enviando…', 'sppl-secao-titulo')); const prog = el('p', `0 de ${total} enviado(s)`); conf.append(prog);
    mensagem(aviso, 'Pode fechar esta janela: o envio continua sozinho.');
    for (let t = 0; t < 400 && j.dlg.open; t += 1) {
      const r = await api(`/api/suporte-escalado/novo-ticket/lote?lote=${encodeURIComponent(lote)}`);
      if (!r.ok) { mensagem(aviso, erroDe(r, 'Não consegui ver o andamento.'), true); return; }
      const s = r.dados.por_status; const feitos = (s.enviado ?? 0) + (s.falhou ?? 0); prog.textContent = `${s.enviado ?? 0} de ${total} enviado(s)${s.falhou ? ` · ${s.falhou} com falha` : ''}`;
      if (feitos >= total) {
        conf.replaceChildren(el('h3', s.falhou ? 'Concluído, com falhas' : 'Concluído', 'sppl-secao-titulo'), el('p', `${s.enviado ?? 0} ticket(s) aberto(s) e e-mail(s) enviado(s)${s.falhou ? `; ${s.falhou} não saíram.` : '.'}`));
        if (r.dados.falhas.length) {
          const ul = el('ul'); for (const f of r.dados.falhas) ul.append(el('li', `${f.para_email}: ${f.erro || 'falhou'}`, 'cartao-sub')); conf.append(ul);
          const bt = el('button', 'Tentar de novo', 'btn'); bt.type = 'button';
          bt.addEventListener('click', async () => { bt.disabled = true; await api('/api/suporte-escalado/novo-ticket/lote/reenviar', { metodo: 'POST', corpo: { lote } }); acompanhar(lote, total); });
          conf.append(bt);
        }
        mensagem(aviso, ''); aoCriar?.(); return;
      }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    aoCriar?.();
  }
  j.abrir();
}
