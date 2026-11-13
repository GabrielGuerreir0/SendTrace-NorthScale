/* Service worker mínimo: só a página "Sem conexão". Nunca guarda dado do painel
   (número velho de pedido/rastreio é pior que painel fora do ar). Mudou este
   arquivo ou a offline.html? Troque CACHE. */
const CACHE = 'shell-v1';
const CASCO = ['/offline.html', '/icones/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCO)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // API, JS e CSS vão direto para a rede
  e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
});
