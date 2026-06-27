// Scraper for https://desaparecidosterremotovenezuela.com/
//
// This site is a Next.js app whose data lives on a separate API:
//   GET https://desaparecidos-terremoto-api.theempire.tech/api/personas?page=N&pageSize=20[&estado=...][&q=...]
//   -> { items: [...], total: N }
// Every request requires a reCAPTCHA v3 token in the header `x-recaptcha-token`
// (site key 6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0, action "list_people").
// Tokens can only be minted in a real browser on the registered domain, so we
// drive a headless Chromium, load the site, and run grecaptcha.execute + fetch
// from inside the page context (which also satisfies CORS to the API origin).

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const SITE = "https://desaparecidosterremotovenezuela.com/";
const API = "https://desaparecidos-terremoto-api.theempire.tech/api/personas";
const SITE_KEY = "6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0";
const ACTION = "list_people";
const PAGE_SIZE = 100; // API caps at 100 per page
const DELAY_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the browser: mint a fresh token and fetch one page of results.
async function fetchPageInBrowser({ api, siteKey, action, page, pageSize }) {
  const token = await window.grecaptcha.execute(siteKey, { action });
  const url = `${api}?page=${page}&pageSize=${pageSize}`;
  const res = await fetch(url, { headers: { "x-recaptcha-token": token } });
  if (!res.ok) {
    return { error: res.status, body: await res.text().catch(() => "") };
  }
  return await res.json();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  await page.goto(SITE, { waitUntil: "networkidle" });

  // Wait until reCAPTCHA v3 is ready.
  await page.waitForFunction(
    () => window.grecaptcha && typeof window.grecaptcha.execute === "function",
    { timeout: 30000 }
  );
  await page.evaluate(
    (key) => new Promise((res) => window.grecaptcha.ready(() => res())),
    SITE_KEY
  );

  const byId = new Map();
  let pageNum = 1;
  let total = null;

  while (true) {
    let data;
    try {
      data = await page.evaluate(fetchPageInBrowser, {
        api: API,
        siteKey: SITE_KEY,
        action: ACTION,
        page: pageNum,
        pageSize: PAGE_SIZE,
      });
    } catch (e) {
      console.log(`\npage ${pageNum}: evaluate error, retrying once: ${e.message}`);
      await sleep(1500);
      data = await page.evaluate(fetchPageInBrowser, {
        api: API, siteKey: SITE_KEY, action: ACTION, page: pageNum, pageSize: PAGE_SIZE,
      });
    }

    if (data?.error) {
      console.log(`\npage ${pageNum}: HTTP ${data.error} ${String(data.body).slice(0, 120)}`);
      // brief backoff then retry same page once
      await sleep(2000);
      data = await page.evaluate(fetchPageInBrowser, {
        api: API, siteKey: SITE_KEY, action: ACTION, page: pageNum, pageSize: PAGE_SIZE,
      });
      if (data?.error) break;
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (typeof data?.total === "number") total = data.total;
    if (!items.length) break;

    for (const it of items) {
      if (it && it.id != null) byId.set(String(it.id), it);
    }
    process.stdout.write(
      `\rpage ${pageNum}  unique ${byId.size}` + (total != null ? `/${total}` : "")
    );

    // Stop once we've covered the reported total.
    if (total != null && pageNum * PAGE_SIZE >= total) break;
    pageNum++;
    await sleep(DELAY_MS);
  }

  await browser.close();

  const all = [...byId.values()].map((it) => ({ source: "desaparecidosterremotovenezuela", ...it }));
  console.log(`\nDone. ${all.length} unique records (reported total ${total}).`);
  writeFileSync("personas_dtv.json", JSON.stringify(all, null, 2));

  const cols = ["id", "nombre", "edad", "ubicacion", "fecha", "estado", "contacto", "foto", "descripcion"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...all.map((p) => cols.map((c) => esc(p[c])).join(","))].join("\n");
  writeFileSync("personas_dtv.csv", csv);
  console.log("Wrote personas_dtv.json and personas_dtv.csv");
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
