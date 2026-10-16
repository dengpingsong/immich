import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AssetSubtitleResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset this transcript belongs to'),
    language: z.string().describe('Detected or configured language of the transcript'),
    modelName: z.string().describe('Model that produced the transcript'),
    cueCount: z.number().int().describe('Number of subtitle cues'),
    droppedCueCount: z.number().int().describe('Cues discarded because the model reported silence'),
    updatedAt: z
      .string()
      .meta({ format: 'date-time' })
      .describe('When the transcript was last generated'),
  })
  .meta({ id: 'AssetSubtitleResponseDto' });

export class AssetSubtitleResponseDto extends createZodDto(AssetSubtitleResponseSchema) {}

const AssetSubtitleGenerateResponseSchema = z
  .object({
    queued: z.boolean().describe('Whether a transcription job was queued'),
  })
  .meta({ id: 'AssetSubtitleGenerateResponseDto' });

export class AssetSubtitleGenerateResponseDto extends createZodDto(AssetSubtitleGenerateResponseSchema) {}
