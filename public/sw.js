/* RoveFrame push-only service worker (hand-written; Serwist stays disabled
   for Turbopack compatibility). Handles push display + click focus. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'RoveFrame', body: '' };
  const raw = event.data ? event.data.text() : '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      payload = {
        title: typeof parsed.title === 'string' ? parsed.title : 'RoveFrame',
        body: typeof parsed.body === 'string' ? parsed.body : '',
      };
    }
  } catch {
    payload = { title: 'RoveFrame', body: raw.slice(0, 200) };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/approvals');
    }),
  );
});
