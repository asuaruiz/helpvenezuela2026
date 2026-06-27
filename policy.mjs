// Política de conciliación endurecida.
// Reclasifica cada conflicto (mismo nombre+edad, localizada en una fuente / desaparecida en
// otra) por NIVEL DE CONFIANZA según señales adicionales, y auto-concilia el nivel más alto.
//
//   AUTO  -> misma cédula o teléfono entre las fuentes  -> se concilia solo (same_located)
//   alta  -> >=2 palabras de ubicación en común          -> cola manual prioritaria
//   media -> 1 palabra de ubicación en común             -> cola manual secundaria
//   baja  -> sin señal extra (homónimos probables)        -> fuera de la cola
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const { url, service } = JSON.parse(readFileSync(".supabase_keys.json", "utf8"));
const sb = createClient(url, service, { auth: { persistSession: false } });

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const nn = (s) => strip(String(s || "")).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("la el de del los las en y a edificio edif residencia residencias res sector calle av avenida apto piso planta torre conjunto urb urbanizacion sin con cerca frente al un una vista mar playa zona estado municipio parroquia casa hotel".split(" "));
const locTokens = (s) => [...new Set(nn(s).split(" ").filter((t) => t.length >= 4 && !STOP.has(t)))];
const idNums = (s) => (String(s || "").match(/\d{6,11}/g) || []);

const fromVtb = (p) => ({ src: "venezuelatebusca", name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), age: typeof p.age === "number" ? p.age : null, status: p.status === "found" ? "found" : "missing", loc: p.lastSeen || "", ids: [...idNums(p.idNumber), ...idNums(p.reporter?.phone)] });
const fromDtv = (p) => ({ src: "desaparecidosterremoto", name: (p.nombre || "").trim(), age: typeof p.edad === "number" ? p.edad : null, status: p.estado === "localizado" ? "found" : "missing", loc: p.ubicacion || "", ids: idNums(p.contacto) });
const fromDv = (p) => ({ src: "desaparecidosvenezuela", name: (p.nombre || "").trim(), age: typeof p.edad === "number" ? p.edad : null, status: (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing", loc: p.zona || "", ids: [] });
const load = (f, m) => JSON.parse(readFileSync(f, "utf8")).map(m);

function classify() {
  const recs = [...load("personas.json", fromVtb), ...load("personas_dtv.json", fromDtv), ...load("personas_dv.json", fromDv)]
    .map((r) => { const n = nn(r.name); return { ...r, key: n ? (r.age != null ? `${n}#${r.age}` : `${n}#`) : null }; })
    .filter((r) => r.key);

  const g = new Map();
  for (const r of recs) (g.get(r.key) || g.set(r.key, []).get(r.key)).push(r);

  const conf = new Map(); // cluster_id -> level
  for (const [key, arr] of g) {
    const srcs = new Set(arr.map((r) => r.src));
    if (srcs.size < 2) continue;
    const found = arr.filter((r) => r.status === "found");
    const missing = arr.filter((r) => r.status === "missing");
    if (!found.length || !missing.length) continue;
    const foundSrc = new Set(found.map((r) => r.src));
    const crossMiss = missing.filter((r) => !foundSrc.has(r.src));
    if (!crossMiss.length) continue; // no es conflicto cross-source

    let idMatch = false, sharedTok = 0;
    for (const f of found) for (const m of crossMiss) {
      const fi = new Set(f.ids), mi = new Set(m.ids);
      if ([...fi].some((x) => mi.has(x))) idMatch = true;
      const ft = locTokens(f.loc), mt = locTokens(m.loc);
      sharedTok = Math.max(sharedTok, ft.filter((t) => mt.includes(t)).length);
    }
    const hasAge = arr[0].age != null;
    let level;
    if (idMatch) level = "auto";
    else if (hasAge && sharedTok >= 2) level = "alta";
    else if (hasAge && sharedTok >= 1) level = "media";
    else level = "baja";
    conf.set(key, level);
  }
  return conf;
}

async function main() {
  const conf = classify();
  const tally = {};
  for (const v of conf.values()) tally[v] = (tally[v] || 0) + 1;
  console.log("Niveles:", tally);

  // 1) Actualizar confidence en clusters (en lotes, via upsert parcial)
  const rows = [...conf.entries()].map(([id, confidence]) => ({ id, confidence }));
  const SIZE = 500;
  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    // update por lote
    await Promise.all(chunk.map((r) => sb.from("clusters").update({ confidence: r.confidence }).eq("id", r.id)));
    process.stdout.write(`\rconfidence: ${Math.min(i + SIZE, rows.length)}/${rows.length}`);
  }
  console.log();

  // 2) Auto-conciliar nivel AUTO (insertar decisión si no existe ya)
  const autos = [...conf.entries()].filter(([, v]) => v === "auto").map(([id]) => id);
  const { data: existing } = await sb.from("decisions").select("cluster_id").in("cluster_id", autos.length ? autos : ["__none__"]);
  const done = new Set((existing || []).map((d) => d.cluster_id));
  const toInsert = autos.filter((id) => !done.has(id)).map((id) => ({ cluster_id: id, decision: "same_located", decided_by: "auto", note: "auto: cédula/teléfono coincide entre plataformas" }));
  for (let i = 0; i < toInsert.length; i += 500) {
    await sb.from("decisions").insert(toInsert.slice(i, i + 500));
  }
  console.log(`Auto-conciliados (nivel AUTO): ${toInsert.length} nuevos (de ${autos.length}).`);
  console.log("Cola manual ahora: alta =", tally.alta || 0, "| media =", tally.media || 0, "| descartados (baja) =", tally.baja || 0);
}
main().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
