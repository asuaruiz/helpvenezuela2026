# Deploy checklist

Estado actual: **NO-GO para público completo** hasta aplicar RLS/auth de operador. El chatbot público ya está desplegado y operativo.

## Bloqueantes

- Aplicar `supabase/migrations/202606270001_public_hardening.sql`.
- Revocar acceso anónimo directo a `records`, `decisions`, `hospital_lists` y `cedula_data`.
- Requerir auth/rol operador para revisión, contactos, cédulas, decisiones y OCR real.
- Rotar el personal access token de Supabase que fue compartido en chat.

## Hecho

- Aplicada `supabase/migrations/202606270002_performance_indexes.sql`.
- Aplicada `supabase/migrations/202606270003_ocr_rate_limit.sql`.
- Aplicada `supabase/migrations/202606270004_chat_assistant.sql`.
- Desplegada `supabase/functions/ocr-hospital`.
- Desplegada `supabase/functions/chat-assistant`.

## Verificación

```bash
npm run check
npm run measure:read
node mirror_photos.mjs --dry-run
```

Con `k6` instalado:

```bash
SUPABASE_URL='https://cjoavvyqbtgqelobwanx.supabase.co' \
SUPABASE_ANON='...' \
BASE_URL='https://TU-DEPLOY.vercel.app' \
k6 run --vus 20 --duration 10m load/k6-public-read.js
```

OCR se prueba aparte para no mezclar costo OpenAI con lectura pública:

```bash
SUPABASE_URL='https://cjoavvyqbtgqelobwanx.supabase.co' \
SUPABASE_ANON='...' \
k6 run --vus 1 --iterations 10 load/k6-ocr.js
```

Chatbot:

```bash
SUPABASE_URL='https://cjoavvyqbtgqelobwanx.supabase.co' \
SUPABASE_ANON='...' \
k6 run --vus 10 --duration 5m load/k6-chat-assistant.js
```

## Operación

- Vigilar Supabase API egress, Storage egress, Function logs y slow queries.
- Vigilar OpenAI spend cap diario y errores OCR.
- No correr `build_and_load.mjs --reset-decisions` ni `--replace-clusters` salvo reset controlado.
- Preferir deploy desde Git limpio; `.vercelignore` evita subir dumps/secretos si se usa Vercel CLI.
