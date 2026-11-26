CREATE TABLE "digest_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "digest_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"date" text NOT NULL,
	"targetAt" timestamp with time zone NOT NULL,
	"periodStartAt" timestamp with time zone NOT NULL,
	"dueAt" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"payload" text,
	"result" jsonb,
	"reason" text,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	"claimToken" text,
	"leaseUntil" timestamp with time zone,
	"attemptStartedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"preparedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_cooldown" (
	"channel" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "digest_runs_date_idx" ON "digest_runs" USING btree ("date");--> statement-breakpoint
CREATE INDEX "digest_runs_due_idx" ON "digest_runs" USING btree ("status","nextAttemptAt");