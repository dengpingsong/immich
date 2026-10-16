import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_subtitle" (
    "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
    "assetId" uuid NOT NULL,
    "language" character varying NOT NULL DEFAULT '',
    "modelName" character varying NOT NULL DEFAULT '',
    "cueCount" integer NOT NULL DEFAULT 0,
    "droppedCueCount" integer NOT NULL DEFAULT 0,
    "vtt" text NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
    CONSTRAINT "asset_subtitle_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_subtitle_assetId_key" UNIQUE ("assetId"),
    CONSTRAINT "asset_subtitle_assetId_fkey" FOREIGN KEY ("assetId")
      REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE
  );`.execute(db);
  await sql`CREATE TRIGGER "asset_subtitle_updatedAt"
    BEFORE UPDATE ON "asset_subtitle"
    FOR EACH ROW EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_subtitle";`.execute(db);
}
