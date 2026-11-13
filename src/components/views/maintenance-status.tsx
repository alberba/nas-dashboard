"use client";
import { bytes } from "@/lib/format";
import type { MaintenanceUnit } from "@/lib/maintenance";
import {
  automationRows,
  failedUnitGroups,
  statusCells,
  type StatusCells,
  type StatusTone,
} from "@/lib/maintenance-status";
import { Panel, StatusDot } from "../ui";
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

const unitStates: Record<
  MaintenanceUnit["state"],
  { label: string; tone: StatusTone }
> = {
  active: { label: "Activo", tone: "gain" },
  paused: { label: "Pausado", tone: "peach" },
  inactive: { label: "Detenido", tone: "muted" },
  failed: { label: "Fallo", tone: "loss" },
};

/**
 * Estado strip of Mantenimiento plus the host's automations and failed
 * systemd units, from one cached snapshot of the selected host.
 */
export function MaintenanceSnapshotStatus({
  vpn,
}: {
  vpn?: "healthy" | "unhealthy" | "starting" | "none";
}) {
  const { phase, snapshot, stale } = useMaintenanceSnapshot();
  const nowMs = (snapshot?.timestamp ?? 0) * 1000;
  const cells = snapshot ? statusCells(snapshot) : null;
  const readAt = snapshot
    ? new Date(nowMs).toLocaleTimeString("es", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

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
          (segment) => (
            <div
              className="strip-segment"
              key={segment.id}
              data-segment={segment.id}
              data-state={segment.state}
            >
              <span className="strip-label">{segment.label}</span>
              <span className="strip-value">
                {cells && <StatusDot tone={segment.tone} />}
                {segment.value}
              </span>
              {segment.detail && (
                <span className="strip-detail">{segment.detail}</span>
              )}
            </div>
          ),
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
        </p>
      )}
      {snapshot && <Automations snapshot={snapshot} nowMs={nowMs} />}
    </div>
  );
}

function Automations({
  snapshot,
  nowMs,
}: {
  snapshot: NonNullable<ReturnType<typeof useMaintenanceSnapshot>["snapshot"]>;
  nowMs: number;
}) {
  const automations = automationRows(snapshot);
  const failed = failedUnitGroups(snapshot);
  return (
    <Panel
      id="automations-title"
      title="Automatismos"
      count={automations.available ? automations.items.length : undefined}
    >
      <div className={styles.body}>
        <div className={styles.cell} data-automations="">
          {!automations.available ? (
            <p className={styles.empty} data-empty="absent">
              {NO_DATA}
            </p>
          ) : !automations.items.length ? (
            <p className={styles.empty} data-empty="none">
              Este host no tiene automatismos.
            </p>
          ) : (
            <ul className={styles.list}>
              {automations.items.map((unit) => {
                const { label, tone } = unitStates[unit.state];
                const last = relative(unit.lastRun, nowMs);
                const next = relative(unit.nextRun, nowMs);
                return (
                  <li
                    key={unit.name}
                    className={styles.row}
                    data-unit={unit.name}
                    data-kind={unit.kind}
                    data-state={unit.state}
                  >
                    <span className={styles.name}>
                      <StatusDot tone={tone} />
                      <strong>{unit.name}</strong>
                    </span>
                    <span className={`${styles.state} ${tone}`}>{label}</span>
                    <span className={styles.meta}>
                      {[last && `última ${last}`, next && `próxima ${next}`]
                        .filter(Boolean)
                        .join(" · ") || "sin ejecuciones"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className={styles.cell} data-failed-units="">
          <h3 className={styles.subhead}>Unidades fallidas</h3>
          {!failed.available ? (
            <p className={styles.empty} data-empty="absent">
              {NO_DATA}
            </p>
          ) : (
            <>
              <FailedGroup
                id="stack"
                title="Del stack"
                tone="loss"
                units={failed.stack}
                none="Ninguna."
              />
              <FailedGroup
                id="other"
                title="Ajenas al stack"
                tone="muted"
                units={failed.other}
                none="Ninguna."
              />
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

function FailedGroup({
  id,
  title,
  tone,
  units,
  none,
}: {
  id: "stack" | "other";
  title: string;
  tone: StatusTone;
  units: { name: string; description: string | null }[];
  none: string;
}) {
  return (
    <section
      className={styles.group}
      data-failed-group={id}
      data-count={units.length}
      aria-label={title}
    >
      <h4 className={styles.groupHead}>
        {title}
        <span className={styles.groupCount}>{units.length}</span>
      </h4>
      {units.length ? (
        <ul className={styles.list}>
          {units.map((unit) => (
            <li
              key={unit.name}
              className={styles.row}
              data-failed-unit={unit.name}
            >
              <span className={styles.name}>
                <StatusDot tone={tone} />
                <strong>{unit.name}</strong>
              </span>
              {unit.description && (
                <span className={styles.meta}>{unit.description}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{none}</p>
      )}
    </section>
  );
}
