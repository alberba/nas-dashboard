# hub.

## What This Is

Dashboard personal en español para supervisar y administrar un NAS y un servidor de aplicaciones desde un servidor remoto. El navegador solo habla con Next.js; el hub centraliza métricas, mantenimiento, despliegues, archivos, contenedores, avisos y PR de Renovate, y cada máquina vigilada ejecuta un agente Python privado con acceso al host. Es una herramienta de una sola persona, instalable como PWA y pensada para el móvil.

## Core Value

Saber en segundos qué está pasando en los dos servidores y poder actuar sobre ellos sin abrir una consola.

## Requirements

### Validated

<!-- Inferidas del código existente y del mapa en .planning/codebase/. -->

- ✓ Métricas nativas por host (CPU total y por núcleo, carga, memoria y swap, red, discos, RAID, temperaturas, contenedores) con histórico de 30 días — existente
- ✓ Varios hosts con estado de conexión independiente y alcance por host en API y UI — existente
- ✓ Ciclo de vida de contenedores (iniciar, parar, reiniciar, eliminar, actualizar imagen) con operación idempotente y sin reintento automático — existente
- ✓ Mantenimiento: copia, unidades systemd, SMART, uso de Docker y acciones fijas del host — existente
- ✓ Despliegues de media-stack: releases, retenidas, journal y ajustes de `.env` con escritura atómica — existente
- ✓ Explorador de archivos limitado a dos raíces, con papelera de 7 días y sin transferencias entre raíces — existente
- ✓ Better Auth con correo/contraseña y passkeys, registro cerrado tras el alta y verificación reciente para acciones sensibles — existente
- ✓ Avisos internos y Web Push para umbrales, copia, discos, unidades, releases y despliegues — existente
- ✓ Renovate: lectura de PR y merge verificado; progreso de despliegue en seis pasos — existente
- ✓ PWA instalable con notificaciones en móvil y CI completo (tipos, lint, Vitest, agente Python, build, Playwright) — existente
- ✓ Auditoría del volumen de avisos, mapa de política y objetivo de ruido — fase 01 (AUDT-01 a AUDT-05)

### Active

- [ ] Auditar el ruido de Telegram con datos reales: qué mensajes llegan, desde qué job y con qué frecuencia
- [ ] Una sola notificación por incidencia, sin aviso de recuperación ni reenvíos mientras el estado no cambie
- [ ] Resumen diario para lo no urgente, con lo crítico entregado al momento
- [ ] Bot de Telegram interactivo: botones para abrir vistas del hub y ejecutar acciones con autorización y verificación reciente
- [ ] Exigir verificación reciente en el servidor para todas las acciones destructivas, no solo para algunas
- [ ] Rechazar credenciales de ejemplo al arrancar y documentar la rotación de secretos
- [ ] CSP y HSTS, más límites de cuerpo y de tamaño de respuesta en el hub
- [ ] Validar la configuración obligatoria al arranque del hub y del worker antes de declarar el contenedor sano
- [ ] Validar en runtime los contratos Python↔TS (métricas, mantenimiento, despliegues) en vez de confiar en la forma
- [ ] Rollups y caché del histórico para que 30 días de muestras no dominen la carga de PostgreSQL
- [ ] Healthchecks de agente y worker, reaper de contenedores auxiliares y `expectedContainers` reconciliado

### Out of Scope

- Múltiples réplicas web o de worker — el diseño es de escritor único y el rate limit de auth vive en memoria; escalar exige rehacer ambos
- Consola o shell remota arbitraria — el agente expone una lista cerrada de comandos y acciones; es una decisión de diseño
- Transferencia de archivos entre las dos raíces — la papelera vive dentro de cada raíz para no mover datos entre servidores
- Notificaciones por correo — los canales son el push del hub y Telegram
- Capacidades nuevas del hub (el bloque "3") — entran en un milestone posterior; este milestone no las planifica

## Context

- Dos repositorios: este (el hub) y `media-stack` (Compose, scripts y servicios multimedia), que hoy es quien envía los mensajes a Telegram. Las fases de notificaciones pueden tocar ambos, con commits y CI separados.
- Despliegue: Compose en un servidor Oracle con `db`, `migrate`, `app` y `worker`; agentes en el NAS y en el servidor de apps, unidos por Tailscale. Un solo `app` y un solo `worker`.
- Stack muy reciente: Next.js 16, React 19, TypeScript 7, Effect 4, PostgreSQL 18, Python 3.14. El adaptador de TypeScript 6 para ESLint es el punto más frágil de las actualizaciones.
- El detalle por archivo está en `.planning/codebase/`; `CONCERNS.md` enumera los huecos de seguridad, rendimiento y cobertura de tests.
- El ruido de avisos no está medido: no existe un histórico agregado de qué se envió, cuándo ni por qué.
- Acceso del usuario al NAS por SSH (`100.124.98.51`, usuario `alberba`) para leer journals y logs de los servicios implicados.

## Constraints

- **Seguridad**: el agente monta el socket de Docker y crea ayudantes privilegiados; un fallo suyo equivale a root en el host. Ningún cambio puede ampliar esa superficie.
- **Infraestructura**: una réplica web y un worker; PostgreSQL 18 sin puerto publicado; el navegador solo habla con Next.js.
- **Idioma**: interfaz y mensajes al usuario en español. Los tests no se acoplan al copy (`CODING_STANDARD.md`).
- **Compatibilidad**: el agente requiere Linux; el hub funciona en macOS y Linux.
- **Multi-repo**: `media-stack` conserva sus propios commits, tests y CI; el hub no lo despliega.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Auditar el ruido antes de decidir el alcance de notificaciones | El export de Telegram aporta una línea base de 1,25 mensajes/día en E4 | Fase 01 aprobada con 9 claves de aviso inmediato, 9 para el resumen, 4 silenciosas y un objetivo de mediana diaria de hasta 1 aviso proactivo fuera del resumen en 14 días |
| Un mensaje por incidencia, sin aviso de recuperación | El volumen por evento es la queja principal | — Pending |
| Resumen diario para lo no urgente | Evita interrumpir por informativo sin perderlo | — Pending |
| Telegram con acciones inline | El usuario quiere resolver desde el móvil, no solo enterarse | — Pending |
| Auditar con datos reales del NAS y de media-stack | Sin una cifra de partida no hay criterio de éxito | Telegram medido. El push histórico queda sin medir en ausencia del CSV de `alerts`. |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-24 after initialization*
