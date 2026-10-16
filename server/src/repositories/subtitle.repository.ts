import { Injectable } from '@nestjs/common';
import { Insertable, Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { AssetSubtitleTable } from 'src/schema/tables/asset-subtitle.table';

@Injectable()
export class SubtitleRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getByAssetId(assetId: string) {
    return this.db
      .selectFrom('asset_subtitle')
      .selectAll('asset_subtitle')
      .where('asset_subtitle.assetId', '=', assetId)
      .executeTakeFirst();
  }

  upsert(value: Insertable<AssetSubtitleTable>) {
    return this.db
      .insertInto('asset_subtitle')
      .values(value)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => ({
          language: eb.ref('excluded.language'),
          modelName: eb.ref('excluded.modelName'),
          cueCount: eb.ref('excluded.cueCount'),
          droppedCueCount: eb.ref('excluded.droppedCueCount'),
          vtt: eb.ref('excluded.vtt'),
        })),
      )
      .execute();
  }

  deleteByAssetId(assetId: string) {
    return this.db.deleteFrom('asset_subtitle').where('assetId', '=', assetId).execute();
  }
}
