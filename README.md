# Conciliación de desaparecidos · Terremoto Venezuela 2026

App para cruzar y conciliar los registros ciudadanos de personas desaparecidas tras el
terremoto del 24 jun 2026, publicados en varias plataformas independientes.

## Cómo correr la app

```bash
node server.mjs    # http://localhost:8787  (sirve con gzip y MIME correcto)
```

La app es un único `index.html` que habla directo con la API REST de Supabase mediante
`fetch` (sin SDK). El service worker (`sw.js`) cachea la app para reabrirla sin gastar datos.

## Optimización de datos (conexión difícil)
Pensada para conectividad limitada (Venezuela):
- **Sin Google Fonts ni supabase-js** → ~270KB menos. La app entera son ~9KB gzip.
- **Fotos apagadas por defecto** — se cargan solo al activarlas o tocar "ver foto", con `lazy`.
  Medido: con fotos OFF la primera carga es ~0 datos; las fotos costaban ~1,4MB cada 6 casos.
- **Lotes de 6** casos, caché local de stats (5 min), y service worker para el shell.

## Política de conciliación (dura)
El cruce ancho por nombre+edad daba 899 conflictos — inviable a mano. `policy.mjs` los
reclasifica por confianza y auto-resuelve los más seguros:

| Nivel | Señal adicional | Casos | Destino |
|---|---|---|---|
| **auto** | misma cédula o teléfono entre plataformas | 222 | conciliado automáticamente |
| **alta** | ≥2 palabras de ubicación en común | 141 | cola manual prioritaria |
| **media** | 1 palabra de ubicación en común | 253 | cola manual (opcional, checkbox) |
| **baja** | solo nombre+edad (homónimos probables) | 283 | descartado, fuera de la cola |

Resultado: la revisión humana baja de 899 a **141** (o 394 con media). Re-aplicar tras
recargar datos: `node policy.mjs`.

## Vistas
- **Conciliar** — cola de los 899 conflictos (localizada en una plataforma / desaparecida en
  otra). Cada caso muestra todos los reportes lado a lado con foto; se decide y se guarda.
- **Buscar** — búsqueda sobre las 59.619 personas únicas, con filtros (conflicto, multi-fuente,
  localizada / por localizar).
- **Resumen** — métricas del cruce por plataforma.

## Datos / pipeline
| Script | Qué hace |
|---|---|
| `scrape.mjs` | venezuelatebusca.com (React Router single-fetch `/_root.data`) → `personas.json` |
| `scrape_dtv.mjs` | desaparecidosterremotovenezuela.com (API + reCAPTCHA v3 vía Playwright) → `personas_dtv.json` |
| `scrape_dv.mjs` | desaparecidosvenezuela.com (`/api/personas?skip=`) → `personas_dv.json` |
| `unify.mjs` | cruce por nombre normalizado + edad → `unified.json/csv` |
| `load_supabase.mjs` | carga `records` + `clusters` a Supabase |

Re-scrapear y recargar:
```bash
node scrape.mjs && node scrape_dtv.mjs && node scrape_dv.mjs
node unify.mjs && node load_supabase.mjs
```

## Verificación por cédula (cedula.com.ve)
`enrich_cedula.mjs` consulta el API oficial de cédulas (límite 200/cuenta) para obtener
nombre y edad reales, priorizando cédulas en clusters de conflicto. Guarda en `cedula_data`
y marca los records como `verified` (badge ✓ en la app). En **Buscar**, si escribes solo
dígitos busca por cédula. Crédito a cedula.com.ve en el footer.
```bash
node enrich_cedula.mjs   # consume hasta 200 consultas, no repite las ya hechas
```

## Actualización automática (cron cada 3 min)
`refresh.mjs` hace un refresco INCREMENTAL: trae las primeras páginas (lo más reciente) de
las 3 fuentes, inserta solo los reportes nuevos y recalcula sus clusters (~20s por corrida
típica). Programado con launchd:
```bash
launchctl load -w  ~/Library/LaunchAgents/com.conciliacion.refresh.plist   # activar
launchctl unload   ~/Library/LaunchAgents/com.conciliacion.refresh.plist   # detener
tail -f refresh.log    # ver actividad
```
El re-scrape completo + reconsolidación se corre aparte con `node build_and_load.mjs`.

## Backend (Supabase)
- Proyecto: `conciliacion-vzla` (ref `cjoavvyqbtgqelobwanx`, org asuaruiz)
- Tablas: `records` (70.759 reportes crudos), `clusters` (59.619 personas únicas), `decisions`
- RPC: `app_stats()`, `next_candidates()`, `cluster_with_records()`
- RLS: anon puede **leer** todo e **insertar** decisiones (no borrar/editar)

## ⚠️ Privacidad
Contiene datos personales sensibles (nombres, edades, contactos de reportes de desaparecidos).
La clave anon embebida da acceso de lectura a todo el registro: **no publiques esta app en
internet sin añadir autenticación**. Úsala solo para reunificación familiar.
El cruce automático puede unir homónimos distintos o separar a la misma persona escrita de dos
formas — por eso cada conflicto requiere verificación humana antes de actuar.
