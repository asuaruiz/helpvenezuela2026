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
    const prompt = "Lee esta foto de una lista de personas atendidas en un hospital o centro de acopio tras un terremoto en Venezuela. Extrae TODOS los nombres de personas. Devuelve SOLO JSON: {\"personas\":[{\"nombre\":\"...\",\"edad\":num_o_null,\"estado\":\"texto_o_null\",\"nota\":\"texto_o_null\"}]}. Ignora encabezados y texto que no sea nombre de persona.";
    const oai = await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${OPENAI}`,"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-4o",temperature:0,response_format:{type:"json_object"},messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:image}}]}]})});
    if(!oai.ok) return json({error:"OpenAI: "+(await oai.text()).slice(0,300)},502);
    const out = await oai.json();
    let personas=[]; try{ personas=(JSON.parse(out.choices?.[0]?.message?.content||"{}").personas)||[]; }catch{ personas=[]; }
    const matches=[];
    for(const p of personas.slice(0,60)){
      const nm=String(p?.nombre||"").trim(); if(!nm) continue;
      const toks=norm(nm).split(" ").filter(t=>t.length>=3);
      let cands=[];
      if(toks.length){
        const { data } = await sb.from("clusters").select("id,name,age,location,status,has_conflict").ilike("name",`%${nm.split(/\s+/).slice(-1)[0]}%`).limit(8);
        cands=(data||[]).filter(c=>{const cn=norm(c.name); return toks.filter(t=>cn.includes(t)).length>=Math.min(2,toks.length);}).slice(0,5);
      }
      matches.push({extracted:p,candidates:cands});
    }
    const total_matched=matches.filter(m=>m.candidates.length).length;
    const { error: insertError } = await sb.from("hospital_lists").insert({hospital:hospital||null,uploaded_by:uploaded_by||null,extracted:personas,matched_count:total_matched});
    if(insertError) return json({error:"No se pudo guardar la lista OCR"},500);
    return json({personas,matches,total_matched});
  }catch(e){ return json({error:errorMessage(e)},500); }
});
