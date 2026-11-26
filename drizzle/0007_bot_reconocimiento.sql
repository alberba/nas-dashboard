CREATE TABLE "incident_snoozes" (
	"hostId" text DEFAULT 'nas-home' NOT NULL,
	"key" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"setAt" timestamp with time zone DEFAULT now() NOT NULL,
	"setVia" text NOT NULL,
	"setBy" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_snoozes_hostId_key_pk" PRIMARY KEY("hostId","key")
);
--> statement-breakpoint
CREATE TABLE "telegram_action_tokens" (
	"tokenHash" text PRIMARY KEY NOT NULL,
	"incidentId" integer NOT NULL,
	"action" text NOT NULL,
	"chatId" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"usedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_poll_state" (
	"name" text PRIMARY KEY NOT NULL,
	"lastUpdateId" bigint,
	"lastUpdateAt" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgedVia" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgedBy" text;--> statement-breakpoint
ALTER TABLE "telegram_action_tokens" ADD CONSTRAINT "telegram_action_tokens_incidentId_incidents_id_fk" FOREIGN KEY ("incidentId") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_action_tokens_incident_idx" ON "telegram_action_tokens" USING btree ("incidentId");--> statement-breakpoint
CREATE INDEX "telegram_action_tokens_expires_idx" ON "telegram_action_tokens" USING btree ("expiresAt");