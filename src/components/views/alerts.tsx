"use client";
import { useEffect, useRef } from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { StatusDot, type Tone } from "../ui";
import type {
  Alert,
  DigestState,
  PublicDelivery,
  PublicDeliveryReason,
  PublicDeliveryState,
  PublicDigestReason,
  PublicDigestStatus,
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

const digestStateLabels: Record<PublicDigestStatus, string> = {
  pending: "Preparado o en curso",
  sent: "Enviado",
  empty: "Sin contenido",
  unconfigured: "Sin configurar",
  expired: "Vencido",
  failed: "No entregado",
  uncertain: "Sin confirmación",
};

const digestStateTones: Record<PublicDigestStatus, Tone> = {
  pending: "accent",
  sent: "gain",
  empty: "muted",
  unconfigured: "muted",
  expired: "peach",
  failed: "loss",
  uncertain: "peach",
};

/**
 * Reasons explain a date without ever asserting what the provider did. An
 * uncertain attempt says that confirmation is missing, not whether Telegram
 * accepted the message.
 */
const digestReasonLabels: Record<PublicDigestReason, string> = {
  telegram_disabled: "Telegram está desactivado",
  digest_empty: "El periodo no tenía nada que contar",
  window_closed: "La ventana de recuperación terminó",
  digest_missed: "No hubo ejecución dentro de la ventana",
  retry_budget_exhausted: "Se agotaron los reintentos permitidos",
  lease_expired_after_attempt: "Falta confirmación del proveedor",
  rate_limited: "El proveedor pidió esperar antes de reintentar",
  telegram_400: "El proveedor rechazó la solicitud",
  telegram_401: "El proveedor rechazó la credencial",
  telegram_403: "El proveedor bloqueó la entrega",
  telegram_404: "El destino no existe en el proveedor",
  telegram_server_error: "El proveedor no respondió correctamente",
  message_missing: "El mensaje ya no existe en el proveedor",
  network: "No se pudo contactar con el proveedor",
  timeout: "El proveedor no respondió a tiempo",
  aborted: "La entrega se interrumpió",
  invalid_response: "El proveedor devolvió una respuesta no válida",
  missing_message_id: "El proveedor no confirmó el mensaje",
};

function digestTarget(value: string) {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return value;
  return target.toLocaleString("es", {
    timeZone: "Europe/Madrid",
    dateStyle: "long",
    timeStyle: "short",
  });
}

function DigestStatus({ digest }: { digest: DigestState }) {
  return (
    <div
      className="alert-delivery digest-status"
      data-digest-panel
      data-digest-scope="global"
      data-digest-state={digest.status}
      data-digest-date={digest.date}
      data-digest-target={digest.targetAt}
      data-digest-reason={digest.reason ?? undefined}
    >
      <span className="alert-delivery-label">Último resumen diario</span>
      <span className="alert-delivery-value">
        <StatusDot tone={digestStateTones[digest.status]} />
        <span>{digestStateLabels[digest.status]}</span>
      </span>
      <time dateTime={digest.targetAt}>{digestTarget(digest.targetAt)}</time>
      {digest.reason && (
        <p className="subtle">{digestReasonLabels[digest.reason]}</p>
      )}
    </div>
  );
}

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
  if (
    alert.inhibitedBy === null &&
    !alert.observationPending &&
    alert.inhibitedReason === null
  )
    return null;
  const absence = alert.inhibitedReason === "container-absent";
  return (
    <p
      className="alert-inhibited"
      data-inhibited={alert.inhibitedBy !== null ? "true" : undefined}
      data-inhibited-by={alert.inhibitedBy ?? undefined}
      data-inhibited-reason={alert.inhibitedReason ?? undefined}
      data-observation-pending={alert.observationPending ? "true" : "false"}
      data-watch-pending={absence ? "true" : undefined}
    >
      <TriangleAlert />
      <span>
        {absence
          ? "Estado pendiente: el nombre no aparece en el inventario. La vigilancia se conserva mientras se acreditan 30 minutos de ausencia."
          : "Estado sin verificar: el host no responde" +
            (alert.inhibitedReason === "host-unreachable"
              ? " y la lectura se reanudará al recuperar la conexión."
              : ".")}
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
        <h2>Resumen diario</h2>
        {data.digest ? (
          <DigestStatus digest={data.digest} />
        ) : (
          <p
            className="subtle"
            data-digest-panel
            data-digest-state="none"
            data-digest-scope="global"
          >
            Todavía no hay ningún resumen registrado.
          </p>
        )}
      </section>
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
