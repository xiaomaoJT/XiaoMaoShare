'use strict';

// 壳页面缓存：主机停止后刷新，靠它从缓存里把页面兜回来，再由页面内的
// localStorage 快照 + 断线提示还原上一次的内容（配合前端的 B+C 离线策略）。
const CACHE = 'xm-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  // 清掉旧版本缓存，避免壳页面永远停留在上一个大版本
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // 只缓存 GET
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 跨域不碰

  // API 始终走网络、不缓存：离线时自然失败，页面据此显示「对方已离线」
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：网络优先，失败回退到缓存的壳页面
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = (await caches.match(req)) || (await caches.match('/'));
        if (cached) return cached;
        throw e; // 真没缓存过，才让它报错
      }
    })());
    return;
  }

  // 静态资源：缓存优先
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    const c = await caches.open(CACHE);
    c.put(req, fresh.clone());
    return fresh;
  })());
});
