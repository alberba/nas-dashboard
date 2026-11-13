"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Clock,
  Fingerprint,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import styles from "./sensitive-action.module.css";

export type Consequence = { tone: "ok" | "warn"; text: ReactNode };

export type VerificationMethod = "passkey" | "password";

export type SensitiveActionOutcome =
  | { status: "succeeded"; idempotencyKey: string; data: unknown }
  | { status: "pending"; idempotencyKey: string; data: unknown }
  | {
      status: "failed";
      idempotencyKey: string;
      data: unknown;
      error: string;
    };

/**
 * A 5xx other than 503 means the hub could not confirm the result: the action
 * may have run. 503 is the hub's "nothing was sent" answer.
 */
function isUncertain(status: number) {
  return status >= 500 && status !== 503;
}

export type SensitiveActionRequest = {
  title: string;
  /** Optional one-line context under the title (host, version, PR). */
  description?: ReactNode;
  consequences: Consequence[];
  confirmLabel: string;
  destructive?: boolean;
  endpoint: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  body: unknown;
  /** Destructive removals: the button stays disabled until `value` is typed exactly. */
  typedConfirmation?: { label: string; value: string };
  /** Checkbox that must be ticked first, e.g. "He leído los pasos manuales". */
  acknowledgement?: string;
  /** Reuse the key of an attempt the server already refused; new UUID otherwise. */
  idempotencyKey?: string;
  onSettled?: (outcome: SensitiveActionOutcome) => void;
};

type Phase = "ready" | "verifying" | "executing" | "pending" | "failed";

type Open = SensitiveActionRequest & {
  idempotencyKey: string;
  returnFocus: HTMLElement | null;
};

type Verification = {
  method: VerificationMethod;
  recent: boolean;
  reason: "missing" | "expired" | null;
};

/** True when a sensitive route answered 403 because the verification is missing or expired. */
export function isVerificationRequired(data: unknown): data is {
  code: "recent_verification_required";
  reason: "missing" | "expired";
  method: VerificationMethod;
} {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "recent_verification_required"
  );
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function useSensitiveAction() {
  const [open, setOpen] = useState<Open | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRejected, setPasswordRejected] = useState(false);
  const passwordId = useId();
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const request = useCallback((action: SensitiveActionRequest) => {
    const active = document.activeElement;
    setPhase("ready");
    setError("");
    setVerification(null);
    setPassword("");
    setPasswordRejected(false);
    setTyped("");
    setAcknowledged(false);
    setOpen({
      ...action,
      idempotencyKey: action.idempotencyKey ?? crypto.randomUUID(),
      returnFocus: active instanceof HTMLElement ? active : null,
    });
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (open && node && !node.open) node.showModal();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/verification", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then((state: Verification) => {
        setVerification({
          method: state.method,
          recent: state.recent,
          reason: state.reason,
        });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          "No se pudo comprobar tu verificación. Cierra y vuelve a intentarlo.",
        );
      });
    return () => controller.abort();
  }, [open]);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  function closed() {
    const target = open?.returnFocus;
    setOpen(null);
    if (target?.isConnected) target.focus();
  }

  async function verify(method: VerificationMethod) {
    if (method === "passkey") {
      const result = await authClient.signIn.passkey();
      if (result.error)
        throw new Error(
          result.error.message ?? "No se pudo verificar la passkey",
        );
    }
    if (method === "password") {
      const response = await fetch("/api/verification/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        if (data.code === "invalid_password") setPasswordRejected(true);
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "No se pudo verificar la contraseña",
        );
      }
      setPassword("");
      setPasswordRejected(false);
    }
    setVerification({ method, recent: true, reason: null });
  }

  const gatesMet =
    (!open?.typedConfirmation || typed === open.typedConfirmation.value) &&
    (!open?.acknowledgement || acknowledged);

  function settle(outcome: SensitiveActionOutcome) {
    open?.onSettled?.(outcome);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!open || phase !== "ready" || !gatesMet) return;
    const idempotencyKey = open.idempotencyKey;
    setError("");
    if (!verification?.recent) {
      setPhase("verifying");
      try {
        await verify(verification?.method ?? "passkey");
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo verificar");
        setPhase("ready");
        return;
      }
    }

    setPhase("executing");
    let response: Response;
    try {
      response = await fetch(open.endpoint, {
        method: open.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(open.body),
      });
    } catch {
      // The request may have reached the hub: never send it again.
      setPhase("pending");
      settle({ status: "pending", idempotencyKey, data: null });
      return;
    }
    const data = await readJson(response);

    if (response.ok && data.status === "pending") {
      setPhase("pending");
      settle({ status: "pending", idempotencyKey, data });
      return;
    }
    if (response.ok && data.status === "failed") {
      setPhase("failed");
      settle({
        status: "failed",
        idempotencyKey,
        data,
        error: "La operación anterior falló",
      });
      return;
    }
    if (response.ok) {
      settle({ status: "succeeded", idempotencyKey, data });
      dialogRef.current?.close();
      return;
    }
    if (response.status === 403 && isVerificationRequired(data)) {
      // Same key, no automatic resend: the Operator confirms again.
      setVerification({
        method: data.method,
        recent: false,
        reason: data.reason,
      });
      setPhase("ready");
      return;
    }
    const message =
      typeof data.error === "string"
        ? data.error
        : "No se pudo completar la acción";
    setError(message);
    if (isUncertain(response.status)) {
      setPhase("pending");
      settle({ status: "pending", idempotencyKey, data });
      return;
    }
    setPhase("failed");
    settle({ status: "failed", idempotencyKey, data, error: message });
  }

  const busy = phase === "verifying" || phase === "executing";
  const settled = phase === "pending" || phase === "failed";
  const needsPassword =
    verification?.method === "password" && !verification.recent;
  const needsPasskey =
    verification?.method === "passkey" && !verification.recent;

  // showModal() alone would focus the close button; move focus to the field
  // the Operator has to fill, or to Cancel, the least destructive choice.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node?.open) return;
    node.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [open, needsPassword, settled]);

  const tone = open?.destructive ? "loss" : "accent";
  const typedId = `${passwordId}-typed`;
  const helpId = `${passwordId}-help`;

  const dialog = open ? (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={open.description ? `${titleId}-description` : undefined}
      aria-busy={busy}
      data-sensitive-action
      data-phase={phase}
      data-verification-method={verification?.method}
      data-verification-recent={
        verification ? String(verification.recent) : undefined
      }
      data-verification-reason={verification?.reason ?? undefined}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={closed}
    >
      <form className={styles.body} onSubmit={(event) => void confirm(event)}>
        <header className={styles.head}>
          <span className={styles.icon} data-tone={tone} aria-hidden="true">
            {open.destructive ? <TriangleAlert /> : <ShieldCheck />}
          </span>
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>
              {open.title}
            </h2>
            {open.description && (
              <p id={`${titleId}-description`} className={styles.description}>
                {open.description}
              </p>
            )}
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Cerrar"
            disabled={busy}
            onClick={close}
          >
            <X />
          </button>
        </header>

        <ul className={styles.consequences} aria-label="Consecuencias">
          {open.consequences.map((item, index) => (
            <li key={index} data-consequence={item.tone}>
              {item.tone === "ok" ? (
                <Check data-tone="gain" aria-hidden="true" />
              ) : (
                <TriangleAlert data-tone="peach" aria-hidden="true" />
              )}
              <span>{item.text}</span>
            </li>
          ))}
        </ul>

        {!settled && open.typedConfirmation && (
          <div className={styles.field}>
            <label htmlFor={typedId}>{open.typedConfirmation.label}</label>
            <input
              id={typedId}
              className={styles.mono}
              value={typed}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              disabled={busy}
              data-initial-focus
              data-typed-confirmation
              data-matches={typed === open.typedConfirmation.value}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}

        {!settled && open.acknowledgement && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{open.acknowledgement}</span>
          </label>
        )}

        {!settled && needsPassword && (
          <div className={styles.field}>
            <label htmlFor={passwordId}>Contraseña</label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={password}
              aria-invalid={passwordRejected}
              aria-describedby={helpId}
              disabled={busy}
              data-initial-focus={!open.typedConfirmation || undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordRejected(false);
              }}
            />
            <p id={helpId} className={styles.help}>
              Esta entrada no usa passkeys. La verificación vale 5 minutos.
            </p>
          </div>
        )}

        {!settled && needsPasskey && (
          <p
            className={styles.hint}
            data-tone={verification?.reason ?? "missing"}
          >
            <Fingerprint aria-hidden="true" />
            <span>
              {verification?.reason === "expired"
                ? "Tu verificación ha caducado. Vuelve a usar tu passkey; valdrá 5 minutos."
                : "Se pedirá tu passkey antes de enviar la acción. La verificación vale 5 minutos."}
            </span>
          </p>
        )}

        {phase === "pending" && (
          <p className={styles.notice} data-tone="peach" role="status">
            <Clock aria-hidden="true" />
            <span>
              {error ||
                "No se ha podido confirmar el resultado. Queda pendiente de verificar y no se repetirá sola."}
            </span>
          </p>
        )}
        {phase !== "pending" && error && (
          <p className={styles.notice} data-tone="loss" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <footer className={styles.actions}>
          <button
            type="button"
            className={styles.cancel}
            disabled={busy}
            onClick={close}
            data-initial-focus={
              settled ||
              (!needsPassword && !open.typedConfirmation) ||
              undefined
            }
          >
            {settled ? "Cerrar" : "Cancelar"}
          </button>
          {!settled && (
            <button
              type="submit"
              className={styles.confirm}
              data-tone={tone}
              data-confirm
              disabled={
                phase !== "ready" ||
                !verification ||
                !gatesMet ||
                (needsPassword && !password)
              }
            >
              {phase === "verifying"
                ? "Verificando…"
                : phase === "executing"
                  ? "Enviando…"
                  : needsPasskey
                    ? "Confirmar con passkey"
                    : open.confirmLabel}
              {needsPasskey && phase === "ready" && (
                <Fingerprint aria-hidden="true" />
              )}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  ) : null;

  return { request, dialog, phase: open ? phase : ("closed" as const) };
}
