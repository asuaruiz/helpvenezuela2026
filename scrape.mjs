// Scraper for https://venezuelatebusca.com/
// The site is a React Router v7 (SSR) app. Its loader data is served from the
// "single fetch" endpoint /_root.data, encoded with the turbo-stream format.
// We page through it with ?page=N until hasMore is false.

import { decode } from "turbo-stream";
import { writeFileSync } from "node:fs";

const BASE = "https://venezuelatebusca.com/_root.data";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DELAY_MS = 400; // be polite

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page) {
  const res = await fetch(`${BASE}?page=${page}`, {
    headers: { "User-Agent": UA, "Accept": "text/x-turbo" },
  });
  if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
  // turbo-stream decodes from a ReadableStream<Uint8Array>; that's res.body.
  const decoded = await decode(res.body);
  await decoded.done; // let the stream finish
  // decoded.value is the routes payload: { root, "routes/_index": { data: {...} } }
  return decoded.value;
}

function extract(payload) {
  // Walk to the index route's loader data.
  const data =
    payload?.["routes/_index"]?.data ??
    payload?.root?.data ??
    payload;
  const persons = data?.persons ?? [];
  const pagination = data?.pagination ?? {};
  const stats = data?.stats ?? {};
  return { persons, pagination, stats };
}

async function main() {
  const byId = new Map(); // dedupe: the feed is live (newest-first), pages shift
  let page = 1;
  let stats = null;

  while (true) {
    const payload = await fetchPage(page);
    const { persons, pagination, stats: s } = extract(payload);
    if (s) stats = s;
    if (!persons.length) break;
    for (const p of persons) byId.set(p.id, p);
    process.stdout.write(
      `\rpage ${page}  unique ${byId.size}` +
        (stats?.total ? `/${stats.total}` : "")
    );
    if (!pagination.hasMore) break;
    page++;
    await sleep(DELAY_MS);
  }

  const all = [...byId.values()];
  console.log(`\nDone. ${all.length} unique records. stats:`, stats);
  writeFileSync("personas.json", JSON.stringify(all, null, 2));

  // Also write CSV with the real fields returned by the loader.
  const cols = ["id", "firstName", "lastName", "idNumber", "age", "gender", "lastSeen", "status", "photoUrl", "createdAt"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    cols.join(","),
    ...all.map((p) => cols.map((c) => esc(p[c])).join(",")),
  ].join("\n");
  writeFileSync("personas.csv", csv);
  console.log("Wrote personas.json and personas.csv");
}

main().catch((e) => {
  console.error("\nError:", e.message);
  process.exit(1);
});
