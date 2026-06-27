// Espeja las fotos externas a Supabase Storage (bucket 'photos') para no depender de los
// sitios originales (muchos fallan / bloquean hotlink). Solo procesa casos abiertos en
// revision: clusters con conflicto, no resueltos, y confianza alta/media.
import { existsSync, readFileSync } from "node:fs";

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
const H = { apikey: service, Authorization: "Bearer " + service };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ext = (ct) => ct?.includes("png") ? "png" : ct?.includes("webp") ? "webp" : ct?.includes("gif") ? "gif" : "jpg";
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const LEVELS = (process.argv.find((a) => a.startsWith("--levels="))?.split("=")[1] || "alta,media")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function fetchJson(endpoint) {
  const res = await fetch(endpoint, { headers: H });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function fetchOpenReviewClusterIds() {
  const all = [];
  let from = 0;
  for (;;) {
    const qs = new URLSearchParams({
      select: "id",
      has_conflict: "eq.true",
      resolved: "eq.false",
      order: "id",
      limit: "1000",
      offset: String(from),
    });
    if (LEVELS.length) qs.set("confidence", `in.(${LEVELS.join(",")})`);
    const data = await fetchJson(`${url}/rest/v1/clusters?${qs}`);
    if (!data.length) break;
    all.push(...data.map((r) => r.id));
    from += 1000;
  }
  return all;
}

async function fetchAllConflictPhotos() {
  const ids = await fetchOpenReviewClusterIds();
  const all = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(encodeURIComponent).join(",");
    const qs = [
      "select=pk,photo,cluster_id",
      "photo=not.is.null",
      "photo=not.ilike.*supabase*",
      "order=pk",
      `cluster_id=in.(${chunk})`,
    ].join("&");
    all.push(...await fetchJson(`${url}/rest/v1/records?${qs}`));
    process.stdout.write(`\rclusters abiertos: ${Math.min(i + 100, ids.length)}/${ids.length} · fotos externas: ${all.length}`);
  }
  console.log();
  return all;
}

async function mirrorOne(rec) {
  try {
    const res = await fetch(rec.photo, { headers: { "User-Agent": UA, Referer: new URL(rec.photo).origin } });
    if (!res.ok) return "skip";
    const ct = res.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image")) return "skip";
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 200) return "skip";
    const path = `${rec.pk.replace(/[^a-zA-Z0-9]/g, "_")}.${ext(ct)}`;
    const up = await fetch(`${url}/storage/v1/object/photos/${path}`, {
      method: "POST", headers: { ...H, "Content-Type": ct, "x-upsert": "true" }, body: buf,
    });
    if (!up.ok) return "skip";
    const publicUrl = `${url}/storage/v1/object/public/photos/${path}`;
    await fetch(`${url}/rest/v1/records?pk=eq.${encodeURIComponent(rec.pk)}`, {
      method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ photo_orig: rec.photo, photo: publicUrl }),
    });
    return "ok";
  } catch { return "err"; }
}

async function main() {
  const recs = await fetchAllConflictPhotos();
  console.log(`fotos externas a espejar en revision (${LEVELS.join(",") || "todas"}): ${recs.length}`);
  if (DRY) return;
  let ok = 0, skip = 0, err = 0, i = 0;
  const CONC = 6;
  async function worker() {
    while (i < recs.length) {
      const r = recs[i++];
      const res = await mirrorOne(r);
      if (res === "ok") ok++; else if (res === "err") err++; else skip++;
      if ((ok + skip + err) % 100 === 0) process.stdout.write(`\r${ok + skip + err}/${recs.length} (ok ${ok}, sin foto ${skip}, err ${err})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\nListo. Espejadas ${ok}, omitidas ${skip}, errores ${err}.`);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
