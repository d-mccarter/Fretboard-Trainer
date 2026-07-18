const CACHE = 'fretboard-trainer-v3';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/fretboard.js',
  './js/pitch.js',
  './js/simulator.js',
  './js/storage.js',
  './js/app.js',
  './manifest.json',
  './build.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const NETWORK_FIRST = /\.(?:html|css|js|json)$|\/$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (NETWORK_FIRST.test(url.pathname) || event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(new Request(request, { cache: 'no-store' }));
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Offline and not cached');
  }
}
