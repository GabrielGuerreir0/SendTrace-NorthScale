/* Instalação como app (PWA): registra o service worker e liga o botão "Instalar app".
   Chrome/Edge/Android: beforeinstallprompt. iPhone: modal com o passo a passo (Safari). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

const botao = document.getElementById('instalar-app');
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
let evento = null;

function mostrar() { if (botao && !standalone()) botao.hidden = false; }

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); evento = e; mostrar(); });
window.addEventListener('appinstalled', () => { evento = null; if (botao) botao.hidden = true; });
if (ios) mostrar();

botao?.addEventListener('click', async () => {
  if (evento) {
    evento.prompt();
    await evento.userChoice.catch(() => {});
    evento = null;
    botao.hidden = true;
  } else {
    document.getElementById('janela-instalar-ios')?.showModal();
  }
});
