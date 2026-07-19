// Minimal service worker: makes the app installable. Network passthrough —
// this is a real-time game, so we never want stale cached responses.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
