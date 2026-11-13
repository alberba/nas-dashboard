"use client";
import { bytes } from "@/lib/format";
import type { MaintenanceFailedUnit } from "@/lib/maintenance";
import {
  failedUnitGroups,
  statusCells,
  type StatusCells,
  type StatusTone,
} from "@/lib/maintenance-status";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { StatusDot } from "../ui";
import { useHostScope } from "../host-context";
import { routeHref } from "./routes";
import styles from "./maintenance-status.module.css";
import { useMaintenanceSnapshot } from "./use-maintenance-snapshot";

const NO_DATA = "Sin datos";

/** Spanish relative time between an ISO date and the snapshot's own clock. */
function relative(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((then - nowMs) / 1000);
  const abs = Math.abs(seconds);
  const [value, unit] =
    abs < 90
      ? [1, "min"]
      : abs < 5400
        ? [Math.round(abs / 60), "min"]
        : abs < 129_600
          ? [Math.round(abs / 3600), "h"]
          : [Math.round(abs / 86_400), "d"];
  return seconds > 0 ? `en ${value} ${unit}` : `hace ${value} ${unit}`;
}

type Segment = {
  id: keyof StatusCells;
  label: string;
  state: string;
  tone: StatusTone;
  value: React.ReactNode;
  detail?: React.ReactNode;
};

function segments(cells: StatusCells, nowMs: number): Segment[] {
  const { release, follower, security, backup, reboot, docker } = cells;
  const installedAt = relative(release.installedAt, nowMs);
  const nextRun = relative(follower.nextRun, nowMs);
  const lastRun = relative(follower.lastRun, nowMs);
  const backupAt = relative(backup.at, nowMs);
  return [
    {
      id: "release",
      label: "Release",
      ...release,
      value:
        release.state === "installed" ? (
          <span className="mono">{release.release}</span>
        ) : (
          NO_DATA
        ),
      detail:
        release.state === "installed"
          ? release.bootstrap
            ? "instalación inicial"
            : installedAt
              ? `instalada ${installedAt}`
              : undefined
          : undefined,
    },
    {
      id: "follower",
      label: "Seguidor",
      ...follower,
      value: {
        active: "Activo",
        paused: "Pausado",
        inactive: "Detenido",
        failed: "Fallo",
        deploying: "Desplegando",
        absent: NO_DATA,
      }[follower.state],
      detail:
        follower.state === "failed" && follower.failed ? (
          <>
            <span className="mono">{follower.failed}</span> fallida
          </>
        ) : follower.state === "deploying" && follower.pending ? (
          <>
            instalando <span className="mono">{follower.pending}</span>
          </>
        ) : nextRun ? (
          `próxima ${nextRun}`
        ) : lastRun ? (
          `última ${lastRun}`
        ) : undefined,
    },
    {
      id: "security",
      label: "Seguridad",
      ...security,
      value: {
        ok: "Al día",
        pending: "Actualizando",
        review: `${security.review} por revisar`,
        absent: NO_DATA,
      }[security.state],
      detail:
        security.state === "pending" && security.pendingService
          ? security.pendingService
          : security.state === "absent"
            ? undefined
            : `${security.pins} ${security.pins === 1 ? "pin" : "pins"}`,
    },
    {
      id: "backup",
      label: "Copia",
      ...backup,
      value: {
        ok: "Correcta",
        failed: "Fallida",
        unknown: NO_DATA,
        absent: NO_DATA,
      }[backup.state],
      detail: backupAt ?? undefined,
    },
    {
      id: "reboot",
      label: "Reinicio",
      ...reboot,
      value: {
        none: "No hace falta",
        required: "Pendiente",
        unavailable: "No disponible",
      }[reboot.state],
    },
    {
      id: "docker",
      label: "Docker",
      ...docker,
      value: docker.state === "ok" ? bytes(docker.size) : "No disponible",
      detail:
        docker.state === "ok" && docker.reclaimable > 0
          ? `${bytes(docker.reclaimable)} recuperables`
          : undefined,
    },
  ];
}

function placeholders(phase: "loading" | "ready" | "error"): Segment[] {
  const labels = [
    ["release", "Release"],
    ["follower", "Seguidor"],
    ["security", "Seguridad"],
    ["backup", "Copia"],
    ["reboot", "Reinicio"],
    ["docker", "Docker"],
  ] as const;
  return labels.map(([id, label]) => ({
    id,
    label,
    state: phase === "error" ? "absent" : "loading",
    tone: "muted",
    value: phase === "error" ? NO_DATA : "…",
  }));
}

/**
 * Estado strip of Mantenimiento plus a single alert when a systemd unit is
 * failing. Routine automation listings stay out of the page: the strip already
 * answers whether the host is healthy.
 */
export function MaintenanceSnapshotStatus({
  vpn,
}: {
  vpn?: "healthy" | "unhealthy" | "starting" | "none";
}) {
  const { phase, snapshot, stale } = useMaintenanceSnapshot();
  const scope = useHostScope();
  const deploymentsHref = routeHref({
    view: "maintenance",
    tab: "deployments",
    host: scope.host?.id,
  });
  const nowMs = (snapshot?.timestamp ?? 0) * 1000;
  const cells = snapshot ? statusCells(snapshot) : null;
  const readAt = snapshot
    ? new Date(nowMs).toLocaleTimeString("es", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const failed = snapshot ? failedUnitGroups(snapshot) : null;
  const failedCount = failed
    ? failed.stack.length + failed.other.length
    : 0;

  return (
    <div
      className={styles.status}
      data-maintenance-snapshot=""
      data-phase={phase}
      data-stale={stale || undefined}
    >
      <div
        className="status-strip"
        role="group"
        aria-label="Estado de mantenimiento"
        aria-busy={phase === "loading"}
      >
        {(cells ? segments(cells, nowMs) : placeholders(phase)).map(
          (segment) => {
            const linked =
              segment.id === "release" || segment.id === "security";
            const Tag = (linked ? "a" : "div") as "a" | "div";
            return (
              <Tag
                className="strip-segment"
                key={segment.id}
                data-segment={segment.id}
                data-state={segment.state}
                data-segment-link={linked || undefined}
                {...(linked ? { href: deploymentsHref } : {})}
              >
                <span className={`strip-label ${styles.labelLink}`}>
                  {segment.label}
                  {linked && (
                    <ChevronRight
                      className={styles.linkChevron}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="strip-value">
                  {cells && <StatusDot tone={segment.tone} />}
                  {segment.value}
                </span>
                {segment.detail && (
                  <span className="strip-detail">{segment.detail}</span>
                )}
              </Tag>
            );
          },
        )}
        {vpn && (
          <div className="strip-segment" data-segment="vpn">
            <span className="strip-label">VPN</span>
            <span className="strip-value">
              <StatusDot
                tone={
                  vpn === "healthy"
                    ? "gain"
                    : vpn === "unhealthy"
                      ? "loss"
                      : "muted"
                }
              />
              {vpn === "healthy"
                ? "Conectada"
                : vpn === "unhealthy"
                  ? "Falla"
                  : "Sin datos"}
            </span>
          </div>
        )}
      </div>

      {(stale || phase === "error") && (
        <p
          className={styles.note}
          role="status"
          data-snapshot-note={phase === "error" ? "error" : "stale"}
        >
          {phase === "error"
            ? "No se pudo leer el estado de mantenimiento de este host."
            : `No se pudo actualizar: se muestran los datos de las ${readAt}.`}
          <button
            type="button"
            className={`text-button ${styles.retry}`}
            onClick={() =>
              window.dispatchEvent(new Event("maintenance-refresh"))
            }
          >
            Reintentar
          </button>
        </p>
      )}
      {failed && failedCount > 0 && (
        <details className={`notice warning ${styles.failed}`} data-failed-units="">
          <summary>
            <TriangleAlert aria-hidden="true" />
            {failedCount}{" "}
            {failedCount === 1 ? "unidad fallida" : "unidades fallidas"}
            <ChevronDown className={styles.failedChevron} aria-hidden="true" />
          </summary>
          {failed.stack.length > 0 && (
            <FailedGroup
              id="stack"
              title="Del stack"
              tone="loss"
              units={failed.stack}
            />
          )}
          {failed.other.length > 0 && (
            <FailedGroup
              id="other"
              title="Ajenas al stack"
              tone="muted"
              units={failed.other}
            />
          )}
        </details>
      )}
    </div>
  );
}

function FailedGroup({
  id,
  title,
  tone,
  units,
}: {
  id: "stack" | "other";
  title: string;
  tone: StatusTone;
  units: MaintenanceFailedUnit[];
}) {
  return (
    <section
      className={styles.failedGroup}
      data-failed-group={id}
      data-count={units.length}
      aria-label={title}
    >
      <h3 className={styles.failedHead}>{title}</h3>
      <ul className={styles.failedList}>
        {units.map((unit) => (
          <li key={unit.name} data-failed-unit={unit.name}>
            <StatusDot tone={tone} />
            <strong>{unit.name}</strong>
            {unit.description && <span>{unit.description}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
