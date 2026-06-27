import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.BASE_URL || "http://localhost:8787";
const supabaseUrl = __ENV.SUPABASE_URL;
const anon = __ENV.SUPABASE_ANON;

if (!supabaseUrl || !anon) {
  throw new Error("Set SUPABASE_URL and SUPABASE_ANON");
}

export const options = {
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

const headers = {
  apikey: anon,
  Authorization: `Bearer ${anon}`,
  "Content-Type": "application/json",
};

export default function () {
  const roll = Math.random();
  if (roll < 0.25) {
    check(http.get(baseUrl), { "shell ok": (r) => r.status === 200 });
  } else if (roll < 0.50) {
    check(http.post(`${supabaseUrl}/rest/v1/rpc/app_stats`, "{}", { headers }), { "stats ok": (r) => r.status === 200 });
  } else if (roll < 0.75) {
    const body = JSON.stringify({ p_limit: 6, p_offset: 0, p_undecided: true, p_levels: ["alta"] });
    check(http.post(`${supabaseUrl}/rest/v1/rpc/next_candidates`, body, { headers }), { "queue ok": (r) => r.status === 200 || r.status === 401 || r.status === 403 });
  } else if (roll < 0.93) {
    check(http.get(`${supabaseUrl}/rest/v1/clusters?select=id,name,age,location,status,sources,n_sources,has_conflict,resolved,resolved_decision&name=ilike.*jose*&limit=40&order=n_records.desc`, { headers }), { "search ok": (r) => r.status === 200 || r.status === 401 || r.status === 403 });
  } else {
    check(http.get(`${supabaseUrl}/rest/v1/clusters?select=id,name,age,location,status,sources,n_sources,has_conflict,resolved,resolved_decision&limit=50&order=name.asc`, { headers }), { "all ok": (r) => r.status === 200 || r.status === 401 || r.status === 403 });
  }
  sleep(1);
}
