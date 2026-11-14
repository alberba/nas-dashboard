import type { MaintenanceReview } from "./maintenance";

const reasons = {
  "major version: manual review": ["major", "Cambio de versión principal", "Revisa compatibilidad y migraciones en el host o repositorio. Comprueba también las CVEs nuevas o agravadas de la candidata."],
  "candidate introduces or escalates HIGH/CRITICAL CVEs": ["regression", "La candidata introduce o agrava CVEs graves", "Mantén la versión actual y revisa una candidata que corrija las vulnerabilidades sin introducir estas regresiones."],
  "App data is shared with another running container": ["shared-data", "Datos compartidos con otro contenedor", "Prepara una actualización coordinada en el host: otro contenedor en ejecución escribe en estos datos."],
  "App data in a named volume requires manual review": ["named-volume", "Datos en un volumen que requiere revisión", "Revisa el volumen y prepara una copia y una actualización manual en el host."],
  "missing healthcheck or current app is unhealthy": ["health", "La salud actual no permite una actualización automática", "Comprueba la aplicación y su healthcheck en el host antes de actualizar."],
  "stale comparison": ["stale", "La comparación ha caducado", "Necesitas un análisis nuevo antes de decidir sobre esta candidata."],
  "running image changed since scan": ["changed-image", "La imagen en ejecución cambió después del análisis", "Compara la imagen actual con la candidata antes de decidir."],
  "unknown or prerelease version": ["unknown-version", "Versión desconocida o preliminar", "Revisa la versión candidata y su compatibilidad en el repositorio."],
  "unclassified version change": ["unclassified", "Cambio de versión sin clasificar", "Revisa las versiones y las notas de publicación antes de actualizar."],
  "volume configuration differs from the running app": ["volume-change", "Los volúmenes difieren de la configuración", "Revisa los montajes y las copias de datos en el host antes de actualizar."],
  "environment differs from the running app": ["environment-change", "La configuración difiere de la aplicación en ejecución", "Revisa las variables de configuración en el host antes de actualizar."],
} as const;

export function securityReviewReason(raw: string | null) {
  const reason = raw?.replace(/^manual:\s*/, "").trim() ?? "";
  const known = reasons[reason as keyof typeof reasons];
  return known
    ? { code: known[0], label: known[1], next: known[2] }
    : {
        code: reason ? "unknown" : "unrecorded",
        label: reason ? "Requiere revisión manual" : "Sin motivo de intervención registrado",
        next: "Revisa las versiones y el registro en el host. El hub no dispone de una acción para aprobar o forzar esta candidata.",
      };
}

/** Public records have no ID. Preserve alternatives and exact duplicates. */
export function securityReviewRows(reviews: MaintenanceReview[]) {
  const occurrences = new Map<string, number>();
  return reviews.map((review) => {
    const identity = JSON.stringify([review.names, review.from, review.to, review.verifiedAt]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { id: `${identity}:${occurrence}`, review };
  });
}

export function maintenanceDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString("es", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" }) + " · Madrid"
    : "Fecha no disponible";
}
