// Service worker: caches the app shell so the app opens offline.
// Model weights are cached separately by WebLLM in Cache Storage ("webllm/*").
const VERSION = 'v1.1.0';
const CACHE = 'story-shell-' + VERSION;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './llm.js', './db.js', './presets.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './vendor/web-llm.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('story-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Same-origin GET: serve from cache immediately, refresh in the background.
// Cross-origin requests (model downloads) are left to WebLLM.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    return res || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
