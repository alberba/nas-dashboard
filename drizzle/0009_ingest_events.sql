CREATE TABLE "ingest_events" (
	"source" text NOT NULL,
	"eventId" text NOT NULL,
	"bodyHash" text NOT NULL,
	"incidentId" integer,
	"receivedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_events_source_eventId_pk" PRIMARY KEY("source","eventId")
);
--> statement-breakpoint
CREATE INDEX "ingest_events_received_at_idx" ON "ingest_events" USING btree ("receivedAt");