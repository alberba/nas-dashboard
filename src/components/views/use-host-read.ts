"use client";
import { useEffect, useState } from "react";
import { useHostScope } from "../host-context";
/** Host-keyed, abortable read. Failed refreshes retain explicitly stale data. */
export function useHostRead<T>(path: string, revision = 0) {
  const { key, withHost } = useHostScope();
  const url = withHost(path);
  const [held, setHeld] = useState<{
    key: string;
    data: T | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  useEffect(() => {
    let controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      controller.abort();
      const attempt = new AbortController();
      controller = attempt;
      try {
        const response = await fetch(url, { signal: attempt.signal });
        if (!response.ok) throw new Error("No se pudo actualizar esta sección");
        const data = (await response.json()) as T;
        if (!stopped && !attempt.signal.aborted)
          setHeld({ key, data, error: "" });
      } catch (error) {
        if (!stopped && !attempt.signal.aborted)
          setHeld((old) => ({
            key,
            data: old.key === key ? old.data : null,
            error: error instanceof Error ? error.message : "Sin datos",
          }));
      } finally {
        if (!stopped && !attempt.signal.aborted)
          timer = setTimeout(read, 60_000);
      }
    }
    const refresh = () => {
      clearTimeout(timer);
      void read();
    };
    window.addEventListener("maintenance-refresh", refresh);
    void read();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("maintenance-refresh", refresh);
    };
  }, [key, url, revision]);
  return held.key === key ? held : { key, data: null, error: "" };
}
