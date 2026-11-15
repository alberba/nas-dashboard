"use client";
import { useCallback, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { Container } from "@/lib/types";
import { useHostScope } from "../host-context";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "../sensitive-action/sensitive-action";
import styles from "./update-container.module.css";

/**
 * Pulls the newest image of one Compose service and recreates it. The agent
 * decides if the container is updatable; the dialog states every warning
 * before the operator confirms and never retries an uncertain result.
 */
export function useUpdateContainer() {
  const sensitive = useSensitiveAction();
  const { withHost, key } = useHostScope();
  const [pending, setPending] = useState<{ host: string; ids: string[] }>({
    host: key,
    ids: [],
  });

  const update = useCallback(
    (container: Container, version: string | null) =>
      sensitive.request({
        title: `Actualizar ${container.name}`,
        description: (
          <>
            {container.image}
            {version && ` · versión ${version}`}
          </>
        ),
        consequences: [
          {
            tone: "warn",
            text: "Se descargará la imagen más reciente y el contenedor se recreará.",
          },
          {
            tone: "warn",
            text: "El servicio dejará de responder mientras dura la actualización.",
          },
          {
            tone: "warn",
            text: "Si la nueva imagen falla, el servicio quedará caído hasta que lo revises. El hub no revierte solo.",
          },
          {
            tone: "ok",
            text: "Los volúmenes y la configuración de Compose no se modifican.",
          },
        ],
        acknowledgement:
          "He leído las advertencias y quiero actualizar la imagen",
        confirmLabel: "Actualizar",
        endpoint: withHost("/api/action"),
        body: { action: "update-container", id: container.id },
        onSettled: (outcome: SensitiveActionOutcome) => {
          if (outcome.status === "pending")
            setPending((current) => ({
              host: key,
              ids: [...(current.host === key ? current.ids : []), container.id],
            }));
          window.dispatchEvent(new Event("maintenance-refresh"));
        },
      }),
    [sensitive, withHost, key],
  );

  const isPending = (container: Container) =>
    pending.host === key && pending.ids.includes(container.id);

  return { update, isPending, dialog: sensitive.dialog };
}

export function UpdateContainerButton({
  container,
  available,
  disabled,
  pending,
  onUpdate,
}: {
  container: Container;
  available: boolean;
  disabled: boolean;
  pending: boolean;
  onUpdate: (container: Container) => void;
}) {
  if (pending)
    return (
      <span className={styles.pending} data-update-pending="">
        Pendiente
      </span>
    );
  return (
    <button
      type="button"
      className={`row-button ${styles.update}`}
      data-action="update"
      data-update-available={available ? "" : undefined}
      aria-label={`Actualizar ${container.name}`}
      title={
        available
          ? "Hay una imagen nueva disponible"
          : "Descargar la última imagen y recrear el contenedor"
      }
      disabled={disabled}
      onClick={() => onUpdate(container)}
    >
      <ArrowUpCircle />
    </button>
  );
}
