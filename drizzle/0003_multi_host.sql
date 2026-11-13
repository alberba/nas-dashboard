-- Existing rows belong to NAS-HOME, the only agent before multi-host support.
ALTER TABLE "alerts" ADD COLUMN "hostId" text DEFAULT 'nas-home' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuration" ADD COLUMN "hostId" text DEFAULT 'nas-home' NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "hostId" text DEFAULT 'nas-home' NOT NULL;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "hostId" text DEFAULT 'nas-home' NOT NULL;--> statement-breakpoint
ALTER TABLE "configuration" DROP CONSTRAINT "configuration_pkey";--> statement-breakpoint
ALTER TABLE "configuration" ADD CONSTRAINT "configuration_hostId_id_pk" PRIMARY KEY("hostId","id");--> statement-breakpoint
CREATE INDEX "alerts_host_key_idx" ON "alerts" USING btree ("hostId","key");--> statement-breakpoint
CREATE INDEX "operations_host_at_idx" ON "operations" USING btree ("hostId","at");--> statement-breakpoint
CREATE INDEX "samples_host_at_idx" ON "samples" USING btree ("hostId","at");
