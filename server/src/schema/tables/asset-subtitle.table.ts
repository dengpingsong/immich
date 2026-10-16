import { Column, ForeignKeyColumn, Generated, PrimaryGeneratedColumn, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AssetTable } from 'src/schema/tables/asset.table';

/**
 * Generated WebVTT subtitles for one asset.
 *
 * The serialized WebVTT is stored as text so a read is a single atomic row fetch and a re-transcription
 * can replace it in one statement. Cues are always produced from the asset's own audio; nothing here
 * is derived from another asset, so a row is only valid while its asset exists (CASCADE).
 */
@Table({ name: 'asset_subtitle' })
@UpdatedAtTrigger('asset_subtitle_updatedAt')
export class AssetSubtitleTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    unique: true,
  })
  assetId!: string;

  /** Detected or configured language of the transcript; empty when the worker did not report one. */
  @Column({ type: 'character varying', default: '' })
  language!: Generated<string>;

  /** Model that produced the transcript, for provenance and to detect stale results. */
  @Column({ type: 'character varying', default: '' })
  modelName!: Generated<string>;

  /** Number of cues kept after confidence filtering. */
  @Column({ type: 'integer', default: 0 })
  cueCount!: Generated<number>;

  /** Cues discarded because the model reported them as silence instead of speech. */
  @Column({ type: 'integer', default: 0 })
  droppedCueCount!: Generated<number>;

  @Column({ type: 'text' })
  vtt!: string;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
