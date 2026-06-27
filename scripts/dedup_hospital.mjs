// Fusiona los clusters "hospital_list:*" que son la MISMA persona que un reporte real ya
// existente (match por tokens, acentos/orden normalizados). Para cada duplicado:
//   - mueve el record de la lista de hospital al cluster real,
//   - marca el cluster real como localizado (resolved/same_located),
//   - recalcula fuentes y conteos, y borra el cluster hospital_list vacío.
//
// Uso:
//   node scripts/dedup_hospital.mjs            (DRY RUN: solo muestra qué fusionaría)
//   node scripts/dedup_hospital.mjs --apply    (aplica los cambios en producción)
import fs from "fs";

const APPLY = process.argv.includes("--apply");
const K = JSON.parse(fs.readFileSync(new URL("../.supabase_keys.json", import.meta.url), "utf8"));
const H = { apikey: K.service, Authorization: "Bearer " + K.service, "Content-Type": "application/json" };
const g = (p) => fetch(K.url + "/rest/v1/" + p, { headers: H }).then((r) => r.json());
const rpc = (fn, a) => fetch(K.url + "/rest/v1/rpc/" + fn, { method: "POST", headers: H, body: JSON.stringify(a) }).then((r) => r.json());
const patch = (p, b) => fetch(K.url + "/rest/v1/" + p, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(b) });
const del = (p) => fetch(K.url + "/rest/v1/" + p, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).split(" ").filter((t) => t.length >= 2);
function sameName(a, b) {
  const A = toks(a), B = toks(b);
  if (A.length < 2 || B.length < 2) return false;
  const overlap = A.filter((t) => B.includes(t)).length;
  return overlap >= 2 && (A.every((t) => B.includes(t)) || B.every((t) => A.includes(t)));
}

const hl = await g("clusters?select=id,name&id=like.hospital_list:*&limit=1000");
const merges = [];
for (const c of hl) {
  const cands = await rpc("public_search_clusters", { p_term: c.name, p_filter: "", p_limit: 8, p_offset: 0 });
  const twin = (cands || []).find((t) => !String(t.id).startsWith("hospital_list:") && sameName(c.name, t.name));
  if (twin) merges.push({ hl: c.id, hlName: c.name, twin: twin.id, twinName: twin.name, twinStatus: twin.status });
}
console.log(`hospital_list totales: ${hl.length} · a fusionar con reporte real: ${merges.length}`);
console.log(JSON.stringify(merges, null, 2));

if (APPLY) {
  for (const m of merges) {
    await patch(`records?cluster_id=eq.${encodeURIComponent(m.hl)}`, { cluster_id: m.twin });
    const recs = await g(`records?select=source&cluster_id=eq.${encodeURIComponent(m.twin)}`);
    const sources = [...new Set((recs || []).map((r) => r.source))];
    await patch(`clusters?id=eq.${encodeURIComponent(m.twin)}`, {
      status: "found", any_found: true, resolved: true, resolved_decision: "same_located",
      sources, n_sources: sources.length, n_records: (recs || []).length,
    });
    await del(`clusters?id=eq.${encodeURIComponent(m.hl)}`);
  }
  console.log(`APLICADO: ${merges.length} fusiones`);
} else {
  console.log("\n(DRY RUN) Ejecuta con --apply para aplicar.");
}
