/**
 * Run from server: node --experimental-strip-types test/video-face-database.integration.ts
 * Self-contained, disposable PostgreSQL integration test; NEVER accepts a database URL.
 * Uses the real migration and actual refreshVideoFaces method extracted by TypeScript AST,
 * with the application's sql-tools/postgres-js driver. No application bootstrap/import side effects.
 * Limitations: minimal prerequisite tables; updateId trigger uses UUID v4 instead of Immich v7;
 * face_search.embedding is real[] rather than vector; no audit/sync or full-schema migration tests.
 */
import { createPostgres } from '@immich/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const localRequire = createRequire(resolve('package.json'));
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function main() {
  const image = 'ghcr.io/immich-app/postgres:14-vectorchord0.3.0-pgvectors0.2.0';
  const name = `video-face-test-${randomUUID()}`;
  const label = `immich.video-face-test=${name}`;
  const password = randomBytes(24).toString('hex');
  const load = (source: string) => {
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports: Record<string, any> = {};
    new Function('require', 'exports', output.outputText)(localRequire, exports);
    return exports;
  };
  const migrationSource = readFileSync(resolve('src/schema/migrations/1792047600000-VideoFaceTimeline.ts'), 'utf8');
  const repositorySource = readFileSync(resolve('src/repositories/person.repository.ts'), 'utf8');
  const ast = ts.createSourceFile('person.repository.ts', repositorySource, ts.ScriptTarget.Latest, true);
  const repository = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'PersonRepository',
  );
  assert.ok(repository && ts.isClassDeclaration(repository));
  const method = repository.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'refreshVideoFaces',
  );
  assert.ok(method);
  const methodSource = method.getText(ast);
  const { Repository } = load(`export class Repository { constructor(public db: any) {} ${methodSource} }`);
  const migration = load(migrationSource);
  console.log('Input SHA256:', { migration: sha(migrationSource), method: sha(methodSource) });
  let containerId: string | undefined;
  let db: Kysely<any> | undefined;
  const passed: string[] = [];
  const failures: string[] = [];
  async function check(title: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed.push(title);
      console.log(`PASS ${title}`);
    } catch (error) {
      failures.push(title);
      console.error(`FAIL ${title}`, error);
    }
  }
  try {
    containerId = docker(
      'run',
      '--detach',
      '--name',
      name,
      '--label',
      label,
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '128',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,size=384m',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_USER=video_face_test',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=video_face_test',
      image,
      'postgres',
      '-c',
      'shared_preload_libraries=',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'max_connections=20',
    );
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const inspection = JSON.parse(docker('inspect', containerId))[0];
    assert.equal(inspection.Name, `/${name}`);
    assert.equal(inspection.Config.Labels['immich.video-face-test'], name);
    assert.ok(inspection.Mounts.every((mount: { Type: string }) => mount.Type === 'tmpfs'));
    const binding = inspection.NetworkSettings.Ports['5432/tcp'][0];
    assert.equal(binding.HostIp, '127.0.0.1');
    const port = Number(binding.HostPort);
    assert.ok(port > 0 && port !== 5432);
    console.log('Owned isolated container:', {
      name,
      id: containerId,
      port,
      memory: inspection.HostConfig.Memory,
      nanoCpus: inspection.HostConfig.NanoCpus,
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        docker('exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'video_face_test', '-d', 'video_face_test');
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL did not start');
    const postgres = createPostgres({
      connection: {
        connectionType: 'url',
        url: `postgres://video_face_test:${password}@127.0.0.1:${port}/video_face_test`,
      },
    });
    db = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres }) });
    const database = db;
    const execute = (query: string) => sql.raw(query).execute(database);
    await execute(`CREATE TABLE asset (id uuid PRIMARY KEY, "ownerId" uuid, "originalPath" text, "livePhotoVideoId" uuid, "deletedAt" timestamptz);
    CREATE TABLE asset_face (
      id uuid PRIMARY KEY, "assetId" uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      "personGroupId" uuid, "sourceType" text DEFAULT 'machine-learning', "isVisible" boolean DEFAULT true,
      "deletedAt" timestamptz, "updateId" uuid NOT NULL DEFAULT gen_random_uuid(), "updatedAt" timestamptz DEFAULT now(),
      "imageWidth" integer DEFAULT 0, "imageHeight" integer DEFAULT 0,
      "boundingBoxX1" integer DEFAULT 0, "boundingBoxY1" integer DEFAULT 0, "boundingBoxX2" integer DEFAULT 0, "boundingBoxY2" integer DEFAULT 0
    );
    CREATE TABLE face_search ("faceId" uuid PRIMARY KEY REFERENCES asset_face(id) ON DELETE CASCADE, embedding real[] NOT NULL);
    CREATE TABLE person ("ownerId" uuid, "personGroupId" uuid, "faceAssetId" uuid REFERENCES asset_face(id));
    CREATE FUNCTION test_update_id() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."updateId" = gen_random_uuid(); NEW."updatedAt" = clock_timestamp(); RETURN NEW; END $$;
    CREATE TRIGGER test_update_id BEFORE UPDATE ON asset_face FOR EACH ROW EXECUTE FUNCTION test_update_id();`);
    const still = randomUUID(),
      video = randomUUID(),
      faceId = randomUUID(),
      group = randomUUID(),
      owner = randomUUID();
    await database
      .insertInto('asset')
      .values([
        { id: still, ownerId: owner, originalPath: '/test/photo.heic', livePhotoVideoId: video },
        { id: video, ownerId: owner, originalPath: '/test/video.mov' },
      ])
      .execute();
    await database
      .insertInto('asset_face')
      .values({ id: faceId, assetId: still, personGroupId: group, sourceType: 'manual', isVisible: false })
      .execute();
    await check('actual migration up: default/backfill, FK and index', async () => {
      await migration.up(database);
      const row = await database.selectFrom('asset_face').selectAll().executeTakeFirstOrThrow();
      assert.deepEqual(row.appearances, []);
      assert.equal(row.sourceAssetId, null);
      assert.equal(row.timestampMs, null);
      const fk =
        await sql<any>`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = 'asset_face_sourceAssetId_fkey'`.execute(
          database,
        );
      assert.deepEqual(fk.rows, [{ confdeltype: 'n', confupdtype: 'c' }]);
      const index =
        await sql<any>`SELECT indexname FROM pg_indexes WHERE indexname = 'asset_face_sourceAssetId_idx'`.execute(
          database,
        );
      assert.equal(index.rows.length, 1);
    });
    const sut = new Repository(database);
    const expectedSource = { id: video, originalPath: '/test/video.mov', ownerId: owner };
    const refresh = (...args: any[]) => Repository.prototype.refreshVideoFaces.call(sut, ...args, expectedSource);
    const snapshot = () =>
      database.selectFrom('asset_face').select(['id', 'updateId']).where('assetId', '=', still).execute();
    const face = () => database.selectFrom('asset_face').selectAll().where('id', '=', faceId).executeTakeFirstOrThrow();
    const appearances = [0, 3000].map((timestampMs) => ({
      timestampMs,
      imageWidth: 640,
      imageHeight: 360,
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 90,
      boundingBoxY2: 100,
    }));
    const replacement = {
      id: faceId,
      assetId: still,
      sourceAssetId: video,
      timestampMs: 250,
      appearances,
      imageWidth: 640,
      imageHeight: 360,
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 90,
      boundingBoxY2: 100,
    };
    await database.insertInto('person').values({ ownerId: owner, personGroupId: group, faceAssetId: faceId }).execute();
    await check('actual repository JSONB array roundtrip and stable ID update', async () => {
      const before = await face();
      const result = await refresh(still, [replacement], [], [{ faceId, embedding: [0.1, 0.2] }], await snapshot());
      const after = await face();
      assert.deepEqual(after.appearances, appearances);
      assert.equal(after.id, before.id);
      assert.equal(after.assetId, still);
      assert.equal(after.personGroupId, group);
      assert.equal(after.sourceType, 'manual');
      assert.equal(after.isVisible, false);
      assert.equal(after.sourceAssetId, video);
      assert.equal(after.timestampMs, 250);
      assert.notEqual(after.updateId, before.updateId);
      assert.deepEqual(result, [{ ownerId: owner, personGroupId: group }]);
      const typed =
        await sql<any>`SELECT jsonb_typeof(appearances) AS type FROM asset_face WHERE id = ${faceId}`.execute(database);
      assert.equal(typed.rows[0].type, 'array');
    });
    await check('actual repository new face with empty JSONB array and subsequent nonempty update', async () => {
      const id = randomUUID();
      await refresh(still, [{ ...replacement, id, appearances: [] }], [], [], await snapshot());
      let row = await database.selectFrom('asset_face').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      assert.deepEqual(row.appearances, []);
      await refresh(still, [{ ...replacement, id }], [], [], await snapshot());
      row = await database.selectFrom('asset_face').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      assert.deepEqual(row.appearances, appearances);
      await refresh(still, [], [id], [], await snapshot());
    });
    await check('stale updateId snapshot rejects concurrent edit without changing rows', async () => {
      const oldSnapshot = await snapshot();
      await database.updateTable('asset_face').set({ boundingBoxX1: 77 }).where('id', '=', faceId).execute();
      const before = await face();
      await assert.rejects(
        refresh(still, [replacement], [faceId], [], oldSnapshot),
        /Faces changed during video inference/,
      );
      assert.deepEqual(await face(), before);
    });
    await check('stale membership snapshot rejects concurrent insertion', async () => {
      const oldSnapshot = await snapshot(),
        extra = randomUUID();
      await database.insertInto('asset_face').values({ id: extra, assetId: still }).execute();
      await assert.rejects(refresh(still, [], [faceId], [], oldSnapshot), /Faces changed during video inference/);
      const currentSnapshot = await snapshot();
      assert.equal(currentSnapshot.length, oldSnapshot.length + 1);
      await database.deleteFrom('asset_face').where('id', '=', extra).execute();
    });
    await check('late embedding FK failure rolls back successful face update and removal', async () => {
      const extra = randomUUID();
      await database.insertInto('asset_face').values({ id: extra, assetId: still }).execute();
      const before = await face();
      await assert.rejects(
        refresh(still, [replacement], [extra], [{ faceId: randomUUID(), embedding: [1] }], await snapshot()),
        (error: any) => error.code === '23503',
      );
      assert.deepEqual(await face(), before);
      assert.ok(await database.selectFrom('asset_face').select('id').where('id', '=', extra).executeTakeFirst());
      await database.deleteFrom('asset_face').where('id', '=', extra).execute();
    });
    await check(
      'rejects changed Live Photo link, source path, owner and trash status without face mutation',
      async () => {
        const before = await face();
        const expectedFaces = await snapshot();
        const cases = [
          { id: still, change: { livePhotoVideoId: null }, restore: { livePhotoVideoId: video } },
          { id: video, change: { originalPath: '/test/replaced.mov' }, restore: { originalPath: '/test/video.mov' } },
          { id: video, change: { ownerId: randomUUID() }, restore: { ownerId: owner } },
          { id: video, change: { deletedAt: new Date() }, restore: { deletedAt: null } },
          { id: still, change: { deletedAt: new Date() }, restore: { deletedAt: null } },
        ];
        for (const { id, change, restore } of cases) {
          await database.updateTable('asset').set(change).where('id', '=', id).execute();
          try {
            await assert.rejects(refresh(still, [replacement], [faceId], [], expectedFaces), /Motion source changed/);
            assert.deepEqual(await face(), before);
          } finally {
            await database.updateTable('asset').set(restore).where('id', '=', id).execute();
          }
        }
      },
    );
    await check('source delete SET NULL preserves logical still face, appearances and person pointer', async () => {
      // Seed independently so migration semantics are tested even if repository JSON serialization fails.
      await sql`UPDATE asset_face SET "sourceAssetId" = ${video}, "timestampMs" = 250, appearances = ${appearances}::jsonb WHERE id = ${faceId}`.execute(
        database,
      );
      await database.deleteFrom('asset').where('id', '=', video).execute();
      const after = await face();
      assert.equal(after.sourceAssetId, null);
      assert.equal(after.assetId, still);
      assert.equal(after.timestampMs, 250);
      assert.deepEqual(after.appearances, appearances);
      const person = await database.selectFrom('person').selectAll().executeTakeFirstOrThrow();
      assert.equal(person.faceAssetId, faceId);
    });
    await check('actual migration down removes columns, dependent FK/index; up works again', async () => {
      await migration.down(database);
      const columns =
        await sql<any>`SELECT column_name FROM information_schema.columns WHERE table_name = 'asset_face'`.execute(
          database,
        );
      assert.ok(
        columns.rows.every((row: any) => !['sourceAssetId', 'timestampMs', 'appearances'].includes(row.column_name)),
      );
      const constraints =
        await sql<any>`SELECT conname FROM pg_constraint WHERE conname = 'asset_face_sourceAssetId_fkey'`.execute(
          database,
        );
      assert.equal(constraints.rows.length, 0);
      const indexes =
        await sql<any>`SELECT indexname FROM pg_indexes WHERE indexname = 'asset_face_sourceAssetId_idx'`.execute(
          database,
        );
      assert.equal(indexes.rows.length, 0);
      await migration.up(database);
      const remigrated = await face();
      assert.deepEqual(remigrated.appearances, []);
    });
    console.log(`RESULT ${passed.length} passed; ${failures.length} failed`, failures);
    assert.equal(failures.length, 0, 'Integration checks failed');
  } finally {
    await db?.destroy();
    if (containerId) {
      const owned = JSON.parse(docker('inspect', containerId))[0];
      assert.equal(owned.Id, containerId);
      assert.equal(owned.Name, `/${name}`);
      assert.equal(owned.Config.Labels['immich.video-face-test'], name);
      docker('rm', '--force', containerId);
      const remaining = docker('ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`);
      assert.equal(remaining, '');
      console.log('Verified owned container removed:', containerId);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
