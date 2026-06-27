// Scraper for https://www.desaparecidosvenezuela.com/
// Next.js app with a same-origin JSON API (no reCAPTCHA):
//   GET /api/personas?skip=N   -> array of 20 records (fixed page size)
//   GET /api/stats             -> { total, encontrados, sanos }
// Fields: id, nombre, edad, zona, fotoUrl, estado, tipo, descripcion, lat, lng, createdAt...

import { writeFileSync } from "node:fs";

const BASE = "https://www.desaparecidosvenezuela.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const STEP = 20;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

async function main() {
  const stats = await get("/api/stats").catch(() => ({}));
  const total = stats.total ?? null;
  const byId = new Map();
  let skip = 0;
  let empties = 0;

  while (true) {
    const items = await get(`/api/personas?skip=${skip}`);
    if (!Array.isArray(items) || items.length === 0) {
      if (++empties >= 2) break; // stop after consecutive empties
    } else {
      empties = 0;
      for (const it of items) if (it?.id != null) byId.set(String(it.id), it);
    }
    process.stdout.write(`\rskip ${skip}  unique ${byId.size}` + (total ? `/${total}` : ""));
    if (total != null && byId.size >= total) break;
    skip += STEP;
    if (skip > (total ?? 5000) + 200) break; // safety bound
    await sleep(DELAY_MS);
  }

  const all = [...byId.values()].map((it) => ({ source: "desaparecidosvenezuela", ...it }));
  console.log(`\nDone. ${all.length} unique records (reported total ${total}).`);
  writeFileSync("personas_dv.json", JSON.stringify(all, null, 2));

  const cols = ["id", "nombre", "edad", "zona", "estado", "tipo", "descripcion", "fotoUrl", "createdAt"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...all.map((p) => cols.map((c) => esc(p[c])).join(","))].join("\n");
  writeFileSync("personas_dv.csv", csv);
  console.log("Wrote personas_dv.json and personas_dv.csv");
}

main().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
