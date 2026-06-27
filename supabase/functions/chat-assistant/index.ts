import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);

const MODEL = Deno.env.get("OPENAI_CHAT_MODEL") || "gpt-5.5";
const MAX_MESSAGE = 1000;
const MAX_IMAGE = 8_000_000;
const SESSION_TURNS_PER_HOUR = 20;
const CEDULA_PER_SESSION_HOUR = 5;
const CEDULA_PER_CLIENT_DAY = 20;
const OCR_PER_VERIFIER_DAY = 5;

type ChatAction = { type: "open_record"; cluster_id: string; label: string };
type PublicCluster = {
  id: string;
  name: string | null;
  age: number | null;
  location: string | null;
  status: string | null;
  sources?: string[] | null;
  n_sources?: number | null;
  n_records?: number | null;
  has_conflict?: boolean | null;
};

function cleanText(value: unknown, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value: unknown) {
  return cleanText(value, 1200)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[numero]");
}

function extractCedula(message: string) {
  const digits = message.replace(/\D/g, "");
  if (/^\d{6,9}$/.test(digits)) return digits;
  const explicit = message.match(/\b(?:ci|c\.i\.|cedula|cédula)\D{0,8}(\d[\d.\-\s]{4,14}\d)\b/i);
  const clean = explicit?.[1]?.replace(/\D/g, "") || "";
  return /^\d{6,9}$/.test(clean) ? clean : "";
}

function likelySensitiveRequest(message: string) {
  return /\b(telefono|teléfono|contacto|cedula|cédula|correo|email|direccion exacta|dirección exacta|notas internas)\b/i.test(message) &&
    /\b(dame|mostrar|muestra|ver|revelar|pasa|numero|número)\b/i.test(message);
}

function statusWord(status: string | null | undefined) {
  return status === "found" || status === "found_alive" ? "localizada" : "por localizar";
}

function clusterSummary(c: PublicCluster) {
  const age = c.age == null ? "edad no reportada" : `${c.age} años`;
  const loc = c.location ? `, ${c.location}` : "";
  return `${c.name || "Nombre no disponible"} (${age}${loc}) - ${statusWord(c.status)}.`;
}

async function sha256(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",")[0].trim();
}

async function countEvents(sb: any, filters: { session_id?: string; client_hash?: string | null; verifier_hash?: string | null; tool_name?: string; since: string }) {
  let q = sb.from("chat_events").select("id", { count: "exact", head: true }).gte("created_at", filters.since);
  if (filters.session_id) q = q.eq("session_id", filters.session_id);
  if (filters.tool_name) q = q.eq("tool_name", filters.tool_name);
  if (filters.client_hash || filters.verifier_hash) {
    const sessionQuery = sb.from("chat_sessions").select("id").gte("last_seen_at", filters.since);
    const { data, error } = filters.client_hash
      ? await sessionQuery.eq("client_hash", filters.client_hash)
      : await sessionQuery.eq("verifier_hash", filters.verifier_hash);
    if (error) throw error;
    const ids = (data || []).map((r: { id: string }) => r.id);
    if (!ids.length) return 0;
    q = q.in("session_id", ids);
  }
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function safeCountEvents(sb: any, filters: { session_id?: string; client_hash?: string | null; verifier_hash?: string | null; tool_name?: string; since: string }) {
  try {
    return await countEvents(sb, filters);
  } catch {
    return 0;
  }
}

async function ensureSession(sb: any, session_id: string | null, client_hash: string, verifier_hash: string | null) {
  try {
    if (session_id) {
      const { data } = await sb.from("chat_sessions").select("id").eq("id", session_id).maybeSingle();
      if (data?.id) {
        await sb.from("chat_sessions").update({ last_seen_at: new Date().toISOString(), verifier_hash }).eq("id", data.id);
        return data.id;
      }
    }
    const { data, error } = await sb.from("chat_sessions")
      .insert({ client_hash, verifier_hash })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  } catch {
    return session_id || crypto.randomUUID();
  }
}

async function logEvent(sb: any, row: Record<string, unknown>) {
  try {
    await sb.from("chat_events").insert(row);
  } catch {
    // Audit tables are part of the hardening migration. The assistant should still
    // answer while the migration is being rolled out.
  }
}

async function searchByName(sb: any, term: string) {
  const rpc = await sb.rpc("public_search_clusters", {
    p_term: term,
    p_filter: "",
    p_limit: 5,
    p_offset: 0,
  });
  if (!rpc.error) return rpc.data || [];
  const words = term.split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  let q = sb.from("clusters").select("id,name,age,location,status,sources,n_sources,n_records,has_conflict,resolved,resolved_decision").limit(5).order("n_records", { ascending: false });
  for (const w of words) q = q.ilike("name", `%${w}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function searchByCedula(sb: any, cedula: string) {
  const rpc = await sb.rpc("public_search_by_cedula", { p_cedula: cedula });
  if (!rpc.error) return rpc.data || [];
  const { data: hits, error: hitError } = await sb.from("records").select("cluster_id").eq("id_number", cedula).limit(5);
  if (hitError) throw hitError;
  const ids = [...new Set((hits || []).map((h: { cluster_id: string }) => h.cluster_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await sb.from("clusters").select("id,name,age,location,status,sources,n_sources,n_records,has_conflict,resolved,resolved_decision").in("id", ids).limit(5);
  if (error) throw error;
  return data || [];
}

async function runOcr(sb: any, image: string, verifier: string, uploaded_by: string | null) {
  if (!image.startsWith("data:image/")) throw new Error("La imagen debe venir como data URL");
  if (image.length > MAX_IMAGE) throw new Error("Imagen demasiado grande");

  const OPENAI = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI) throw new Error("OPENAI_API_KEY no configurada");

  const prompt = "Lee esta foto de una lista de personas atendidas en un hospital o centro de acopio tras un terremoto en Venezuela. Extrae TODOS los nombres de personas. Devuelve SOLO JSON: {\"personas\":[{\"nombre\":\"...\",\"edad\":num_o_null,\"estado\":\"texto_o_null\",\"nota\":\"texto_o_null\"}]}. Ignora encabezados y texto que no sea nombre de persona.";
  const oai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_OCR_MODEL") || "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] }],
    }),
  });
  if (!oai.ok) throw new Error("No se pudo procesar OCR");
  const out = await oai.json();
  let personas: any[] = [];
  try {
    personas = JSON.parse(out.choices?.[0]?.message?.content || "{}").personas || [];
  } catch {
    personas = [];
  }

  const matches = [];
  for (const p of personas.slice(0, 30)) {
    const name = cleanText(p?.nombre, 120);
    if (!name) continue;
    const candidates = await searchByName(sb, name);
    matches.push({ extracted: { nombre: name, edad: p?.edad ?? null, estado: cleanText(p?.estado, 80) || null }, candidates });
  }
  try {
    await sb.from("hospital_lists").insert({
      hospital: "chatbot",
      uploaded_by: uploaded_by || verifier,
      extracted: personas.slice(0, 60),
      matched_count: matches.filter((m) => m.candidates.length).length,
    });
  } catch {
    // Keep OCR useful even if storage/audit tables are not ready yet.
  }
  return { personas: personas.slice(0, 60), matches };
}

async function composeAnswer(input: {
  message: string;
  mode: string;
  results: PublicCluster[];
  ocr?: any;
  refused_sensitive?: boolean;
}) {
  const base = fallbackAnswer(input);
  const OPENAI = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI) return base;

  const system = [
    "Eres un asistente público para familias que buscan personas tras un terremoto en Venezuela.",
    "Responde en español, con calma y cuidado.",
    "Solo puedes usar los datos sanitizados que se te entregan.",
    "Nunca muestres cédulas, teléfonos, correos, contactos, notas internas ni datos no presentes.",
    "Nunca confirmes identidad, vida o fallecimiento como certeza. Di 'posible coincidencia' y recomienda ver la ficha.",
    "Si el usuario pide datos sensibles, rechaza brevemente y ofrece abrir la ficha sanitizada.",
  ].join(" ");
  const payload = {
    mode: input.mode,
    user_message_redacted: redact(input.message),
    results: input.results.slice(0, 5).map((r) => ({
      name: r.name,
      age: r.age,
      location: r.location,
      status: statusWord(r.status),
      sources: r.sources,
      n_records: r.n_records,
      has_conflict: r.has_conflict,
    })),
    ocr_count: input.ocr?.personas?.length || 0,
    refused_sensitive: input.refused_sensitive || false,
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: system },
          { role: "user", content: `Redacta una respuesta breve para esta búsqueda. Datos JSON:\n${JSON.stringify(payload)}` },
        ],
      }),
    });
    if (!res.ok) return base;
    const data = await res.json();
    const text = data.output_text ||
      (data.output || []).flatMap((o: any) => o.content || []).map((c: any) => c.text || "").filter(Boolean).join("\n");
    return cleanText(text, 1400) || base;
  } catch {
    return base;
  }
}

function fallbackAnswer(input: { mode: string; results: PublicCluster[]; ocr?: any; refused_sensitive?: boolean }) {
  if (input.refused_sensitive) {
    return "No puedo mostrar teléfonos, cédulas, contactos ni notas internas. Sí puedo ayudarte con resultados sanitizados y abrir una ficha para revisión.";
  }
  if (input.ocr) {
    const matched = input.ocr.matches?.filter((m: any) => m.candidates?.length)?.length || 0;
    return `Leí ${input.ocr.personas?.length || 0} nombre(s) en la imagen y encontré ${matched} posible(s) coincidencia(s). Revisa cada ficha antes de asumir que es la misma persona.`;
  }
  if (!input.results.length) {
    return "No encontré coincidencias claras. Prueba con nombre y apellido, o verifica si el nombre puede estar escrito de otra forma.";
  }
  const lines = input.results.slice(0, 3).map((r) => `- ${clusterSummary(r)}`);
  return `Encontré ${input.results.length} posible(s) coincidencia(s). Revisa la ficha antes de asumir que es la misma persona:\n${lines.join("\n")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const body = await req.json();
    const message = cleanText(body.message, MAX_MESSAGE);
    const image = typeof body.image === "string" ? body.image : "";
    const verifier = cleanText(body.verifier, 120);
    const sessionInput = cleanText(body.session_id, 80) || null;
    if (!message && !image) return json({ error: "Escribe una búsqueda o sube una imagen" }, 400);
    if (String(body.message || "").length > MAX_MESSAGE) return json({ error: "Mensaje demasiado largo" }, 413);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE) return json({ error: "Supabase no configurado" }, 500);
    const sb = createClient(SUPABASE_URL, SERVICE);

    const client_hash = await sha256(clientIp(req));
    const verifier_hash = verifier ? await sha256(verifier.toLowerCase()) : null;
    const session_id = await ensureSession(sb, sessionInput, client_hash, verifier_hash);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (await safeCountEvents(sb, { session_id, since: hourAgo }) >= SESSION_TURNS_PER_HOUR) {
      return json({ error: "Demasiadas consultas en esta sesión. Intenta más tarde." }, 429);
    }

    const metadata: Record<string, unknown> = {};
    let mode = "name";
    let results: PublicCluster[] = [];
    let ocr: any = null;
    let refused_sensitive = false;
    const cedula = extractCedula(message);

    await logEvent(sb, { session_id, role: "user", content_redacted: redact(message), metadata: { has_image: !!image } });

    if (likelySensitiveRequest(message)) refused_sensitive = true;

    if (image) {
      mode = "ocr";
      if (!verifier) {
        return json({ error: "Para procesar una imagen, escribe tu nombre o contacto en el campo de verificación." }, 400);
      }
      if (await safeCountEvents(sb, { verifier_hash, tool_name: "ocr_hospital_list", since: dayAgo }) >= OCR_PER_VERIFIER_DAY) {
        return json({ error: "Límite diario de OCR alcanzado para esta verificación." }, 429);
      }
      ocr = await runOcr(sb, image, verifier, verifier);
      results = (ocr.matches || []).flatMap((m: any) => m.candidates || []).slice(0, 5);
      metadata.ocr_names = ocr.personas?.length || 0;
      await logEvent(sb, { session_id, role: "tool", tool_name: "ocr_hospital_list", metadata });
    } else if (cedula) {
      mode = "cedula";
      if (await safeCountEvents(sb, { session_id, tool_name: "search_by_cedula_public", since: hourAgo }) >= CEDULA_PER_SESSION_HOUR) {
        return json({ error: "Demasiadas búsquedas por cédula en esta sesión." }, 429);
      }
      if (await safeCountEvents(sb, { client_hash, tool_name: "search_by_cedula_public", since: dayAgo }) >= CEDULA_PER_CLIENT_DAY) {
        return json({ error: "Límite diario de búsquedas por cédula alcanzado." }, 429);
      }
      results = await searchByCedula(sb, cedula);
      await logEvent(sb, { session_id, role: "tool", tool_name: "search_by_cedula_public", metadata: { result_count: results.length } });
    } else {
      const term = message.replace(/\b(dame|busca|buscar|encuentra|persona|desaparecida|desaparecido|por favor|ayuda)\b/gi, " ").replace(/\s+/g, " ").trim();
      results = term.length >= 2 ? await searchByName(sb, term) : [];
      await logEvent(sb, { session_id, role: "tool", tool_name: "search_people_public", metadata: { result_count: results.length } });
    }

    const actions: ChatAction[] = results.slice(0, 5).map((r) => ({ type: "open_record", cluster_id: r.id, label: r.name || "Abrir ficha" }));
    const answer = await composeAnswer({ message, mode, results, ocr, refused_sensitive });
    await logEvent(sb, { session_id, role: "assistant", content_redacted: redact(answer), metadata: { mode, result_count: results.length } });

    return json({
      session_id,
      answer,
      mode,
      results: results.slice(0, 5),
      actions,
      ocr: ocr ? { personas: ocr.personas?.slice(0, 20) || [], total_matched: results.length } : null,
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
});
