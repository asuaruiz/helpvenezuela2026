// Unifies the two scraped datasets into one deduplicated registry.
//
//   personas.json      -> venezuelatebusca   (firstName/lastName, age, lastSeen, status, ...)
//   personas_dtv.json  -> desaparecidosterremoto (nombre, edad, ubicacion, estado, ...)
//
// Match key = normalized full name + age (when present). Records that share the
// key — within or across sources — collapse into one person carrying both
// sources. Output: unified.json, unified.csv, and a printed summary.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const stripAccents = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const normName = (s) =>
  stripAccents(String(s || ""))
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Bring each source onto a common schema.
function fromVtb(p) {
  const name = `${p.firstName || ""} ${p.lastName || ""}`.trim();
  return {
    source: "venezuelatebusca",
    sourceId: p.id,
    name,
    age: typeof p.age === "number" ? p.age : null,
    gender: p.gender || null,
    location: p.lastSeen || null,
    status: p.status === "found" ? "found" : "missing",
    photo: p.photoUrl ? `https://venezuelatebusca.com${p.photoUrl}` : null,
    idNumber: p.idNumber || null,
    contact: p.reporter
      ? [p.reporter.name, p.reporter.phone, p.reporter.email].filter(Boolean).join(" / ")
      : null,
    date: p.createdAt || null,
    description: null,
  };
}

function fromDtv(p) {
  return {
    source: "desaparecidosterremoto",
    sourceId: p.id,
    name: (p.nombre || "").trim(),
    age: typeof p.edad === "number" ? p.edad : null,
    gender: null,
    location: p.ubicacion || null,
    status: p.estado === "localizado" ? "found" : "missing",
    photo: p.foto || null,
    idNumber: null,
    contact: p.contacto || null,
    date: p.fecha || null,
    description: p.descripcion || null,
  };
}

function fromDv(p) {
  return {
    source: "desaparecidosvenezuela",
    sourceId: p.id,
    name: (p.nombre || "").trim(),
    age: typeof p.edad === "number" ? p.edad : null,
    gender: null,
    location: p.zona || null,
    // BUSCADO / INFO_RECIBIDA -> missing ; SANO_SALVO / ENCONTRADO -> found
    status: (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing",
    photo: p.fotoUrl ? `https://www.desaparecidosvenezuela.com${p.fotoUrl}` : null,
    idNumber: null,
    contact: null,
    date: p.createdAt || null,
    description: p.descripcion || null,
  };
}

function load(file, mapper) {
  if (!existsSync(file)) {
    console.warn(`WARN: ${file} not found — skipping`);
    return [];
  }
  return JSON.parse(readFileSync(file, "utf8")).map(mapper);
}

function keyOf(r) {
  const n = normName(r.name);
  if (!n) return null; // unkeyable (no name) -> keep standalone
  return r.age != null ? `${n}#${r.age}` : `${n}#`;
}

function main() {
  const a = load("personas.json", fromVtb);
  const b = load("personas_dtv.json", fromDtv);
  const c = load("personas_dv.json", fromDv);
  const records = [...a, ...b, ...c];

  const groups = new Map();
  const standalone = [];
  for (const r of records) {
    const k = keyOf(r);
    if (!k) {
      standalone.push(r);
      continue;
    }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const merge = (recs) => {
    const sources = [...new Set(recs.map((r) => r.source))];
    const pick = (f) => recs.map((r) => r[f]).find((v) => v != null && v !== "") ?? null;
    return {
      name: pick("name"),
      age: pick("age"),
      gender: pick("gender"),
      // any source reporting "found" wins
      status: recs.some((r) => r.status === "found") ? "found" : "missing",
      location: pick("location"),
      idNumber: pick("idNumber"),
      photo: pick("photo"),
      contact: pick("contact"),
      description: pick("description"),
      date: pick("date"),
      sources, // which platforms hold this person
      inBoth: sources.length > 1,
      refs: recs.map((r) => ({ source: r.source, id: r.sourceId })),
    };
  };

  const unified = [
    ...[...groups.values()].map(merge),
    ...standalone.map((r) => merge([r])),
  ];

  // Summary
  const multi = unified.filter((u) => u.sources.length > 1).length;
  const only = (s) => unified.filter((u) => u.sources.length === 1 && u.sources[0] === s).length;
  const found = unified.filter((u) => u.status === "found").length;

  console.log("=== Unificación (3 fuentes) ===");
  console.log(`venezuelatebusca:          ${a.length}`);
  console.log(`desaparecidosterremoto:    ${b.length}`);
  console.log(`desaparecidosvenezuela:    ${c.length}`);
  console.log(`total registros crudos:    ${records.length}`);
  console.log(`personas únicas:           ${unified.length}`);
  console.log(`  en >1 plataforma:        ${multi}`);
  console.log(`  solo venezuelatebusca:   ${only("venezuelatebusca")}`);
  console.log(`  solo desaparec.terremoto:${only("desaparecidosterremoto")}`);
  console.log(`  solo desaparec.venezuela:${only("desaparecidosvenezuela")}`);
  console.log(`  marcadas localizadas:    ${found}`);

  writeFileSync("unified.json", JSON.stringify(unified, null, 2));

  const cols = ["name", "age", "gender", "status", "location", "idNumber", "contact", "photo", "date", "sources", "inBoth"];
  const esc = (v) => `"${String(Array.isArray(v) ? v.join("|") : v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    cols.join(","),
    ...unified.map((u) => cols.map((c) => esc(u[c])).join(",")),
  ].join("\n");
  writeFileSync("unified.csv", csv);
  console.log("\nWrote unified.json and unified.csv");
}

main();
