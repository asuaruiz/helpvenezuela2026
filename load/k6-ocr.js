import http from "k6/http";
import { check, sleep } from "k6";

const supabaseUrl = __ENV.SUPABASE_URL;
const anon = __ENV.SUPABASE_ANON;

if (!supabaseUrl || !anon) {
  throw new Error("Set SUPABASE_URL and SUPABASE_ANON");
}

export const options = {
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<20000"],
  },
};

const headers = {
  apikey: anon,
  Authorization: `Bearer ${anon}`,
  "Content-Type": "application/json",
};

// Tiny invalid image data URL. This validates auth/rate-limit/request path without
// doing useful OCR; use a real fixture only in a controlled cost test.
const image = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

export default function () {
  const res = http.post(`${supabaseUrl}/functions/v1/ocr-hospital`, JSON.stringify({
    image,
    hospital: "k6 smoke",
    uploaded_by: `k6-${__VU}`,
  }), { headers });
  check(res, {
    "ocr guarded": (r) => [200, 400, 429, 502].includes(r.status),
  });
  sleep(5);
}
