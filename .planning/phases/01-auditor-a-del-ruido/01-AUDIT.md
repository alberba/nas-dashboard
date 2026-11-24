# Auditoría del ruido de avisos — NAS Monitor

Informe generado desde `01-AUDIT.json`. El sha256 del export es `fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74`.

<!-- id: politica -->
## Política de avisos

_Fuente: codigo._

El mapa cubre las 22 claves del catálogo: 9 immediate, 9 digest y 4 silent.

WUD queda en silent y la copia en immediate. El éxito de security-update y de release-apply va al digest; manual y failed exigen acción inmediata.

**Mapa por clave**

| Clave | Origen | Bucket | Split por resultado |
|---|---|---|---|
| connection | hub | immediate | — |
| temperature | hub | immediate | — |
| backup-failed | hub | immediate | — |
| disk-health | hub | immediate | — |
| stack-unit-failed | hub | immediate | — |
| deploy-failed | hub | immediate | — |
| release-stop | telegram | immediate | — |
| backup | telegram | immediate | — |
| issue-incident | telegram | immediate | — |
| cpu | hub | digest | — |
| memory | hub | digest | — |
| disk | hub | digest | — |
| reboot-pending | hub | digest | — |
| release-retained | hub | digest | — |
| security-digest | telegram | digest | — |
| security-update | telegram | digest | updated→digest; manual→immediate; failed→immediate |
| release-apply | telegram | digest | applied→digest; failed→immediate |
| release-upgrade | telegram | digest | — |
| container:<name> | hub | silent | — |
| wud | telegram | silent | — |
| issue-test | telegram | silent | — |
| smart | telegram | silent | — |

<!-- id: objetivo -->
## Objetivo de éxito

_Fuente: export._

El objetivo se apoya en E4: 1.25 mensajes/día sobre 12 días inclusivos. Se propone 1.0 mensajes proactivos/día fuera del digest, menor o igual que la línea base.

El ack se publica como — porque no existe ackAt: la métrica queda definida y se medirá en la fase 6.

**Línea base y propuesta**

| Campo | Valor |
|---|---|
| Era de referencia | E4 |
| Días inclusivos | 12 |
| Mensajes/día de referencia | 1.25 |
| Objetivo proactivo/día | 1.0 |
| Ventana de medida (días) | 14 |
| Definición | Mediana diaria de mensajes proactivos fuera del digest, medida sobre una ventana de 14 días consecutivos. |

**Contrato del ack**

| Campo | Valor |
|---|---|
| Métrica | median(sentAt -> ackAt) |
| Guardia | p90 |
| Por severidad | sí |
| Objetivo de mediana inmediata (min) | 15 |
| Guardia p90 (min) | 60 |
| Valor actual | — |
| Estado | not_measurable |
