"use client";
import { useEffect, useState } from "react";
import {
  BellRing,
  Fingerprint,
  Plus,
  Trash2,
  Check,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import type { Settings as SettingsType } from "@/lib/types";

type PasskeyItem = {
  id: string;
  name?: string | null;
  createdAt?: Date | null;
};
export function Settings({
  value,
  refresh,
}: {
  value: SettingsType;
  refresh: () => void;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState<PasskeyItem[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function loadKeys() {
    const result = await authClient.passkey.listUserPasskeys();
    if (result.data) setKeys(result.data);
  }
  useEffect(() => {
    let disposed = false;
    void authClient.passkey.listUserPasskeys().then((result) => {
      if (!disposed && result.data) setKeys(result.data);
    });
    return () => {
      disposed = true;
    };
  }, []);
  async function task(callback: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await callback();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar");
    } finally {
      setBusy(false);
    }
  }
  async function enablePush() {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    )
      throw new Error(
        "Este navegador no permite notificaciones push. En iPhone, añade hub. a la pantalla de inicio y ábrelo desde su icono.",
      );
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error(
        "Permite las notificaciones en los ajustes del navegador para continuar.",
      );
    await navigator.serviceWorker.register("/sw.js");
    const registration = await navigator.serviceWorker.ready;
    const response = await fetch("/api/push");
    const { publicKey } = await response.json();
    if (!publicKey)
      throw new Error(
        "Las notificaciones aún no están configuradas en el servidor.",
      );
    const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const applicationServerKey = Uint8Array.from(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      }));
    const saved = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!saved.ok) throw new Error((await saved.json()).error);
    setMessage("Notificaciones activadas en este dispositivo.");
  }
  async function disablePush() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const response = await fetch("/api/push", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await subscription.unsubscribe();
    }
    setMessage("Notificaciones desactivadas en este dispositivo.");
  }
  async function addKey() {
    const result = await authClient.passkey.addPasskey({
      name: "Passkey · " + new Date().toLocaleDateString("es"),
    });
    if (result.error)
      throw new Error(
        result.error.message ?? "No se pudo registrar la passkey",
      );
    await loadKeys();
    setMessage("Passkey añadida. Ya puedes usarla para entrar.");
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await task(async () => {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          Object.fromEntries([...data].map(([k, v]) => [k, Number(v)])),
        ),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      setMessage("Umbrales guardados.");
      refresh();
    });
  }
  return (
    <div className="stack section-gap">
      {message && (
        <p className="notice success" role="status">
          <Check />
          {message}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-grid">
        <section className="panel stack">
          <div className="section-heading">
            <h2>
              <Fingerprint />
              Tus passkeys
            </h2>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => task(addKey)}
            >
              <Plus />
              Añadir
            </button>
          </div>
          {!keys.length && (
            <p className="empty-note">
              Todavía no has registrado ninguna passkey.
            </p>
          )}
          {keys.map((key) => (
            <div className="setting-row" key={key.id}>
              <span>{key.name || "Passkey"}</span>
              <button
                className="icon-button danger-text"
                disabled={busy}
                aria-label={`Eliminar ${key.name || "passkey"}`}
                onClick={() => {
                  if (
                    window.confirm(
                      "¿Eliminar esta passkey? Podrás seguir entrando con tu contraseña.",
                    )
                  )
                    void task(async () => {
                      const result = await authClient.passkey.deletePasskey({
                        id: key.id,
                      });
                      if (result.error) throw new Error(result.error.message);
                      await loadKeys();
                    });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </section>
        <section className="panel stack">
          <h2>
            <BellRing />
            En tu móvil
          </h2>
          <div className="toolbar wrap">
            <button
              className="primary"
              disabled={busy}
              onClick={() => task(enablePush)}
            >
              <BellRing />
              Activar avisos
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                task(async () => {
                  const response = await fetch("/api/push/test", {
                    method: "POST",
                  });
                  if (!response.ok)
                    throw new Error((await response.json()).error);
                  setMessage(
                    "Aviso de prueba enviado a tus dispositivos suscritos.",
                  );
                })
              }
            >
              Enviar prueba
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => task(disablePush)}
            >
              Desactivar aquí
            </button>
          </div>
        </section>
      </div>
      <section className="panel stack">
        <h2>Cuándo avisarte</h2>
        <form onSubmit={save} className="stack">
          <div className="form-grid">
            {(
              [
                ["cpu", "CPU (%)", 50, 100],
                ["memory", "Memoria (%)", 50, 100],
                ["disk", "Disco ocupado (%)", 50, 99],
                ["temperature", "Temperatura (°C)", 40, 110],
                [
                  "sustainedSeconds",
                  "CPU / RAM sostenidas (segundos)",
                  30,
                  1800,
                ],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  type="number"
                  min={min}
                  max={max}
                  required
                  defaultValue={value[key]}
                />
              </label>
            ))}
          </div>
          <button className="primary align-start" disabled={busy}>
            Guardar umbrales
          </button>
        </form>
      </section>
      <section className="panel setting-row">
        <h2>
            <ShieldCheck />
            Tu cuenta
          </h2>
        <button
          className="secondary"
          onClick={async () => {
            await authClient.signOut();
            router.replace("/");
            router.refresh();
          }}
        >
          <LogOut />
          Cerrar sesión
        </button>
      </section>
    </div>
  );
}
