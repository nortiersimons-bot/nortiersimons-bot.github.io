/* Service worker du Planificateur de recharge EV : permet l'utilisation hors connexion.
   Seuls les fichiers de l'appli (même origine) sont mis en cache ; les services externes
   (adresses, itinéraires, météo) ne sont jamais interceptés. */
const VERSION = '028b9c3ec5';
const CACHE = 'evplan-' + VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-192.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.svg', './icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('evplan-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // services externes : jamais interceptés
  if (req.mode === 'navigate') {
    // page : réseau d'abord (nouvelle version dès qu'elle existe) ; si le réseau est absent ou trop lent (> 4 s), version en cache
    const fromCache = () => caches.match('./index.html').then((r) => r || caches.match('./'));
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); }
      return res;
    });
    const slow = new Promise((resolve) => setTimeout(() => fromCache().then((r) => resolve(r || net)), 4000));
    e.respondWith(Promise.race([net.catch(() => fromCache().then((r) => r || Promise.reject(new Error('hors connexion')))), slow]));
    return;
  }
  // autres fichiers : cache d'abord
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});

/* notifications envoyées par le relais (rappels de recharge) */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Recharge EV', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag || 'evplan', renotify: true, data: { url: './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
