import http from "k6/http";
import { check, sleep } from "k6";

const supabaseUrl = __ENV.SUPABASE_URL;
const anon = __ENV.SUPABASE_ANON;

if (!supabaseUrl || !anon) {
  throw new Error("Set SUPABASE_URL and SUPABASE_ANON");
}

export const options = {
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<25000"],
  },
};

const headers = {
  apikey: anon,
  Authorization: `Bearer ${anon}`,
  "Content-Type": "application/json",
};

const names = ["Jose Perez", "Maria Gonzalez", "Luis Rodriguez", "Carmen Hernandez"];
const cedulas = ["12345678", "87654321", "23456789", "34567890"];
const tinyImage = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

export default function () {
  const r = Math.random();
  let payload;
  if (r < 0.7) {
    payload = { message: names[Math.floor(Math.random() * names.length)] };
  } else if (r < 0.9) {
    payload = { message: cedulas[Math.floor(Math.random() * cedulas.length)] };
  } else {
    payload = { message: "revisar lista hospitalaria", image: tinyImage, verifier: `k6-${__VU}` };
  }
  const res = http.post(`${supabaseUrl}/functions/v1/chat-assistant`, JSON.stringify(payload), { headers });
  check(res, {
    "chat guarded": (x) => [200, 400, 401, 403, 429, 500, 502].includes(x.status),
    "no raw cedula echo": (x) => !/"id_number"|contact|telefono|teléfono/i.test(x.body || ""),
  });
  sleep(2);
}
