const C = "snoking-v2";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil((async function () { var ks = await caches.keys(); await Promise.all(ks.filter(function (k) { return k !== C; }).map(function (k) { return caches.delete(k); })); await self.clients.claim(); })()); });
// versioned (?v=) URLs, pinned CDN assets, and map tiles never change for a given URL, so serve
// them cache-FIRST: a returning visitor's repeat requests are answered by the SW and never reach
// the Worker. (Everything else stays network-first so HTML/data stays fresh.)
function immutable(u) { return /[?&]v=/.test(u.search) || /unpkg\.com|basemaps\.cartocdn\.com|tile\.openstreetmap/.test(u.host); }
self.addEventListener("fetch", function (e) {
  var r = e.request; if (r.method !== "GET") return; var u = new URL(r.url);
  if (immutable(u)) {
    e.respondWith(caches.match(r).then(function (m) { return m || fetch(r).then(function (res) { if (res && res.status === 200) { var c = res.clone(); caches.open(C).then(function (ca) { ca.put(r, c); }); } return res; }); }));
    return;
  }
  e.respondWith((async function () {
    try { var res = await fetch(r); if (res && res.status === 200 && u.origin === location.origin) { var c = res.clone(); caches.open(C).then(function (ca) { ca.put(r, c); }); } return res; }
    catch (err) { var m = await caches.match(r); if (m) return m; throw err; }
  })());
});
