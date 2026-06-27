// Pipeline completo: construye `records` + `clusters` con CONSOLIDACIÓN DIFUSA conservadora
// y los sube a Supabase, reinicia decisiones y auto-concilia el nivel AUTO.
//
// Clustering (Union-Find):
//   base   : misma cadena de nombre normalizada + misma edad  (nunca fragmenta lo ya unido)
//   difuso : >=2 palabras de nombre compartidas, edad ±2/null, nombres casi idénticos
//            (subconjunto o Jaccard>=.5), una palabra de nombre poco común (df<=80) y una de
//            ubicación poco común compartida (df<=150)  -> fusiona variantes de la misma persona.
//   Se excluyen como "puente" las fichas que listan a 2+ personas ("Fulano y Mengano").
//   Identidad fiable = SOLO cédula (no teléfonos: son de quien reporta).
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const { url, service } = JSON.parse(readFileSync(".supabase_keys.json", "utf8"));
const sb = createClient(url, service, { auth: { persistSession: false } });
const args = new Set(process.argv.slice(2));
const RESET_DECISIONS = args.has("--reset-decisions");
const REPLACE_CLUSTERS = args.has("--replace-clusters");

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const norm = (s) => strip(String(s || "")).toLowerCase();
const NAME_STOP = new Set("de la del los las y e da do dos al el".split(" "));
const nameTokens = (s) => [...new Set(norm(s).replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !NAME_STOP.has(t)))];
const LOC_STOP = new Set("la el de del los las en y a edificio edif residencia residencias res sector calle av avenida apto piso planta torre conjunto urb urbanizacion sin con cerca frente al un una vista mar playa zona estado municipio parroquia casa hotel".split(" "));
const locTokens = (s) => [...new Set(norm(s).replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 4 && !LOC_STOP.has(t)))];
const idNums = (s) => (String(s || "").match(/\d{6,11}/g) || []);
// Detecta fichas con 2+ personas (no deben servir de puente entre personas distintas):
// conector " y "/" e ", o un separador que une DOS nombres ("Morantes. Tadeo", "x & y").
const isMulti = (name, nt) =>
  /\sy\s|\se\s/i.test(" " + name + " ") ||
  /[a-záéíóúñ][.;/&+]\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(name) ||
  (/,/.test(name) && nt.length >= 4) ||
  nt.length >= 6; // una sola persona rara vez tiene 6+ palabras de nombre

// Mapeo completo (todas las columnas de records) + señales de clustering.
function fromVtb(p) {
  const name = `${p.firstName || ""} ${p.lastName || ""}`.trim();
  return base("venezuelatebusca", p.id, name, typeof p.age === "number" ? p.age : null, p.gender || null,
    p.lastSeen || null, p.status === "found" ? "found" : "missing",
    p.photoUrl ? `https://venezuelatebusca.com${p.photoUrl}` : null, p.idNumber || null,
    p.reporter ? [p.reporter.name, p.reporter.phone, p.reporter.email].filter(Boolean).join(" / ") : null,
    null, p.createdAt || null, idNums(p.idNumber));
}
function fromDtv(p) {
  return base("desaparecidosterremoto", p.id, (p.nombre || "").trim(), typeof p.edad === "number" ? p.edad : null, null,
    p.ubicacion || null, p.estado === "localizado" ? "found" : "missing", p.foto || null, null, p.contacto || null,
    p.descripcion || null, p.fecha || null, []);
}
function fromDv(p) {
  return base("desaparecidosvenezuela", p.id, (p.nombre || "").trim(), typeof p.edad === "number" ? p.edad : null, null,
    p.zona || null, (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing",
    p.fotoUrl ? `https://www.desaparecidosvenezuela.com${p.fotoUrl}` : null, null, null, p.descripcion || null,
    p.createdAt || null, []);
}
function base(source, sid, name, age, gender, location, status, photo, id_number, contact, description, date, ids) {
  const nt = nameTokens(name);
  return { source, source_id: String(sid), pk: `${source}:${sid}`, name, name_norm: norm(name).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim(),
    age, gender, location, status, photo, id_number, contact, description, source_date: date,
    nt, lt: locTokens(location), idset: new Set(ids), multi: isMulti(name, nt) };
}
const load = (f, m) => JSON.parse(readFileSync(f, "utf8")).map(m);

function cluster(recs) {
  recs.forEach((r, i) => (r.i = i));
  const parent = recs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  // base: exacto name_norm + age
  const baseKey = new Map();
  for (const r of recs) { const k = `${r.name_norm}#${r.age ?? ""}`; if (baseKey.has(k)) union(baseKey.get(k), r.i); else baseKey.set(k, r.i); }

  // difuso
  const dfName = new Map(), dfLoc = new Map();
  for (const r of recs) { for (const t of r.nt) dfName.set(t, (dfName.get(t) || 0) + 1); for (const t of r.lt) dfLoc.set(t, (dfLoc.get(t) || 0) + 1); }
  const RARE_NAME = 80, VERY_RARE = 50, RARE_LOC = 150;
  const ageOk = (a, b) => a == null || b == null || Math.abs(a - b) <= 2;
  function tryMerge(a, b) {
    const sh = a.nt.filter((t) => b.nt.includes(t));
    const idMatch = a.idset.size && [...a.idset].some((x) => b.idset.has(x));
    if (idMatch && sh.length >= 2) return union(a.i, b.i);
    if (sh.length < 2 || !ageOk(a.age, b.age)) return;
    const uni = new Set([...a.nt, ...b.nt]).size;
    if (!(sh.length === Math.min(a.nt.length, b.nt.length) || sh.length / uni >= 0.5)) return; // nombres casi idénticos
    const veryRare = sh.some((t) => (dfName.get(t) || 0) <= VERY_RARE);
    const twoRare = sh.filter((t) => (dfName.get(t) || 0) <= RARE_NAME).length >= 2;
    const rareLoc = a.lt.some((t) => b.lt.includes(t) && (dfLoc.get(t) || 0) <= RARE_LOC);
    if (veryRare || twoRare || rareLoc) union(a.i, b.i);
  }
  const byTok = new Map();
  for (const r of recs) { if (r.multi) continue; for (const t of r.nt) if ((dfName.get(t) || 0) <= RARE_NAME) (byTok.get(t) || byTok.set(t, []).get(t)).push(r.i); }
  for (const [, idxs] of byTok) { if (idxs.length < 2) continue; for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) tryMerge(recs[idxs[x]], recs[idxs[y]]); }

  const comp = new Map();
  for (const r of recs) { const c = find(r.i); (comp.get(c) || comp.set(c, []).get(c)).push(r); }
  return { comp, dfLoc, RARE_LOC };
}

function buildClusters(comp, dfLoc, RARE_LOC) {
  const clusters = [], cidOf = new Map();
  const pick = (arr, f) => arr.map((r) => r[f]).find((v) => v != null && v !== "") ?? null;
  for (const members of comp.values()) {
    const id = members.map((r) => r.pk).sort()[0]; // canónico estable
    members.forEach((r) => cidOf.set(r.pk, id));
    const name = members.slice().sort((a, b) => b.nt.length - a.nt.length || b.name.length - a.name.length)[0].name;
    const sources = [...new Set(members.map((r) => r.source))];
    const found = members.filter((r) => r.status === "found");
    const missing = members.filter((r) => r.status === "missing");
    const foundSrc = new Set(found.map((r) => r.source));
    const crossMiss = missing.filter((r) => !foundSrc.has(r.source));
    const has_conflict = found.length > 0 && crossMiss.length > 0;
    let confidence = null;
    if (has_conflict) {
      let idMatch = false, rareLoc = false;
      for (const f of found) for (const m of crossMiss) {
        if (f.idset.size && [...f.idset].some((x) => m.idset.has(x))) idMatch = true;
        if (f.lt.some((t) => m.lt.includes(t) && (dfLoc.get(t) || 0) <= RARE_LOC)) rareLoc = true;
      }
      confidence = idMatch ? "auto" : rareLoc ? "alta" : (members[0].age != null ? "media" : "baja");
    }
    clusters.push({ id, name, age: pick(members, "age"), location: pick(members, "location"),
      status: found.length ? "found" : "missing", sources, n_sources: sources.length, n_records: members.length,
      has_conflict, any_found: found.length > 0, confidence });
  }
  return { clusters, cidOf };
}

async function upsert(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 1000), { onConflict: conflict });
    if (error) throw new Error(`${table}@${i}: ${error.message}`);
    process.stdout.write(`\r${table}: ${Math.min(i + 1000, rows.length)}/${rows.length}`);
  }
  console.log();
}

// Lee TODOS los records desde la base (estado actual: incluye nuevos del cron y nombres
// oficiales de cédula), y reconstruye las señales de clustering desde sus campos.
async function fetchAllRecords() {
  const cols = "pk,source,source_id,name,name_norm,age,gender,location,status,photo,id_number,contact,description,source_date,verified";
  const all = []; let from = 0; const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from("records").select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    all.push(...data); from += PAGE;
    process.stdout.write(`\rleyendo records: ${all.length}`);
  }
  console.log();
  return all.map((r) => ({ ...r, nt: nameTokens(r.name), lt: locTokens(r.location),
    idset: new Set(idNums(r.id_number)), multi: isMulti(r.name, nameTokens(r.name)) }));
}

async function main() {
  const recs = await fetchAllRecords();
  const { comp, dfLoc, RARE_LOC } = cluster(recs);
  const { clusters, cidOf } = buildClusters(comp, dfLoc, RARE_LOC);
  const recRows = recs.map((r) => ({ pk: r.pk, source: r.source, source_id: r.source_id, name: r.name, name_norm: r.name_norm,
    age: r.age, gender: r.gender, location: r.location, status: r.status, photo: r.photo, id_number: r.id_number,
    contact: r.contact, description: r.description, source_date: r.source_date, verified: r.verified,
    match_key: cidOf.get(r.pk), cluster_id: cidOf.get(r.pk) }));
  const tally = {}; for (const c of clusters) if (c.confidence) tally[c.confidence] = (tally[c.confidence] || 0) + 1;
  console.log(`records=${recRows.length} clusters=${clusters.length} (antes 59.619)`);
  console.log("conflictos por confianza:", tally);

  if (RESET_DECISIONS) {
    console.log("Limpiando decisiones previas (--reset-decisions)…");
    await sb.from("decisions").delete().neq("id", 0);
  } else {
    console.log("Preservando decisiones humanas. Usa --reset-decisions solo para resets controlados.");
  }
  if (REPLACE_CLUSTERS) {
    console.log("Limpiando clusters previos (--replace-clusters)…");
    await sb.from("clusters").delete().neq("id", "__none__");
  } else {
    console.log("Preservando clusters no tocados. Usa --replace-clusters para reconstrucción total controlada.");
  }

  await upsert("records", recRows, "pk");
  await upsert("clusters", clusters, "id");

  // auto-conciliar nivel AUTO, sin duplicar decisiones existentes.
  const autos = clusters.filter((c) => c.confidence === "auto").map((c) => ({ cluster_id: c.id, decision: "same_located", decided_by: "auto", note: "auto: cédula coincide entre plataformas" }));
  const { data: existingAutos } = autos.length
    ? await sb.from("decisions").select("cluster_id").in("cluster_id", autos.map((a) => a.cluster_id))
    : { data: [] };
  const done = new Set((existingAutos || []).map((d) => d.cluster_id));
  const pendingAutos = autos.filter((a) => !done.has(a.cluster_id));
  for (let i = 0; i < pendingAutos.length; i += 500) await sb.from("decisions").insert(pendingAutos.slice(i, i + 500));
  console.log(`Auto-conciliados nuevos: ${pendingAutos.length} (de ${autos.length}). Cola manual: alta=${tally.alta || 0} media=${tally.media || 0} (baja=${tally.baja || 0} descartados).`);
}
main().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
