"use client";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  captureHandoff,
  clearHandoff,
  handoffStorage,
} from "@/lib/telegram-handoff-client";
import type { Operation } from "@/lib/types";
import {
  useSensitiveAction,
  type SensitiveActionOutcome,
} from "../sensitive-action/sensitive-action";

/** What `data-handoff-state` reports; the tests assert it, never the copy. */
export type HandoffState =
  | "idle"
  | "loading"
  | "ready"
  | "executing"
  | "succeeded"
  | "pending"
  | "failed"
  | "expired"
  | "cancelled"
  | "consumed"
  | "invalid"
  | "dismissed";

/** The answer of `POST /api/telegram/intents/inspect`. */
type Inspected = {
  state: "ready" | "expired" | "cancelled" | "consumed";
  action: string;
  verb: string;
  target: string;
  host: { id: string; name: string };
  incident: { id: number; resolved: boolean };
  requiresVerification: boolean;
  expiresAt: string;
  operation?: Operation;
};

const EXECUTE_ENDPOINT = "/api/telegram/intents/execute";
const INSPECT_ENDPOINT = "/api/telegram/intents/inspect";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function operationIn(value: unknown): Operation | null {
  const operation = asRecord(value).operation;
  return typeof operation === "object" && operation !== null
    ? (operation as Operation)
    : null;
}

/** The notice only names a container for the actions that act on one. */
function titleOf(intent: Inspected) {
  return intent.action === "start" || intent.action === "restart"
    ? `${intent.verb} ${intent.target}`
    : intent.verb;
}

/**
 * Completes in the hub the action started from a Telegram notice (BOT-07). The
 * token comes from the link fragment and lives in `sessionStorage` until the
 * intent ends. The server decides what needs a passkey and `inspect` only
 * reports it, so confirming and verifying are one step in one dialog (P-20).
 */
export function TelegramHandoff() {
  const { request, dialog, phase } = useSensitiveAction();
  const [state, setState] = useState<HandoffState>("idle");
  const [intent, setIntent] = useState<Inspected | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [failure, setFailure] = useState("");

  const settled = useCallback((outcome: SensitiveActionOutcome) => {
    const found = operationIn(outcome.data);
    if (outcome.status === "succeeded") {
      clearHandoff(handoffStorage());
      setOperation(found);
      setState("succeeded");
      return;
    }
    if (outcome.status === "pending") {
      // The hub may have run it: the link is not offered again.
      clearHandoff(handoffStorage());
      setOperation(found);
      setState("pending");
      return;
    }
    setFailure(outcome.error);
    setState("failed");
  }, []);

  const open = useCallback(
    (inspected: Inspected, token: string) => {
      const consequences: { tone: "ok" | "warn"; text: ReactNode }[] = [
        { tone: "warn", text: "Se ejecutará una sola vez." },
      ];
      if (inspected.incident.resolved)
        consequences.push({
          tone: "warn",
          text: "La incidencia ya está resuelta; puedes confirmar igualmente.",
        });
      if (inspected.requiresVerification)
        consequences.push({
          tone: "warn",
          text: (
            <span data-handoff-passkey-help>
              Si la passkey falla en el navegador de Telegram, vuelve al aviso y
              abre el botón en el navegador del sistema antes de que pasen 5
              minutos.
            </span>
          ),
        });
      request({
        title: titleOf(inspected),
        description: inspected.host.name,
        consequences,
        confirmLabel: "Confirmar",
        endpoint: EXECUTE_ENDPOINT,
        body: { token },
        requiresVerification: inspected.requiresVerification,
        onSettled: settled,
      });
    },
    [request, settled],
  );

  const inspect = useCallback(
    async (token: string, signal?: AbortSignal) => {
      setState("loading");
      setFailure("");
      let response: Response;
      try {
        response = await fetch(INSPECT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setFailure("No se pudo comprobar el enlace.");
        setState("failed");
        return;
      }
      if (response.status === 401) {
        // The login keeps the token in sessionStorage and comes back here.
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | Inspected
        | { error?: string }
        | null;
      if (!response.ok || !body || !("state" in body)) {
        setFailure(
          (body && "error" in body && body.error) ||
            "No se pudo comprobar el enlace.",
        );
        setState("failed");
        return;
      }
      setIntent(body);
      if (body.state === "ready") {
        setState("ready");
        open(body, token);
        return;
      }
      setFailure("");
      setState("failed");
    },
    [open],
  );

  useEffect(() => {
    const token = captureHandoff(
      window.location,
      window.history,
      handoffStorage(),
    );
    if (!token) return;
    const controller = new AbortController();
    // The first state change waits a microtask: an effect must not set state
    // synchronously.
    queueMicrotask(() => void inspect(token, controller.signal));
    return () => controller.abort();
  }, [inspect]);

  if (state === "idle") return null;

  const busy = phase === "verifying" || phase === "executing";
  const shown: HandoffState = state === "ready" && busy ? "executing" : state;

  return (
    <>
      <section
        className="panel stack"
        data-handoff
        data-handoff-state={shown}
        data-handoff-action={intent?.action}
        data-handoff-target={intent?.target}
        data-handoff-resolved={
          intent ? String(intent.incident.resolved) : undefined
        }
      >
        <h2>Acción desde Telegram</h2>
        {intent && (
          <p className="subtle">
            {titleOf(intent)} · {intent.host.name}
          </p>
        )}
        {failure && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
        {operation?.detail && (
          <p className="subtle" data-handoff-operation={operation.id}>
            {operation.detail}
          </p>
        )}
      </section>
      {dialog}
    </>
  );
}
