import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AssetSubtitleGenerateResponseDto, AssetSubtitleResponseDto } from 'src/dtos/subtitle.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetType, AssetVisibility, JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { JobOf } from 'src/types';
import { BaseService } from 'src/services/base.service';
import { batched } from 'src/utils/misc';
import { asDateTimeString } from 'src/utils/date';
import {
  getTranscriptionChunks,
  normalizeTranscriptionSegments,
  serializeWebVttCue,
  TRANSCRIPTION_SAMPLE_RATE,
  WEBVTT_HEADER,
} from 'src/utils/transcription';

/**
 * Generates switchable subtitles for a video, or for the video part of a Live Photo.
 *
 * The asset's own audio stays on this server: only bounded 16 kHz mono PCM windows are sent to the
 * isolated transcription worker. The result is stored as one WebVTT row and replaced atomically, so a
 * failed or cancelled run never leaves a partial transcript behind.
 */
@Injectable()
export class TranscriptionService extends BaseService {
  @OnJob({ name: JobName.TranscriptionQueueAll, queue: QueueName.Transcription })
  async handleQueueTranscription({ force }: JobOf<JobName.TranscriptionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!machineLearning.transcription.enabled) {
      return JobStatus.Skipped;
    }

    for await (const assets of batched(this.assetJobRepository.streamForTranscriptionJob(force))) {
      await this.jobRepository.queueAll(assets.map((asset) => ({ name: JobName.Transcription, data: { id: asset.id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.Transcription, queue: QueueName.Transcription })
  async handleTranscription({ id }: JobOf<JobName.Transcription>): Promise<JobStatus> {
    return this.transcribeAsset(id);
  }

  /** Subtitle metadata for a viewer. A transcript without cues is reported as absent. */
  async getSubtitle(auth: AuthDto, assetId: string): Promise<AssetSubtitleResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    const subtitle = await this.subtitleRepository.getByAssetId(assetId);
    if (!subtitle || subtitle.cueCount === 0) {
      throw new NotFoundException('No subtitles for this asset');
    }
    return mapSubtitle(subtitle);
  }

  /** The serialized WebVTT track. Permission-checked exactly like any other asset read. */
  async getSubtitleTrack(auth: AuthDto, assetId: string): Promise<string> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    const subtitle = await this.subtitleRepository.getByAssetId(assetId);
    if (!subtitle || subtitle.cueCount === 0) {
      throw new NotFoundException('No subtitles for this asset');
    }
    return subtitle.vtt;
  }

  /**
   * Transcription runs in the worker queue rather than inline: a long video would otherwise hold the
   * request open for minutes. The caller only learns that the work was accepted.
   */
  async requestTranscription(auth: AuthDto, assetId: string): Promise<AssetSubtitleGenerateResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [assetId] });

    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.transcription.enabled) {
      throw new BadRequestException('Video transcription is disabled');
    }

    await this.jobRepository.queue({ name: JobName.Transcription, data: { id: assetId } });
    return { queued: true };
  }

  async deleteSubtitle(auth: AuthDto, assetId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [assetId] });
    await this.subtitleRepository.deleteByAssetId(assetId);
  }

  async transcribeAsset(assetId: string): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    const settings = machineLearning.transcription;
    if (!settings.enabled) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForTranscription(assetId);
    if (!asset) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const source = this.getAudioSource(asset);

    if (!source) {
      // No media with audio: drop any stale transcript so the player cannot offer outdated subtitles.
      await this.subtitleRepository.deleteByAssetId(assetId);
      return JobStatus.Skipped;
    }

    const info = await this.mediaRepository.probe(source.path);
    const audioStream = info.audioStreams.at(0);
    const durationMs = Math.round((info.format.duration ?? 0) * 1000);

    if (!audioStream || !Number.isFinite(durationMs) || durationMs <= 0) {
      await this.subtitleRepository.deleteByAssetId(assetId);
      this.logger.debug(`No transcribable audio for ${assetId}`);
      return JobStatus.Skipped;
    }

    const vtt = await this.buildSubtitles(assetId, source.path, audioStream.index, durationMs, settings);

    // The asset may have been replaced, trashed, or relinked while we were transcribing; a transcript
    // that no longer describes its source must not be published.
    const current = await this.assetJobRepository.getForTranscription(assetId);
    if (!current || this.getAudioSource(current)?.path !== source.path) {
      this.logger.warn(`Discarding subtitles for ${assetId}: its video source changed during transcription`);
      return JobStatus.Failed;
    }

    await this.subtitleRepository.upsert({
      assetId,
      language: vtt.language,
      modelName: vtt.modelName,
      cueCount: vtt.cueCount,
      droppedCueCount: vtt.droppedCueCount,
      vtt: WEBVTT_HEADER + vtt.cues,
    });

    this.logger.debug(
      `Stored ${vtt.cueCount} subtitle cue(s) for ${assetId} in ${vtt.language || 'unknown language'} ` +
        `(${vtt.droppedCueCount} dropped as silence)`,
    );
    return JobStatus.Success;
  }

  private async buildSubtitles(
    assetId: string,
    path: string,
    audioStreamIndex: number,
    durationMs: number,
    settings: { url: string; apiKey: string; modelName: string; language: string; maxChunkMs: number; noSpeechThreshold: number },
  ) {
    const cues: string[] = [];
    let cueCount = 0;
    let droppedCueCount = 0;
    // The first chunk that reports a language steers the rest of the video, so a chunk of music cannot
    // flip the whole transcript into another language.
    let language = settings.language;
    let modelName = settings.modelName;
    let chunkIndex = 0;

    for (const chunk of getTranscriptionChunks(durationMs, settings.maxChunkMs)) {
      const audio = await this.mediaRepository.extractTranscriptionAudio(path, chunk, audioStreamIndex);
      if (audio.length === 0) {
        continue;
      }

      const response = await this.transcriptionRepository.transcribe({
        url: settings.url,
        apiKey: settings.apiKey,
        chunkIndex: chunkIndex++,
        offsetMs: chunk.startMs,
        durationMs: chunk.durationMs,
        sampleRate: TRANSCRIPTION_SAMPLE_RATE,
        language: language || undefined,
        audio,
      });

      language ||= response.language ?? '';
      modelName = response.model || modelName;

      const speech = response.segments.filter((segment) => !this.isSilence(segment, settings.noSpeechThreshold));
      droppedCueCount += response.segments.length - speech.length;

      for (const cue of normalizeTranscriptionSegments(speech, chunk)) {
        cues.push(serializeWebVttCue(cue));
        cueCount++;
      }
    }

    if (cueCount === 0) {
      this.logger.debug(`No speech detected in ${assetId}`);
    }

    return { cues: cues.join(''), cueCount, droppedCueCount, language, modelName };
  }

  /** A Live Photo stores its audio in the linked motion asset; a plain video is its own source. */
  private getAudioSource(asset: {
    id: string;
    type: AssetType;
    originalPath: string;
    motionAsset?: { type: AssetType; originalPath: string } | null;
  }): { id: string; path: string } | undefined {
    if (asset.type === AssetType.Video) {
      return { id: asset.id, path: asset.originalPath };
    }
    if (asset.motionAsset?.type === AssetType.Video) {
      return { id: asset.id, path: asset.motionAsset.originalPath };
    }
    return undefined;
  }

  /**
   * Whisper emits fluent sentences for music and noise. The model's own no-speech probability is the
   * only reliable signal available, so cues it flags as silence are dropped instead of being shown.
   */
  private isSilence(segment: { noSpeechProbability?: number | null }, threshold: number) {
    return (segment.noSpeechProbability ?? 0) >= threshold;
  }
}

export const mapSubtitle = (subtitle: {
  assetId: string;
  language: string;
  modelName: string;
  cueCount: number;
  droppedCueCount: number;
  updatedAt: Date;
}): AssetSubtitleResponseDto => ({
  assetId: subtitle.assetId,
  language: subtitle.language,
  modelName: subtitle.modelName,
  cueCount: subtitle.cueCount,
  droppedCueCount: subtitle.droppedCueCount,
  updatedAt: asDateTimeString(subtitle.updatedAt),
});
