/* Push only: no fetch handler and no offline caching. */
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    const titles = ['CommuteGuard Test','CommuteGuard — Bx28 Verified','CommuteGuard — Bx28 Unverified','CommuteGuard — Bx28 Warning'];
    if (!payload || !titles.includes(payload.title) || typeof payload.body !== 'string' || payload.body.length > 180 || typeof payload.tag !== 'string' || payload.tag.length > 250) return;
    await self.registration.showNotification(payload.title, { body:payload.body, tag:payload.tag, data:{url:'/'} });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for (const client of windows) if (new URL(client.url).origin === self.location.origin) { await client.focus(); return; }
    await self.clients.openWindow('/');
  })());
});
