import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS" };
const json = (b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}});
const strip = (s)=>s.normalize("NFD").replace(/[̀-ͯ]/g,"");
const norm = (s)=>strip(String(s||"")).toLowerCase().replace(/[^a-z\s]/g," ").replace(/\s+/g," ").trim();
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
async function sha256(s:string){
  const data=new TextEncoder().encode(s);
  const hash=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

const PROMPT = "Esta es la foto de una lista (escrita a mano o impresa) de personas atendidas o localizadas en un hospital, refugio o centro de acopio tras un terremoto en Venezuela. Lee CADA renglón con cuidado y extrae TODOS los nombres de personas, aunque la letra sea difícil. Devuelve SOLO JSON válido con esta forma exacta: {\"personas\":[{\"nombre\":\"Nombre Apellido\",\"edad\":numero_o_null,\"estado\":\"texto_o_null\",\"nota\":\"texto_o_null\"}]}. Ignora encabezados, títulos, fechas y cualquier texto que no sea el nombre de una persona. No inventes nombres que no estén en la imagen.";

// OCR con detail alto, suficientes tokens para listas largas, y un reintento si vuelve vacío.
async function extractPersonas(image:string, OPENAI:string){
  const mkBody=(extra:string)=>JSON.stringify({
    model:"gpt-4o", temperature:0, max_tokens:4096, response_format:{type:"json_object"},
    messages:[{role:"user",content:[
      {type:"text",text:PROMPT+extra},
      {type:"image_url",image_url:{url:image,detail:"high"}},
    ]}],
  });
  let lastErr="";
  for(let attempt=0; attempt<2; attempt++){
    const extra = attempt ? " Es una pizarra o papel con varios nombres en columnas; recórrelas todas de arriba a abajo y no omitas ninguno." : "";
    const oai = await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${OPENAI}`,"Content-Type":"application/json"},body:mkBody(extra)});
    if(!oai.ok){ lastErr="OpenAI: "+(await oai.text()).slice(0,200); continue; }
    const out = await oai.json();
    let personas:any[]=[];
    try{ personas = JSON.parse(out.choices?.[0]?.message?.content||"{}").personas || []; }catch{ personas=[]; }
    if(Array.isArray(personas) && personas.length) return { personas, error:"" };
  }
  return { personas:[], error:lastErr };
}

// Crea (o reusa, dedup por nombre+centro) un cluster + record "localizado" para los nombres
// de la lista que no coinciden con nadie del registro. Best-effort: si falla, no rompe el OCR.
async function createLocalized(sb:any, nm:string, p:any, hospital:string|null, nowIso:string){
  try{
    const key = (await sha256(norm(nm)+"|"+norm(hospital||"hospital"))).slice(0,24);
    const cid = "hospital_list:"+key;
    const age = (typeof p?.edad==="number" && p.edad>0 && p.edad<120) ? Math.round(p.edad) : null;
    const loc = String(hospital||"Hospital/centro de atención").slice(0,200);
    const note = [p?.estado, p?.nota].filter(Boolean).map((x:any)=>String(x).slice(0,160)).join(" · ") || `Aparece en lista de ${loc}`;
    const cluster = { id:cid, name:nm.slice(0,200), age, location:loc, status:"found", sources:["hospital_list"], n_sources:1, n_records:1, has_conflict:false, any_found:true, confidence:null, resolved:true, resolved_decision:"same_located" };
    const { error: ce } = await sb.from("clusters").upsert(cluster, { onConflict:"id" });
    if(ce) return null;
    const { error: re } = await sb.from("records").upsert({
      pk:"hospital_list:"+key, source:"hospital_list", source_id:key, name:nm.slice(0,200), name_norm:norm(nm),
      age, gender:null, location:loc, status:"found", photo:null, id_number:null, contact:null,
      description:note, source_date:nowIso, cluster_id:cid, verified:false,
    }, { onConflict:"pk" });
    if(re) return null;
    return cluster;
  }catch{ return null; }
}

Deno.serve(async (req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try{
    const { image, hospital, uploaded_by } = await req.json();
    if(!image) return json({error:"Falta la imagen"},400);
    if(typeof image!=="string" || !image.startsWith("data:image/")) return json({error:"La imagen debe venir como data URL"},400);
    if(image.length>8_000_000) return json({error:"Imagen demasiado grande"},413);
    const OPENAI = Deno.env.get("OPENAI_API_KEY");
    if(!OPENAI) return json({error:"OPENAI_API_KEY no configurada"},500);
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if(!SUPABASE_URL||!SERVICE) return json({error:"Supabase no configurado"},500);
    const sb = createClient(SUPABASE_URL, SERVICE);
    const ip=(req.headers.get("x-forwarded-for")||req.headers.get("cf-connecting-ip")||"unknown").split(",")[0].trim();
    const client_hash=await sha256(`${ip}:${String(uploaded_by||"").slice(0,80)}`);
    const hourAgo=new Date(Date.now()-60*60*1000).toISOString();
    const dayAgo=new Date(Date.now()-24*60*60*1000).toISOString();
    const [{ count: hourCount, error: hourError }, { count: dayCount, error: dayError }]=await Promise.all([
      sb.from("hospital_ocr_events").select("id",{count:"exact",head:true}).eq("client_hash",client_hash).gte("created_at",hourAgo),
      sb.from("hospital_ocr_events").select("id",{count:"exact",head:true}).eq("client_hash",client_hash).gte("created_at",dayAgo),
    ]);
    if(hourError||dayError) return json({error:"Rate limit no disponible"},500);
    if((hourCount||0)>=10||(dayCount||0)>=40) return json({error:"Demasiadas solicitudes de OCR. Intenta más tarde."},429);
    const image_bytes=Math.floor(image.length*0.75);
    const { error: auditError }=await sb.from("hospital_ocr_events").insert({client_hash,uploaded_by:uploaded_by||null,hospital:hospital||null,image_bytes,status:"accepted"});
    if(auditError) return json({error:"No se pudo registrar la solicitud OCR"},500);

    const { personas, error: ocrError } = await extractPersonas(image, OPENAI);
    if(!personas.length && ocrError) return json({error:ocrError},502);

    const nowIso = new Date().toISOString();
    const isFound = (s:any)=> s==="found" || s==="found_alive";
    const matches:any[] = [];
    let created = 0, already = 0;
    for(const p of personas.slice(0,80)){
      const nm=String(p?.nombre||"").trim(); if(!nm) continue;
      const toks=norm(nm).split(" ").filter((t)=>t.length>=2);
      let cands:any[]=[];
      if(toks.length){
        // Reportes previos con ese nombre (mismo RPC que la búsqueda pública: acentos/orden).
        const { data } = await sb.rpc("public_search_clusters",{p_term:nm,p_filter:"",p_limit:5,p_offset:0});
        cands=(data||[]).slice(0,5);
      }
      // Estar en la lista del hospital = la persona FUE LOCALIZADA. Si no existe ya un reporte
      // localizado con ese nombre, se crea como localizado. Los reportes "por localizar" con el
      // mismo nombre se muestran aparte para que un humano confirme si es la misma persona.
      const alreadyLocated = cands.some((c)=>isFound(c.status));
      let wasCreated=false;
      if(toks.length>=2 && !alreadyLocated){
        const c = await createLocalized(sb, nm, p, hospital||null, nowIso);
        if(c){ wasCreated=true; created++; }
      }
      if(alreadyLocated) already++;
      matches.push({ extracted:p, candidates:cands, created:wasCreated, alreadyLocated });
    }
    const total_matched = already;

    // Guardar la lista YA matcheada (qué se encontró y qué se creó).
    const saved = matches.map((m)=>({
      nombre:m.extracted?.nombre||null, edad:m.extracted?.edad??null, estado:m.extracted?.estado??null,
      resultado: m.created ? "creado_localizado" : (m.alreadyLocated ? "ya_localizado" : (m.candidates.length ? "posible_match_pendiente" : "sin_coincidencia")),
      candidate_ids: m.candidates.map((c:any)=>c.id),
    }));
    await sb.from("hospital_lists").insert({ hospital:hospital||null, uploaded_by:uploaded_by||null, extracted:saved, matched_count:total_matched });

    return json({ personas, matches, total_matched, created_count:created });
  }catch(e){ return json({error:errorMessage(e)},500); }
});
