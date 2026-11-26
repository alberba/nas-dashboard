import { unlinkSync } from "node:fs";
import { lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Worker progress health.
 *
 * The worker writes a small private mark inside its own container tmpfs after
 * every completed milestone of the loop that owns the collection lock. The
 * Compose probe only trusts a mark that is parseable, recent, privately owned
 * and still backed by the same boot identity of the live PID: a live process
 * whose loop stopped, or whose PID was reused, is not healthy.
 */

/** Fixed private progress mark of the worker inside its container tmpfs. */
export const WORKER_HEALTH_FILE = "/tmp/nas-dashboard-worker-health.json";
/**
 * A mark older than this means the loop stopped making progress. Docker probes
 * every 30 s with 3 retries, so three missed probes (90 s) cover both the
 * ordinary 25 s agent collection and a 10 s provider request.
 */
export const WORKER_STALE_MS = 90_000;
/** A mark dated further ahead than this is not trustworthy. */
export const WORKER_FUTURE_TOLERANCE_MS = 5_000;
/** The mark never grows beyond this size; the probe rejects anything larger. */
const MAX_MARK_BYTES = 512;

export type WorkerHealthMark = {
  progressAt: number;
  pid: number;
  startedAt: string;
};

export type WorkerHealthReason =
  | "ok"
  | "missing"
  | "unreadable"
  | "unsafe"
  | "malformed"
  | "future"
  | "stale"
  | "dead_pid"
  | "identity_unreadable"
  | "wrong_start";

export type WorkerHealthCheck = {
  ok: boolean;
  reason: WorkerHealthReason;
};

export type WorkerHealthOptions = {
  file?: string;
  pid?: number;
  procRoot?: string;
  now?: () => number;
  /** Re-checked before every renewal so a lost lock never extends health. */
  holdsLock: () => Promise<boolean>;
  /** Injectable boot identity; by default read from `/proc/<pid>/stat`. */
  startIdentity?: () => Promise<string | null>;
  /** Finite operational messages; never includes secrets or file contents. */
  log?: (line: string) => void;
};

/**
 * Boot identity of a PID: field 22 (`starttime`) of `/proc/<pid>/stat`, which
 * a reused PID cannot repeat. Returns null when the process or the field is not
 * readable, and the probe then fails instead of assuming health.
 */
export async function readProcessStartIdentity(
  pid: number,
  procRoot = "/proc",
): Promise<string | null> {
  try {
    const raw = await readFile(join(procRoot, String(pid), "stat"), "utf8");
    // `comm` is parenthesised and may contain spaces: split after its last `)`.
    const end = raw.lastIndexOf(")");
    if (end < 0) return null;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    // fields[0] is field 3 (state); starttime is field 22.
    const startedAt = fields[19];
    return startedAt && /^\d+$/.test(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

/**
 * Writes the mark atomically and privately: a same-directory temporary file
 * with mode 0600 is renamed over the fixed path, so a reader never observes a
 * half-written mark and the file is never world-readable.
 */
export async function writeWorkerHealth(
  file: string,
  mark: WorkerHealthMark,
): Promise<void> {
  const payload = JSON.stringify(mark);
  if (Buffer.byteLength(payload) > MAX_MARK_BYTES)
    throw new Error("La marca de salud es demasiado grande");
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validates the persisted mark without trusting any of its text. */
function parseMark(raw: string): WorkerHealthMark | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const progressAt = value.progressAt;
  const pid = value.pid;
  const startedAt = value.startedAt;
  if (
    typeof progressAt !== "number" ||
    !Number.isFinite(progressAt) ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== "string" ||
    !/^\d{1,24}$/.test(startedAt)
  )
    return null;
  return { progressAt, pid, startedAt };
}

/**
 * Read-only probe used by Docker. It never starts work, contacts a network or
 * touches the database: it only reads the private mark and the local `/proc`.
 */
export async function checkWorkerHealth(
  options: { file?: string; procRoot?: string; now?: number } = {},
): Promise<WorkerHealthCheck> {
  const file = options.file ?? WORKER_HEALTH_FILE;
  const procRoot = options.procRoot ?? "/proc";
  const now = options.now ?? Date.now();

  let info;
  try {
    info = await lstat(file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (info.isSymbolicLink()) return { ok: false, reason: "unsafe" };
  if (!info.isFile()) return { ok: false, reason: "unreadable" };
  if ((info.mode & 0o077) !== 0) return { ok: false, reason: "unsafe" };
  if (info.size > MAX_MARK_BYTES) return { ok: false, reason: "malformed" };

  let mark: WorkerHealthMark | null;
  try {
    mark = parseMark(await readFile(file, "utf8"));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!mark) return { ok: false, reason: "malformed" };

  if (mark.progressAt > now + WORKER_FUTURE_TOLERANCE_MS)
    return { ok: false, reason: "future" };
  if (now - mark.progressAt > WORKER_STALE_MS)
    return { ok: false, reason: "stale" };

  try {
    if (!(await stat(join(procRoot, String(mark.pid)))).isDirectory())
      return { ok: false, reason: "dead_pid" };
  } catch {
    return { ok: false, reason: "dead_pid" };
  }
  const startedAt = await readProcessStartIdentity(mark.pid, procRoot);
  if (!startedAt) return { ok: false, reason: "identity_unreadable" };
  if (startedAt !== mark.startedAt) return { ok: false, reason: "wrong_start" };
  return { ok: true, reason: "ok" };
}

/**
 * Writer used by the worker loop. `renew` is a no-op after a lost lock or a
 * close, so neither the shutdown path nor a repeated error can leave a
 * healthy mark behind a stopped loop.
 */
export class WorkerHealth {
  private readonly file: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly holdsLock: () => Promise<boolean>;
  private readonly identity: () => Promise<string | null>;
  private readonly log?: (line: string) => void;
  private lastReported: boolean | null = null;
  private closed = false;

  constructor(options: WorkerHealthOptions) {
    const procRoot = options.procRoot ?? "/proc";
    this.file = options.file ?? WORKER_HEALTH_FILE;
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.holdsLock = options.holdsLock;
    this.identity =
      options.startIdentity ??
      (() => readProcessStartIdentity(this.pid, procRoot));
    this.log = options.log;
  }

  private report(ok: boolean, reason: string) {
    if (this.lastReported === ok) return;
    this.lastReported = ok;
    this.log?.(
      ok
        ? "Marca de salud del worker actualizada"
        : `Marca de salud del worker no disponible (${reason})`,
    );
  }

  /** Publishes a milestone only while the lock is still held. */
  async renew(): Promise<boolean> {
    if (this.closed) return false;
    if (!(await this.holdsLock())) {
      this.report(false, "lock_lost");
      return false;
    }
    const startedAt = await this.identity();
    if (!startedAt) {
      this.report(false, "identity_unreadable");
      return false;
    }
    try {
      await writeWorkerHealth(this.file, {
        progressAt: this.now(),
        pid: this.pid,
        startedAt,
      });
      this.report(true, "ok");
      return true;
    } catch {
      this.report(false, "write_failed");
      return false;
    }
  }

  /** Removes a mark before the first lock is taken or after a voluntary stop. */
  invalidateSync(): void {
    try {
      unlinkSync(this.file);
    } catch {
      // No mark means the probe already reports missing.
    }
  }

  async invalidate(): Promise<void> {
    await unlink(this.file).catch(() => {});
  }

  /** Shutdown or lock loss: no later renewal may recreate a healthy mark. */
  closeSync(): void {
    this.closed = true;
    this.invalidateSync();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.invalidate();
  }
}
