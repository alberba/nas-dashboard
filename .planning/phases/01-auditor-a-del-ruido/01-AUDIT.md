# Auditoría del ruido de avisos — NAS Monitor

Informe generado desde `01-AUDIT.json`. El sha256 del export es `fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74`.

<!-- id: resumen -->
## Resumen

_Fuente: export._

El export contiene 148 mensajes (146 del bot y 2 del operador) entre 2026-04-25 y 2026-11-24, en 214 días inclusivos.

El bot usa 10 familias y 9 emisores; el hub no envía Telegram y sus 12 claves se mapean por separado.

El mapa de política fija 9 immediate, 9 digest y 4 silent; el orden de apagado tiene 5 pasos y la copia se estrecha en vez de apagarse.

El objetivo propuesto es 1.0 mensajes proactivos/día frente a 1.25 de E4, con el ack publicado como —.

**Cifras de cabecera**

| Cifra | Valor | Origen |
|---|---|---|
| Mensajes totales | 148 | export |
| Mensajes del bot | 146 | export |
| Mensajes del operador | 2 | export |
| Claves con disposición | 22 | codigo |
| Pasos de apagado | 5 | codigo |
| Objetivo proactivo/día | 1.0 | export |

<!-- id: ventana -->
## Ventana medida

_Fuente: export._

La ventana se cierra en el último mensaje, no en la fecha del export; el denominador es inclusivo y se declara por era.

**Ventana y fuente**

| Campo | Valor |
|---|---|
| Primer mensaje | 2026-04-25T18:13:42 |
| Último mensaje | 2026-11-24T06:08:00 |
| Días inclusivos | 214 |
| Días con mensajes | 45 |
| Mensajes sin hora | 0 |
| Separadores de fecha | 45 |
| sha256 del export | fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74 |
| Bytes del export | 76936 |

<!-- id: inventario -->
## Inventario de emisores

_Fuente: export._

Se identifican 9 emisores. El hub declara 0 mensajes de Telegram porque su canal es push.

**Emisores**

| Emisor | Canal | Mensajes |
|---|---|---|
| wud | telegram | 95 |
| security-monitor | telegram | 1 |
| security-updater | telegram | 31 |
| upgrade-script | telegram | 6 |
| merged-updates | telegram | 4 |
| backup | telegram | 2 |
| issue-automator | telegram | 5 |
| unknown-smart | telegram | 2 |
| hub | push | 0 |

**Familias del bot**

| Familia | Mensajes |
|---|---|
| backup | 2 |
| issue-incident | 3 |
| issue-test | 2 |
| release-apply | 4 |
| release-stop | 5 |
| release-upgrade | 1 |
| security-digest | 1 |
| security-update | 31 |
| smart | 2 |
| wud | 95 |

<!-- id: eras -->
## Eras y tendencia

_Fuente: export._

Cada era publica mensajes y eventos con su denominador inclusivo. E3 se parte en E3a (3–7 nov) y E3b (8–12 nov) para no confundir el efecto del tag.transform con el de WUD 9.8.0.

**Eras**

| Era | Desde | Hasta | Días | Mensajes | Eventos | Mensajes/día |
|---|---|---|---|---|---|---|
| E1 | 2026-04-25 | 2026-09-27 | 156 | 8 | 6 | 0.05 |
| E2 | 2026-09-28 | 2026-11-02 | 36 | 105 | 62 | 2.92 |
| E3 | 2026-11-03 | 2026-11-12 | 10 | 20 | 19 | 2.0 |
| E4 | 2026-11-13 | 2026-11-24 | 12 | 15 | 15 | 1.25 |

**Tendencia con E3 partida**

| Ventana | Desde | Hasta | Días | Mensajes | Marcadores previos | Marcadores posteriores |
|---|---|---|---|---|---|---|
| E1 | 2026-04-25 | 2026-09-27 | 156 | 8 | — | 16d824e, d6831af, 38061f0, cc8d8a3 |
| E2 | 2026-09-28 | 2026-11-02 | 36 | 105 | — | 16d824e, d6831af, 38061f0, cc8d8a3 |
| E3a | 2026-11-03 | 2026-11-07 | 5 | 11 | 16d824e | d6831af, 38061f0, cc8d8a3 |
| E3b | 2026-11-08 | 2026-11-12 | 5 | 9 | 16d824e, d6831af, 38061f0 | cc8d8a3 |
| E4 | 2026-11-13 | 2026-11-24 | 12 | 15 | 16d824e, d6831af, 38061f0, cc8d8a3 | — |

<!-- id: eventos -->
## Eventos y repeticiones

_Fuente: export._

WUD agrupa 95 mensajes en 51 pasadas de escaneo (1.86 mensajes por pasada).

Las repeticiones suman 11 grupos y 14 mensajes extra.

**Grupos repetidos**

| Contenedor | Tag destino | Mensajes | Extras |
|---|---|---|---|
| qbittorrent | 5.2.3_v2.0.15-ls478 | 4 | 3 |
| qbittorrent | 5.2.4_v2.0.15-ls480 | 3 | 2 |
| radarr | 6.4.4.10685-ls319 | 2 | 1 |
| radarr-vo | 6.4.4.10685-ls319 | 2 | 1 |
| sonarr | 4.0.20.3014-ls328 | 2 | 1 |
| sonarr | 4.0.20.3014-ls329 | 2 | 1 |
| sonarr-vo | 4.0.20.3014-ls328 | 2 | 1 |
| sonarr-vo | 4.0.20.3014-ls329 | 2 | 1 |
| tdarr | 2.93.01 | 2 | 1 |
| tdarr | 3.00.00 | 2 | 1 |
| tdarr | 3.01.00 | 2 | 1 |

<!-- id: recuperaciones -->
## Recuperaciones por canal

_Fuente: state._

Telegram publica 120 aperturas, 26 informativos y 0 recuperaciones (ratio 0.0).

El hub queda unavailable: sin CSV de alerts no hay cifra de push y se publica —, nunca 0.

**Recuperaciones por canal**

| Canal | Aperturas | Informativos | Recuperaciones | Ratio | Estado |
|---|---|---|---|---|---|
| telegram | 120 | 26 | 0 | 0.0 | measured |
| hub_push | — | — | — | — | unavailable |

<!-- id: duplicados -->
## Duplicados

_Fuente: export._

El duplicado entre sistemas y el duplicado entre canales se publican en bloques separados y nunca se suman en una cifra.

**Duplicado entre sistemas**

| Mensajes | Mismo tag | Actualización real | Solo manual | Latencia mínima (min) |
|---|---|---|---|---|
| 14 | 12 | 1 | 13 | 39 |

**Duplicado entre canales**

| Estado | Duplicados | Latencia (s) |
|---|---|---|
| unavailable | — | — |

<!-- id: horario -->
## Distribución horaria

_Fuente: export._

El histograma usa la hora de pared del export, sin convertirla.

El pico de E4 es de 8 mensajes a las 06:00.

**Mensajes por hora**

| Hora | Mensajes |
|---|---|
| 00:00 | 17 |
| 01:00 | 0 |
| 02:00 | 0 |
| 03:00 | 0 |
| 04:00 | 7 |
| 05:00 | 1 |
| 06:00 | 38 |
| 07:00 | 0 |
| 08:00 | 0 |
| 09:00 | 0 |
| 10:00 | 1 |
| 11:00 | 1 |
| 12:00 | 8 |
| 13:00 | 2 |
| 14:00 | 0 |
| 15:00 | 5 |
| 16:00 | 3 |
| 17:00 | 2 |
| 18:00 | 29 |
| 19:00 | 4 |
| 20:00 | 1 |
| 21:00 | 8 |
| 22:00 | 19 |
| 23:00 | 2 |

<!-- id: top_claves -->
## Top de claves

_Fuente: export._

El top se ordena por volumen y desempata alfabéticamente.

**Top de claves**

| Clave | Mensajes | Cuota | E1 | E2 | E3 | E4 |
|---|---|---|---|---|---|---|
| security:update | 31 | 0.212 | 0 | 15 | 9 | 7 |
| wud:tdarr | 15 | 0.103 | 0 | 13 | 2 | 0 |
| wud:radarr | 10 | 0.068 | 0 | 8 | 1 | 1 |

<!-- id: push -->
## Columna de push

_Fuente: no medido._

La tabla alerts no está disponible: push queda unavailable. La columna se publica como — y no se infiere del volumen de Telegram.

**Cobertura de push**

| Campo | Valor |
|---|---|
| Estado | unavailable |
| Origen | alerts CSV |
| Filas | — |
| Filas omitidas | 0 |

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
| security-update | telegram | digest | failed→immediate; manual→immediate; updated→digest |
| release-apply | telegram | digest | applied→digest; failed→immediate |
| release-upgrade | telegram | digest | — |
| container:<name> | hub | silent | — |
| wud | telegram | silent | — |
| issue-test | telegram | silent | — |
| smart | telegram | silent | — |

<!-- id: apagado -->
## Orden de apagado

_Fuente: codigo._

La copia no se apaga: se estrecha a backup-failed con origen propio (SEC-06, PITFALLS #24). issue-automator y SMART quedan fuera del cutover y se revisan en la fase 8.

**Orden de apagado**

| Paso | Emisor | Familias | Sustituto | Reversibilidad |
|---|---|---|---|---|
| 1 | upgrade-script | release-stop, release-upgrade | deploy-failed en el hub y digest | media |
| 2 | merged-updates | release-apply | deploy-failed y digest | media |
| 3 | security-updater | security-update | ingesta y digest (fases 4 y 8) | media |
| 4 | security-monitor | security-digest | digest del hub disponible antes del apagado | media |
| 5 | wud | wud | UI de WUD y recuento en el digest | alta |

**Copia estrechada**

| Emisor | Destino | Origen | Requisito | Motivo |
|---|---|---|---|---|
| backup | backup-failed | media-stack backup | SEC-06 | PITFALLS #24 |

**Fuera de alcance**

| Emisor | Familias | Revisión |
|---|---|---|
| issue-automator | issue-incident, issue-test | phase 8 |
| unknown-smart | smart | phase 8 |

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

<!-- id: supuestos -->
## Supuestos

_Fuente: codigo._

Los ocho supuestos siguientes sostienen las cifras del informe.

**Supuestos**

| Id | Supuesto | Riesgo |
|---|---|---|
| A1 | La hora del export es hora de pared de Madrid. | El histograma se desplaza 1 o 2 horas y los picos de las 06:00 se leen mal. |
| A2 | Las firmas de los mensajes son estables y únicas en toda la ventana. | Un cambio de plantilla manda mensajes a unknown y subestima una familia. |
| A3 | Los 14 mensajes WUD con coincidencia son el mismo pendiente avisado por dos sistemas. | Si son hechos distintos, se sobrecuenta el duplicado. |
| A4 | issue-automator y SMART quedan fuera del cutover. | El mapa quedaría incompleto si el operador quiere apagar también Seerr. |
| A5 | El export contiene todo el tráfico de Telegram relevante: un solo chat y un solo bot. | Si hubiera otro chat o bot, faltarían mensajes. |
| A6 | El acceso a alerts sigue sin estar disponible durante la fase. | Si aparece, hay que rellenar la columna de push. |
| A7 | E4, con 12 días, es una línea base suficiente para el objetivo. | Un objetivo calculado sobre 12 días puede ser demasiado estricto o laxo. |
| A8 | Los dos mensajes SMART del 25 abr son el mismo hecho con dos codificaciones. | Contarlos como dos eventos sobrecuenta E1 en un evento. |

<!-- id: reproducibilidad -->
## Reproducibilidad

_Fuente: export._

El sha256 del export es fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74.

Regenerar el informe: `python3 scripts/audit/noise_audit.py --export <export> --out-json <json> --out-md <md> --force`.

Comprobar el informe: `python3 scripts/audit/noise_audit.py --check-report --out-json <json> --out-md <md>`.

Comprobar la reproducibilidad: `python3 scripts/audit/noise_audit.py --export <export> --check-repro`.

Notas de cobertura: La discusión usó un denominador no declarado (0,04/día en E1 y 1,15/día en E4). Este informe usa días inclusivos: E1 8/156 = 0,05 y E4 15/12 = 1,25; los conteos no cambian. La columna de push se publica como —: no hay CSV de la tabla alerts, así que no se rellena con 0 ni se infiere del volumen de Telegram. El tiempo hasta reconocer se publica como —: no existe ackAt hasta la fase 6, así que no se inventa un 0.
