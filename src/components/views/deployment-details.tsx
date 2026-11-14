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
import { SecurityReview, SecurityPins } from "./security-review";
import { maintenanceDate } from "@/lib/security-review";
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
export function MergeControl({ pr }: { pr: RenovatePullRequest }) {
  const scope = useHostScope();
  const sensitive = useSensitiveAction();
  const [deployNow, setDeployNow] = useState(false);
  return (
    <div>
      <label className={styles.note}>
        <input
          type="checkbox"
          checked={deployNow}
          onChange={(e) => setDeployNow(e.target.checked)}
          disabled={!scope.canMutate}
        />{" "}
        Comprobar releases tras fusionar
      </label>
      <p className={styles.note}>El ciclo puede terminar antes de que CI publique la nueva release.</p>
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
            confirmLabel: "Merge",
            endpoint: scope.withHost("/api/renovate/merge"),
            body: { number: pr.number, headSha: pr.headSha, deployNow },
            onSettled: refresh,
          })
        }
      >
        Merge
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
  return (
    <Panel title="Progreso de actualizaciones" id="deployment-progress">
      <div className={styles.body}>
        {error && <p role="status">{error}</p>}
        <p className={styles.note}>PR del repositorio, incluidas las fusionadas en las últimas 48 horas. La instalación se registra por host; no confirma por sí sola la salud actual.</p>
        <ul className={styles.list}>
          {data?.updates.map((u) => (
            <li
              key={u.number}
              className={styles.row}
              data-progress-pr={u.number}
            >
              <div>
                <strong>{u.updates.map((update) => update.service).join(", ") || `PR #${u.number}`}</strong>
                <div className={styles.note}>{u.updates.map((update) => `${update.from} → ${update.to}`).join(" · ")}</div>
                <a href={u.url} target="_blank" rel="noreferrer" className={styles.note}>#{u.number} · {u.title}</a>
              </div>
              <span
                role="img"
                aria-label={`Paso actual: ${u.currentStep === "health" ? "Salud" : stepLabels[u.currentStep]}. ${u.currentStep === "health" && !u.failed ? "Salud sin confirmar" : progressLabel(u)}`}
                data-current-step={u.currentStep}
              >
                <span className={styles.namedSteps}>
                  {u.steps.map((step) => (
                    <span key={step.id} data-state={step.id === "health" && step.state === "done" ? "pending" : step.state}>
                      {step.id === "health" ? "Salud" : stepLabels[step.id]} · {step.id === "health" && step.state === "done" ? "Sin confirmar" : step.detail}
                    </span>
                  ))}
                </span>
                {u.currentStep === "health" && !u.failed ? "Salud sin confirmar" : progressLabel(u)}
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
  const unit = maintenance.snapshot?.units.find((u) => u.kind === "follower");
  const partial = !!error || !snapshot?.available || !!snapshot.degraded.length;
  const maintenancePartial = maintenance.stale || !!maintenance.snapshot?.degraded.length;
  const unitLabels = { active: "Activo", paused: "Pausado", inactive: "Inactivo", failed: "Fallo" };
  return (
    <>
      <StatusStrip
        label="Estado de despliegues"
        segments={[
          {
            id: "installed",
            label: "Plantilla registrada",
            value:
              maintenance.snapshot?.follower.installed?.release ?? "Sin datos",
            detail: maintenance.snapshot?.follower.installed?.bootstrap
              ? "Base inicial registrada; despliegue sin verificar"
              : maintenancePartial ? "Datos anteriores o parciales" : maintenanceDate(maintenance.snapshot?.follower.installed?.installedAt ?? null),
          },
          {
            id: "follower",
            label: "Despliegue automático",
            value: unit ? unitLabels[unit.state] : "Sin confirmar",
            detail: maintenancePartial ? "Datos anteriores o parciales" : unit?.nextRun ? `Próxima: ${maintenanceDate(unit.nextRun)}` : "Programación sin confirmar",
          },
          {
            id: "retained",
            label: "Releases bloqueadas",
            value: partial ? "Sin confirmar" : snapshot.retained.length,
            detail: "Según los tags locales del host",
            tone: snapshot?.retained.length ? "peach" : "muted",
          },
          {
            id: "security",
            label: "Comparaciones de seguridad",
            value: maintenance.snapshot?.degraded.includes("security") ? "Sin datos" : maintenance.snapshot?.security.review.length ?? "Sin datos",
            detail: maintenance.stale ? "Datos anteriores · vigencia sin confirmar" : "Vigencia sin confirmar",
            tone: "peach",
          },
          {
            id: "pins",
            label: "Versiones fijadas",
            value: maintenance.snapshot?.degraded.includes("security") ? "Sin datos" : maintenance.snapshot?.security.pins.length ?? "Sin datos",
            detail: maintenance.stale ? "Datos anteriores" : "Imágenes que sustituyen a la Plantilla",
          },
        ]}
      />
      <div className="page-stack">
          {(error || snapshot?.blocker || snapshot?.degraded.length) ? <Panel title="Bloqueos del despliegue automático" id="deployment-blockers">
            <div
              className={styles.body}
              data-blocker={snapshot?.blocker?.code ?? "none"}
            >
              {error && <p role="alert">{error}</p>}
              {snapshot?.degraded.length ? (
                <p className={styles.note}>
                  Datos parciales: {snapshot.degraded.join(", ")}
                </p>
              ) : null}
              {snapshot?.blocker ? (
                <>
                  <strong>{reasons[snapshot.blocker.code]}</strong>
                  <ul>
                    {snapshot.blocker.files.map((f) => (
                      <li key={f.path} className="mono">
                        {f.from ? `${f.from} → ` : ""}
                        {f.path}
                      </li>
                    ))}
                  </ul>
                  {snapshot.blocker.missingSettings.join(", ")}
                </>
              ) : (
                <span>
                  {snapshot ? "Sin bloqueos detectados" : "Esperando datos"}
                </span>
              )}
            </div>
          </Panel> : null}
          <SecurityReview />
          <details className={styles.activity} open={!!snapshot?.retained.length} data-deployment-activity="">
            <summary>Actividad y despliegues anteriores{snapshot?.retained.length ? ` · ${snapshot.retained.length} releases bloqueadas` : ""}</summary>
            <div className={`${styles.body} page-stack`}>
          {children}
          <Panel title="Releases bloqueadas e historial" id="releases">
            {maintenance.snapshot?.follower.failed && <p className={styles.body}>Fallo de release registrado: {maintenance.snapshot.follower.failed.release}. Consulta el historial para comprobar si una release posterior lo ha superado.</p>}
            {error && <p className={styles.body} role="status">{error}. El historial puede estar incompleto.</p>}
            {!snapshot && <p className={styles.body} role="status">{error ? "Historial no disponible" : "Cargando historial…"}</p>}
            {snapshot && !snapshot.retained.length && !snapshot.history.length && <p className={styles.body}>No hay releases bloqueadas ni intentos en los datos recibidos.</p>}
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
                        <td>
                          {r.at ? new Date(r.at).toLocaleString("es") : "—"}
                        </td>
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
                          ? "Despliegue completado"
                          : "Fallida · restaurada"}
                      </td>
                      <td>
                        {h.at ? new Date(h.at).toLocaleString("es") : "—"}
                      </td>
                      <td>{h.services.join(", ") || "Sin reinicios"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Registro de unidades" id="unit-journal">
            <div className={styles.body}>
              <label>
                Filtrar registro
                <input
                  className={styles.input}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <div
                className={styles.log}
                role="log"
                aria-label="Registro de unidades permitidas"
              >
                {snapshot?.journal.entries
                  .filter((e) =>
                    `${e.unit} ${e.message}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((e, i) => (
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
              </div>
              <span className={styles.note}>Solo lectura</span>
            </div>
          </Panel>
            </div>
          </details>
          <SecurityPins />
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
