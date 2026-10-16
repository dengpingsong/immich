import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face"
    ADD "sourceAssetId" uuid,
    ADD "timestampMs" integer,
    ADD "appearances" jsonb NOT NULL DEFAULT '[]'::jsonb;`.execute(db);
  await sql`ALTER TABLE "asset_face" ADD CONSTRAINT "asset_face_sourceAssetId_fkey"
    FOREIGN KEY ("sourceAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(db);
  await sql`CREATE INDEX "asset_face_sourceAssetId_idx" ON "asset_face" ("sourceAssetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" DROP COLUMN "sourceAssetId", DROP COLUMN "timestampMs", DROP COLUMN "appearances";`.execute(db);
}
