"use client";
import type { ReactNode } from "react";
import { MergeControl } from "./deployment-details";
import { ExternalLink } from "lucide-react";
import type { PrRow, PrStatus } from "@/lib/renovate-view";
import { prRows } from "@/lib/renovate-view";
import type { RenovateCi, RenovateUpdateType } from "@/lib/types";
import { Panel, type Tone } from "../ui";
import styles from "./renovate-panel.module.css";
import { useRenovate } from "./use-renovate";

const typeLabels: Record<RenovateUpdateType, string> = {
  major: "major",
  minor: "minor",
  patch: "patch",
  digest: "digest",
  pin: "pin",
  unknown: "sin clasificar",
};
const typeTones: Record<RenovateUpdateType, Tone> = {
  major: "loss",
  minor: "peach",
  patch: "muted",
  digest: "muted",
  pin: "lilac",
  unknown: "muted",
};
const ciLabels: Record<RenovateCi, string> = {
  success: "CI correcto",
  pending: "CI en curso",
  failure: "CI falla",
  none: "Sin comprobaciones",
};
const ciTones: Record<RenovateCi, Tone> = {
  success: "gain",
  pending: "accent",
  failure: "loss",
  none: "muted",
};
const statusLabels: Record<PrStatus, string> = {
  automerge: "automerge",
  waiting: "esperando merge",
  draft: "borrador",
};

/**
 * Renovate pull requests as a table for Mantenimiento · Despliegues. Renders
 * nothing when the hub has no GitHub token: the section is simply hidden.
 */
export function RenovatePanel() {
  const { phase, overview, stale, hostId } = useRenovate();
  if (phase === "ready" && !overview?.enabled) return null;
  const rows = prRows(overview, hostId);
  return (
    <Panel
      id="renovate-title"
      title="Propuestas abiertas en el repositorio"
      count={phase === "ready" ? rows.length : undefined}
      tools={
        stale ? (
          <span className={styles.note} data-renovate-stale="">
            Sin actualizar · datos anteriores
          </span>
        ) : undefined
      }
    >
      <div
        data-renovate-panel=""
        data-phase={phase}
        data-stale={stale || undefined}
      >
        {phase === "loading" && <p className={styles.empty}>Cargando…</p>}
        {phase === "error" && (
          <p className={styles.empty} data-renovate-error="">
            No se han podido leer las PR de Renovate.
          </p>
        )}
        {phase === "ready" &&
          (rows.length ? (
            <div className="table-scroll">
              <table className={`data-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th scope="col">PR</th>
                    <th scope="col">Servicios</th>
                    <th scope="col">Tipo</th>
                    <th scope="col">CI</th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row
                      key={row.number}
                      row={row}
                      control={
                        overview?.prs.find((p) => p.number === row.number) ? (
                          <MergeControl
                            pr={overview.prs.find(
                              (p) => p.number === row.number,
                            )!}
                          />
                        ) : null
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty} data-renovate-empty="">
              No hay propuestas de imágenes Compose reconocidas. Las fusionadas recientemente aparecen en el progreso.
            </p>
          ))}
      </div>
    </Panel>
  );
}

function Row({ row, control }: { row: PrRow; control: ReactNode }) {
  return (
    <tr
      data-renovate-pr={row.number}
      data-type={row.type}
      data-ci={row.ci}
      data-status={row.status}
      data-requires-worker={row.requiresWorker || undefined}
    >
      <td className={styles.pr}>
        <a href={row.url} target="_blank" rel="noreferrer">
          <strong>#{row.number}</strong>
          <ExternalLink aria-hidden="true" />
          <span className="sr-only">Abrir en GitHub</span>
        </a>
        <span className={styles.title} title={row.title}>
          {row.title}
        </span>
      </td>
      <td>
        <ul className={styles.services}>
          {row.services.map((u) => (
            <li key={`${u.file}:${u.service}`} data-service={u.service}>
              <strong>{u.service}</strong>
              <span className="mono soft">
                {u.from} → {u.to}
              </span>
            </li>
          ))}
        </ul>
        {row.containers.length > 0 && (
          <span className={styles.hostline} data-renovate-containers="">
            {row.projects.join(", ")} ·{" "}
            {row.containers.map((c) => c.name).join(", ")}
          </span>
        )}
      </td>
      <td>
        <span className={styles.tag} data-tone={typeTones[row.type]}>
          {typeLabels[row.type]}
        </span>
      </td>
      <td>
        <span className={styles.state} data-tone={ciTones[row.ci]}>
          <i aria-hidden="true" />
          {ciLabels[row.ci]}
        </span>
      </td>
      <td>
        <div className={styles.tags}>
          <span
            className={styles.tag}
            data-tone={row.status === "automerge" ? "accent" : "muted"}
          >
            {statusLabels[row.status]}
          </span>
          {row.requiresWorker && (
            <span className={styles.tag} data-tone="peach" data-worker="">
              requiere Worker
            </span>
          )}
        </div>
        {control}
      </td>
    </tr>
  );
}
