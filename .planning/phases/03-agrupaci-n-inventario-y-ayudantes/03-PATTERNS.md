# Fase 3 · Patrones del código

**Fecha** 2026-11-25

## Clasificación de archivos

La tabla identifica puntos de entrada y análogos para los tres planes. Las filas con varios archivos agrupan partes del mismo flujo.

| Plan | Punto de entrada o extensión | Rol y flujo | Análogo existente |
| --- | --- | --- | --- |
| 03-01 | `src/lib/collector.ts` | Servicio, observación periódica por host | `condition` y `collectHost` en el mismo archivo |
| 03-01 y 03-02 | `src/lib/incident-store.ts`, `src/lib/schema.ts` | Store, transiciones transaccionales | Cierre, evolución de severidad y unicidad parcial del episodio abierto |
| 03-01 y 03-03 | `src/lib/notification-policy.ts`, `src/lib/notification-dispatch.ts` | Política y entrega asíncrona | `connection`, `disk-health` y mensajes de apertura desde el outbox |
| 03-01 y 03-02 | `src/app/api/[...path]/route.ts`, `src/lib/types.ts`, `src/components/views/alerts.tsx` | API y componente, proyección autenticada | Proyección compartida del resumen y la consulta de incidencias por host e ID |
| 03-02 | `agent/server.py`, `src/lib/agent-snapshots.ts`, `src/lib/types.ts` | Agente y contrato, inventario y validación | `container_stat`, `metrics` y el esquema de contenedor |
| 03-02 | `src/lib/settings.ts`, `src/lib/lifecycle.ts`, `src/app/api/[...path]/route.ts` | Store y acciones, cambios de vigilancia por host | Inicialización y mutaciones de ajustes, arranque, parada y eliminación |
| 03-02 | `src/components/dashboard.tsx`, `src/components/views/maintenance.tsx` | Componentes, inventario | Entrega de `expectedContainers` a Mantenimiento y tablas de Docker |
| 03-03 | `agent/maintenance.py`, `agent/server.py` | Ejecución y recogida, Docker por socket Unix | `HostExecutor`, `DiskExecutor`, arranque del ayudante de reinicio y ciclo de limpieza de papelera |
| 03-03 | `src/lib/maintenance.ts`, `src/lib/agent-snapshots.ts`, `src/lib/maintenance-alerts.ts`, `src/components/views/maintenance-status.tsx` | Contrato, señal y vista, lectura de snapshot | Secciones de Mantenimiento, degradación y señales independientes |

## 03-01 · Caída y recuperación del host

- `src/lib/collector.ts:23-43`, `:59-94` y `:132-195` distinguen el reloj inyectable, los temporizadores `host.id:key` y los estados válidos. El error `NasInvalidResponse` borra ventanas sin tocar muestras o episodios. Una desconexión real se evalúa a los 60 s y un reinicio planeado pendiente tiene 5 min de gracia. Hoy la desconexión retorna sin reiniciar las ventanas de contenedor. El bucle en `:251-264` trata «ausente» y «presente detenido» como el mismo fallo de 30 s. Separar la espera de recuperación de la detección de ausencia.
- `src/lib/schema.ts:136-195` y `src/lib/incident-store.ts:255-345` modelan la identidad por host y clave, el ID persistente por episodio y la secuencia del historial. En el store, una observación de igual severidad no escribe título ni detalle. Para inhibir, reanudar o cambiar la referencia de un episodio, definir una transición o proyección explícita. El cierre existente actualiza el historial e invalida envíos pendientes o edita un mensaje confirmado. Conservarlo para evitar avisos nuevos en la recuperación.

```ts
// src/lib/incident-store.ts:261-273
return db.transaction(async (tx) => {
  const [open] = await tx
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.hostId, input.hostId),
        eq(incidents.key, input.key),
        isNull(incidents.resolvedAt),
      ),
    )
    .limit(1)
    .for("update");
```

- `src/lib/notification-policy.ts:25-41` y `:70-102` envían `connection` inmediatamente y mantienen silenciosa la familia `container:`. Si `services-down` se convierte en clave de notificación, asignarle una política explícita. El valor por defecto de una clave desconocida pertenece al resumen y puede convertirse en push con `PUSH_WARNINGS`. En `src/lib/notification-dispatch.ts:283` y `:545-550` el texto de Telegram sale de la incidencia. Comprobar ese recorrido cuando se añada el inventario al detalle visible en el hub.
- En `src/app/api/[...path]/route.ts:224-259` la lectura puntual requiere sesión, host configurado e ID. En `:309-385`, el resumen ya devuelve `latest` y `lastAt` del host. `src/lib/incident-store.ts:498-551` proyecta ambos listados. `src/components/dashboard.tsx:315-344` carga el enlace puntual y `src/components/views/alerts.tsx:118-179` expone selectores de estado para Playwright. Reutilizar la consulta puntual para enlaces antiguos, incluidos episodios fuera de las 100 incidencias recientes. La antigüedad de una lista de Docker y la de la última muestra general pueden diferir.

## 03-02 · Inventario esperado

- `agent/server.py:288-312` ya publica el ID de Docker y `compose: { project, service }` si ambos datos existen. `metrics` lista todos los contenedores, incluidos los detenidos. Renombrar con el mismo ID y reemplazar por una pareja Compose inequívoca son señales distintas. Revisar tanto la unicidad del candidato como que el mismo candidato no se asigne a dos entradas esperadas. Comparar y reasignar dentro del host.

```py
# agent/server.py:341-349
def metrics():
    global container_cache
    sample = HOST.sample(PROC, SYS, ROOTS, EXTRA_FILESYSTEMS, HOST_ROOT)
    now = sample["timestamp"]
    if now - container_cache[0] > 10:
        items = docker("GET", "/containers/json?all=true")
        active = lifecycle.active_projects(items, PROTECTED)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            container_cache = (
```

- `agent/server.py:341-361` conserva una caché de 10 s y su fecha interna. La fecha pública de la muestra procede de `HOST.sample`. El esquema de `src/lib/agent-snapshots.ts:94-149` valida los elementos de la lista en el cliente del hub. Planificar cómo acreditar inventario fresco y completo y cómo tratar un agente anterior durante el despliegue. Una lista vacía acreditada y una lista faltante, caducada o parcial tienen efectos diferentes.
- `src/lib/settings.ts:14-30` usa una fila JSONB por host y sustituye todo el documento. `src/lib/collector.ts:189-195`, `src/lib/lifecycle.ts:63-78` y `src/app/api/[...path]/route.ts:548-570,650-674` leen y escriben estos ajustes. Coordinar esas escrituras con la reconciliación para preservar altas y bajas, identidad y umbrales cuando una acción se intercale con una recolección. El bloqueo de escritor del worker no abarca el proceso de la API. Releer y aplicar el cambio bajo control transaccional o aislar el estado de reconciliación con una estrategia explícita de coherencia.
- `src/lib/incident-store.ts:64-74,261-273` deriva el fingerprint de la clave y busca el episodio por host y clave. Un cambio de nombre necesita preservar historial, ID y referencia de entrega, y definir qué ocurre si el nombre destino ya tiene un episodio abierto. Usar los cierres transaccionales existentes para purgas. Los reintentos deben respetar el plazo de 30 minutos y la intención del operador.
- `src/components/dashboard.tsx:714-724` y `src/components/views/maintenance.tsx:102-146,324-355` muestran actualmente filas solo para contenedores devueltos. Incorporar los nombres pendientes con un estado propio. Las filas de Docker existentes usan IDs reales para las acciones, por lo que una entrada pendiente requiere una presentación sin acciones de contenedor.

## 03-03 · Limpieza de ayudantes

- `agent/maintenance.py:438-541` crea, arranca, espera, lee logs y elimina ayudantes en `finally`. Tanto `HostExecutor` como `DiskExecutor` descartan actualmente los errores de eliminación. También existe una creación en `agent/server.py:416-424` para reiniciar el host, con `AutoRemove: True`. Buscar el marcador propio en los productores incluidos, preservar los que están en uso y definir cómo se tratan los ayudantes sin etiqueta de versiones previas. La imagen es compartida con el agente y por sí sola no acredita propiedad.
- `agent/server.py:538-554` tiene el precedente de un ciclo periódico daemon. Mantener las operaciones de Docker acotadas y apartadas de las lecturas HTTP. `agent/maintenance.py:397-420` tiene timeouts e interpreta errores HTTP como `OSError` sin campo de estado. Acreditar la desaparición con un 404 estructurado o un inventario exacto válido, según el cliente elegido. La clasificación de huérfanos de Compose en `agent/lifecycle.py:84-109` sirve como precedente de condiciones de elegibilidad, con un criterio de propiedad diferente para estos ayudantes.
- `agent/maintenance.py:779-787,828-858` cachea snapshots y degrada cada sección independientemente. `src/lib/maintenance.ts:139-185` ya permite secciones opcionales para agentes previos. Las lecturas deben proyectar resultados del ciclo y de los intentos de eliminación, con su estado de disponibilidad, sin contabilizar las lecturas como intentos. Contabilizar dos fallos atribuibles al mismo pendiente y cerrar el episodio después de constatar que ya no quedan pendientes afectados.

```ts
// src/lib/maintenance-alerts.ts:117-121
const reboot = snapshot.reboot;
if (!degraded.has("reboot") && record(reboot) && reboot.available === true) {
  if (reboot.required === true || reboot.required === false) {
    const failing = reboot.required === true;
    signals.push({
```

- `src/lib/maintenance-alerts.ts:49-75,117-157` emite señales por sección confirmada. `src/lib/collector.ts:101-129` las lleva al mismo store por host. `src/components/views/maintenance-status.tsx:174-212` proyecta datos y antigüedad del snapshot. Dar al primer fallo un estado visible en Mantenimiento y a la segunda eliminación fallida una clave estable por host. La política de resumen de esta clave requiere una rama que siga en resumen con `PUSH_WARNINGS` activado. La fase 4 consumirá esa disposición.

## Patrones compartidos y verificación

- El cliente del agente valida sus snapshots antes de que los use el colector. Conservar la validación en `src/lib/agent-snapshots.ts` y el aislamiento por host en `src/lib/collector.ts:308-320`. Las lecturas sin evidencia no cierran una condición.
- La fase 2 ofrece un precedente de migraciones y retroceso en `drizzle/0004_incidents.sql`, `scripts/rollback/0004_incidents.sql` y `scripts/migrate.ts`. Aplicar migraciones de prueba solo contra PostgreSQL local desechable. `tests/database.ts:11-34` convierte la omisión de suites por ausencia de base de datos en error con `HUB_REQUIRE_TEST_DB=1`.

| Plan | Comando con las suites existentes | Cobertura que se debe ampliar |
| --- | --- | --- |
| 03-01 | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts tests/maintenance-alerts.test.ts` | Dos hosts, reloj inyectado, desconexión real frente a respuesta inválida, gracia de reinicio, entrega única y consulta autenticada por host e ID |
| 03-02 | `HUB_REQUIRE_TEST_DB=1 pnpm test tests/collector-alerts.test.ts tests/incident-store.test.ts tests/api-incidents.test.ts tests/api-lifecycle.test.ts tests/agent-client.test.ts` | Ausencia acreditada, conservación, cambio inequívoco o ambiguo de nombre, purga y carrera con acciones del operador |
| 03-02 | `python3 -m unittest discover -s agent -p test_containers.py` y `python3 -m unittest discover -s agent -p test_metrics.py` | ID, etiquetas Compose, inventario con detenidos y frescura |
| 03-03 | `python3 -m unittest discover -s agent -p test_maintenance.py` y `pnpm test tests/api-maintenance.test.ts tests/maintenance-alerts.test.ts tests/agent-client.test.ts` | Inyección del cliente Docker, intentos, ayudantes en uso, ausencia confirmada, antigüedad, degradación y política de resumen |
| UI | `pnpm test:e2e tests/e2e/incidents.spec.ts tests/e2e/maintenance-status.spec.ts` | Selectores orientados a estado y recorrido autenticado con el entorno de Playwright del repositorio |

`pnpm typecheck`, `pnpm lint`, `pnpm test:agent` y la configuración de `.github/workflows/ci.yml` son las comprobaciones generales existentes. Las suites PostgreSQL de la tabla requieren `DATABASE_URL` de loopback, con permiso para crear bases desechables.

## Sin análogo directo

- Temporizador persistente de ausencia basado en inventario válido y reasignación inequívoca de la vigilancia. El temporizador local de `collector.ts` solo sirve de análogo para ventanas cortas sobre observaciones consecutivas.
- Recogida de ayudantes del agente con control de propiedad y exclusión de actividad. La papelera aporta la forma del ciclo y los ejecutores aportan el ciclo de vida de Docker.
