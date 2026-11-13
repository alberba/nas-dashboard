"use client";
import { Fragment, useState } from "react";
import type {
  DeploymentsResponse,
  DeploymentsRetained,
} from "@/lib/deployments";
import type { DeployProgressOverview, RenovatePullRequest } from "@/lib/types";
import { progressLabel, stepLabels } from "@/lib/maintenance-ui";
import { useHostScope } from "../host-context";
import { useSensitiveAction } from "../sensitive-action/sensitive-action";
import { Panel, StatusStrip } from "../ui";
import { useMaintenanceSnapshot } from "./use-maintenance-snapshot";
import { SecurityPanel } from "./maintenance-extras";
import { useHostRead } from "./use-host-read";
import styles from "./maintenance-extra.module.css";
const reasons: Record<string, string> = {
  "dirty-checkout": "El checkout tiene cambios sin commit",
  "missing-configuration": "Faltan ajustes",
  "release-recovery-pending": "Transacción pendiente",
  "security-recovery-pending": "Recuperación de seguridad pendiente",
  "checkout-unavailable": "Checkout no disponible",
  "missing-manifest": "Falta el manifiesto de despliegue",
  "invalid-manifest": "Manifiesto no válido",
  "previously-failed": "El intento anterior falló",
  "blocked-by-previous-release": "Bloqueada por la release anterior",
};
const refresh = () => window.dispatchEvent(new Event("maintenance-refresh"));
const shortDateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
export function MergeControl({ pr }: { pr: RenovatePullRequest }) {
  const scope = useHostScope();
  const sensitive = useSensitiveAction();
  const [deployNow, setDeployNow] = useState(false);
  return (
    <div className={styles.merge}>
      <label className={styles.note}>
        <input
          type="checkbox"
          checked={deployNow}
          onChange={(e) => setDeployNow(e.target.checked)}
          disabled={!scope.canMutate}
        />{" "}
        Desplegar después
      </label>
      <button
        className={styles.button}
        data-merge-pr={pr.number}
        disabled={!scope.canMutate || pr.ci !== "success" || pr.draft}
        onClick={() =>
          sensitive.request({
            title: `Fusionar PR #${pr.number}`,
            description: pr.title,
            consequences: [
              {
                tone: "warn",
                text: "Se fusionará por squash el SHA revisado. Esta acción no se reintenta.",
              },
              ...(pr.requiresWorker
                ? [
                    {
                      tone: "warn" as const,
                      text: "Esta actualización requiere revisar el Worker de Tdarr.",
                    },
                  ]
                : []),
            ],
            acknowledgement:
              pr.type === "major"
                ? "He leído los pasos manuales y revisado las notas de la release major"
                : undefined,
            confirmLabel: "Fusionar",
            endpoint: scope.withHost("/api/renovate/merge"),
            body: { number: pr.number, headSha: pr.headSha, deployNow },
            onSettled: refresh,
          })
        }
      >
        Fusionar
      </button>
      {sensitive.dialog}
    </div>
  );
}
export function DeploymentProgress() {
  const { data, error } = useHostRead<DeployProgressOverview>(
    "/api/renovate/progress",
  );
  if (!data?.enabled && !error) return null;
  if (data?.enabled && !data.updates.length) return null;
  return (
    <Panel title="Progreso de actualizaciones" id="deployment-progress">
      <div className={styles.body}>
        {error && <p role="status">{error}</p>}
        <ul className={styles.list}>
          {data?.updates.map((u) => (
            <li
              key={u.number}
              className={styles.row}
              data-progress-pr={u.number}
            >
              <strong>
                #{u.number} · {u.title}
              </strong>
              <span
                role="img"
                aria-label={`Paso actual: ${stepLabels[u.currentStep]}. ${progressLabel(u)}`}
                data-current-step={u.currentStep}
              >
                <span className={styles.steps}>
                  {u.steps.map((step) => (
                    <i
                      key={step.id}
                      data-state={step.state}
                      title={`${stepLabels[step.id]}: ${step.detail}`}
                    />
                  ))}
                </span>
                {progressLabel(u)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
export function ReleaseDetails({ children }: { children?: React.ReactNode }) {
  const maintenance = useMaintenanceSnapshot();
  const { data, error } = useHostRead<DeploymentsResponse>(
    "/api/deployments?lines=200",
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const snapshot = data?.deployments;
  const journal = snapshot?.journal.entries ?? [];
  const visibleJournal = journal.filter((e) =>
    `${e.unit} ${e.message}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const blocker = snapshot?.blocker;
  const followerState = maintenance.snapshot?.follower.state;
  const followerUnit = maintenance.snapshot?.units.find(
    (u) => u.kind === "follower",
  );
  const follower =
    followerState === "deploying"
      ? { value: "Desplegando", tone: "accent" as const }
      : followerState === "failed" || followerUnit?.state === "failed"
        ? { value: "Fallo", tone: "loss" as const }
        : followerUnit?.state === "paused"
          ? { value: "Pausado", tone: "peach" as const }
          : followerUnit?.state === "inactive"
            ? { value: "Detenido", tone: "muted" as const }
            : followerUnit
              ? { value: "Activo", tone: "gain" as const }
              : { value: "Sin datos", tone: "muted" as const };
  const security = maintenance.snapshot?.security;
  const securityTone = !security
    ? ("muted" as const)
    : security.pending
      ? ("accent" as const)
      : security.review.length
        ? ("peach" as const)
        : ("gain" as const);
  const lastFailed = maintenance.snapshot?.follower.failed?.release;
  return (
    <>
      <StatusStrip
        label="Estado de despliegues"
        segments={[
          {
            id: "installed",
            label: "Instalada",
            value:
              maintenance.snapshot?.follower.installed?.release ?? "Sin datos",
          },
          {
            id: "follower",
            label: "Seguidor",
            value: follower.value,
            tone: follower.tone,
            detail: snapshot
              ? blocker
                ? "con bloqueo"
                : "sin bloqueos"
              : undefined,
          },
          {
            id: "retained",
            label: "Retenidas",
            value: snapshot?.retained.length ?? "—",
            tone: snapshot?.retained.length ? "peach" : "muted",
          },
          {
            id: "security",
            label: "Seguridad",
            value: !security
              ? "—"
              : security.pending
                ? "Actualizando"
                : security.review.length
                  ? `${security.review.length} por revisar`
                  : "Al día",
            tone: securityTone,
            detail: security
              ? `${security.pins.length} ${security.pins.length === 1 ? "pin" : "pins"}`
              : undefined,
          },
          {
            id: "failed",
            label: "Último fallo",
            value: lastFailed ?? "—",
            tone: lastFailed ? "loss" : "muted",
          },
        ]}
      />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {maintenance.stale && (
        <p className={styles.note} role="status">
          No se pudo actualizar la release: se muestran los datos anteriores.
        </p>
      )}
      {snapshot?.degraded.length ? (
        <p className={styles.note}>
          Datos parciales: {snapshot.degraded.join(", ")}
        </p>
      ) : null}
      <div className="columns">
        <div className="main-column page-stack">
          {children}
          {blocker && (
            <Panel title="Bloqueos del seguidor" id="deployment-blockers">
              <div className={styles.body} data-blocker={blocker.code}>
                <strong>{reasons[blocker.code]}</strong>
                {blocker.files.length > 0 && (
                  <ul>
                    {blocker.files.map((f) => (
                      <li key={f.path} className="mono">
                        {f.from ? `${f.from} → ` : ""}
                        {f.path}
                      </li>
                    ))}
                  </ul>
                )}
                {blocker.missingSettings.join(", ")}
              </div>
            </Panel>
          )}
          <Panel title="Releases" id="releases">
            <div className="table-scroll">
              <table className={`data-table ${styles.releaseTable}`} data-releases="">
                <thead>
                  <tr>
                    <th>Release</th>
                    <th>Resultado</th>
                    <th>Fecha</th>
                    <th>Servicios</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot?.retained.map((r) => (
                    <Fragment key={r.release}>
                      <tr
                        className={
                          expanded === r.release ? styles.expanded : undefined
                        }
                        data-release={r.release}
                      >
                        <td>
                          <button
                            className={styles.button}
                            aria-expanded={expanded === r.release}
                            onClick={() =>
                              setExpanded(
                                expanded === r.release ? null : r.release,
                              )
                            }
                          >
                            {r.release}
                          </button>
                        </td>
                        <td>Retenida</td>
                        <td>{shortDateTime(r.at)}</td>
                        <td>{r.services.join(", ") || "Sin reinicios"}</td>
                      </tr>
                      {expanded === r.release && (
                        <tr className={styles.expanded}>
                          <td colSpan={4}>
                            <div className={styles.body}>
                              <strong>{reasons[r.reason] ?? r.reason}</strong>
                              {r.blockedBy && (
                                <p>Bloqueada por {r.blockedBy}</p>
                              )}
                              <ol>
                                {r.manualSteps.map((step, i) => (
                                  <li key={i}>{step}</li>
                                ))}
                              </ol>
                              {r.breaking && (
                                <p className="peach">
                                  Release major: revisa los pasos y la
                                  compatibilidad antes de continuar.
                                </p>
                              )}
                              <SettingsForm key={r.release} release={r} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {snapshot?.history.map((h, i) => (
                    <tr
                      key={`${h.release}:${i}`}
                      data-release-outcome={h.outcome}
                    >
                      <td className="mono">{h.release}</td>
                      <td className={h.outcome === "success" ? "gain" : "loss"}>
                        {h.outcome === "success"
                          ? "Correcta"
                          : "Fallida · restaurada"}
                      </td>
                      <td>{shortDateTime(h.at)}</td>
                      <td>{h.services.join(", ") || "Sin reinicios"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <div className="side-column">
          <SecurityPanel />
          <Panel title="Registro de unidades" id="unit-journal">
            <div className={styles.body}>
              {journal.length > 6 && (
                <label>
                  Filtrar registro
                  <input
                    className={styles.input}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
              )}
              <div
                className={styles.log}
                role="log"
                aria-label="Registro de unidades permitidas"
              >
                {visibleJournal.map((e, i) => (
                  <div
                    key={i}
                    className={
                      e.level === "error"
                        ? "loss"
                        : e.level === "warning"
                          ? "peach"
                          : ""
                    }
                  >
                    <time>{new Date(e.at).toLocaleTimeString("es")}</time>{" "}
                    {e.unit} · {e.message}
                  </div>
                ))}
                {!visibleJournal.length && <p>Sin registros.</p>}
              </div>
              <span className={styles.note}>Solo lectura</span>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
function SettingsForm({ release }: { release: DeploymentsRetained }) {
  const { host, canMutate, withHost } = useHostScope();
  const sensitive = useSensitiveAction();
  const [values, setValues] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState("");
  if (!release.missingSettings.length) return null;
  return (
    <form
      data-release-settings={release.release}
      onSubmit={(e) => {
        e.preventDefault();
        sensitive.request({
          title: `Guardar ajustes de ${release.release}`,
          consequences: [
            {
              tone: "ok",
              text: "Solo se añaden claves ausentes; se conserva una copia previa.",
            },
            {
              tone: "warn",
              text: "El seguidor podrá desplegar la release en su próximo ciclo.",
            },
          ],
          confirmLabel: "Guardar ajustes",
          endpoint: withHost("/api/deployments/settings"),
          body: {
            release: release.release,
            values,
            acknowledgedManualSteps: ack,
          },
          acknowledgement: release.manualSteps.length
            ? "He leído los pasos manuales"
            : undefined,
          onSettled: (outcome) => {
            setValues({});
            setResult(
              outcome.status === "pending"
                ? "Pendiente de verificar"
                : outcome.status === "succeeded"
                  ? "Guardado"
                  : "No se guardaron los ajustes",
            );
            refresh();
          },
        });
      }}
      className={styles.body}
    >
      {release.missingSettings.map((name) => (
        <label key={name}>
          <span className="mono">{name}</span>
          <input
            required
            autoComplete="off"
            className={styles.input}
            name={name}
            type={release.secretSettings.includes(name) ? "password" : "text"}
            value={values[name] ?? ""}
            onChange={(e) => setValues({ ...values, [name]: e.target.value })}
          />
          <span className={styles.note}>
            Se escribe en .env y no se vuelve a mostrar.
          </span>
        </label>
      ))}
      {release.manualSteps.length > 0 && (
        <label>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />{" "}
          He leído los pasos manuales
        </label>
      )}
      <button
        className={styles.button}
        disabled={
          !canMutate ||
          host?.role !== "instance" ||
          (release.manualSteps.length > 0 && !ack)
        }
      >
        Guardar ajustes
      </button>
      <p role="status">{result}</p>
      {sensitive.dialog}
    </form>
  );
}
