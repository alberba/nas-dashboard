# Fase 03 · Corrección de los gaps de verificación

Las tres sondas de [03-VERIFICATION.md](03-VERIFICATION.md) se reprodujeron como pruebas automatizadas sobre la verificación registrada en `ed40dfb`. Cada prueba falló antes de su arreglo y pasó después.

| Gap | Sonda y resultado antes del arreglo | Arreglo y evidencia posterior | Commit |
|---|---|---|---|
| A · D-04, criterio 2, INCD-09 | En la primera respuesta tras la caída, un inventario anterior al episodio omite un contenedor vigilado. La fila cambiaba de `host-unreachable` a `container-absent`, perdía el ID del grupo y avanzaba de secuencia 2 a 3. | El colector aplica el límite de frescura del último episodio de conexión antes de reconciliar el inventario. El filtro cubre ausencia, transferencia y cierre. La prueba comprueba que la fila sigue abierta, con el ID del grupo, `host-unreachable` y secuencia 2. La primera lista posterior sí deja la ausencia pendiente con secuencia 3. [Regresión](../../../tests/collector-alerts.test.ts#L2276) | `8be6089` |
| B · D-05/D-06, INCD-10 | Con 60 000 ms acreditados, el colector recibe una lista válida sin marca en el segundo 90 y una lista fechada en el 95, con reloj inyectado y sin fallo intermedio. La segunda lectura llevaba el total a 95 000 ms. | La muestra sin marca corta la continuidad de la ausencia dentro de la mutación de ajustes. La siguiente lista fechada arranca una cadena nueva y conserva los 60 000 ms. [Regresión](../../../tests/collector-alerts.test.ts#L920) | `6c6911d` |
| C · D-09/D-12, criterio 4, CONT-04 | El Docker falso captura una lista vacía y, antes de devolverla, registra dos fallos de DELETE para un segundo ID. El barrido borraba ambos pendientes y devolvía `clean`. | El barrido toma la revisión de fallos antes del GET. Bajo el bloqueo del registro, el inventario solo acredita ausencias de fallos cubiertos por esa revisión. `clean` exige que la última revisión cubierta coincida con la actual y que el registro esté sin pendientes. La prueba conserva el segundo ID y su estado persistente, y comprueba el resultado del barrido y el estado publicado. [Regresión](../../../agent/test_maintenance.py#L1205) | `4f52864` |

## Suites

| Comando | Resultado |
|---|---|
| `DATABASE_URL=postgresql://hub:hub@127.0.0.1:55432/hub HUB_REQUIRE_TEST_DB=1 pnpm test` | 484 aprobadas en 41 archivos, con PostgreSQL obligatorio. |
| `pnpm typecheck` | Salida 0. |
| `pnpm build` | Salida 0. |
| `python3 -m unittest discover -s agent -p 'test_maintenance.py'` | 49 aprobadas. |
| `pnpm test:agent` | 204 casos, 202 aprobados y 2 omitidos por requerir `renameat2` de Linux. El flake preexistente de `test_env_settings` con `.env.lock` quedó sin reproducir. |
| `CI=1 pnpm test:e2e tests/e2e/incidents.spec.ts tests/e2e/maintenance.spec.ts tests/e2e/maintenance-status.spec.ts` | 21 de 21 aprobadas. |

## Residuales

Siguen como comprobaciones de despliegue la prueba con Docker desechable y la lectura manual de estados descritas en la verificación original. También siguen vigentes los residuales aceptados sobre reinicios con respuesta perdida y ayudantes históricos sin etiquetas.
