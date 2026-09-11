/**
 * "Meu Perfil" — dados da própria conta + alertas por e-mail (11/09/2026).
 *
 * Abre clicando no chip de usuário do header (virou botão). Não tem relação
 * com a tela "Usuários" (admin, gerencia OUTRAS contas) — aqui é só a
 * própria, sem checagem de `admin` nenhuma: qualquer conta logada usa.
 */
import { $, api } from './emailComum.js';
import { dia } from './format.js';

const ROTULO_ALERTA = {
  foto_defeito: {
    titulo: 'Fotos com defeito visível',
    descricao: 'Quando a IA identifica defeito numa foto enviada por e-mail.',
  },
  email_urgente: {
    titulo: 'E-mails urgentes sem resposta',
    descricao: 'Urgência alta e ainda esperando alguém responder.',
  },
  caso_escalado: {
    titulo: 'Novo caso escalado',
    descricao: 'A IA tirou o cliente de si e o caso entrou pendente no kanban.',
  },
  chargeback: {
    titulo: 'Chargeback consumado',
    descricao: 'Disputa aberta direto com o banco — o mais grave dos dois.',
  },
  reembolso: {
    titulo: 'Reembolso consumado',
    descricao: 'Confirmado pela plataforma de pagamento.',
  },
};

const janela = $('janela-perfil');
let preferenciasCarregadas = [];

function msgPerfil(texto, tom = 'erro') {
  const el = $('perfil-msg');
  el.textContent = texto;
  el.dataset.tom = tom;
  el.hidden = !texto;
}

function renderAlertas(preferencias) {
  preferenciasCarregadas = preferencias;
  $('lista-perfil-alertas').replaceChildren(...preferencias.map(({ tipo, ativo }) => {
    const info = ROTULO_ALERTA[tipo] ?? { titulo: tipo, descricao: '' };
    const li = document.createElement('li');
    li.className = 'perfil-alerta-item';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = ativo;
    input.dataset.tipo = tipo;
    const corpo = document.createElement('span');
    const tit = document.createElement('span');
    tit.className = 'perfil-alerta-tit';
    tit.textContent = info.titulo;
    const desc = document.createElement('span');
    desc.className = 'perfil-alerta-desc';
    desc.textContent = info.descricao;
    corpo.append(tit, desc);
    label.append(input, corpo);
    li.append(label);
    return li;
  }));
}

async function abrirPerfil() {
  msgPerfil('');
  janela.showModal();

  const [perfilResp, alertasResp] = await Promise.all([
    api('/api/perfil'),
    api('/api/alertas/preferencias'),
  ]);

  if (perfilResp.ok) {
    const u = perfilResp.dados;
    $('perfil-nome').textContent = u.nome || '(sem nome cadastrado)';
    $('perfil-email').textContent = u.email;
    $('perfil-permissao').textContent = u.admin ? 'Administrador' : 'Leitura';
    $('perfil-criado').textContent = u.criado_em ? dia(u.criado_em) : '—';
  } else {
    msgPerfil('Não deu para carregar seus dados agora.');
  }

  if (alertasResp.ok) {
    renderAlertas(alertasResp.dados.preferencias ?? []);
    $('perfil-sem-smtp').hidden = alertasResp.dados.emailConfigurado !== false;
  } else {
    msgPerfil('Não deu para carregar suas preferências de alerta.');
  }
}

$('usuario-chip').addEventListener('click', abrirPerfil);
$('fechar-perfil').addEventListener('click', () => janela.close());

$('perfil-salvar').addEventListener('click', async () => {
  const btn = $('perfil-salvar');
  const preferencias = {};
  for (const input of $('lista-perfil-alertas').querySelectorAll('input[type=checkbox]')) {
    preferencias[input.dataset.tipo] = input.checked;
  }

  btn.disabled = true;
  msgPerfil('');
  try {
    const { ok, dados } = await api('/api/alertas/preferencias', { metodo: 'PATCH', corpo: { preferencias } });
    if (!ok) throw new Error(dados?.erro || 'Falha ao salvar.');
    renderAlertas(dados.preferencias ?? preferenciasCarregadas);
    msgPerfil('Alertas atualizados.', 'ok');
  } catch (err) {
    msgPerfil(err.message);
  } finally {
    btn.disabled = false;
  }
});
