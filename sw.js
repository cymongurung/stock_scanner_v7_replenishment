// Offline support for The Deal Stock Scanner
const CACHE = "deal-scanner-v7";
const LIB_HOSTS = ["unpkg.com", "cdn.jsdelivr.net"];   // barcode scanner library
const SHELL = ["./", "index.html", "style.css?v=7", "app.js?v=7", "manifest.webmanifest", "icon-192.png"];
const LIB = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    try { const r = await fetch(new Request(LIB, {mode:"no-cors"})); await c.put(LIB, r); } catch(err) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Scanner library: use the saved copy first (works offline), save it the first time
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  // The app's own files: try the internet first so updates show up, fall back to the saved copy offline
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req)) || (await c.match(req, {ignoreSearch:true})) || (await c.match("index.html"));
      }
    })());
  }
});
