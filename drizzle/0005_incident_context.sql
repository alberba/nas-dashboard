ALTER TABLE "incidents" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "inhibitedBy" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "inhibitedReason" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "observationPending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_inhibited_idx" ON "incidents" USING btree ("inhibitedBy");