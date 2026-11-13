CREATE TABLE "recent_verification" (
	"sessionId" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"method" text NOT NULL,
	"verifiedAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recent_verification" ADD CONSTRAINT "recent_verification_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_verification" ADD CONSTRAINT "recent_verification_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recent_verification_expires_idx" ON "recent_verification" USING btree ("expiresAt");