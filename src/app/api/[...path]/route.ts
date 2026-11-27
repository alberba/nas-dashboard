import { NextRequest, NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auth, bootstrapAuth, origins } from "@/lib/auth";
import { db, pool } from "@/lib/db";
import {
  alerts,
  notificationOutbox,
  operations,
  presence,
  samples,
  subscriptions,
  user,
} from "@/lib/schema";
import { getSettings, mutateSettings } from "@/lib/settings";
import { pendingWatch } from "@/lib/container-watch";
import { actionSchema, settingsSchema } from "@/lib/validation";
import { requiresVerificationForAction } from "@/lib/sensitive-actions";
import {
  logsResponseSchema,
  parseLogsQuery,
} from "@/lib/logs";
import {
  guardSensitiveAction,
  handlePasswordVerification,
  handleVerificationStatus,
} from "@/lib/verification-api";
import {
  finalizeContainerOperation,
  publicOperation,
  removeContainer,
  updatePendingOperation,
} from "@/lib/lifecycle";
import { verificationStore } from "@/lib/verification";
import { nasForHost, NasRejected, CONTAINER_UPDATE_TIMEOUT_MS } from "@/lib/nas";
import {
  getHosts,
  primaryHost,
  publicHost,
  resolveHost,
  HostConfigError,
  HostNotFound,
  type HostConfig,
} from "@/lib/hosts";
import { deploymentsForHost } from "@/lib/deployments";
import { eventsForHost } from "@/lib/events";
import { saveDeploymentSettings } from "@/lib/deployment-settings";
import { hostStatuses } from "@/lib/host-status";
import { maintenanceForHost } from "@/lib/maintenance";
import { runHostCommand } from "@/lib/host-commands";
import { BodyTooLarge, readJsonBody } from "@/lib/request-body";
import { projectIncidents } from "@/lib/incident-store";
import {
  applyIncidentAction,
  type IncidentActionInput,
} from "@/lib/incident-actions";
import {
  fetchRenovatePullRequests,
  githubConfig,
  GithubConfigError,
  GithubUnavailable,
  relatePullRequests,
} from "@/lib/github";
import { projectDigestOverview, type DigestOverview } from "@/lib/digest-runs";
import { deployProgressForHost } from "@/lib/deploy-progress";
import { mergeRenovatePullRequest } from "@/lib/renovate-merge";
import type { Metrics, RenovateContainer, Settings } from "@/lib/types";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
const ranges = {
  "1h": [3600, 30],
  "6h": [21600, 60],
  "24h": [86400, 120],
  "7d": [604800, 900],
  "30d": [2592000, 3600],
} as const;

/** Public settings never expose the internal inventory watch metadata. */
function publicSettings(settings: Settings) {
  const visible = { ...settings };
  delete visible.watch;
  return visible;
}

function requestHost(value: unknown): string | null {
  if (value && typeof value === "object" && "host" in value) {
    const host = (value as { host?: unknown }).host;
    if (typeof host === "string" && host) return host;
  }
  return null;
}

/** Containers that Docker Compose created, with the labels used to join a PR. */
async function renovateContainers(hosts: HostConfig[]) {
  const result: RenovateContainer[] = [];
  for (const host of hosts) {
    const [latest] = await db
      .select({ data: samples.data })
      .from(samples)
      .where(eq(samples.hostId, host.id))
      .orderBy(desc(samples.at))
      .limit(1);
    const containers = (latest?.data as Metrics | undefined)?.containers ?? [];
    for (const container of containers) {
      const project = container.composeProject ?? container.compose?.project;
      const service = container.composeService ?? container.compose?.service;
      if (!project || !service) continue;
      result.push({
        hostId: host.id,
        id: container.id,
        name: container.name,
        image: container.image,
        project,
        service,
      });
    }
  }
  return result;
}

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const route = (await context.params).path.join("/");
  const mutation = request.method !== "GET";
  if (mutation && !origins.includes(request.headers.get("origin") ?? ""))
    return json({ error: "Origen no autorizado" }, 403);
  try {
    if (route === "setup") {
      const [{ value }] = await db.select({ value: count() }).from(user);
      if (!mutation) return json({ required: value === 0 });
      if (value !== 0)
        return json({ error: "La cuenta ya está configurada" }, 403);
      const input = z
        .object({
          token: z.string().min(32).max(256),
          email: z.email(),
          password: z.string().min(12).max(128),
          name: z.string().min(1).max(80),
        })
        .parse(await readJsonBody(request));
      const expected = Buffer.from(process.env.SETUP_TOKEN ?? "");
      const provided = Buffer.from(input.token);
      if (
        expected.length < 32 ||
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      )
        return json({ error: "Código de configuración no válido" }, 403);
      const conn = await pool.connect();
      try {
        await conn.query("SELECT pg_advisory_lock(734922)");
        const check = await conn.query('SELECT count(*)::int AS n FROM "user"');
        if (check.rows[0].n > 0)
          return json({ error: "La cuenta ya está configurada" }, 403);
        await bootstrapAuth.api.signUpEmail({
          body: {
            email: input.email,
            password: input.password,
            name: input.name,
          },
        });
        return json({ ok: true });
      } finally {
        await conn.query("SELECT pg_advisory_unlock(734922)");
        conn.release();
      }
    }
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current) return json({ error: "Inicia sesión para continuar" }, 401);

    if (route === "verification" && !mutation)
      return handleVerificationStatus({
        request,
        session: current,
        store: verificationStore,
      });
    if (route === "verification/password" && request.method === "POST")
      // `await` keeps a rethrown BodyTooLarge inside this try, so it reaches
      // the 413 branch instead of escaping as an unhandled rejection.
      return await handlePasswordVerification({
        request,
        session: current,
        store: verificationStore,
        verifyPassword: (input) => auth.api.verifyPassword(input),
      });
    if (route === "containers/remove" && request.method === "POST") {
      const removed = await removeContainer({
        request,
        session: current,
        hosts: getHosts(),
      });
      return removed;
    }
    if (route === "hosts" && !mutation) {
      const hosts = getHosts();
      return json({
        default: primaryHost(hosts).id,
        hosts: await hostStatuses(hosts),
      });
    }
    if (route === "maintenance" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      return json(await maintenanceForHost(host));
    }
    if (route === "host-command" && request.method === "POST") {
      return await runHostCommand({
        request,
        session: current,
        hosts: getHosts(),
      });
    }
    if (route === "deployments" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      const lines = z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .parse(request.nextUrl.searchParams.get("lines") ?? "100");
      return json(await deploymentsForHost(host, lines));
    }
    if (route === "events" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      return json(await eventsForHost(host));
    }
    const incidentRoute = /^incidents\/([^/]+)$/.exec(route);
    if (incidentRoute && !mutation) {
      // A point lookup needs both an explicit configured host and a safe id;
      // a missing pair is not enough to fall back to another host's episode.
      const hostParam = request.nextUrl.searchParams.get("host");
      if (!hostParam) return json({ error: "No encontrado" }, 404);
      const id = z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .safeParse(incidentRoute[1]);
      if (!id.success) return json({ error: "No encontrado" }, 404);
      const incidentId = Number(id.data);
      // `incidents.id` is a PostgreSQL integer; an out-of-range id is simply
      // not found instead of reaching the database as a 503.
      if (!Number.isSafeInteger(incidentId) || incidentId > 2_147_483_647)
        return json({ error: "No encontrado" }, 404);
      const hosts = getHosts();
      const host = resolveHost(hosts, hostParam);
      const [row] = await db
        .select()
        .from(alerts)
        .where(
          and(eq(alerts.id, incidentId), eq(alerts.hostId, host.id)),
        )
        .limit(1);
      if (!row) return json({ error: "No encontrado" }, 404);
      const projected = await projectIncidents([row]);
      const [open] = await db
        .select({ value: count() })
        .from(alerts)
        .where(
          and(eq(alerts.hostId, host.id), isNull(alerts.resolvedAt)),
        );
      return json({
        host: publicHost(host),
        incident: projected[0] ?? null,
        alerts: projected,
        openAlerts: open.value,
      });
    }
    // Operator actions from the hub. The common guards already required a
    // session and an allowed Origin, so this branch only adds the strict body,
    // the exact host/id pair and the shared action itself (T-05-13, T-05-14).
    const incidentActionRoute =
      /^incidents\/([^/]+)\/(acknowledge|snooze|unsnooze)$/.exec(route);
    if (incidentActionRoute && request.method === "POST") {
      const action = incidentActionRoute[2];
      // Same id contract as the point lookup: a malformed or out-of-range id
      // is simply not found instead of reaching the database as a 503.
      const id = z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .safeParse(incidentActionRoute[1]);
      if (!id.success) return json({ error: "No encontrado" }, 404);
      const incidentId = Number(id.data);
      if (!Number.isSafeInteger(incidentId) || incidentId > 2_147_483_647)
        return json({ error: "No encontrado" }, 404);
      // Strict body: the host and, only for a silence, a duration of the
      // closed set. An unknown field or a foreign duration writes nothing.
      const body = z
        .strictObject({
          host: z.string().min(1).max(64),
          hours: z.union([z.literal(1), z.literal(24)]).optional(),
        })
        .refine(
          (value) =>
            action === "snooze"
              ? value.hours !== undefined
              : value.hours === undefined,
          {
            message: "La duración no corresponde a la acción",
            path: ["hours"],
          },
        )
        .parse(await readJsonBody(request));
      const host = resolveHost(getHosts(), body.host);
      // The pair, never the id alone: another host's episode is not found.
      const [row] = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.id, incidentId), eq(alerts.hostId, host.id)))
        .limit(1);
      if (!row) return json({ error: "No encontrado" }, 404);
      const now = Date.now();
      // The session name is the actor of a hub action; Telegram leaves it null.
      const by = current.user.name.trim().slice(0, 80);
      let input: IncidentActionInput;
      if (action === "snooze") {
        if (body.hours === undefined)
          return json(
            { error: "La duración no corresponde a la acción" },
            400,
          );
        input = {
          action: "snooze",
          hours: body.hours,
          incidentId,
          via: "hub",
          by,
          now,
        };
      } else if (action === "acknowledge") {
        input = { action: "ack", incidentId, via: "hub", by, now };
      } else {
        input = { action: "unsnooze", incidentId, via: "hub", by, now };
      }
      const outcome = await db.transaction((tx) =>
        applyIncidentAction(tx, input),
      );
      if (outcome === "not_found")
        return json({ error: "No encontrado" }, 404);
      if (outcome === "resolved")
        return json({ error: "La incidencia ya está resuelta" }, 409);
      // The projection re-reads the row after the action, so the response and
      // the list agree on the new state, its silence and its acknowledgement.
      const [updated] = await db
        .select()
        .from(alerts)
        .where(eq(alerts.id, incidentId))
        .limit(1);
      const [incident] = updated ? await projectIncidents([updated]) : [];
      return json({ outcome, incident: incident ?? null });
    }
    if (route === "deployments/settings" && request.method === "POST") {
      return await saveDeploymentSettings({
        request,
        session: current,
        hosts: getHosts(),
      });
    }
    if (route === "renovate" && !mutation) {
      const config = githubConfig();
      if (!config)
        return json({ enabled: false, repository: null, prs: [] });
      const hosts = getHosts();
      const selected = request.nextUrl.searchParams.get("host");
      const scope = selected ? [resolveHost(hosts, selected)] : hosts;
      const containers = await renovateContainers(scope);
      const prs = await fetchRenovatePullRequests(config);
      return json({
        enabled: true,
        repository: config.repository,
        prs: relatePullRequests(prs, containers),
      });
    }
    if (route === "renovate/merge" && request.method === "POST") {
      return await mergeRenovatePullRequest({
        request,
        session: current,
        hosts: getHosts(),
      });
    }
    if (route === "renovate/progress" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      const config = githubConfig();
      if (!config)
        return json({
          enabled: false,
          repository: null,
          host: publicHost(host),
          snapshotAvailable: false,
          updates: [],
        });
      return json(await deployProgressForHost({ config, host }));
    }
    if (route === "overview" && !mutation) {
      const hosts = getHosts();
      const host = resolveHost(
        hosts,
        request.nextUrl.searchParams.get("host"),
      );
      const [latest] = await db
        .select()
        .from(samples)
        .where(eq(samples.hostId, host.id))
        .orderBy(desc(samples.at))
        .limit(1);
      const recentAlerts = await projectIncidents(
        await db
          .select()
          .from(alerts)
          .where(eq(alerts.hostId, host.id))
          .orderBy(desc(alerts.at))
          .limit(100),
      );
      const [openAlerts] = await db
        .select({ value: count() })
        .from(alerts)
        .where(
          and(eq(alerts.hostId, host.id), isNull(alerts.resolvedAt)),
        );
      const recentOperations = await db
        .select()
        .from(operations)
        .where(eq(operations.hostId, host.id))
        .orderBy(desc(operations.at))
        .limit(30);
      const [active] = await db
        .select()
        .from(presence)
        .where(gt(presence.expiresAt, new Date()))
        .limit(1);
      const range = z
        .enum(["1h", "6h", "24h", "7d", "30d"])
        .catch("1h")
        .parse(request.nextUrl.searchParams.get("range"));
      const [seconds, bucket] = ranges[range];
      const history = await db.execute(sql`
        WITH series AS (SELECT generate_series(
          date_bin(make_interval(secs => ${bucket}), now() - make_interval(secs => ${seconds}), timestamp '2000-01-01'),
          date_bin(make_interval(secs => ${bucket}), now(), timestamp '2000-01-01'), make_interval(secs => ${bucket})) AS at),
        grouped AS (SELECT date_bin(make_interval(secs => ${bucket}), at, timestamp '2000-01-01') AS at,
          avg((data->>'cpu')::float) AS cpu,
          avg((data->'memory'->>'used')::float / nullif((data->'memory'->>'total')::float, 0) * 100) AS memory,
          avg((data->'memory'->'swap'->>'used')::float / nullif((data->'memory'->'swap'->>'total')::float, 0) * 100) AS swap,
          avg((data->'network'->>'rx')::float) AS rx, avg((data->'network'->>'tx')::float) AS tx,
          avg((data->'io'->>'read')::float) AS "ioRead", avg((data->'io'->>'write')::float) AS "ioWrite",
          avg((data->'load'->>0)::float) AS "load1",
          avg((data->'load'->>1)::float) AS "load5",
          avg((data->'load'->>2)::float) AS "load15",
          avg((data->'io'->'latency'->>'readMs')::float) AS "readAwait",
          avg((data->'io'->'latency'->>'writeMs')::float) AS "writeAwait",
          avg((data->'io'->'latency'->>'utilization')::float) AS "utilization"
          FROM samples WHERE "hostId" = ${host.id} AND at > now() - make_interval(secs => ${seconds}) GROUP BY 1)
        SELECT series.at, grouped.cpu, grouped.memory, grouped.swap, grouped.rx, grouped.tx,
          grouped."ioRead", grouped."ioWrite", grouped."load1", grouped."load5", grouped."load15",
          grouped."readAwait", grouped."writeAwait", grouped."utilization"
        FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`);
      const statuses = await hostStatuses(hosts);
      const settings = await getSettings(host.id);
      // The digest belongs to the hub, not to the selected host: the same
      // finite projection answers for every host of the overview.
      let digest: DigestOverview | null = null;
      try {
        digest = await projectDigestOverview(
          { query: (text, values) => pool.query(text, values) },
          Date.now(),
        );
      } catch {
        // A read-only panel must not take the whole dashboard down.
        console.error("No se pudo leer el estado del resumen diario");
      }
      return json({
        host: publicHost(host),
        hosts: statuses,
        latest: latest?.data ?? null,
        lastAt: latest?.at ?? null,
        connected:
          statuses.find((status) => status.id === host.id)?.connected ?? false,
        interval: active ? 5 : 30,
        alerts: recentAlerts,
        openAlerts: openAlerts.value,
        digest,
        watchPending: pendingWatch(settings),
        operations: recentOperations.map(publicOperation),
        history: history.rows,
        settings: publicSettings(settings),
      });
    }
    if (route === "container-history" && !mutation) {
      const hosts = getHosts();
      const host = resolveHost(
        hosts,
        request.nextUrl.searchParams.get("host"),
      );
      const name = z
        .string()
        .min(1)
        .max(200)
        .safeParse(request.nextUrl.searchParams.get("name"));
      if (!name.success)
        return json({ error: "Contenedor no válido" }, 400);
      const range = z
        .enum(["1h", "6h", "24h", "7d", "30d"])
        .catch("1h")
        .parse(request.nextUrl.searchParams.get("range"));
      const [seconds, bucket] = ranges[range];
      const history = await db.execute(sql`
        WITH series AS (SELECT generate_series(
          date_bin(make_interval(secs => ${bucket}), now() - make_interval(secs => ${seconds}), timestamp '2000-01-01'),
          date_bin(make_interval(secs => ${bucket}), now(), timestamp '2000-01-01'), make_interval(secs => ${bucket})) AS at),
        grouped AS (SELECT date_bin(make_interval(secs => ${bucket}), s.at, timestamp '2000-01-01') AS at,
          avg((c->>'cpu')::float) AS cpu,
          avg((c->>'memory')::float) AS memory,
          avg((c->'network'->>'rx')::float) AS rx,
          avg((c->'network'->>'tx')::float) AS tx
          FROM samples s
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(s.data->'containers') = 'array'
              THEN s.data->'containers' ELSE '[]'::jsonb END
          ) c
          WHERE s."hostId" = ${host.id}
            AND s.at > now() - make_interval(secs => ${seconds})
            AND c->>'name' = ${name.data}
          GROUP BY 1)
        SELECT series.at, grouped.cpu, grouped.memory, grouped.rx, grouped.tx
        FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`);
      return json({
        host: publicHost(host),
        name: name.data,
        history: history.rows,
      });
    }
    if (route === "presence" && mutation) {
      const input = z
        .object({ id: z.uuid(), visible: z.boolean() })
        .parse(await readJsonBody(request));
      if (input.visible) {
        await db
          .insert(presence)
          .values({
            id: input.id,
            userId: current.user.id,
            expiresAt: new Date(Date.now() + 45000),
          })
          .onConflictDoUpdate({
            target: presence.id,
            set: {
              expiresAt: new Date(Date.now() + 45000),
              userId: current.user.id,
            },
          });
      } else
        await db
          .delete(presence)
          .where(
            and(
              eq(presence.id, input.id),
              eq(presence.userId, current.user.id),
            ),
          );
      return json({ ok: true });
    }
    if (route === "action" && mutation) {
      const raw = await readJsonBody(request);
      const body = actionSchema.parse(raw);
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host") ?? requestHost(raw),
      );
      const operationId = z
        .uuid()
        .parse(request.headers.get("idempotency-key"));
      const [existing] = await db
        .select()
        .from(operations)
        .where(eq(operations.id, operationId));
      if (existing) {
        if (existing.hostId !== host.id)
          return json(
            { error: "La clave de idempotencia ya se usó en otro host" },
            409,
          );
        return json(publicOperation(existing));
      }
      // The manifest decides, not a hardcoded action: a new protected action
      // is guarded as soon as it is declared. A 403 here records no operation
      // and sends nothing to the agent, so the UI can retry with the same key.
      if (requiresVerificationForAction(body.action)) {
        const denied = await guardSensitiveAction({
          request,
          session: current,
          store: verificationStore,
        });
        if (denied) return denied;
      }
      const latest = await db
        .select()
        .from(samples)
        .where(eq(samples.hostId, host.id))
        .orderBy(desc(samples.at))
        .limit(1);
      if (!latest[0] || Date.now() - latest[0].at.getTime() > 75000)
        return json(
          {
            error: `${host.name} no está conectado. No se ha enviado la acción.`,
          },
          503,
        );
      const target =
        "id" in body ? body.id : "path" in body ? body.path : host.name;
      const inserted = await db
        .insert(operations)
        .values({
          id: operationId,
          hostId: host.id,
          userId: current.user.id,
          action: body.action,
          target,
          status: "pending",
          bootAt:
            body.action === "reboot"
              ? new Date(
                  (latest[0].data.timestamp - latest[0].data.uptime) * 1000,
                )
              : null,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return json({ status: "pending" });
      try {
        const result = await nasForHost<{ state?: string }>(
          host,
          "/action",
          body,
          body.action === "update-container"
            ? CONTAINER_UPDATE_TIMEOUT_MS
            : undefined,
        );
        if (body.action === "reboot") {
          await db
            .update(operations)
            .set({
              status: "pending",
              detail:
                "Reinicio solicitado; esperando que el host vuelva a responder.",
            })
            .where(eq(operations.id, operationId));
          return json({ ok: true, status: "pending", result });
        }
        if (
          (body.action === "start" ||
            body.action === "stop" ||
            body.action === "restart") &&
          "id" in body
        ) {
          const metrics = latest[0].data as Metrics;
          const container = metrics.containers.find(
            (c) => c.id === body.id,
          );
          if (container) {
            // The shared close-out locks the operation and the settings row,
            // applies the watching intention and closes the episode once.
            await finalizeContainerOperation({
              hostId: host.id,
              hostName: host.name,
              operationId,
              action: body.action,
              name: container.name,
              containerId: body.id,
              container,
              detail: "Operación completada y comprobada.",
            });
            return json({ ok: true, status: "success", result });
          }
          await db
            .update(operations)
            .set({
              status: "success",
              detail: "Operación completada y comprobada.",
            })
            .where(eq(operations.id, operationId));
          return json({ ok: true, status: "success", result });
        }
        await db
          .update(operations)
          .set({
            status: "success",
            detail:
              body.action === "update-container"
                ? "Contenedor actualizado: imagen descargada y servicio recreado."
                : "Operación completada y comprobada.",
          })
          .where(eq(operations.id, operationId));
        return json({ ok: true, status: "success", result });
      } catch (error) {
        if (error instanceof NasRejected && error.status < 500) {
          const { updated, operation } = await updatePendingOperation(operationId, {
            status: "failed",
            detail: error.message,
          });
          if (!updated && operation) return json(operation);
          return json({ error: error.message, status: "failed" }, 400);
        }
        // A timeout may occur after the NAS executed the action. Never retry it automatically.
        const { updated, operation } = await updatePendingOperation(operationId, {
          detail:
            "No se pudo confirmar el resultado. Comprueba el estado antes de repetir.",
        });
        if (!updated && operation) return json(operation);
        return json(
          {
            error:
              "Resultado pendiente de verificar. No se ha repetido la acción.",
            status: "pending",
          },
          502,
        );
      }
    }
    if (route === "files" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      const root = z
        .enum(["media", "torrents"])
        .parse(request.nextUrl.searchParams.get("root") ?? "media");
      const path = z
        .string()
        .max(2048)
        .parse(request.nextUrl.searchParams.get("path") ?? "");
      return json(
        await nasForHost(
          host,
          `/files?root=${root}&path=${encodeURIComponent(path)}`,
        ),
      );
    }
    if (route === "trash" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      return json(await nasForHost(host, "/trash"));
    }
    if (route === "logs" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      const input = parseLogsQuery(request.nextUrl.searchParams);
      const query = new URLSearchParams({
        id: input.id,
        lines: String(input.lines),
      });
      if (input.since) query.set("since", input.since);
      const result = logsResponseSchema.safeParse(
        await nasForHost(host, `/logs?${query.toString()}`),
      );
      if (!result.success) throw new Error("Respuesta de logs no válida");
      return json({ host: publicHost(host), ...result.data });
    }
    if (route === "settings" && !mutation) {
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host"),
      );
      return json({
        host: publicHost(host),
        settings: publicSettings(await getSettings(host.id)),
      });
    }
    if (route === "settings" && mutation) {
      const raw = await readJsonBody(request);
      const host = resolveHost(
        getHosts(),
        request.nextUrl.searchParams.get("host") ?? requestHost(raw),
      );
      // `host` may travel in the body, but the watch metadata never does:
      // the schema is strict and only thresholds reach the settings row.
      const input = settingsSchema.parse(
        raw && typeof raw === "object"
          ? Object.fromEntries(
              Object.entries(raw as Record<string, unknown>).filter(
                ([key]) => key !== "host",
              ),
            )
          : raw,
      );
      await mutateSettings(host.id, (current) => ({ ...current, ...input }));
      return json({
        host: publicHost(host),
        settings: publicSettings(await getSettings(host.id)),
      });
    }
    if (route === "push" && !mutation)
      return json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
    if (route === "push" && request.method === "POST") {
      const body = z
        .object({
          endpoint: z
            .url()
            .refine(
              (v) =>
                new URL(v).protocol === "https:" &&
                /(^|\.)(googleapis\.com|mozilla\.com|mozilla\.org|apple\.com|windows\.com|microsoft\.com)$/.test(
                  new URL(v).hostname,
                ),
            ),
          keys: z.object({
            p256dh: z.string().min(20).max(256),
            auth: z.string().min(10).max(128),
          }),
        })
        .parse(await readJsonBody(request));
      await db
        .insert(subscriptions)
        .values({ ...body, userId: current.user.id })
        .onConflictDoUpdate({
          target: subscriptions.endpoint,
          set: { keys: body.keys, userId: current.user.id },
        });
      return json({ ok: true });
    }
    if (route === "push/test" && mutation) {
      // The route only records durable work: the worker owns delivery and
      // scopes it to the subscriptions of the authenticated session owner.
      const [job] = await db
        .insert(notificationOutbox)
        .values({
          key: `push-test:${randomUUID()}`,
          ownerUserId: current.user.id,
          kind: "push-test",
          channel: "push",
          status: "pending",
        })
        .returning({ id: notificationOutbox.id });
      return json({ ok: true, queued: true, jobId: job.id }, 202);
    }
    if (route === "push" && request.method === "DELETE") {
      const { endpoint } = z
        .object({ endpoint: z.url() })
        .parse(await readJsonBody(request));
      await db
        .delete(subscriptions)
        .where(
          and(
            eq(subscriptions.endpoint, endpoint),
            eq(subscriptions.userId, current.user.id),
          ),
        );
      return json({ ok: true });
    }
    return json({ error: "No encontrado" }, 404);
  } catch (error) {
    // First on purpose: an oversized body leaves no operation, incident or log
    // line (D-09), and no later branch may turn it into a 400 or a 503.
    if (error instanceof BodyTooLarge)
      return json({ error: "La solicitud es demasiado grande." }, 413);
    if (error instanceof HostNotFound)
      return json({ error: "Host no configurado" }, 404);
    if (error instanceof HostConfigError)
      return json(
        { error: "La configuración de hosts del servidor no es válida" },
        503,
      );
    if (error instanceof GithubConfigError)
      return json(
        { error: "La configuración de GitHub del servidor no es válida" },
        503,
      );
    if (error instanceof GithubUnavailable) {
      console.error("GitHub error", error.status);
      return json(
        { error: "GitHub no está disponible. Inténtalo de nuevo más tarde." },
        503,
      );
    }
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues[0]?.message ?? "Datos no válidos" },
        400,
      );
    console.error("API error", error instanceof Error ? error.name : "unknown");
    return json(
      {
        error:
          "No se pudo completar la solicitud. Comprueba la conexión e inténtalo de nuevo.",
      },
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
