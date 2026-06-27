// Loads the three scraped sources into Supabase as `records` + `clusters`.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const { url, service } = JSON.parse(readFileSync(".supabase_keys.json", "utf8"));
const sb = createClient(url, service, { auth: { persistSession: false } });

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normName = (s) =>
  strip(String(s || "")).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

function fromVtb(p) {
  const name = `${p.firstName || ""} ${p.lastName || ""}`.trim();
  return {
    source: "venezuelatebusca", source_id: String(p.id), name,
    age: typeof p.age === "number" ? p.age : null, gender: p.gender || null,
    location: p.lastSeen || null, status: p.status === "found" ? "found" : "missing",
    photo: p.photoUrl ? `https://venezuelatebusca.com${p.photoUrl}` : null,
    id_number: p.idNumber || null,
    contact: p.reporter ? [p.reporter.name, p.reporter.phone, p.reporter.email].filter(Boolean).join(" / ") : null,
    description: null, source_date: p.createdAt || null,
  };
}
function fromDtv(p) {
  return {
    source: "desaparecidosterremoto", source_id: String(p.id), name: (p.nombre || "").trim(),
    age: typeof p.edad === "number" ? p.edad : null, gender: null,
    location: p.ubicacion || null, status: p.estado === "localizado" ? "found" : "missing",
    photo: p.foto || null, id_number: null, contact: p.contacto || null,
    description: p.descripcion || null, source_date: p.fecha || null,
  };
}
function fromDv(p) {
  return {
    source: "desaparecidosvenezuela", source_id: String(p.id), name: (p.nombre || "").trim(),
    age: typeof p.edad === "number" ? p.edad : null, gender: null,
    location: p.zona || null,
    status: (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing",
    photo: p.fotoUrl ? `https://www.desaparecidosvenezuela.com${p.fotoUrl}` : null,
    id_number: null, contact: null, description: p.descripcion || null,
    source_date: p.createdAt || null,
  };
}

const load = (f, m) => JSON.parse(readFileSync(f, "utf8")).map(m);

function build() {
  const recs = [
    ...load("personas.json", fromVtb),
    ...load("personas_dtv.json", fromDtv),
    ...load("personas_dv.json", fromDv),
  ].map((r) => {
    const nn = normName(r.name);
    const match_key = nn ? (r.age != null ? `${nn}#${r.age}` : `${nn}#`) : `__noname__:${r.source}:${r.source_id}`;
    return { ...r, pk: `${r.source}:${r.source_id}`, name_norm: nn, match_key, cluster_id: match_key };
  });

  const groups = new Map();
  for (const r of recs) {
    if (!groups.has(r.match_key)) groups.set(r.match_key, []);
    groups.get(r.match_key).push(r);
  }
  const pick = (arr, f) => arr.map((r) => r[f]).find((v) => v != null && v !== "") ?? null;
  const clusters = [...groups.entries()].map(([id, arr]) => {
    const sources = [...new Set(arr.map((r) => r.source))];
    const anyFound = arr.some((r) => r.status === "found");
    const anyMissing = arr.some((r) => r.status === "missing");
    // conflict = found in one source and still missing in a DIFFERENT source
    const foundSrc = new Set(arr.filter((r) => r.status === "found").map((r) => r.source));
    const missDiff = arr.some((r) => r.status === "missing" && !foundSrc.has(r.source));
    return {
      id, name: pick(arr, "name"), age: pick(arr, "age"), location: pick(arr, "location"),
      status: anyFound ? "found" : "missing", sources, n_sources: sources.length,
      n_records: arr.length, has_conflict: anyFound && anyMissing && missDiff && sources.length > 1,
      any_found: anyFound,
    };
  });
  return { recs, clusters };
}

async function upsert(table, rows, conflict) {
  const SIZE = 1000;
  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: conflict });
    if (error) throw new Error(`${table} @${i}: ${error.message}`);
    process.stdout.write(`\r${table}: ${Math.min(i + SIZE, rows.length)}/${rows.length}`);
  }
  console.log();
}

async function main() {
  const { recs, clusters } = build();
  console.log(`records=${recs.length} clusters=${clusters.length} (conflictos=${clusters.filter((c) => c.has_conflict).length}, multi=${clusters.filter((c) => c.n_sources > 1).length})`);
  await upsert("clusters", clusters, "id");
  await upsert("records", recs, "pk");
  console.log("Carga completa.");
}
main().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
