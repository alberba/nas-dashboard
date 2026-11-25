"use client";
import { useEffect, useRef } from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { StatusDot, type Tone } from "../ui";
import type {
  Alert,
  PublicDelivery,
  PublicDeliveryReason,
  PublicDeliveryState,
  Overview,
} from "@/lib/types";

const stateLabels: Record<PublicDeliveryState, string> = {
  pending: "En cola",
  sent: "Enviado",
  failed: "No entregado",
  suppressed: "Suprimido",
  uncertain: "Entrega incierta",
  none: "Sin envío",
};

const stateTones: Record<PublicDeliveryState, Tone> = {
  pending: "accent",
  sent: "gain",
  failed: "loss",
  suppressed: "muted",
  uncertain: "peach",
  none: "muted",
};

const reasonLabels: Record<PublicDeliveryReason, string> = {
  legacy_open: "Aviso heredado sin nuevo envío",
  digest_pending: "Pendiente del resumen",
  policy_silent: "Silenciado por la política de avisos",
  telegram_disabled: "Telegram desactivado",
  push_disabled: "Push desactivado",
  permanent_rejection: "Rechazo permanente del proveedor",
  uncertain: "Resultado incierto, sin reenvío automático",
};

function DeliveryStatus({
  part,
  label,
  delivery,
}: {
  part: string;
  label: string;
  delivery: PublicDelivery;
}) {
  return (
    <span
      className="alert-delivery"
      data-delivery-part={part}
      data-delivery-state={delivery.state}
      data-delivery-reason={delivery.reason ?? undefined}
    >
      <span className="alert-delivery-label">{label}</span>
      <span className="alert-delivery-value">
        <StatusDot tone={stateTones[delivery.state]} />
        <span>
          {stateLabels[delivery.state]}
          {delivery.reason ? ` · ${reasonLabels[delivery.reason]}` : ""}
        </span>
      </span>
    </span>
  );
}

function inventoryTime(value: number | null) {
  return value === null ? "Sin inventario conocido" : new Date(value * 1000).toLocaleString("es");
}

function InventoryDetail({ alert }: { alert: Alert }) {
  const inventory = alert.inventory;
  if (!inventory) return null;
  return (
    <div
      className="alert-inventory"
      data-incident-group="services-down"
      data-inventory-source={inventory.observedFrom}
      data-inventory-complete={inventory.complete ? "true" : "false"}
      data-inventory-observed-at={inventory.observedAt ?? undefined}
      data-inventory-count={inventory.entries.length}
      data-inventory-omitted={inventory.omitted}
    >
      <span className="alert-inventory-label">Último inventario conocido</span>
      <time>{inventoryTime(inventory.observedAt)}</time>
      {!inventory.complete ? (
        <p className="subtle">No hay una lectura válida del inventario de este host.</p>
      ) : inventory.entries.length === 0 ? (
        <p className="subtle">El host no tenía contenedores en esa lectura.</p>
      ) : (
        <ul className="alert-inventory-list">
          {inventory.entries.map((entry) => (
            <li key={entry.name} data-inventory-entry={entry.name}>
              <span>{entry.name}</span>
              <span data-inventory-state={entry.state}>
                {entry.state === "running" ? "En marcha" : "Detenido"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {inventory.omitted > 0 && (
        <p className="subtle" data-inventory-remaining={inventory.omitted}>
          {inventory.omitted} contenedores más no se muestran.
        </p>
      )}
    </div>
  );
}

function ObservationBlock({ alert }: { alert: Alert }) {
  if (alert.inhibitedBy === null) return null;
  return (
    <p
      className="alert-inhibited"
      data-inhibited="true"
      data-inhibited-by={alert.inhibitedBy}
      data-inhibited-reason={alert.inhibitedReason ?? undefined}
      data-observation-pending={alert.observationPending ? "true" : "false"}
    >
      <TriangleAlert />
      <span>
        Estado sin verificar: el host no responde
        {alert.inhibitedReason === "host-unreachable"
          ? " y la lectura se reanudará al recuperar la conexión."
          : "."}
      </span>
    </p>
  );
}

function InhibitedEpisodes({ alert }: { alert: Alert }) {
  if (!alert.inhibited?.length) return null;
  return (
    <div
      className="alert-inhibited-list"
      data-inhibited-count={alert.inhibited.length}
    >
      <strong>Episodios inhibidos por la caída</strong>
      {alert.inhibited.map((episode) => (
        <div
          className="alert-inhibited-row"
          key={episode.id}
          data-inhibited-incident={episode.id}
          data-observation-pending={
            episode.observationPending ? "true" : "false"
          }
          data-delivery-state={episode.delivery.state}
          data-delivery-reason={episode.delivery.reason ?? undefined}
        >
          <span>{episode.title}</span>
          <span className="subtle">
            Sin verificar · {stateLabels[episode.delivery.state]}
            {episode.delivery.reason
              ? ` · ${reasonLabels[episode.delivery.reason]}`
              : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AlertsView({
  data,
  requested,
  incident,
  incidentHost,
  incidentMissing = false,
}: {
  data: Overview;
  requested?: number;
  incident?: Alert | null;
  incidentHost?: string;
  incidentMissing?: boolean;
}) {
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (requested && selectedRef.current) selectedRef.current.focus();
  }, [requested, incident?.id]);

  const rows = data.alerts.slice();
  if (incident && !rows.some((alert) => alert.id === incident.id))
    rows.unshift(incident);
  const trueAbsence =
    Boolean(requested) &&
    incidentMissing &&
    !rows.some((alert) => alert.id === requested);

  return (
    <div className="stack section-gap">
      <section className="panel stack">
        <h2>Incidencias y recuperaciones</h2>
        {trueAbsence && (
          <div
            className="empty-state"
            data-incident-missing={requested}
            data-incident-host={incidentHost ?? data.host.id}
          >
            <TriangleAlert />
            <h3>No encontramos esa incidencia en este host</h3>
            <p className="subtle">
              El enlace sigue apuntando al host original; no se ha cambiado.
            </p>
          </div>
        )}
        {!rows.length && !trueAbsence && (
          <div className="empty-state">
            <CircleCheck />
            <h3>Sin incidencias registradas</h3>
          </div>
        )}
        {rows.map((alert) => {
          const selected = requested === alert.id;
          const severityTone: Tone =
            alert.severity === "critical" ? "loss" : "peach";
          return (
            <div
              className="alert-row"
              key={alert.id}
              data-incident={alert.id}
              data-incident-kind={alert.kind}
              data-incident-selected={selected ? "true" : undefined}
              data-severity={alert.severity}
              data-delivery-state={alert.delivery.state}
              data-delivery-reason={alert.delivery.reason ?? undefined}
              tabIndex={selected ? -1 : undefined}
              ref={selected ? selectedRef : undefined}
            >
              {alert.resolvedAt ? (
                <CircleCheck className="gain" />
              ) : (
                <TriangleAlert className="danger-text" />
              )}
              <div className="alert-row-body">
                <div className="alert-row-head">
                  <strong>{alert.title}</strong>
                  <span
                    className="alert-severity"
                    data-severity-indicator={alert.severity}
                  >
                    <StatusDot tone={severityTone} />
                    {alert.severity === "critical" ? "Crítica" : "Advertencia"}
                  </span>
                  {selected && (
                    <span className="alert-selected">Incidencia enlazada</span>
                  )}
                </div>
                <p className="subtle">{alert.detail}</p>
                <ObservationBlock alert={alert} />
                <InventoryDetail alert={alert} />
                <InhibitedEpisodes alert={alert} />
                <time>
                  {new Date(alert.at).toLocaleString("es")}
                  {alert.resolvedAt
                    ? ` · Resuelto ${new Date(alert.resolvedAt).toLocaleString("es")}`
                    : " · Pendiente"}
                </time>
                <div className="stack alert-deliveries">
                  <DeliveryStatus
                    part="initial"
                    label="Entrega inicial"
                    delivery={alert.delivery}
                  />
                  {alert.fallback && (
                    <DeliveryStatus
                      part="fallback"
                      label="Respaldo push"
                      delivery={alert.fallback}
                    />
                  )}
                  {alert.lastUpdate && (
                    <DeliveryStatus
                      part="last-update"
                      label="Última actualización"
                      delivery={alert.lastUpdate}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>
      <section className="panel stack">
        <h2>Acciones recientes</h2>
        {!data.operations.length && <p className="subtle">Sin acciones</p>}
        {data.operations.map((op) => (
          <div className="alert-row" key={op.id}>
            <RefreshCw />
            <div>
              <strong>
                {(
                  {
                    start: "Iniciar",
                    stop: "Detener",
                    restart: "Reiniciar",
                    reboot: "Reiniciar NAS",
                    move: "Mover",
                    trash: "Enviar a papelera",
                    restore: "Restaurar",
                    purge: "Eliminar definitivamente",
                    "empty-trash": "Vaciar papelera",
                  } as Record<string, string>
                )[op.action] ?? op.action}
              </strong>
              <p className="subtle">
                {op.target.length === 64
                  ? "Contenedor " + op.target.slice(0, 12)
                  : op.target}{" "}
                · {op.detail}
              </p>
              <time>
                {new Date(op.at).toLocaleString("es")} ·{" "}
                {op.status === "success"
                  ? "Completada"
                  : op.status === "failed"
                    ? "No realizada"
                    : "Pendiente de verificar"}
              </time>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
