// Consolidación DIFUSA (entity resolution) para fusionar la misma persona escrita de
// formas distintas (apellidos de más/menos, typos, edad ±, sin edad).
//
// Regla de fusión entre dos reportes (Union-Find):
//   - comparten >= 2 palabras de nombre (nombre + apellido típicamente), Y
//   - edad compatible (ambas vacías, una vacía, o |a-b| <= 2), Y
//   - ubicación con >=1 palabra en común  O  misma cédula/teléfono.
//   (Atajo: misma cédula/teléfono + >=1 palabra de nombre -> fusiona aunque la ubicación no coincida.)
// La doble condición (nombre fuerte + lugar/identificador) evita unir homónimos distintos.
//
// Uso:  node consolidate.mjs           (informe en seco, no toca la base)
//       node consolidate.mjs --apply   (reconstruye clusters + records.cluster_id en Supabase)
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const norm = (s) => strip(String(s || "")).toLowerCase();
const NAME_STOP = new Set("de la del los las y e da do dos al el".split(" "));
const nameTokens = (s) => [...new Set(norm(s).replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !NAME_STOP.has(t)))];
const LOC_STOP = new Set("la el de del los las en y a edificio edif residencia residencias res sector calle av avenida apto piso planta torre conjunto urb urbanizacion sin con cerca frente al un una vista mar playa zona estado municipio parroquia casa hotel".split(" "));
const locTokens = (s) => [...new Set(norm(s).replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 4 && !LOC_STOP.has(t)))];
const idNums = (s) => (String(s || "").match(/\d{6,11}/g) || []);

// IMPORTANTE: solo la CÉDULA de la persona es identidad fiable. Los teléfonos de
// "contacto"/reporter son de quien reporta (reportan a varios) -> NO sirven como identidad.
const fromVtb = (p) => ({ source: "venezuelatebusca", source_id: String(p.id), name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), age: typeof p.age === "number" ? p.age : null, status: p.status === "found" ? "found" : "missing", loc: p.lastSeen || "", ids: idNums(p.idNumber) });
const fromDtv = (p) => ({ source: "desaparecidosterremoto", source_id: String(p.id), name: (p.nombre || "").trim(), age: typeof p.edad === "number" ? p.edad : null, status: p.estado === "localizado" ? "found" : "missing", loc: p.ubicacion || "", ids: [] });
const fromDv = (p) => ({ source: "desaparecidosvenezuela", source_id: String(p.id), name: (p.nombre || "").trim(), age: typeof p.edad === "number" ? p.edad : null, status: (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing", loc: p.zona || "", ids: [] });
const load = (f, m) => JSON.parse(readFileSync(f, "utf8")).map(m);

const recs = [...load("personas.json", fromVtb), ...load("personas_dtv.json", fromDtv), ...load("personas_dv.json", fromDv)]
  .map((r) => ({ ...r, pk: `${r.source}:${r.source_id}`, nt: nameTokens(r.name), lt: locTokens(r.loc), idset: new Set(r.ids) }))
  .filter((r) => r.nt.length >= 1)
  // Fichas que listan a 2+ personas ("Fulano y Mengano", "X, Y") no deben servir de
  // puente: encadenarían personas distintas. Se marcan y se excluyen del emparejado.
  .map((r) => ({ ...r, multi: /\sy\s|,|&|\/| e /.test(" " + norm(r.name) + " ") && r.nt.length >= 4 }))
  .map((r, i) => ({ ...r, i }));

// Union-Find
const parent = recs.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

const ageOk = (a, b) => a == null || b == null || Math.abs(a - b) <= 2;

// Frecuencia documental: un token es "discriminativo" si aparece en pocos reportes.
const dfName = new Map(), dfLoc = new Map();
for (const r of recs) { for (const t of r.nt) dfName.set(t, (dfName.get(t) || 0) + 1); for (const t of r.lt) dfLoc.set(t, (dfLoc.get(t) || 0) + 1); }
const RARE_NAME = 80;   // token presente en <=80 reportes
const VERY_RARE = 30;   // token muy distintivo (apellido como "ferrini")
const RARE_LOC = 150;   // lugar específico (descarta "guaira","vista","mar"…)

function tryMerge(a, b) {
  const sharedNames = a.nt.filter((t) => b.nt.includes(t));
  const shared = sharedNames.length;
  const idMatch = a.idset.size && [...a.idset].some((x) => b.idset.has(x));
  if (idMatch && shared >= 2) return union(a.i, b.i);
  if (shared < 2 || !ageOk(a.age, b.age)) return;
  // nombres casi idénticos: uno es subconjunto del otro, o Jaccard alto -> evita encadenar
  const uni = new Set([...a.nt, ...b.nt]).size;
  if (!(shared === Math.min(a.nt.length, b.nt.length) || shared / uni >= 0.5)) return;
  // basta UNA de estas señales discriminativas:
  const veryRare = sharedNames.some((t) => (dfName.get(t) || 0) <= VERY_RARE);            // apellido muy raro
  const twoRare = sharedNames.filter((t) => (dfName.get(t) || 0) <= RARE_NAME).length >= 2; // dos tokens raros
  const rareLoc = a.lt.some((t) => b.lt.includes(t) && (dfLoc.get(t) || 0) <= RARE_LOC);    // ubicación específica
  if (veryRare || twoRare || rareLoc) union(a.i, b.i);
}

// Blocking solo por palabras de nombre poco comunes (reduce pares y alinea con la regla).
const byTok = new Map();
for (const r of recs) { if (r.multi) continue; for (const t of r.nt) if ((dfName.get(t) || 0) <= RARE_NAME) (byTok.get(t) || byTok.set(t, []).get(t)).push(r.i); }
let pairs = 0;
for (const [, idxs] of byTok) {
  if (idxs.length < 2) continue;
  for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) { tryMerge(recs[idxs[x]], recs[idxs[y]]); pairs++; }
}

// Construir componentes
const comp = new Map();
for (const r of recs) { const c = find(r.i); (comp.get(c) || comp.set(c, []).get(c)).push(r); }

// Reporte
const sizes = [...comp.values()].map((c) => new Set(c.map((r) => r.pk)).size);
const multiRec = sizes.filter((s) => s > 1).length;
console.log(`reportes: ${recs.length} | pares evaluados: ${pairs.toLocaleString("es")}`);
console.log(`clusters DIFUSOS: ${comp.size}  (antes exacto nombre+edad ≈ 59.619)`);
console.log(`clusters con >1 reporte: ${multiRec}`);
console.log(`cluster más grande: ${Math.max(...sizes)} reportes`);
const dist = {}; for (const s of sizes) { const k = s === 1 ? "1" : s <= 3 ? "2-3" : s <= 6 ? "4-6" : s <= 12 ? "7-12" : "13+"; dist[k] = (dist[k] || 0) + 1; }
console.log("distribución de tamaños:", dist);

// Verificación: caso Sandoval + los 5 clusters más grandes (chequeo de sobre-fusión)
const showComp = (arr) => arr.map((r) => `${r.name}(${r.age ?? "?"})`).slice(0, 8).join(" | ");
const sand = [...comp.values()].find((c) => c.some((r) => /sandoval/i.test(r.name) && /eudimar|valentina/i.test(r.name)));
if (sand) console.log(`\nCaso Sandoval -> 1 cluster de ${sand.length} reportes:\n  ${showComp(sand)}`);
console.log("\n5 clusters más grandes (revisar que sean la misma persona, no homónimos):");
[...comp.values()].sort((a, b) => b.length - a.length).slice(0, 5).forEach((c, n) => console.log(`  #${n + 1} (${c.length}): ${showComp(c)}`));

if (APPLY) { console.log("\n[--apply] exportando para subir…"); globalThis.__comp = comp; globalThis.__recs = recs; await import("./consolidate_apply.mjs"); }
export { comp, recs };
