# Phase 8: Cutover de media-stack y consolidación - Context

**Gathered:** 2026-11-27
**Status:** Ready for planning

<domain>
## Phase Boundary

`media-stack` deja de enviar a Telegram por su cuenta. Las únicas familias que siguen avisando lo hacen por un ingest firmado e idempotente del hub, que decide y formatea. El fallback directo de la copia queda limitado a `backup-failed`. El histórico de 30 días (host y contenedor) se sirve desde rollups con un presupuesto medido sobre 500k muestras. La rotación conjunta del token del bot (y del secreto HMAC) queda documentada y probada en producción. Una guarda impide que vuelva a aparecer un camino de envío que se salte la política.

Requisitos: SEC-05, SEC-06, CONT-02, PERF-01, PERF-02.

</domain>

<decisions>
## Implementation Decisions

### Destino de cada familia tras el apagado
- **D-01:** upgrade-script (`scripts/upgrade.sh`) y merged-updates (`scripts/merged_updates.py`) dejan de enviar a Telegram. Los fallos los cubren `deploy-failed` y `release-retained`, que el hub ya abre desde el snapshot. Las releases aplicadas con éxito no avisan: se ven en Despliegues, sin línea en el digest.
- **D-02:** security-updater y security-monitor dejan de enviar a Telegram, sin sustituto: ni incidencia ni línea en el digest. Las revisiones manuales siguen visibles en Mantenimiento, que el hub lee del agente.
- **D-03:** WUD pierde su trigger de Telegram (`WUD_TRIGGER_TELEGRAM_*` en `stacks/monitoring/compose.yaml`) sin sustituto. Solo queda la UI de WUD.
- **D-04:** issue-automator (`stacks/extras/issue-automator/main.py`) pasa al ingest con disposición **inmediata**. El hub decide y envía.
- **D-05:** Cada issue de Seerr es una incidencia con ciclo de vida. Se abre con `ISSUE_CREATED` y se cierra cuando el issue se cierra en Seerr: issue-automator publica también el evento de resolución y el hub edita el mensaje original en vez de enviar otro. La identidad es estable por issue de Seerr, así que un reintento del mismo evento no abre otra incidencia.
- **D-06:** La familia `smart` de Telegram (emisor sin identificar en la auditoría de la fase 1) se localiza y se apaga. La cubre el hub: si el hub aún no abre incidencia por un disco SMART en mal estado a partir del snapshot del agente, se añade esa clave con su disposición de política.
- **D-07:** Por las decisiones anteriores, el ingest solo tiene dos productores: issue-automator y la copia (`stacks/backup/media-backup.sh`). Ninguna otra familia publica en el ingest.

### Ritmo del cutover
- **D-08:** El apagado se hace todo de golpe, en un solo despliegue de `media-stack`, cuando el ingest del hub ya está en producción y probado. No hay observación entre familias. — **Reversibility:** reversible — el despliegue es un release de media-stack y se puede revertir.
- **D-09:** Para aceptar el cutover, cada familia con ingest (issue-automator al abrir y al cerrar, y la copia) recibe un evento firmado de prueba, y se comprueba en el hub la incidencia y su mensaje. En las familias que solo se apagan, se comprueba que el emisor ya no tiene token ni trigger de Telegram.
- **D-10:** La vuelta atrás es revertir el commit de `media-stack`. Sin flags por familia ni código de doble camino.
- **D-11:** El usuario despliega `media-stack` en el NAS con su proceso de release normal. El plan deja commits, CI verde en `media-stack` y un checklist de pasos y verificación, y el ejecutor no aplica cambios en el NAS por SSH. El orden obligatorio es: hub con ingest desplegado → eventos de prueba → release de media-stack.

### Fallback de la copia
- **D-12:** Cuando falla una copia, `media-backup.sh` publica el evento en el ingest y hace hasta 3 intentos en unos 2 minutos. Solo si ninguno recibe confirmación (2xx del ingest) envía directo a Telegram. La confirmación del ingest es el contrato; la salud genérica del hub no cuenta.
- **D-13:** El fallback solo envía `backup-failed`, nunca el éxito ni otras familias.
- **D-14:** El aviso directo lleva un prefijo visible y un texto fijo que lo distinguen de los avisos del hub, por ejemplo «Aviso directo de media-stack: el hub no confirmó», más el host y la hora. Usa el mismo bot que el hub, no un segundo bot.
- **D-15:** Se acepta el duplicado conocido de la copia: si el hub estaba caído o confirmó tarde, al volver puede abrir la misma incidencia. Hay que documentarlo; no es un defecto.

### Rotación del token y del secreto
- **D-16:** La rotación conjunta del token del bot se documenta en un runbook y se prueba con una **rotación real en producción**: revocar el token en BotFather, actualizar el `.env` del hub y el de `media-stack`, reiniciar lo necesario y verificar con un aviso de prueba por cada camino (hub → Telegram y fallback de copia → Telegram). — **Reversibility:** one-way — revocar un token en BotFather lo invalida para siempre; si se olvida un `.env`, ese camino queda mudo hasta que se corrija.
- **D-17:** El secreto HMAC del ingest (`NOTIFY_INGEST_SECRET` según research) entra en el mismo runbook. Durante la rotación, el hub acepta el secreto actual y el anterior, así que no se pierde ningún evento. Cuando ambos lados usan el nuevo, el anterior se retira.

### Rollups y retención
- **D-18:** Los rangos 7d y 30d se leen de un rollup de 15 min. 30d reagrega esos cubos a 1 h. Los rangos 1h, 6h y 24h siguen leyendo las muestras crudas con sus cubos actuales (30 s, 1 min y 2 min).
- **D-19:** El historial por contenedor (`container-history`) sigue la misma política, con un rollup por (host, contenedor).
- **D-20:** Las muestras crudas (`samples`) se retienen 48 h y los rollups 30 días. Antes de acortar la retención de crudas, hay que poblar los rollups con el histórico existente para que 7d y 30d no queden vacíos tras el despliegue. — **Reversibility:** one-way — las muestras crudas de más de 48 h que se borren no se recuperan; solo queda su agregado.
- **D-21:** Presupuesto del overview: p95 < 150 ms en servidor con 500k muestras sembradas en PostgreSQL real, para la consulta completa del overview con rango 30d. Se mide en una prueba repetible.

### Consolidación de `notify()`
- **D-22:** `notify()` ya se retiró en la fase 2 (commit `4d15f3f`). Para el criterio 5 falta una guarda (test o lint) que falle si un envío a Telegram o Web Push nace fuera de `notification-dispatch.ts` y `digest-runs.ts` (y de la prueba de push del worker, si aplica).

### Claude's Discretion
- La forma exacta del contrato de ingest (campos, versión y códigos de respuesta) dentro de lo que fija research: `POST /api/notifications/ingest`, HMAC, ventana de 5 min, idempotencia por `source:eventId` y respuesta 202.
- Cómo llega `media-stack` al hub: la URL por Tailscale y dónde se configura en `.env`.
- El backoff exacto de los 3 intentos de la copia dentro de unos 2 minutos.
- El esquema de las tablas de rollup, el momento de agregar (worker, en cada ciclo de limpieza o al cerrar cada cubo) y la caché del overview, siempre que cumplan D-18 a D-21.
- La retención de `ingest_events`. Research propone 30 días.
- El texto exacto del prefijo del fallback, en español.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Política y orden de apagado
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` §«Orden de apagado» (alrededor de la línea 276): los cinco pasos, la copia estrechada y los emisores issue-automator y SMART que se dejaron para esta fase.
- `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json`: `policy` y `shutdown_order` como contrato de datos.

### Ingest y fallback
- `.planning/research/ARCHITECTURE.md`: decisión 1 (el hub decide y envía), §«Ingest de `media-stack` y fallback» (alrededor de la línea 686), tabla `ingest_events` (alrededor de la línea 307), variables `NOTIFY_INGEST_SECRET` (alrededor de la línea 438), modos de fallo (líneas 149–151) y retención (alrededor de la línea 713).
- `.planning/research/FEATURES.md`: el emisor de media-stack pasa al ingest (línea 28) y la tabla de claves con `backup-failed` (línea 186).
- `.planning/research/PITFALLS.md` #24: por qué la copia conserva el fallback.
- `.planning/research/STACK.md` (alrededor de la línea 573): un ingest estrecho y autenticado, sin duplicar el formateo.

### Requisitos
- `.planning/REQUIREMENTS.md`: SEC-05, SEC-06, CONT-02, PERF-01 y PERF-02.
- `.planning/ROADMAP.md` §«Phase 8»: los criterios de éxito 1–5.

### Repositorio `media-stack` (`../media-stack`)
- `../media-stack/stacks/backup/media-backup.sh` (envío en las líneas 138–145) y `../media-stack/stacks/backup/compose.yaml`
- `../media-stack/stacks/extras/issue-automator/main.py` y `../media-stack/stacks/extras/compose.yaml`
- `../media-stack/stacks/monitoring/compose.yaml`: WUD (líneas 92–96) y security-monitor
- `../media-stack/stacks/monitoring/security-monitor/main.py`
- `../media-stack/scripts/upgrade.sh` (líneas 38–49) y `../media-stack/scripts/merged_updates.py`
- `../media-stack/AGENTS.md`: convenciones, tests y CI propios del repositorio.

### Hub
- `.planning/codebase/CONCERNS.md`: consultas de histórico y rendimiento.
- `CODING_STANDARD.md`: reglas de tests y del texto visible para el usuario.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/notification-dispatch.ts`: el único despachador de incidencias (Telegram, Web Push y respuestas). Un evento del ingest debe acabar como incidencia por el mismo camino y nunca enviar directamente.
- `src/lib/incident-store.ts`: la persistencia transaccional de incidencias (fingerprint, timeline y seq). Es la frontera para abrir y cerrar las incidencias de issue-automator y de la copia.
- `src/lib/notification-policy.ts`: el mapa de claves (`backup-failed`, `deploy-failed`, `release-retained`…). Ahí se añaden la clave de issue de Seerr (inmediata) y, si falta, la de SMART.
- `src/lib/request-body.ts`: lectura acotada del cuerpo, de la fase 6. La reutiliza la ruta del ingest, que además necesita el cuerpo crudo para el HMAC.
- `src/lib/sensitive-actions.ts`: el manifiesto de rutas. La ruta nueva del ingest tiene que declararse ahí, porque un test falla con una ruta POST sin declarar.
- `src/lib/runtime-config.ts`: la validación de configuración obligatoria al arrancar (SEC-03). Ahí van el secreto HMAC y el secreto anterior opcional.
- `src/lib/telegram-handoff-client.ts` y la subclave HMAC de la fase 7 (P-01) como precedente de HMAC en el hub.

### Established Patterns
- Las migraciones son reversibles y se prueban sembrando la versión anterior (fases 2 y 5).
- La limpieza se hace en el ciclo `cleanup` del worker (`src/worker.ts` alrededor de la línea 165). Hoy borra `samples` con más de 30 días, y ahí cambiará a 48 h y se añadirá la retención de los rollups.
- El histórico se agrega hoy en `src/app/api/[...path]/route.ts`: rangos en las líneas 93–99, overview alrededor de la línea 484 y `container-history` alrededor de la línea 536, con `date_bin` sobre el JSONB de `samples`.
- Los tests no se acoplan al copy (`CODING_STANDARD.md`).
- `media-stack` tiene commits, tests (`tests/*.test.sh`) y CI propios; el hub no lo despliega.

### Integration Points
- La ruta nueva `POST /api/notifications/ingest` vive fuera del catch-all de sesión: no lleva cookie y se autentica por HMAC.
- `samples` (`src/lib/schema.ts:108`) con los índices `samples_host_at_idx`, más las tablas nuevas de rollup y de `ingest_events`.
- Los `.env` de `media-stack` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` y los nuevos URL y secreto del ingest) y el `.env` del hub en `webs:/opt/nas-dashboard`.

</code_context>

<specifics>
## Specific Ideas

- El aviso directo de la copia tiene que leerse como algo distinto del hub, por ejemplo «Aviso directo de media-stack: el hub no confirmó», con el host y la hora.
- La prueba de rotación es real, no un ensayo. El runbook tiene que bastar para repetirla.
- Todo el apagado de `media-stack` en un solo release, una vez probado el ingest.

</specifics>

<deferred>
## Deferred Ideas

- Recuento de actualizaciones de WUD en el digest: descartado por ahora, si se quiere más adelante sería otra fase.
- Revisiones de seguridad de media-stack como incidencia o línea del digest: descartado (D-02). Si se echan de menos, sería una capacidad nueva.
- Backlog 999.1, un emoticono por tipo de mensaje del bot: sigue en el backlog y no se discutió en esta fase.

</deferred>

---

*Phase: 08-cutover-de-media-stack-y-consolidaci-n*
*Context gathered: 2026-11-27*
