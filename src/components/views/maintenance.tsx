import type { ComponentProps } from "react";
import {
  useMaintenanceSnapshot,
  MaintenanceSnapshotProvider,
} from "./use-maintenance-snapshot";
import { Fragment, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Lock,
  Play,
  Power,
  RefreshCw,
  ScrollText,
  Square,
  TriangleAlert,
} from "lucide-react";
import {
  containerFilters,
  containerHealth,
  containerSections,
  isStoppedContainer,
  needsAttention,
  type ContainerFilterId,
  type ContainerHealth,
} from "@/lib/containers";
import type { Container, ContainerWatchPending, Metrics } from "@/lib/types";
import type { ActionRequest } from "../file-browser";
import { useHostScope } from "../host-context";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "../sensitive-action/sensitive-action";
import { FilterChips, Panel, StatusDot, type Tone } from "../ui";
import { MaintenanceSnapshotStatus } from "./maintenance-status";
import {
  HostCommands,
  DisksPanel,
  EventsPanel,
} from "./maintenance-extras";
import {
  RemoveContainerButton,
  ContainerLifecycleTag,
  useRemoveContainer,
} from "./remove-container";
import { useRenovate } from "./use-renovate";
import { containerUpdates } from "@/lib/renovate-view";
import { containerAccess, containerUpdate } from "@/lib/container-access";
import { routeHref } from "./routes";
import extraStyles from "./maintenance-extra.module.css";
import { ContainerLogsRow } from "./container-logs";
import { UpdateContainerButton, useUpdateContainer } from "./update-container";

const filterLabels: Record<ContainerFilterId, string> = {
  all: "Todos",
  problems: "Problemas",
  stopped: "Detenidos",
};
const healthLabels: Record<ContainerHealth, string> = {
  healthy: "sana",
  unhealthy: "falla",
  starting: "arrancando",
  none: "—",
};
const healthTones: Record<ContainerHealth, Tone> = {
  healthy: "gain",
  unhealthy: "loss",
  starting: "peach",
  none: "muted",
};
type ContainerFilter = ContainerFilterId | "updates";

function emptySectionMessage(
  section: "main" | "stopped",
  visible: number,
  total: number,
  filter: ContainerFilter,
) {
  if (visible > 0) return null;
  if (section === "main" && filter === "stopped")
    return total > 0
      ? "Los contenedores detenidos están en la sección inferior"
      : "No hay contenedores detenidos";
  if (total === 0)
    return section === "main"
      ? "No hay contenedores activos"
      : "No hay contenedores detenidos";
  return section === "main"
    ? "Ningún contenedor activo en este filtro"
    : "Ningún contenedor detenido en este filtro";
}

export function MaintenanceStatus(
  props: ComponentProps<typeof MaintenanceContent>,
) {
  return (
    <MaintenanceSnapshotProvider>
      <MaintenanceContent {...props} />
    </MaintenanceSnapshotProvider>
  );
}
function MaintenanceContent({
  metrics,
  expected,
  watchPending = [],
  disabled,
  request,
  appDomain,
  onSensitiveSettled,
}: {
  metrics: Metrics;
  expected: string[];
  /** Absent names still inside their 30-minute reconciliation window. */
  watchPending?: ContainerWatchPending[];
  connected: boolean;
  disabled: boolean;
  lastAt: string | null;
  request: (action: ActionRequest) => void;
  /** Base domain used to build the curated application links. */
  appDomain: string;
  /** Called when a sensitive action finishes, so the shell can refresh. */
  onSensitiveSettled?: (outcome: SensitiveActionOutcome) => void;
}) {
  const sensitive = useSensitiveAction();
  const { canReboot, withHost } = useHostScope();
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const stoppedSection = useRef<HTMLDetailsElement>(null);
  const renovate = useRenovate();
  const updates = containerUpdates(renovate.overview, renovate.hostId);
  const containers = [...metrics.containers].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const filters = [
    ...containerFilters(containers, expected),
    ...(renovate.overview?.enabled
      ? [
          {
            id: "updates" as const,
            items: containers.filter((c) => updates.has(c.id)),
          },
        ]
      : []),
  ];
  const visible = filters.find((f) => f.id === filter)?.items ?? containers;
  const sections = containerSections(visible);
  const allSections = containerSections(containers);
  const stoppedProblems = sections.stopped.filter((c) =>
    needsAttention(c, expected),
  ).length;
  const running = containers.filter((c) => c.state === "running").length;

  function selectFilter(id: ContainerFilter) {
    setFilter(id);
    if (id === "stopped" && stoppedSection.current)
      stoppedSection.current.open = true;
  }

  const mainEmpty = emptySectionMessage(
    "main",
    sections.main.length,
    allSections.main.length,
    filter,
  );
  const stoppedEmpty = emptySectionMessage(
    "stopped",
    sections.stopped.length,
    allSections.stopped.length,
    filter,
  );

  return (
    <div className="page-stack">
      <MaintenanceSnapshotStatus
        vpn={
          metrics.containers.find(
            (c) => c.composeService === "gluetun" || c.name === "gluetun",
          )
            ? containerHealth(
                metrics.containers.find(
                  (c) => c.composeService === "gluetun" || c.name === "gluetun",
                )!,
              )
            : "none"
        }
      />
      <div className="columns">
        <div className={`main-column ${extraStyles.mainStack}`}>
          <PendingWatchPanel items={watchPending} />
          <Panel
            id="containers-title"
            title="Contenedores"
            count={`${running}/${containers.length}`}
            tools={
              <FilterChips
                label="Filtrar contenedores"
                options={filters.map((f) => ({
                  id: f.id,
                  label:
                    f.id === "updates" ? "Actualizaciones" : filterLabels[f.id],
                  count: f.items.length,
                }))}
                value={filter}
                onSelect={selectFilter}
              />
            }
          >
            <ContainerTable
              table="main"
              containers={sections.main}
              expected={expected}
              disabled={disabled}
              request={request}
              appDomain={appDomain}
              updates={updates}
              empty={mainEmpty}
            />
          </Panel>
          <details
            ref={stoppedSection}
            className={`data-panel ${extraStyles.stoppedPanel}`}
            data-stopped-section=""
            data-count={sections.stopped.length}
            data-total={allSections.stopped.length}
          >
            <summary className="panel-head" data-stopped-summary="">
              <h2 id="stopped-containers-title">
                Contenedores detenidos
                <span className="panel-count">{sections.stopped.length}</span>
              </h2>
              <span className={extraStyles.stoppedTools}>
                {stoppedProblems > 0 && (
                  <span
                    className={extraStyles.stoppedProblems}
                    data-stopped-problems={stoppedProblems}
                  >
                    <TriangleAlert aria-hidden="true" />
                    {stoppedProblems} con{" "}
                    {stoppedProblems === 1 ? "problema" : "problemas"}
                  </span>
                )}
                <ChevronDown
                  className={extraStyles.stoppedChevron}
                  aria-hidden="true"
                />
              </span>
            </summary>
            <ContainerTable
              table="stopped"
              containers={sections.stopped}
              expected={expected}
              disabled={disabled}
              request={request}
              appDomain={appDomain}
              updates={updates}
              empty={stoppedEmpty}
            />
          </details>
        </div>
        <div className="side-column">
          <HostCommands>
            <button
              type="button"
              className="command danger"
              data-command="reboot"
              disabled={disabled || !canReboot}
              onClick={() =>
                sensitive.request({
                  title: "Reiniciar el NAS",
                  description:
                    "El resultado se comprobará cuando el NAS vuelva a responder.",
                  consequences: [
                    {
                      tone: "warn",
                      text: "Se interrumpirán las reproducciones y las descargas.",
                    },
                    {
                      tone: "warn",
                      text: "El acceso por NPM se corta hasta que vuelva.",
                    },
                    { tone: "ok", text: "Oracle seguirá funcionando." },
                  ],
                  confirmLabel: "Reiniciar NAS",
                  destructive: true,
                  endpoint: withHost("/api/action"),
                  body: { action: "reboot", confirmation: "REINICIAR NAS" },
                  typedConfirmation: {
                    label: "Escribe REINICIAR NAS para confirmar",
                    value: "REINICIAR NAS",
                  },
                  onSettled: onSensitiveSettled,
                })
              }
            >
              <Power />
              <span>Reiniciar NAS</span>
            </button>
          </HostCommands>
          <EventsPanel />
          <DisksPanel />
        </div>
      </div>
      {sensitive.dialog}
    </div>
  );
}

function pendingMinutes(item: ContainerWatchPending) {
  return Math.max(0, Math.floor(item.accreditedMs / 60_000));
}

/**
 * D-06: a missing name is shown as pending without inventing a Docker ID or
 * offering actions that cannot be executed. The row only states what the
 * inventory has proved so far.
 */
function PendingWatchPanel({ items }: { items: ContainerWatchPending[] }) {
  if (!items.length) return null;
  return (
    <Panel
      id="watch-pending-title"
      title="Vigilancia pendiente"
      count={`${items.length}`}
    >
      <div className="table-scroll">
        <table className="data-table" data-watch-table="">
          <thead>
            <tr>
              <th scope="col">Contenedor</th>
              <th scope="col">Estado</th>
              <th scope="col">Primera ausencia</th>
              <th scope="col" className="numeric">
                Tiempo acreditado
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.name}
                data-watch-row={item.name}
                data-watch-state="pending"
                data-watch-since={item.absentSince}
                data-watch-accredited={item.accreditedMs}
              >
                <td className="name-cell">
                  <span className="row-title">
                    <StatusDot tone="muted" />
                    <strong>{item.name}</strong>
                  </span>
                </td>
                <td data-watch-label="pending">Pendiente de reconciliar</td>
                <td>
                  <time dateTime={new Date(item.absentSince * 1000).toISOString()}>
                    {new Date(item.absentSince * 1000).toLocaleString("es")}
                  </time>
                </td>
                <td className="numeric">
                  {pendingMinutes(item)} min de 30
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ContainerTable({
  table,
  containers,
  expected,
  disabled,
  request,
  appDomain,
  updates,
  empty,
}: {
  table: "main" | "stopped";
  containers: Container[];
  expected: string[];
  disabled: boolean;
  request: (action: ActionRequest) => void;
  appDomain: string;
  updates: Map<string, { number: number; url: string }[]>;
  empty: string | null;
}) {
  const emptyState = table === "main" ? "active" : "stopped";
  return (
    <div className="table-scroll">
      <table
        className={`data-table ${extraStyles.containerTable}`}
        data-container-table={table === "main" ? "" : undefined}
        data-stopped-table={table === "stopped" ? "" : undefined}
      >
        <thead>
          <tr>
            <th scope="col">Contenedor</th>
            <th scope="col">Estado</th>
            <th scope="col">Versión</th>
            <th scope="col" className="numeric">
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {containers.map((container) => (
            <ContainerRow
              key={container.id}
              container={container}
              problem={needsAttention(container, expected)}
              disabled={disabled}
              request={request}
              appDomain={appDomain}
              updates={updates.get(container.id) ?? []}
            />
          ))}
          {!containers.length && (
            <tr className="empty-row" data-empty={emptyState}>
              <td colSpan={4}>{empty ?? "Ningún contenedor"}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function stateLabel(c: Container) {
  if (c.state === "running") return "Activo";
  if (c.state === "restarting") return "Reiniciándose";
  if (c.state === "paused") return "Pausado";
  if (c.state === "removing") return "Eliminándose";
  if (isStoppedContainer(c)) return "Detenido";
  return c.state;
}

function ContainerRow(props: {
  container: Container;
  problem: boolean;
  disabled: boolean;
  request: (action: ActionRequest) => void;
  appDomain: string;
  updates: { number: number; url: string }[];
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const { id, name } = props.container;
  return (
    <Fragment>
      <ContainerLine
        {...props}
        logsOpen={logsOpen}
        toggleLogs={() => setLogsOpen((open) => !open)}
      />
      {logsOpen && <ContainerLogsRow id={id} name={name} columns={4} />}
    </Fragment>
  );
}

function ContainerLine({
  container: c,
  problem,
  disabled,
  request,
  appDomain,
  logsOpen,
  toggleLogs,
  updates,
}: {
  container: Container;
  problem: boolean;
  disabled: boolean;
  request: (action: ActionRequest) => void;
  appDomain: string;
  logsOpen: boolean;
  toggleLogs: () => void;
  updates: { number: number; url: string }[];
}) {
  const scope = useHostScope();
  const snapshot = useMaintenanceSnapshot().snapshot;
  const imageUpdate = containerUpdate(snapshot?.containers, c.id);
  const access = containerAccess({ container: c, update: imageUpdate, appDomain });
  const updater = useUpdateContainer();
  const pin = snapshot?.security.pins.find(
    (p) => p.service === (c.composeService ?? c.compose?.service),
  );
  const health = containerHealth(c);
  const unhealthySince =
    health === "unhealthy" &&
    snapshot &&
    Number.isFinite(c.healthObservedSince)
      ? Math.max(
          0,
          Math.floor((snapshot.timestamp - c.healthObservedSince!) / 60),
        )
      : null;
  const healthLabel =
    healthLabels[health] +
    (unhealthySince === null ? "" : ` · ≥${unhealthySince} min`);
  const removal = useRemoveContainer(() =>
    window.dispatchEvent(new Event("maintenance-refresh")),
  );
  const tone: Tone = problem
    ? "loss"
    : c.state !== "running"
      ? "muted"
      : healthTones[health] === "muted"
        ? "gain"
        : healthTones[health];
  const locked = disabled || c.protected;
  const stateText = `${stateLabel(c)}${
    health === "none" ? "" : ` · ${healthLabel}`
  }`;
  const update = updates[0];
  return (
    <Fragment>
      <tr
        id={`container-${c.id}`}
        data-container={c.name}
        data-state={c.state}
        data-health={health}
        data-problem={problem || undefined}
      >
        <td className="name-cell">
          <span className="row-title">
            <StatusDot tone={tone} />
            {access.url ? (
              <a
                className={extraStyles.nameLink}
                href={access.url}
                target="_blank"
                rel="noopener noreferrer"
                title={access.url}
                data-container-link=""
              >
                <strong>{c.name}</strong>
                <ArrowUpRight aria-hidden="true" />
              </a>
            ) : (
              <strong>{c.name}</strong>
            )}
            <ContainerLifecycleTag container={c} />
            {pin && (
              <span className="gain" data-container-pin="">
                pin · {pin.version ?? "seguridad"}
              </span>
            )}
            {update && (
              <a
                className={extraStyles.pill}
                data-container-update={update.number}
                title={updates
                  .map((pr) => `PR #${pr.number}`)
                  .join(" · ")}
                href={routeHref({
                  view: "maintenance",
                  tab: "deployments",
                  host: scope.host?.id,
                })}
              >
                actualización · #{update.number}
                {updates.length > 1 && ` +${updates.length - 1}`}
              </a>
            )}
            {c.protected && (
              <Lock className="lock" role="img" aria-label="Protegido" />
            )}
          </span>
          <span className={`row-meta ${tone}`}>
            {stateText}
            {access.version && (
              <span className="muted">{" · "}{access.version}</span>
            )}
            {update && (
              <span className="accent">
                {" · "}actualización #{update.number}
                {updates.length > 1 && ` +${updates.length - 1}`}
              </span>
            )}
          </span>
        </td>
        <td className={`${tone} ${extraStyles.stateText}`}>{stateText}</td>
        <td className="mono" data-container-version={access.version ?? ""}>
          <span className="row-title">
            {access.version ?? "—"}
            {access.updateAvailable === true && (
              <span
                className={extraStyles.updateTag}
                data-update-available=""
              >
                nueva
              </span>
            )}
          </span>
        </td>
        <td className="numeric actions-cell">
          <div className="row-actions">
            {removal.dialog}
            {updater.dialog}
            <RemoveContainerButton
              container={c}
              disabled={disabled}
              pending={removal.isPending(c)}
              onRemove={removal.remove}
            />
            {access.canUpdate && access.updateAvailable !== false && (
              <UpdateContainerButton
                container={c}
                available={access.updateAvailable === true}
                disabled={disabled}
                pending={updater.isPending(c)}
                onUpdate={(container) => updater.update(container, access.version)}
              />
            )}
            <button
              type="button"
              className="row-button"
              data-logs-toggle=""
              aria-label={`Ver logs de ${c.name}`}
              aria-expanded={logsOpen}
              onClick={toggleLogs}
            >
              <ScrollText />
            </button>
            {c.state !== "running" ? (
              <button
                type="button"
                className="row-button"
                data-action="start"
                aria-label={`Iniciar ${c.name}`}
                disabled={locked}
                onClick={() =>
                  request({
                    body: { action: "start", id: c.id },
                    title: `Iniciar ${c.name}`,
                    detail:
                      "Se iniciará el contenedor y se comprobará su estado.",
                  })
                }
              >
                <Play />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="row-button"
                  data-action="restart"
                  aria-label={`Reiniciar ${c.name}`}
                  disabled={locked}
                  onClick={() =>
                    request({
                      body: { action: "restart", id: c.id },
                      title: `Reiniciar ${c.name}`,
                      detail:
                        "El servicio se interrumpirá durante el reinicio. Las reproducciones o descargas que dependan de él podrían detenerse.",
                    })
                  }
                >
                  <RefreshCw />
                </button>
                <button
                  type="button"
                  className="row-button danger-text"
                  data-action="stop"
                  aria-label={`Detener ${c.name}`}
                  disabled={locked}
                  onClick={() =>
                    request({
                      body: { action: "stop", id: c.id },
                      title: `Detener ${c.name}`,
                      detail:
                        "El servicio dejará de estar disponible hasta que vuelvas a iniciarlo. Esta parada se considerará intencionada.",
                    })
                  }
                >
                  <Square />
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
    </Fragment>
  );
}
