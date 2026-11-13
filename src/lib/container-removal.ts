import type { SensitiveActionRequest } from "@/components/sensitive-action/sensitive-action";
import type { Container } from "./types";

const stoppedStates = ["created", "exited", "dead"];

/**
 * Removal is offered for stopped, unprotected containers. The agent checks the
 * real state again, so this only decides whether the button exists.
 */
export function canRemoveContainer(
  container: Pick<Container, "state" | "protected">,
) {
  return !container.protected && stoppedStates.includes(container.state);
}

/** The confirmation dialog for removing one container. Volumes are never touched. */
export function removalRequest(
  container: Container,
  withHost: (path: string) => string,
): Omit<SensitiveActionRequest, "onSettled" | "idempotencyKey"> {
  const consequences: SensitiveActionRequest["consequences"] = [
    { tone: "ok", text: "No se borra ningún volumen ni ningún dato." },
    { tone: "warn", text: "El contenedor se elimina y no se puede deshacer." },
  ];
  if (container.recreateOnCompose)
    consequences.push({
      tone: "warn",
      text: `Pertenece al proyecto Compose ${container.composeProject ?? "activo"}: Compose volverá a crearlo la próxima vez que se levante el proyecto.`,
    });
  return {
    title: `Eliminar ${container.name}`,
    consequences,
    confirmLabel: "Eliminar contenedor",
    destructive: true,
    endpoint: withHost("/api/containers/remove"),
    body: { id: container.id, confirmation: container.name },
    typedConfirmation: {
      label: `Escribe ${container.name} para confirmar`,
      value: container.name,
    },
  };
}
