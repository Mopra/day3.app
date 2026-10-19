CREATE TABLE "payment_cards" (
	"clerk_org_id" text NOT NULL,
	"brand" text NOT NULL,
	"last4" text NOT NULL,
	"payer_email" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_cards_clerk_org_id_brand_last4_pk" PRIMARY KEY("clerk_org_id","brand","last4")
);
--> statement-breakpoint
CREATE INDEX "idx_payment_cards_card" ON "payment_cards" USING btree ("brand","last4");