/* Service worker for GlowSpot's PWA push notifications. Registered by the
   customer and staff apps so booking updates reach the phone's real
   notification tray even when the app isn't open — plain in-tab polling
   can't do that. */
self.addEventListener('push', (event) => {
  let data = { title: 'GlowSpot', body: '' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'GlowSpot', {
      body: data.body || '',
      icon: '/icon-512.png',
      badge: '/icon-512.png',
      dir: 'rtl',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(targetUrl); return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
