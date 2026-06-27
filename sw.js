// KILL-SWITCH: el service worker quedó deshabilitado. Esta versión se autodestruye:
// el navegador siempre revalida sw.js al navegar, instala esta versión, y al activarse
// borra todas las cachés, se desregistra y recarga la página con contenido fresco.
// Esto saca a cualquier dispositivo que quedó atascado en una versión vieja.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => c.navigate(c.url));
    } catch (_) {}
  })());
});
