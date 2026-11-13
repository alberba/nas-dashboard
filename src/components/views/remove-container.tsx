import { useCallback, useState } from "react";
import { Trash2 } from "lucide-react";
import { canRemoveContainer, removalRequest } from "@/lib/container-removal";
import type { Container } from "@/lib/types";
import { useHostScope } from "../host-context";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "../sensitive-action/sensitive-action";
import styles from "./remove-container.module.css";

/**
 * Removal of a stopped container through the shared sensitive-action dialog.
 * An uncertain answer leaves the container marked as pending: the operator
 * checks the host, the hub never sends the removal again by itself.
 */
export function useRemoveContainer(
  onSettled?: (outcome: SensitiveActionOutcome) => void,
) {
  const sensitive = useSensitiveAction();
  const { withHost, key } = useHostScope();
  const [pending, setPending] = useState<{ host: string; ids: string[] }>({
    host: key,
    ids: [],
  });

  const remove = useCallback(
    (container: Container) =>
      sensitive.request({
        ...removalRequest(container, withHost),
        onSettled: (outcome) => {
          if (outcome.status === "pending")
            setPending((current) => ({
              host: key,
              ids: [...(current.host === key ? current.ids : []), container.id],
            }));
          onSettled?.(outcome);
        },
      }),
    [sensitive, withHost, key, onSettled],
  );

  const isPending = (container: Container) =>
    pending.host === key && pending.ids.includes(container.id);

  return { remove, isPending, dialog: sensitive.dialog };
}

export function RemoveContainerButton({
  container,
  disabled,
  pending,
  onRemove,
}: {
  container: Container;
  disabled: boolean;
  pending: boolean;
  onRemove: (container: Container) => void;
}) {
  if (!canRemoveContainer(container)) return null;
  if (pending)
    return (
      <span className={styles.pending} data-removal-pending="">
        Pendiente de verificar
      </span>
    );
  return (
    <button
      type="button"
      className={`row-button ${styles.remove}`}
      data-action="remove"
      aria-label={`Eliminar ${container.name}`}
      disabled={disabled}
      onClick={() => onRemove(container)}
    >
      <Trash2 />
    </button>
  );
}

/** Orphans and finished one-shots get a tag; a one-shot that failed is a problem, not a tag. */
export function ContainerLifecycleTag({ container }: { container: Container }) {
  if (container.orphan)
    return (
      <span className={styles.tag} data-tag="orphan" data-tone="lilac">
        huérfano
      </span>
    );
  if (container.oneShot && container.state !== "running")
    return (
      <span
        className={styles.tag}
        data-tag="one-shot"
        data-tone="muted"
        data-exit-code={container.exitCode ?? undefined}
      >
        un solo uso
      </span>
    );
  return null;
}
