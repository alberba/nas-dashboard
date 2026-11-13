import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import type { Overview } from "@/lib/types";

export function AlertsView({ data }: { data: Overview }) {
  return (
    <div className="stack section-gap">
      <section className="panel stack">
        <h2>Incidencias y recuperaciones</h2>
        {!data.alerts.length && (
          <div className="empty-state">
            <CircleCheck />
            <h3>Sin incidencias registradas</h3>
          </div>
        )}
        {data.alerts.map((alert) => (
          <div className="alert-row" key={alert.id}>
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
            </div>
          </div>
        ))}
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
