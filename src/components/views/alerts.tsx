"use client";
import { useEffect, useRef } from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
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

const reasonLabels: Record<PublicDeliveryReason, string> = {
  legacy_open: "Aviso heredado sin nuevo envío",
  digest_pending: "Pendiente del resumen",
  policy_silent: "Silenciado por la política de avisos",
  telegram_disabled: "Telegram desactivado",
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
      {label}: {stateLabels[delivery.state]}
      {delivery.reason ? ` · ${reasonLabels[delivery.reason]}` : ""}
    </span>
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
          return (
            <div
              className="alert-row"
              key={alert.id}
              data-incident={alert.id}
              data-incident-selected={selected ? "true" : undefined}
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
              <div>
                <strong>{alert.title}</strong>
                <p className="subtle">{alert.detail}</p>
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
