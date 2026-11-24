---
phase: "01"
slug: "auditor-a-del-ruido"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-11-24"
---

# Seguridad de la fase 01

## Límites de confianza

- El export HTML y el CSV opcional se leen como datos locales externos.
- El NDJSON contiene cuerpos de mensajes. El JSON y el Markdown versionados contienen agregados.
- Las referencias a `media-stack` identifican emisores mediante evidencia de solo lectura.
- El catálogo y los agregados alimentan el mapa de política y el informe reproducible.

## Registro de amenazas

| ID | Categoría | Severidad | Disposición | Evidencia de mitigación | Estado |
|---|---|---|---|---|---|
| T-01-01 | Divulgación | Alta | Mitigar | `write_ndjson` usa permisos 0700 para el directorio nuevo y 0600 para el fichero, con `O_NOFOLLOW`. Git no contiene NDJSON. | Cerrada |
| T-01-02 | Manipulación | Alta | Mitigar | `read_pinned_bytes` resuelve la ruta y limita la lectura. `parse_export_document` verifica SHA-256 antes de parsear. | Cerrada |
| T-01-03 | Denegación de servicio | Media | Mitigar | Límite de 16 MiB, parser local `HTMLParser` que sigue la profundidad y recorte del texto normalizado. | Cerrada |
| T-01-04 | Repudio | Media | Mitigar | `build_inventory` conserva la categoría `unknown` y la evidencia por emisor. Las pruebas contrastan los totales. | Cerrada |
| T-01-05 | Divulgación | Alta | Mitigar | El README documenta la entrada local. Los únicos HTML y CSV de auditoría versionados son fixtures sintéticos. | Cerrada |
| T-01-06 | Manipulación | Media | Mitigar | `load_alerts_csv` valida la cabecera, normaliza instantes a UTC y descarta filas inválidas. | Cerrada |
| T-01-07 | Manipulación | Alta | Mitigar | `build_histogram` usa la hora de pared. `to_instant` usa la zona `Europe/Madrid` al cruzar canales. | Cerrada |
| T-01-08 | Divulgación | Alta | Mitigar | El CSV real es externo. El flujo exporta cifras agregadas y pruebas con un CSV sintético. | Cerrada |
| T-01-09 | Repudio | Media | Mitigar | `_inter_system` cuenta cada mensaje WUD una vez. Las pruebas distinguen revisión manual, actualización real y coincidencia de tag. | Cerrada |
| T-01-10 | Manipulación | Media | Mitigar | `canonical_json` ordena claves y `check_repro` compara los bytes de dos agregaciones. | Cerrada |
| T-01-11 | Manipulación | Alta | Mitigar | Las pruebas de `build_policy_map` comprueban la cobertura única de las 22 claves y la distribución 9/9/4. | Cerrada |
| T-01-12 | Repudio | Media | Mitigar | `build_success_target` toma los días inclusivos y la tasa de E4 de los agregados. | Cerrada |
| T-01-13 | Divulgación | Alta | Mitigar | El render recibe agregados. Una prueba con un cuerpo centinela verifica que queda fuera del informe. | Cerrada |
| T-01-14 | Manipulación | Media | Mitigar | `check_report` reconstruye el modelo desde el JSON y compara el Markdown generado. | Cerrada |
| T-01-15 | Repudio | Media | Mitigar | Las pruebas de `build_shutdown_order` cubren el orden, las exclusiones y la continuidad de los avisos de fallo de copia. | Cerrada |
| T-01-SC | Manipulación | Alta | Mitigar | Las utilidades de auditoría usan la biblioteca estándar de Python. La fase no añadió dependencias. | Cerrada |

## Riesgos aceptados

Ninguno.

## Registro de revisión

El 2026-11-24 se comprobaron las 16 amenazas de los planes con ASVS nivel 1 e inspección de la implementación. Las 116 pruebas de auditoría pasaron y `--check-report` confirmó la correspondencia entre el JSON y el Markdown.
