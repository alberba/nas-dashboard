# Phase 1: Auditoría del ruido - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-24
**Phase:** 1-Auditoría del ruido
**Areas discussed:** Fuentes y acceso, Ventana histórica, Unidad de medida, Evento WUD, Auto-actualizaciones

---

## Fuentes y acceso

| Option | Description | Selected |
|--------|-------------|----------|
| Export JSON | Export del chat con fecha, remitente y texto en JSON | |
| Export HTML | Export en HTML, parseable para extraer fecha y texto | ✓ (facilitado por el usuario) |
| Sin export | Solo logs y archivos de estado de cada emisor | |
| No sé si es posible | Comprobar si Telegram Desktop lo permite | ✓ (primera respuesta) |

**User's choice:** primero "no sé si mi Telegram lo permite"; tras explicar la ruta de Telegram Desktop, aportó `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html` (148 mensajes, 25 abr – 24 nov).
**Notes:** el export HTML identifica al bot `NAS Monitor`, no al job emisor; la atribución fina requiere logs de `media-stack`. Para el servidor del hub: el usuario indicó que los servidores están en T3 Code, pero la vinculación fue denegada por permisos del hilo y no hay alias SSH configurado.

---

## Servidor del hub (Oracle)

| Option | Description | Selected |
|--------|-------------|----------|
| SSH al Oracle | Leer docker logs y PostgreSQL directamente | ✓ (declarado por el usuario) |
| Solo NAS | Sin acceso al servidor de apps | |
| Sin acceso, ejecuta el agente | El usuario pega la salida | |
| No lo sé | Comprobarlo | |

**User's choice:** "tienes los servidores listados en t3code"; después, "activado".
**Notes:** `t3_environment_links` devolvió `links: []` y `t3_environment_link` falló con `capability_denied` (*"needs a live full-access/default calling thread"*). Queda como fuente condicionada, no como bloqueo de la fase.

---

## Ventana histórica

| Option | Description | Selected |
|--------|-------------|----------|
| 90 días + tendencia | 27 ago – 24 nov para la política; export completo como tendencia | |
| Por eras de cambio | E2/E3/E4 comparadas; E4 (13–24 nov) como línea base | ✓ |
| Todo el export | Un solo bloque de 7 meses | |
| Solo 30 días | Solo el último mes | |

**User's choice:** "es que hice algunos cambios sobre eso (mira tema commits y tal)" → tras revisar `media-stack`, se acordó segmentar por eras.
**Notes:** E1 8 msgs (0,04/día), E2 105 (2,92/día), E3 20 (2,00/día), E4 15 (1,15/día). El informe debe marcar los cortes de `d6831af`, `38061f0`, `16d824e` y WUD 9.8.0.

---

## Unidad de medida

| Option | Description | Selected |
|--------|-------------|----------|
| Ambas cifras | Eventos y mensajes; política por mensajes, reducción por eventos | ✓ |
| Solo eventos | Un escaneo con 6 contenedores = 1 evento | |
| Solo mensajes | Cada envío del bot | |

**User's choice:** "Ambas cifras".
**Notes:** el export muestra ráfagas de 4–8 mensajes por escaneo; sin la doble cifra la mejora no sería comparable entre eras.

---

## Evento WUD

| Option | Description | Selected |
|--------|-------------|----------|
| Una pasada de escaneo = 1 evento | La ráfaga completa es un evento | ✓ (consecuencia de la decisión de retirar WUD de Telegram) |
| Cada contenedor = 1 evento | Un evento por cambio de imagen | |
| Solo actualizaciones aplicadas | Los "tag found" no cuentan | |

**User's choice:** respuesta libre — "¿realmente son tan necesarias las notificaciones de WUD? ¿No hay unas que se duplican con otras?"
**Notes:** el cruce dio 13/95 mensajes WUD con auto-actualización del mismo contenedor en ±2 días, y 11 eventos repetidos (qbittorrent → ls478 cuatro veces). Conclusión: WUD no pide acción y es el único emisor que repite pendientes.

---

## Auto-actualizaciones

| Option | Description | Selected |
|--------|-------------|----------|
| Éxitos al digest, fallos inmediatos | El éxito es informativo; el fallo exige acción | ✓ |
| Silenciar todos los éxitos | Solo se avisa del fallo | |
| Agrupar por host y ejecución | Un mensaje por host y ejecución | |

**User's choice:** "Éxitos al digest, fallos inmediatos".
**Notes:** 7 mensajes de éxito en 12 días en la era actual; la repetición de "Dirty working tree" (5 veces, 7–12 nov) es el ejemplo de lo que la política debe agrupar.

---

## WUD en Telegram

| Option | Description | Selected |
|--------|-------------|----------|
| Fuera de Telegram, recuento en el digest | WUD deja de enviar; el digest puede llevar el número de actualizaciones | ✓ |
| Silencio total | Ni siquiera el recuento; el detalle vive en el hub | |
| Un resumen diario de WUD | Un solo mensaje agrupado al día | |

**User's choice:** "Fuera de Telegram, recuento en el digest".
**Notes:** elimina 95 de los 148 mensajes históricos y deja la acción en manos de security-monitor y Renovate/auto-release.

---

## the agent's Discretion

- Formato del informe y nombre del archivo.
- Parser del HTML y tratamiento de fechas/horas incompletas.
- Atribución de emisor cuando el texto es ambiguo.
- Cómo incorporar el push del hub si el acceso al Oracle aparece a mitad de fase.

## Deferred Ideas

- Vista de actualizaciones disponibles en el hub (fuera del roadmap actual).
- Contador temporal de push si falla el acceso al Oracle (solo si el usuario lo pide).
- Silencio nocturno, presupuesto de supresión y escalado: ya en v2 de REQUIREMENTS.md.
