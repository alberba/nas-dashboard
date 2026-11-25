-- 0004 · incidents: identity, timeline and transactional outbox.
--
-- The rename keeps every existing id, timestamp and column, so the identity
-- sequence and all historical closures survive (T-02-01). Run the database
-- migration only while the old app and worker are stopped: they still read
-- "alerts" by name.
ALTER TABLE "alerts" RENAME TO "incidents";--> statement-breakpoint
ALTER SEQUENCE "alerts_id_seq" RENAME TO "incidents_id_seq";--> statement-breakpoint

-- New columns stay nullable or defaulted while the historical rows are filled.
ALTER TABLE "incidents" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "origin" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "closedBy" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "previousResolvedAt" timestamp;--> statement-breakpoint

-- Stable identity of the watched condition. The length prefixes make the
-- concatenation unambiguous for any (hostId, key) pair: the same pair always
-- produces the same fingerprint and no two different pairs collide.
UPDATE "incidents"
SET "fingerprint" = md5(
  'incident:' || length("hostId")::text || ':' || "hostId" || ':' ||
  length("key")::text || ':' || "key"
);--> statement-breakpoint

-- D-03: episodes already open before this advance are legacy. Their first
-- observation, and any later severity change, must never enqueue a notice.
UPDATE "incidents" SET "origin" = 'legacy' WHERE "resolvedAt" IS NULL;--> statement-breakpoint

-- At most one open episode per (hostId, key). Keep the newest row (at DESC,
-- id DESC) and close the rest with an explicit synthetic mark. The original
-- resolvedAt is preserved so the reverse migration only undoes these closures.
WITH ranked AS (
  SELECT "id",
    row_number() OVER (
      PARTITION BY "hostId", "key"
      ORDER BY "at" DESC, "id" DESC
    ) AS position
  FROM "incidents"
  WHERE "resolvedAt" IS NULL
)
UPDATE "incidents" AS incident
SET "resolvedAt" = now(),
    "closedBy" = 'migration-dedup',
    "previousResolvedAt" = incident."resolvedAt"
FROM ranked
WHERE incident."id" = ranked."id" AND ranked.position > 1;--> statement-breakpoint

ALTER TABLE "incidents" ALTER COLUMN "fingerprint" SET NOT NULL;--> statement-breakpoint

ALTER INDEX "alerts_key_idx" RENAME TO "incidents_key_idx";--> statement-breakpoint
ALTER INDEX "alerts_at_idx" RENAME TO "incidents_at_idx";--> statement-breakpoint
ALTER INDEX "alerts_host_key_idx" RENAME TO "incidents_host_key_idx";--> statement-breakpoint
CREATE INDEX "incidents_fingerprint_idx" ON "incidents" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_open_host_key_idx" ON "incidents" USING btree ("hostId","key") WHERE "incidents"."resolvedAt" is null;--> statement-breakpoint

CREATE TABLE "incident_events" (
	"incidentId" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "incident_events_incidentId_seq_pk" PRIMARY KEY("incidentId","seq")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"incidentId" integer,
	"ownerUserId" text,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	"leaseUntil" timestamp with time zone,
	"claimToken" text,
	"attemptStartedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"chatId" text,
	"messageId" text,
	"result" jsonb,
	"fallbackResult" jsonb,
	"editResult" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incidentId_incidents_id_fk" FOREIGN KEY ("incidentId") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_incidentId_incidents_id_fk" FOREIGN KEY ("incidentId") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_ownerUserId_user_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_events_at_idx" ON "incident_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_key_idx" ON "notification_outbox" USING btree ("key");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("status","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "notification_outbox_incident_idx" ON "notification_outbox" USING btree ("incidentId");--> statement-breakpoint
CREATE INDEX "notification_outbox_owner_idx" ON "notification_outbox" USING btree ("ownerUserId");
