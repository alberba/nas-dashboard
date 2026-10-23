"use client";
import { useEffect, useRef, useState } from "react";
import { Fingerprint, HardDrive, ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function Login({ setup }: { setup: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "setup",
    );
    if (tokenRef.current && token) tokenRef.current.value = token;
    if (token) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      if (setup) {
        const response = await fetch("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.fromEntries(data)),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
      }
      const result = await authClient.signIn.email({
        email: String(data.get("email")),
        password: String(data.get("password")),
      });
      if (result.error)
        throw new Error(result.error.message ?? "No se pudo iniciar sesión");
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar");
      setBusy(false);
    }
  }
  async function signInPasskey() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result.error)
        throw new Error(result.error.message ?? "No se pudo usar la passkey");
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo usar la passkey",
      );
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <Link className="brand" href="/">
          hub<span>.</span>
        </Link>
        <div>
          <div className="server-art" aria-hidden="true">
            <HardDrive />
            <i />
            <i />
            <i />
          </div>
          <h1>
            Todo en casa.
            <br />
            Todo a la vista.
          </h1>
          <p>
            El espacio de tus películas, la salud de tus discos y cada servicio.
            Un lugar para tenerlo todo bajo control.
          </p>
        </div>
        <span className="subtle with-icon">
          <ShieldCheck /> Tu panel personal del NAS
        </span>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="accent with-icon">
            <HardDrive /> Tu NAS, a la vista
          </span>
          <h2>{setup ? "Hazlo tuyo." : "Bienvenido a casa."}</h2>
          <p className="subtle">
            {setup
              ? "Crea tu cuenta para empezar. Después podrás añadir una passkey."
              : "Entra para ver cómo está todo."}
          </p>
          <form onSubmit={submit} className="stack">
            {setup && (
              <>
                <label>
                  Nombre
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    defaultValue="Albert"
                    maxLength={80}
                  />
                </label>
                <label>
                  Código de configuración
                  <input
                    ref={tokenRef}
                    name="token"
                    autoComplete="off"
                    required
                    minLength={32}
                    type="password"
                  />
                </label>
              </>
            )}
            <label>
              Correo
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="tu@correo.com"
                required
              />
            </label>
            <label>
              Contraseña
              <input
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 12 : undefined}
                maxLength={128}
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "Conectando…" : setup ? "Crear mi cuenta" : "Entrar"}
              <ArrowRight />
            </button>
          </form>
          {!setup && (
            <button
              className="secondary passkey-button"
              disabled={busy}
              onClick={signInPasskey}
            >
              <Fingerprint /> Entrar con passkey
            </button>
          )}
          <p className="fineprint">
            Acceso personal. El registro público está cerrado.
          </p>
        </div>
      </section>
    </main>
  );
}
