"use client";
import { useRef, useState } from "react";
import { useMaintenanceSnapshot } from "./use-maintenance-snapshot";
import type { TodayEvents } from "@/lib/events";
import type {
  HostCommand,
  HostCommandResult,
} from "@/lib/host-command-contract";
import { commandResult } from "@/lib/maintenance-ui";
import { useHostScope } from "../host-context";
import { Panel, StatusDot } from "../ui";
import { useHostRead } from "./use-host-read";
import styles from "./maintenance-extra.module.css";
export const commandLabels: Record<HostCommand, string> = {
  "deploy-now": "Desplegar ahora",
  "pause-follower": "Pausar seguidor",
  "resume-follower": "Reanudar seguidor",
  "run-security": "Ejecutar seguridad",
  "backup-now": "Copia ahora",
  "clean-images": "Limpiar imágenes",
  "check-health": "Comprobar salud",
  "reconnect-apps": "Reconectar apps",
};
export function HostCommands({ children }: { children?: React.ReactNode }) {
  const { canMutate, host, withHost, key } = useHostScope();
  const sending = useRef(false);
  const [held, setHeld] = useState<{
    key: string;
    state: string;
    detail: string;
    result?: HostCommandResult;
  }>({ key: "", state: "", detail: "" });
  const state = held.key === key ? held : null;
  async function run(command: HostCommand) {
    if (sending.current || state?.state === "pending" || !canMutate) return;
    if (
      command === "clean-images" &&
      !window.confirm(
        "Se eliminarán imágenes sin contenedor, conservando las de rollback. ¿Continuar?",
      )
    )
      return;
    sending.current = true;
    setHeld({ key, state: "executing", detail: "En curso" });
    try {
      const response = await fetch(withHost("/api/host-command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ command }),
      });
      const data = await response.json();
      const outcome = commandResult(data);
      setHeld({
        key,
        ...outcome,
        detail: response.ok
          ? outcome.detail
          : response.status >= 500 && response.status !== 503
            ? "Pendiente de verificar"
            : (data.error ?? "Operación rechazada"),
        state:
          response.status >= 500 && response.status !== 503
            ? "pending"
            : outcome.state,
        result: data.result,
      });
      window.dispatchEvent(new Event("maintenance-refresh"));
    } catch {
      setHeld({
        key,
        state: "pending",
        detail:
          "Pendiente de verificar. Comprueba el host antes de otra acción.",
      });
    } finally {
      sending.current = false;
    }
  }
  return (
    <Panel title="Acciones del host" id="host-actions">
      <div className="command-list">
        {(Object.keys(commandLabels) as HostCommand[])
          .filter(
            (c) =>
              host?.role === "instance" ||
              !["backup-now", "reconnect-apps"].includes(c),
          )
          .map((c) => (
            <button
              key={c}
              className="command"
              data-host-command={c}
              disabled={
                !canMutate ||
                state?.state === "executing" ||
                state?.state === "pending"
              }
              onClick={() => void run(c)}
            >
              {commandLabels[c]}
              {(
                {
                  "deploy-now": "D",
                  "check-health": "H",
                  "reconnect-apps": "W",
                  "backup-now": "B",
                } as Partial<Record<HostCommand, string>>
              )[c] && (
                <kbd>
                  {
                    (
                      {
                        "deploy-now": "D",
                        "check-health": "H",
                        "reconnect-apps": "W",
                        "backup-now": "B",
                      } as Partial<Record<HostCommand, string>>
                    )[c]
                  }
                </kbd>
              )}
            </button>
          ))}
        {children}
      </div>
      {state && (
        <div
          className={styles.body}
          role="status"
          data-command-state={state.state}
        >
          {state.detail}
          {state.result?.command === "check-health" && (
            <div data-vpn-state={String(state.result.health.vpn.connected)}>
              VPN:{" "}
              {state.result.health.vpn.applicable
                ? state.result.health.vpn.connected
                  ? "Conectada"
                  : "Sin conexión"
                : "No disponible"}
              <ul>
                {state.result.health.apps.map((app) => (
                  <li key={app.service ?? app.name}>
                    {app.name ?? app.service}: {app.healthy ? "sana" : "falla"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
export function DisksPanel() {
  const { snapshot, stale, phase } = useMaintenanceSnapshot();
  const error = stale || phase === "error" ? "Sin actualizar" : "";
  const disks = snapshot?.disks;
  const labels = {
    ok: "Correcto",
    watch: "Vigilar",
    fail: "Fallo",
    unknown: "Sin datos",
  };
  const tones = {
    ok: "gain",
    watch: "peach",
    fail: "loss",
    unknown: "muted",
  } as const;
  return (
    <Panel title="Discos" id="smart-disks">
      <div className={styles.body} data-smart-disks="">
        {error && <p role="status">{error}</p>}
        {!disks?.available ? (
          <p className={styles.note}>Sin datos SMART</p>
        ) : (
          <ul className={styles.list}>
            {disks.devices.map((d) => (
              <li
                key={d.device}
                className={styles.row}
                data-disk={d.device}
                data-state={d.status}
              >
                <StatusDot tone={tones[d.status]} />
                <strong>{d.model ?? d.device}</strong>
                <span>{labels[d.status]}</span>
                <span className={styles.note}>
                  {d.temperature === null ? "—" : `${d.temperature} °C`} ·{" "}
                  {d.kind === "nvme"
                    ? `desgaste ${d.wear ?? "—"} %`
                    : `reasignados ${d.reallocatedSectors ?? "—"}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
export function EventsPanel() {
  const { data, error } = useHostRead<TodayEvents>("/api/events");
  const labels = {
    deploy: "Despliegue",
    health: "Salud",
    retention: "Release retenida",
    backup: "Copia",
    security: "Seguridad",
  };
  const statuses = {
    ok: "Correcta",
    failed: "Fallida",
    pending: "Pendiente",
    info: "Información",
  };
  return (
    <Panel title="Eventos de hoy" id="today-events">
      <div className={styles.body} data-events="">
        {error && <p role="status">{error}</p>}
        {data?.degraded.length ? (
          <p className={styles.note}>
            Registro parcial: hay fuentes sin datos.
          </p>
        ) : null}
        <ul className={styles.list}>
          {data?.events.map((e) => (
            <li
              key={e.id}
              className={styles.row}
              data-event={e.kind}
              data-state={e.status}
            >
              <time>
                {new Date(e.at).toLocaleTimeString("es", {
                  timeZone: "Europe/Madrid",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <StatusDot
                tone={
                  e.status === "failed"
                    ? "loss"
                    : e.status === "ok"
                      ? "gain"
                      : "peach"
                }
              />
              <span>
                {labels[e.kind]} {e.release} · {statuses[e.status]}
              </span>
            </li>
          ))}
        </ul>
        {data && !data.events.length && (
          <p className={styles.note}>Sin eventos hoy.</p>
        )}
      </div>
    </Panel>
  );
}

export function SecurityPanel() {
  const { snapshot } = useMaintenanceSnapshot();
  return (
    <Panel title="Seguridad" id="security-details">
      <div className={styles.body}>
        <ul className={styles.list}>
          {snapshot?.security.pins.map((pin) => (
            <li
              key={pin.service}
              className={styles.row}
              data-security-pin={pin.service}
            >
              <strong>{pin.service}</strong>
              <span className="gain">pin de seguridad</span>
              <span className="mono">{pin.version ?? pin.image}</span>
            </li>
          ))}
        </ul>
        {snapshot?.security.pending && (
          <p className="accent">
            Actualizando {snapshot.security.pending.service} ·{" "}
            {snapshot.security.pending.status}
          </p>
        )}
        <ul className={styles.list}>
          {snapshot?.security.review.map((r, i) => (
            <li key={i} className={styles.row} data-security-review="">
              <strong>{r.names.join(", ")}</strong>
              <span className="peach">revisar · {r.newSevere} graves</span>
              <span className={styles.note}>{r.reason}</span>
            </li>
          ))}
        </ul>
        {!snapshot && <p>Sin datos</p>}
      </div>
    </Panel>
  );
}
