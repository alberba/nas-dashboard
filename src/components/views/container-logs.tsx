"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, RefreshCw, Satellite } from "lucide-react";
import {
  appendLines,
  filterLines,
  logLevel,
  logsRequestPath,
  logsText,
} from "@/lib/log-viewer";
import {
  DEFAULT_LOG_LINES,
  logsResponseSchema,
  type LogLine,
} from "@/lib/logs";
import { useHostScope } from "../host-context";
import styles from "./container-logs.module.css";

const LINE_OPTIONS = [100, 200, 500, 1000, 5000];
const POLL_MS = 2000;
/** Short wait when the agent says more new lines are already waiting. */
const CATCH_UP_MS = 250;

/** The viewer asked for one container, so the echoed id adds nothing. */
const readSchema = logsResponseSchema.omit({ id: true });

type Phase = "loading" | "ready" | "error";

async function readLogs(
  path: string,
  signal: AbortSignal,
): Promise<{ lines: LogLine[]; cursor: string | null; truncated: boolean }> {
  const response = await fetch(path, { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Error ${response.status}`;
    throw new Error(reason);
  }
  const parsed = readSchema.safeParse(body);
  if (!parsed.success) throw new Error("Respuesta de logs no válida");
  return parsed.data;
}

function lineTime(at: string | null) {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es", { hour12: false });
}

/**
 * Read-only log viewer for one container of the scoped host. It tails the
 * latest lines, can follow live by polling for lines newer than the opaque
 * cursor of the previous read, and never opens a console.
 */
export function ContainerLogs({ id, name }: { id: string; name: string }) {
  const scope = useHostScope();
  const withHost = useRef(scope.withHost);
  useEffect(() => {
    withHost.current = scope.withHost;
  });

  const [count, setCount] = useState(DEFAULT_LOG_LINES);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [following, setFollowing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reload, setReload] = useState(0);
  const cursor = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  // Empties the buffer and the cursor before a new first read.
  function restart() {
    cursor.current = null;
    setLines([]);
    setPhase("loading");
    setError(null);
  }

  // First read: the latest `count` lines. Host and container changes remount
  // the viewer and a new size or refresh restarts it, so a slow answer for
  // anything else is aborted and can never reach the screen.
  useEffect(() => {
    const controller = new AbortController();
    readLogs(
      withHost.current(logsRequestPath({ id, lines: count, cursor: null })),
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        cursor.current = result.cursor;
        setLines(result.lines);
        setPhase("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Error de red");
        setPhase("error");
      });
    return () => controller.abort();
  }, [scope.key, id, count, reload]);

  // Live follow: one request at a time, only for lines after the cursor.
  const polling = following && !paused && phase === "ready";
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let wait = POLL_MS;
      try {
        const result = await readLogs(
          withHost.current(
            logsRequestPath({ id, lines: count, cursor: cursor.current }),
          ),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.cursor) cursor.current = result.cursor;
        if (result.lines.length)
          setLines((previous) => appendLines(previous, result.lines, count));
        if (result.truncated) wait = CATCH_UP_MS;
        setError(null);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Error de red");
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [polling, scope.key, id, count]);

  const visible = useMemo(() => filterLines(lines, filter), [lines, filter]);

  // Keep the newest line in view while following.
  useEffect(() => {
    const element = log.current;
    if (following && element) element.scrollTop = element.scrollHeight;
  }, [visible, following]);

  function download() {
    const blob = new Blob([logsText(visible)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-logs.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section
      className={styles.viewer}
      data-logs=""
      data-phase={phase}
      aria-label={`Logs de ${name}`}
    >
      <div className={styles.controls}>
        <label className={styles.filter}>
          <span className="sr-only">Filtrar logs</span>
          <input
            type="search"
            value={filter}
            placeholder="Filtrar"
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <label className={styles.count}>
          <span>Líneas</span>
          <select
            data-logs-count=""
            value={count}
            onChange={(event) => {
              restart();
              setCount(Number(event.target.value));
            }}
          >
            {LINE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`secondary ${styles.tool}`}
          data-logs-follow=""
          aria-pressed={following}
          onClick={() => {
            setFollowing((value) => !value);
            setPaused(false);
          }}
        >
          <Satellite aria-hidden="true" />
          Seguir en vivo
        </button>
        <button
          type="button"
          className={`secondary ${styles.tool}`}
          data-logs-pause=""
          aria-pressed={paused}
          disabled={!following}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? "Reanudar" : "Pausar"}
        </button>
        <button
          type="button"
          className={`secondary ${styles.tool}`}
          data-logs-refresh=""
          onClick={() => {
            restart();
            setReload((value) => value + 1);
          }}
        >
          <RefreshCw aria-hidden="true" />
          Actualizar
        </button>
        <button
          type="button"
          className={`secondary ${styles.tool}`}
          data-logs-download=""
          disabled={!visible.length}
          onClick={download}
        >
          <Download aria-hidden="true" />
          Descargar
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div
        ref={log}
        className={styles.log}
        role="log"
        tabIndex={0}
        aria-label={`Salida de ${name}`}
        aria-busy={phase === "loading"}
      >
        {visible.map((line, index) => {
          const level = logLevel(line.message);
          return (
            <div
              key={index}
              className={styles.line}
              data-log-line=""
              data-stream={line.stream}
              data-level={level ?? undefined}
            >
              <time className={styles.time} dateTime={line.at ?? undefined}>
                {lineTime(line.at)}
              </time>
              <span className={styles.message}>{line.message}</span>
            </div>
          );
        })}
        {phase === "ready" && !visible.length && (
          <p className={styles.empty}>
            {lines.length ? "Ninguna línea coincide" : "Sin líneas de log"}
          </p>
        )}
      </div>
      <p className={styles.meta}>
        <span>Solo lectura</span>
        <span>
          {filter.trim()
            ? `${visible.length} de ${lines.length} líneas`
            : `${lines.length} líneas`}
        </span>
      </p>
    </section>
  );
}

/** Table row that expands under a container to hold its log viewer. */
export function ContainerLogsRow({
  id,
  name,
  columns,
}: {
  id: string;
  name: string;
  columns: number;
}) {
  const scope = useHostScope();
  return (
    <tr className={styles.row} data-logs-row={name}>
      <td className={styles.cell} colSpan={columns}>
        <ContainerLogs key={`${scope.key}:${id}`} id={id} name={name} />
      </td>
    </tr>
  );
}
