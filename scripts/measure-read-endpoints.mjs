import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const supabaseUrl = process.env.SUPABASE_URL || html.match(/url:"([^"]+)/)?.[1];
const anon = process.env.SUPABASE_ANON_KEY || html.match(/anon:"([^"]+)/)?.[1];

if (!supabaseUrl || !anon) {
  console.error("Faltan SUPABASE_URL/SUPABASE_ANON_KEY o CFG embebido en index.html");
  process.exit(1);
}

const headers = { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" };

async function measure(name, url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  const bytes = Buffer.byteLength(text);
  console.log(`${name}: status=${res.status} bytes=${bytes} ms=${ms}`);
  if (!res.ok) console.log(text.slice(0, 300));
}

await measure("app_stats", `${supabaseUrl}/rest/v1/rpc/app_stats`, {
  method: "POST",
  body: "{}",
});
await measure("next_candidates", `${supabaseUrl}/rest/v1/rpc/next_candidates`, {
  method: "POST",
  body: JSON.stringify({ p_limit: 6, p_offset: 0, p_undecided: true, p_levels: ["alta"] }),
});
await measure("clusters_search", `${supabaseUrl}/rest/v1/clusters?select=id,name,age,location,status,sources,n_sources,has_conflict,resolved,resolved_decision&name=ilike.*jose*&limit=40&order=n_records.desc`);
