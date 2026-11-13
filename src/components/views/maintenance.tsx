import { useState } from "react";
import { Lock, Play, Power, RefreshCw, Square } from "lucide-react";
import {
  containerFilters,
  containerHealth,
  needsAttention,
  type ContainerFilterId,
  type ContainerHealth,
} from "@/lib/containers";
import { bytes, percent } from "@/lib/format";
import type { Container, Metrics } from "@/lib/types";
import type { ActionRequest } from "../file-browser";
import { useHostScope } from "../host-context";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "../sensitive-action/sensitive-action";
import { FilterChips, Panel, StatusDot, type Tone } from "../ui";
import { MaintenanceSnapshotStatus } from "./maintenance-status";

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

export function MaintenanceStatus({
  metrics,
  expected,
  disabled,
  request,
  onSensitiveSettled,
}: {
  metrics: Metrics;
  expected: string[];
  connected: boolean;
  disabled: boolean;
  lastAt: string | null;
  request: (action: ActionRequest) => void;
  /** Called when a sensitive action finishes, so the shell can refresh. */
  onSensitiveSettled?: (outcome: SensitiveActionOutcome) => void;
}) {
  const sensitive = useSensitiveAction();
  const { canReboot, withHost } = useHostScope();
  const [filter, setFilter] = useState<ContainerFilterId>("all");
  const containers = [...metrics.containers].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const filters = containerFilters(containers, expected);
  const visible = filters.find((f) => f.id === filter)?.items ?? containers;
  const running = containers.filter((c) => c.state === "running").length;

  return (
    <div className="page-stack">
      <MaintenanceSnapshotStatus />
      <div className="columns">
        <Panel
          id="containers-title"
          title="Contenedores"
          count={`${running}/${containers.length}`}
          className="main-column"
          tools={
            <FilterChips
              label="Filtrar contenedores"
              options={filters.map((f) => ({
                id: f.id,
                label: filterLabels[f.id],
                count: f.items.length,
              }))}
              value={filter}
              onSelect={setFilter}
            />
          }
        >
          <div className="table-scroll">
            <table className="data-table" data-container-table="">
              <thead>
                <tr>
                  <th scope="col">Contenedor</th>
                  <th scope="col">Imagen</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Salud</th>
                  <th scope="col" className="numeric">
                    CPU
                  </th>
                  <th scope="col" className="numeric">
                    RAM
                  </th>
                  <th scope="col" className="numeric">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((container) => (
                  <ContainerRow
                    key={container.id}
                    container={container}
                    problem={needsAttention(container, expected)}
                    disabled={disabled}
                    request={request}
                  />
                ))}
                {!visible.length && (
                  <tr className="empty-row">
                    <td colSpan={7}>Ningún contenedor en este filtro</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="side-column">
          <Panel id="actions-title" title="Acciones">
            <div className="command-list">
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
            </div>
          </Panel>
        </div>
      </div>
      {sensitive.dialog}
    </div>
  );
}

function stateLabel(c: Container) {
  if (c.state === "running") return "Activo";
  if (c.state === "exited") return "Detenido";
  if (c.state === "restarting") return "Reiniciándose";
  return c.state;
}

function ContainerRow({
  container: c,
  problem,
  disabled,
  request,
}: {
  container: Container;
  problem: boolean;
  disabled: boolean;
  request: (action: ActionRequest) => void;
}) {
  const health = containerHealth(c);
  const tone: Tone = problem
    ? "loss"
    : c.state !== "running"
      ? "muted"
      : healthTones[health] === "muted"
        ? "gain"
        : healthTones[health];
  const locked = disabled || c.protected;
  return (
    <tr
      data-container={c.name}
      data-state={c.state}
      data-health={health}
      data-problem={problem || undefined}
    >
      <td className="name-cell">
        <span className="row-title">
          <StatusDot tone={tone} />
          <strong>{c.name}</strong>
          {c.protected && (
            <Lock className="lock" role="img" aria-label="Protegido" />
          )}
        </span>
        <span className={`row-meta ${tone}`}>
          {stateLabel(c)}
          {health !== "none" && ` · ${healthLabels[health]}`}
        </span>
      </td>
      <td className="mono soft">
        <span className="truncate" title={c.image}>
          {c.image}
        </span>
      </td>
      <td className={c.state === "running" ? "" : "subtle"}>{stateLabel(c)}</td>
      <td className={healthTones[health]}>{healthLabels[health]}</td>
      <td className="numeric">{percent(c.cpu)}</td>
      <td className="numeric">{bytes(c.memory)}</td>
      <td className="numeric actions-cell">
        <div className="row-actions">
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
  );
}
