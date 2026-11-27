CREATE TABLE "telegram_action_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"incidentId" integer NOT NULL,
	"hostId" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"userId" text NOT NULL,
	"handoffHash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"usedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "keyboardView" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "channel" text DEFAULT 'hub' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "requestedBy" text;--> statement-breakpoint
ALTER TABLE "telegram_action_intents" ADD CONSTRAINT "telegram_action_intents_incidentId_incidents_id_fk" FOREIGN KEY ("incidentId") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_action_intents" ADD CONSTRAINT "telegram_action_intents_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_action_intents_hash_idx" ON "telegram_action_intents" USING btree ("handoffHash");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_action_intents_live_idx" ON "telegram_action_intents" USING btree ("incidentId") WHERE "telegram_action_intents"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "telegram_action_intents_expires_idx" ON "telegram_action_intents" USING btree ("expiresAt");