"use client";
import { useEffect, useRef, useState } from "react";
import type { Container } from "@/lib/types";
import type { HostCommand } from "@/lib/host-command-contract";
import { useHostScope } from "./host-context";
import { useSensitiveAction } from "./sensitive-action/sensitive-action";
import { commandLabels } from "./views/maintenance-extras";
import styles from "./views/maintenance-extra.module.css";
const shortcuts: Record<string, HostCommand> = {
  d: "deploy-now",
  h: "check-health",
  w: "reconnect-apps",
  b: "backup-now",
};
export function CommandSearch({
  containers,
  onContainer,
}: {
  containers: Container[];
  onContainer: (id: string) => void;
}) {
  const scope = useHostScope();
  const sensitive = useSensitiveAction();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  function close() {
    dialog.current?.close();
    opener.current?.focus();
  }
  const runRef = useRef<(command: HostCommand) => void>(() => {});
  useEffect(() => {
    runRef.current = (command) => {
      if (!scope.canMutate) return;
      close();
      sensitive.request({
        title: commandLabels[command],
        consequences: [
          {
            tone: "warn",
            text:
              command === "clean-images"
                ? "Se eliminarán imágenes sin contenedor, conservando las de rollback."
                : "La acción se ejecutará una sola vez en el host seleccionado.",
          },
        ],
        confirmLabel: "Confirmar",
        endpoint: scope.withHost("/api/host-command"),
        body: { command },
        onSettled: () => window.dispatchEvent(new Event("maintenance-refresh")),
      });
    };
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (document.querySelector("dialog[open]") && !dialog.current?.open) return;
        event.preventDefault();
        if (dialog.current?.open) close();
        else {
          setQuery("");
          dialog.current?.showModal();
        }
        return;
      }
      const target = event.target as HTMLElement;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        target.closest(
          "input,textarea,select,[contenteditable=true],dialog[open]",
        ) ||
        document.querySelector("dialog[open]")
      )
        return;
      const command = shortcuts[event.key.toLowerCase()];
      if (command) {
        event.preventDefault();
        runRef.current(command);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const commands = (Object.keys(commandLabels) as HostCommand[]).filter(
    (c) =>
      commandLabels[c].toLowerCase().includes(query.toLowerCase()) &&
      (scope.host?.role === "instance" ||
        !["backup-now", "reconnect-apps"].includes(c)),
  );
  return (
    <>
      <button
        ref={opener}
        className={styles.button}
        data-search-toggle=""
        onClick={() => {
          setQuery("");
          dialog.current?.showModal();
        }}
      >
        Buscar <kbd>Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-label="Buscar contenedores y acciones"
        onCancel={() => opener.current?.focus()}
      >
        <div className={styles.body}>
          <label>
            Buscar
            <input
              autoFocus
              className={styles.input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ul className={styles.list}>
            {containers
              .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
              .map((c) => (
                <li key={c.id}>
                  <button
                    className={styles.button}
                    data-search-container={c.id}
                    onClick={() => {
                      close();
                      onContainer(c.id);
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            {commands.map((c) => (
              <li key={c}>
                <button
                  className={styles.button}
                  data-search-command={c}
                  disabled={!scope.canMutate}
                  onClick={() => runRef.current(c)}
                >
                  {commandLabels[c]}
                </button>
              </li>
            ))}
          </ul>
          <button className={styles.button} onClick={close}>
            Cerrar
          </button>
        </div>
      </dialog>
      {sensitive.dialog}
    </>
  );
}
