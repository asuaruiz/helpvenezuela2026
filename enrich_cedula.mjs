// Enriquece datos con el API oficial de cédulas (cedula.com.ve).
// Límite estricto de 200 consultas. Prioriza cédulas en clusters de conflicto.
// Guarda en cedula_data y actualiza el nombre/edad oficial en los records verificados.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const { url, service } = JSON.parse(readFileSync(".supabase_keys.json", "utf8"));
const sb = createClient(url, service, { auth: { persistSession: false } });
const APP_ID = "9270", TOKEN = "2129a4aeb43b5d5d59a9ea7373ea662a";
const MAX = 200; // límite de la cuenta
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normName = (s) => strip(String(s || "")).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const ageFrom = (d) => { if (!d) return null; const b = new Date(d); const n = new Date("2026-06-26"); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };

async function lookup(cedula) {
  const u = `https://api.cedula.com.ve/api/v1?app_id=${APP_ID}&token=${TOKEN}&cedula=${encodeURIComponent(cedula)}`;
  try {
    const r = await fetch(u);
    const j = await r.json();
    if (!j || j.error || !j.data || !j.data.primer_apellido) return null;
    return j.data;
  } catch { return null; }
}

async function main() {
  // ya verificadas (no re-consultar, ahorra cuota)
  const { data: done } = await sb.from("cedula_data").select("cedula");
  const have = new Set((done || []).map((d) => d.cedula));

  // candidatas: records con cédula; prioriza las de clusters en conflicto
  const { data: recs } = await sb.from("records").select("id_number, cluster_id, source").not("id_number", "is", null).eq("source", "venezuelatebusca");
  const { data: conf } = await sb.from("clusters").select("id").eq("has_conflict", true);
  const confSet = new Set((conf || []).map((c) => c.id));
  const seen = new Set();
  const cleaned = [];
  for (const r of recs || []) {
    const c = (r.id_number || "").replace(/\D/g, "");
    if (c.length < 6 || c.length > 9 || seen.has(c) || have.has(c)) continue;
    seen.add(c);
    cleaned.push({ cedula: c, priority: confSet.has(r.cluster_id) ? 0 : 1 });
  }
  cleaned.sort((a, b) => a.priority - b.priority);
  const batch = cleaned.slice(0, MAX);
  console.log(`Candidatas únicas: ${cleaned.length} | en conflicto: ${cleaned.filter((c) => c.priority === 0).length} | a consultar ahora: ${batch.length} (límite ${MAX})`);

  let ok = 0, fail = 0;
  for (const { cedula } of batch) {
    const d = await lookup(cedula);
    if (!d) { fail++; process.stdout.write(`\r${ok} ok / ${fail} sin datos`); await sleep(150); continue; }
    const nombre = [d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const row = {
      cedula, nacionalidad: d.nacionalidad || null,
      primer_nombre: d.primer_nombre || null, segundo_nombre: d.segundo_nombre || null,
      primer_apellido: d.primer_apellido || null, segundo_apellido: d.segundo_apellido || null,
      nombre_completo: nombre, fecha_nac: d.fecha_nac || null, edad: ageFrom(d.fecha_nac),
      estado: d.cne?.estado || null, municipio: d.cne?.municipio || null, parroquia: d.cne?.parroquia || null,
    };
    await sb.from("cedula_data").upsert(row, { onConflict: "cedula" });
    // actualizar los records con esa cédula: nombre/edad oficial + verified
    await sb.from("records").update({ name: nombre, name_norm: normName(nombre), age: row.edad ?? undefined, verified: true })
      .eq("source", "venezuelatebusca").eq("id_number", cedula);
    ok++; process.stdout.write(`\r${ok} ok / ${fail} sin datos`);
    await sleep(150);
  }
  console.log(`\nListo. Verificadas ${ok}, sin datos ${fail}. Cuota usada ~${ok + fail}/${MAX}.`);
}
main().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
