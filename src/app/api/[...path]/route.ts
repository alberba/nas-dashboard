import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { auth, bootstrapAuth, origins } from "@/lib/auth";
import { db, pool } from "@/lib/db";
import {
  alerts,
  operations,
  presence,
  samples,
  subscriptions,
  user,
} from "@/lib/schema";
import { getSettings, saveSettings } from "@/lib/settings";
import { actionSchema, settingsSchema } from "@/lib/validation";
import { nas, NasRejected } from "@/lib/nas";
import { notify } from "@/lib/push";
import type { Metrics } from "@/lib/types";

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
        .parse(await request.json());
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

    if (route === "overview" && !mutation) {
      const [latest] = await db
        .select()
        .from(samples)
        .orderBy(desc(samples.at))
        .limit(1);
      const recentAlerts = await db
        .select()
        .from(alerts)
        .orderBy(desc(alerts.at))
        .limit(100);
      const recentOperations = await db
        .select()
        .from(operations)
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
          avg((data->'network'->>'rx')::float) AS rx, avg((data->'network'->>'tx')::float) AS tx
          FROM samples WHERE at > now() - make_interval(secs => ${seconds}) GROUP BY 1)
        SELECT series.at, grouped.cpu, grouped.memory, grouped.rx, grouped.tx FROM series LEFT JOIN grouped USING(at) ORDER BY series.at`);
      return json({
        latest: latest?.data ?? null,
        lastAt: latest?.at ?? null,
        connected: Boolean(latest && Date.now() - latest.at.getTime() < 75000),
        interval: active ? 5 : 30,
        alerts: recentAlerts,
        operations: recentOperations,
        history: history.rows,
        settings: await getSettings(),
      });
    }
    if (route === "presence" && mutation) {
      const input = z
        .object({ id: z.uuid(), visible: z.boolean() })
        .parse(await request.json());
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
      const body = actionSchema.parse(await request.json());
      const operationId = z
        .uuid()
        .parse(request.headers.get("idempotency-key"));
      const [existing] = await db
        .select()
        .from(operations)
        .where(eq(operations.id, operationId));
      if (existing) return json(existing);
      const latest = await db
        .select()
        .from(samples)
        .orderBy(desc(samples.at))
        .limit(1);
      if (!latest[0] || Date.now() - latest[0].at.getTime() > 75000)
        return json(
          { error: "El NAS no está conectado. No se ha enviado la acción." },
          503,
        );
      const target =
        "id" in body ? body.id : "path" in body ? body.path : "NAS";
      const inserted = await db
        .insert(operations)
        .values({
          id: operationId,
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
        const result = await nas<{ state?: string }>("/action", body);
        const status = body.action === "reboot" ? "pending" : "success";
        await db
          .update(operations)
          .set({
            status,
            detail:
              status === "pending"
                ? "Reinicio solicitado; esperando que el NAS vuelva a responder."
                : "Operación completada y comprobada.",
          })
          .where(eq(operations.id, operationId));
        if (
          ["start", "stop", "restart"].includes(body.action) &&
          "id" in body
        ) {
          const settings = await getSettings();
          const metrics = latest[0].data as Metrics;
          const name = metrics.containers.find((c) => c.id === body.id)?.name;
          if (name) {
            settings.expectedContainers = settings.expectedContainers.filter(
              (n) => n !== name,
            );
            if (body.action !== "stop") settings.expectedContainers.push(name);
            await saveSettings(settings);
            if (body.action === "stop")
              await db
                .update(alerts)
                .set({ resolvedAt: new Date() })
                .where(
                  and(
                    eq(alerts.key, "container:" + name),
                    sql`${alerts.resolvedAt} IS NULL`,
                  ),
                );
          }
        }
        return json({ ok: true, status, result });
      } catch (error) {
        if (error instanceof NasRejected && error.status < 500) {
          await db
            .update(operations)
            .set({ status: "failed", detail: error.message })
            .where(eq(operations.id, operationId));
          return json({ error: error.message, status: "failed" }, 400);
        }
        // A timeout may occur after the NAS executed the action. Never retry it automatically.
        await db
          .update(operations)
          .set({
            detail:
              "No se pudo confirmar el resultado. Comprueba el estado antes de repetir.",
          })
          .where(eq(operations.id, operationId));
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
      const root = z
        .enum(["media", "torrents"])
        .parse(request.nextUrl.searchParams.get("root") ?? "media");
      const path = z
        .string()
        .max(2048)
        .parse(request.nextUrl.searchParams.get("path") ?? "");
      return json(
        await nas(`/files?root=${root}&path=${encodeURIComponent(path)}`),
      );
    }
    if (route === "trash" && !mutation) return json(await nas("/trash"));
    if (route === "settings" && mutation) {
      const input = settingsSchema.parse(await request.json());
      await saveSettings({ ...(await getSettings()), ...input });
      return json({ ok: true });
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
        .parse(await request.json());
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
      await notify(
        "hub. conectado",
        "Las notificaciones del NAS están activadas en este dispositivo.",
        "test",
      );
      return json({ ok: true });
    }
    if (route === "push" && request.method === "DELETE") {
      const { endpoint } = z
        .object({ endpoint: z.url() })
        .parse(await request.json());
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
