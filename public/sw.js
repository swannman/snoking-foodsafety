// v3: CARTO began watermarking unauthenticated tiles, so the stats basemap moved to Esri. The
// bump matters — tiles are cached FIRST and never revalidated, so every visitor who loaded /stats
// after CARTO flipped the switch had "API KEY REQUIRED" tiles pinned locally forever. Changing the
// cache name is what evicts them; activate() deletes every cache that isn't this one.
const C = "snoking-v3";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil((async function () { var ks = await caches.keys(); await Promise.all(ks.filter(function (k) { return k !== C; }).map(function (k) { return caches.delete(k); })); await self.clients.claim(); })()); });
// versioned (?v=) URLs, pinned CDN assets, and map tiles never change for a given URL, so serve
// them cache-FIRST: a returning visitor's repeat requests are answered by the SW and never reach
// the Worker. (Everything else stays network-first so HTML/data stays fresh.)
function immutable(u) { return /[?&]v=/.test(u.search) || /unpkg\.com|services\.arcgisonline\.com|tile\.openstreetmap/.test(u.host); }
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
// ── push notifications ──
self.addEventListener("push", function (e) {
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  var title = d.title || "SnoKing Food Safety";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-180.png",
    tag: "snoking-rating", renotify: true, data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.url.indexOf(location.origin) === 0 && "focus" in c) {
        c.postMessage({ type: "notif-open", url: url });   // already-open app: open the card without a reload
        return c.focus();
      }
    }
    return self.clients.openWindow(url);   // no open window -> fresh load reads ?focus= and opens the card
  }));
});
