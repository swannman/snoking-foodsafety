// Submit all site URLs to IndexNow (instant-notifies Bing + Yandex). Re-runnable anytime; can be
// added to the ingest workflow. Key file must be live at https://food.snoking.app/<KEY>.txt.
const KEY = "92061ca95ead58ec6e7cf36f5eee3f43";
const HOST = "food.snoking.app";
const KEYLOC = `https://${HOST}/${KEY}.txt`;

const sm = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
console.log(`submitting ${urls.length} URLs to IndexNow…`);
let ok = 0;
for (let i = 0; i < urls.length; i += 10000) {          // IndexNow caps at 10,000 URLs per request
  const batch = urls.slice(i, i + 10000);
  const r = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEYLOC, urlList: batch }) });
  console.log(`  batch ${batch.length} URLs -> HTTP ${r.status} ${await r.text()}`.trim());
  if (r.ok) ok += batch.length;
}
console.log(`done: ${ok}/${urls.length} accepted`);
