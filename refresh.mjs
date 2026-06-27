// Refresco INCREMENTAL de las fuentes (para cron cada 3 min).
// Las 3 plataformas devuelven primero lo más reciente, así que basta traer las primeras
// páginas, detectar reportes nuevos (por pk), insertarlos en Supabase y recalcular sus
// clusters. El re-scrape completo (build_and_load.mjs) se corre aparte, con menos frecuencia.
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { decode } from "turbo-stream";

function loadKeys() {
  if (existsSync(".supabase_keys.json")) {
    const { url, service } = JSON.parse(readFileSync(".supabase_keys.json", "utf8"));
    return { url, service };
  }
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error("Faltan .supabase_keys.json o SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
  return { url, service };
}

const { url, service } = loadKeys();
const sb = createClient(url, service, { auth: { persistSession: false } });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const log = (...a) => console.log(new Date().toISOString(), ...a);

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const norm = (s) => strip(String(s || "")).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const LOC_STOP = new Set("la el de del los las en y a edificio edif residencia residencias res sector calle vista mar playa zona guaira".split(" "));
const locTokens = (s) => [...new Set(norm(s).split(" ").filter((t) => t.length >= 4 && !LOC_STOP.has(t)))];
const idNums = (s) => (String(s || "").match(/\d{6,11}/g) || []);
const isSupabasePhoto = (u) => String(u || "").includes("/storage/v1/object/public/photos/");

function changed(existing, next) {
  const fields = ["name", "name_norm", "age", "gender", "location", "status", "id_number", "contact", "description", "source_date"];
  if (fields.some((f) => (existing[f] ?? null) !== (next[f] ?? null))) return true;
  if (!isSupabasePhoto(existing.photo) && (existing.photo ?? null) !== (next.photo ?? null)) return true;
  return false;
}

async function must(label, promise) {
  const res = await promise;
  if (res?.error) throw new Error(`${label}: ${res.error.message}`);
  return res;
}

// ---- Fetchers (solo lo más reciente) ----
async function fetchVtb(pages = 3) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const res = await fetch(`https://venezuelatebusca.com/_root.data?page=${p}`, { headers: { "User-Agent": UA } });
    const d = await decode(res.body); await d.done;
    const items = d.value?.["routes/_index"]?.data?.persons || [];
    for (const x of items) out.push(mapVtb(x));
  }
  return out;
}
async function fetchDv(pages = 3) {
  const out = [];
  for (let i = 0; i < pages; i++) {
    const r = await fetch(`https://www.desaparecidosvenezuela.com/api/personas?skip=${i * 20}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    const items = await r.json();
    if (!Array.isArray(items)) break;
    for (const x of items) out.push(mapDv(x));
  }
  return out;
}
async function fetchDtv(pages = 1) {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { log("playwright no disponible, omito dtv"); return []; }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto("https://desaparecidosterremotovenezuela.com/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, { timeout: 30000 });
    await page.evaluate((k) => new Promise((r) => window.grecaptcha.ready(() => r())), "6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0");
    const out = [];
    for (let p = 1; p <= pages; p++) {
      const data = await page.evaluate(async ({ p }) => {
        const t = await window.grecaptcha.execute("6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0", { action: "list_people" });
        const r = await fetch(`https://desaparecidos-terremoto-api.theempire.tech/api/personas?page=${p}&pageSize=100`, { headers: { "x-recaptcha-token": t } });
        return r.ok ? r.json() : { items: [] };
      }, { p });
      for (const x of (data.items || [])) out.push(mapDtv(x));
    }
    return out;
  } finally { await browser.close(); }
}

// ---- Mappers a fila de records ----
const baseRow = (source, sid, name, age, gender, location, status, photo, id_number, contact, description, date) => ({
  pk: `${source}:${sid}`, source, source_id: String(sid), name, name_norm: norm(name), age, gender, location, status,
  photo, id_number, contact, description, source_date: date,
});
const mapVtb = (p) => baseRow("venezuelatebusca", p.id, `${p.firstName || ""} ${p.lastName || ""}`.trim(), typeof p.age === "number" ? p.age : null, p.gender || null, p.lastSeen || null, p.status === "found" ? "found" : "missing", p.photoUrl ? `https://venezuelatebusca.com${p.photoUrl}` : null, p.idNumber || null, p.reporter ? [p.reporter.name, p.reporter.phone, p.reporter.email].filter(Boolean).join(" / ") : null, null, p.createdAt || null);
const mapDtv = (p) => baseRow("desaparecidosterremoto", p.id, (p.nombre || "").trim(), typeof p.edad === "number" ? p.edad : null, null, p.ubicacion || null, p.estado === "localizado" ? "found" : "missing", p.foto || null, null, p.contacto || null, p.descripcion || null, p.fecha || null);
const mapDv = (p) => baseRow("desaparecidosvenezuela", p.id, (p.nombre || "").trim(), typeof p.edad === "number" ? p.edad : null, null, p.zona || null, (p.estado === "SANO_SALVO" || p.estado === "ENCONTRADO") ? "found" : "missing", p.fotoUrl ? `https://www.desaparecidosvenezuela.com${p.fotoUrl}` : null, null, null, p.descripcion || null, p.createdAt || null);

// Recalcula un cluster a partir de sus records actuales en la base.
async function recomputeCluster(cid) {
  const { data: members } = await must(`records cluster ${cid}`, sb.from("records").select("name,age,location,status,source,id_number,contact").eq("cluster_id", cid));
  if (!members || !members.length) {
    await must(`delete empty cluster ${cid}`, sb.from("clusters").delete().eq("id", cid));
    return;
  }
  const pick = (f) => members.map((r) => r[f]).find((v) => v != null && v !== "") ?? null;
  const sources = [...new Set(members.map((r) => r.source))];
  const found = members.filter((r) => r.status === "found");
  const foundSrc = new Set(found.map((r) => r.source));
  const crossMiss = members.filter((r) => r.status === "missing" && !foundSrc.has(r.source));
  const has_conflict = found.length > 0 && crossMiss.length > 0;
  let confidence = null;
  if (has_conflict) {
    let idMatch = false, rareLoc = false;
    for (const f of found) for (const m of crossMiss) {
      const fi = new Set(idNums(f.id_number)), mi = new Set(idNums(m.id_number));
      if (fi.size && [...fi].some((x) => mi.has(x))) idMatch = true;
      const ft = locTokens(f.location), mt = new Set(locTokens(m.location));
      if (ft.some((t) => mt.has(t))) rareLoc = true;
    }
    confidence = idMatch ? "auto" : rareLoc ? "alta" : (pick("age") != null ? "media" : "baja");
  }
  await must(`upsert cluster ${cid}`, sb.from("clusters").upsert({ id: cid, name: pick("name"), age: pick("age"), location: pick("location"),
    status: found.length ? "found" : "missing", sources, n_sources: sources.length, n_records: members.length,
    has_conflict, any_found: found.length > 0, confidence }, { onConflict: "id" }));
}

// Asigna cluster a un record nuevo: match exacto name_norm+age existente, si no, nuevo cluster.
async function assignCluster(row) {
  let q = sb.from("records").select("cluster_id").eq("name_norm", row.name_norm).limit(1);
  q = row.age == null ? q.is("age", null) : q.eq("age", row.age);
  const { data } = await must(`assign cluster ${row.pk}`, q);
  return data && data.length ? data[0].cluster_id : row.pk;
}

async function main() {
  const t0 = Date.now();
  const [vtb, dv, dtv] = await Promise.all([
    fetchVtb(3).catch((e) => (log("vtb err", e.message), [])),
    fetchDv(3).catch((e) => (log("dv err", e.message), [])),
    fetchDtv(1).catch((e) => (log("dtv err", e.message), [])),
  ]);
  const fetched = [...new Map([...vtb, ...dv, ...dtv].map((r) => [r.pk, r])).values()];
  if (!fetched.length) { log("nada fetchado"); return; }

  // Trae los existentes para detectar nuevos y cambios de estado/datos.
  const pks = fetched.map((r) => r.pk);
  const existing = new Map();
  for (let i = 0; i < pks.length; i += 300) {
    const { data } = await must("fetch existing records", sb.from("records")
      .select("pk,name,name_norm,age,gender,location,status,photo,id_number,contact,description,source_date,cluster_id,verified")
      .in("pk", pks.slice(i, i + 300)));
    (data || []).forEach((d) => existing.set(d.pk, d));
  }
  const fresh = fetched.filter((r) => !existing.has(r.pk));
  const changedRows = fetched.filter((r) => existing.has(r.pk) && changed(existing.get(r.pk), r));
  log(`fetchados ${fetched.length} | nuevos ${fresh.length} | cambiados ${changedRows.length}`);
  if (!fresh.length && !changedRows.length) { log(`sin novedades (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return; }

  const touched = new Set();
  for (const row of [...fresh, ...changedRows]) {
    const prev = existing.get(row.pk);
    const shouldReassign = !prev || prev.name_norm !== row.name_norm || (prev.age ?? null) !== (row.age ?? null);
    const cid = shouldReassign ? await assignCluster(row) : prev.cluster_id;
    if (prev?.cluster_id && prev.cluster_id !== cid) touched.add(prev.cluster_id);
    const photoPatch = prev && isSupabasePhoto(prev.photo) && row.photo && row.photo !== prev.photo
      ? { photo: prev.photo, photo_orig: row.photo }
      : { photo: row.photo };
    await must(`upsert record ${row.pk}`, sb.from("records").upsert({
      ...row,
      ...photoPatch,
      match_key: cid,
      cluster_id: cid,
      verified: prev?.verified ?? false,
    }, { onConflict: "pk" }));
    touched.add(cid);
  }
  for (const cid of touched) await recomputeCluster(cid);
  log(`+${fresh.length} nuevos, ~${changedRows.length} cambiados, ${touched.size} clusters actualizados (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
main().catch((e) => { console.error(new Date().toISOString(), "Fatal:", e.message); process.exit(1); });
