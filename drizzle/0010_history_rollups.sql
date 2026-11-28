CREATE TABLE "container_rollups" (
	"hostId" text NOT NULL,
	"container" text NOT NULL,
	"bucket" timestamp NOT NULL,
	"n" integer NOT NULL,
	"cpu" double precision,
	"memory" double precision,
	"rx" double precision,
	"tx" double precision,
	CONSTRAINT "container_rollups_hostId_container_bucket_pk" PRIMARY KEY("hostId","container","bucket")
);
--> statement-breakpoint
CREATE TABLE "sample_rollups" (
	"hostId" text NOT NULL,
	"bucket" timestamp NOT NULL,
	"n" integer NOT NULL,
	"cpu" double precision,
	"memory" double precision,
	"swap" double precision,
	"rx" double precision,
	"tx" double precision,
	"ioRead" double precision,
	"ioWrite" double precision,
	"load1" double precision,
	"load5" double precision,
	"load15" double precision,
	"readAwait" double precision,
	"writeAwait" double precision,
	"utilization" double precision,
	CONSTRAINT "sample_rollups_hostId_bucket_pk" PRIMARY KEY("hostId","bucket")
);
--> statement-breakpoint
CREATE INDEX "sample_rollups_bucket_idx" ON "sample_rollups" USING btree ("bucket");