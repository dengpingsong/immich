import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum';
import { TranscriptionUnavailableError } from 'src/repositories/transcription.repository';
import { TranscriptionService } from 'src/services/transcription.service';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';

const settings = {
  enabled: true,
  url: 'http://immich-transcription:3004',
  apiKey: 'secret',
  modelName: 'faster-whisper:tiny',
  language: '',
  maxChunkMs: 30_000,
  noSpeechThreshold: 0.6,
};

const videoAsset = {
  id: 'asset-id',
  type: AssetType.Video,
  visibility: AssetVisibility.Timeline,
  ownerId: 'user-id',
  originalPath: '/uploads/user-id/video.mp4',
  livePhotoVideoId: null,
  motionAsset: null,
};

const livePhotoAsset = {
  ...videoAsset,
  id: 'live-photo-id',
  type: AssetType.Image,
  originalPath: '/uploads/user-id/photo.heic',
  livePhotoVideoId: 'motion-id',
  motionAsset: { id: 'motion-id', type: AssetType.Video, originalPath: '/uploads/user-id/motion.mov' },
};

describe(TranscriptionService.name, () => {
  let sut: TranscriptionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TranscriptionService));

    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { transcription: settings } });
    mocks.assetJob.getForTranscription.mockResolvedValue(videoAsset);
    mocks.media.probe.mockResolvedValue({
      format: { duration: 10 },
      audioStreams: [{ index: 1, codecName: 'aac', profile: null, bitrate: 128_000 }],
      videoStreams: [],
    } as never);
    mocks.media.extractTranscriptionAudio.mockResolvedValue(Buffer.alloc(32));
    mocks.transcription.transcribe.mockResolvedValue({
      chunkIndex: 0,
      offsetMs: 0,
      durationMs: 10_000,
      status: 'ok',
      language: 'zh',
      languageProbability: 0.9,
      model: 'faster-whisper:tiny',
      segments: [{ startMs: 0, endMs: 1000, text: '你好', noSpeechProbability: 0.01, avgLogprob: -0.2 }],
    });
  });

  it('skips when transcription is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { transcription: { ...settings, enabled: false } } });

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Skipped);
    expect(mocks.media.probe).not.toHaveBeenCalled();
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });

  it('fails for a missing asset', async () => {
    mocks.assetJob.getForTranscription.mockResolvedValue(undefined);

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Failed);
  });

  it('skips hidden assets without touching their stored subtitles', async () => {
    mocks.assetJob.getForTranscription.mockResolvedValue({ ...videoAsset, visibility: AssetVisibility.Hidden });

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Skipped);
    expect(mocks.subtitle.deleteByAssetId).not.toHaveBeenCalled();
  });

  it('stores one WebVTT row with the chunk-relative timestamps shifted by their offset', async () => {
    mocks.media.probe.mockResolvedValue({
      format: { duration: 10 },
      audioStreams: [{ index: 3, codecName: 'aac', profile: null, bitrate: 128_000 }],
      videoStreams: [],
    } as never);

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Success);

    expect(mocks.media.extractTranscriptionAudio).toHaveBeenCalledWith(videoAsset.originalPath, { startMs: 0, durationMs: 10_000 }, 3);
    expect(mocks.transcription.transcribe).toHaveBeenCalledWith({
      url: settings.url,
      apiKey: settings.apiKey,
      chunkIndex: 0,
      offsetMs: 0,
      durationMs: 10_000,
      sampleRate: 16_000,
      language: undefined,
      audio: expect.any(Buffer),
    });
    expect(mocks.subtitle.upsert).toHaveBeenCalledWith({
      assetId: 'asset-id',
      language: 'zh',
      modelName: 'faster-whisper:tiny',
      cueCount: 1,
      droppedCueCount: 0,
      vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n\n',
    });
  });

  it('reads the audio of a Live Photo from its motion asset', async () => {
    mocks.assetJob.getForTranscription.mockResolvedValue(livePhotoAsset);

    await expect(sut.transcribeAsset('live-photo-id')).resolves.toBe(JobStatus.Success);

    expect(mocks.media.probe).toHaveBeenCalledWith('/uploads/user-id/motion.mov');
    expect(mocks.subtitle.upsert).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'live-photo-id' }));
  });

  it('drops transcripts for an image without a linked video', async () => {
    mocks.assetJob.getForTranscription.mockResolvedValue({ ...livePhotoAsset, livePhotoVideoId: null, motionAsset: null });

    await expect(sut.transcribeAsset('live-photo-id')).resolves.toBe(JobStatus.Skipped);
    expect(mocks.subtitle.deleteByAssetId).toHaveBeenCalledWith('live-photo-id');
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });

  it('removes stale subtitles for a video without an audio track', async () => {
    mocks.media.probe.mockResolvedValue({ format: { duration: 10 }, audioStreams: [], videoStreams: [] } as never);

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Skipped);
    expect(mocks.subtitle.deleteByAssetId).toHaveBeenCalledWith('asset-id');
    expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
  });

  it('removes stale subtitles when the duration is unusable', async () => {
    mocks.media.probe.mockResolvedValue({
      format: { duration: 0 },
      audioStreams: [{ index: 1, codecName: 'aac', profile: null, bitrate: 0 }],
      videoStreams: [],
    } as never);

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Skipped);
    expect(mocks.subtitle.deleteByAssetId).toHaveBeenCalledWith('asset-id');
  });

  it('splits long audio into bounded windows and passes the first language on', async () => {
    mocks.media.probe.mockResolvedValue({
      format: { duration: 90 },
      audioStreams: [{ index: 1, codecName: 'aac', profile: null, bitrate: 0 }],
      videoStreams: [],
    } as never);
    mocks.media.extractTranscriptionAudio.mockResolvedValue(Buffer.alloc(32));
    mocks.transcription.transcribe.mockImplementation(async ({ chunkIndex, offsetMs, durationMs, language }) => ({
      chunkIndex,
      offsetMs,
      durationMs,
      status: 'ok' as const,
      language: chunkIndex === 0 ? 'zh' : 'en',
      languageProbability: 0.9,
      model: 'faster-whisper:tiny',
      segments: [{ startMs: 0, endMs: 1000, text: `c${chunkIndex}`, noSpeechProbability: 0.01, avgLogprob: -0.2 }],
    }));

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Success);

    expect(mocks.media.extractTranscriptionAudio.mock.calls.map((call) => call[1])).toEqual([
      { startMs: 0, durationMs: 30_000 },
      { startMs: 30_000, durationMs: 30_000 },
      { startMs: 60_000, durationMs: 30_000 },
    ]);
    // The detected language of the first chunk steers the following chunks instead of flipping per chunk.
    expect(mocks.transcription.transcribe.mock.calls.map((call) => call[0].language)).toEqual([undefined, 'zh', 'zh']);
    // Only one detected language is stored, and offsets accumulate across windows.
    expect(mocks.subtitle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'zh',
        cueCount: 3,
        vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nc0\n\n00:00:30.000 --> 00:00:31.000\nc1\n\n00:01:00.000 --> 00:01:01.000\nc2\n\n',
      }),
    );
  });

  it('drops cues the model reports as silence instead of showing hallucinated text', async () => {
    mocks.transcription.transcribe.mockResolvedValue({
      chunkIndex: 0,
      offsetMs: 0,
      durationMs: 10_000,
      status: 'ok',
      language: 'en',
      languageProbability: 0.26,
      model: 'faster-whisper:tiny',
      segments: [
        { startMs: 0, endMs: 2000, text: ' Thank you very much.', noSpeechProbability: 0.83, avgLogprob: -0.93 },
        { startMs: 2000, endMs: 4000, text: '真实语音', noSpeechProbability: 0.02, avgLogprob: -0.2 },
      ],
    });

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Success);

    expect(mocks.subtitle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cueCount: 1,
        droppedCueCount: 1,
        vtt: 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n真实语音\n\n',
      }),
    );
  });

  it('keeps a transcript that is entirely silence out of the player as an empty cue list', async () => {
    mocks.transcription.transcribe.mockResolvedValue({
      chunkIndex: 0,
      offsetMs: 0,
      durationMs: 10_000,
      status: 'ok',
      language: null,
      languageProbability: null,
      model: 'faster-whisper:tiny',
      segments: [{ startMs: 0, endMs: 2000, text: 'noise', noSpeechProbability: 0.9, avgLogprob: -1.5 }],
    });

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Success);

    expect(mocks.subtitle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ cueCount: 0, droppedCueCount: 1, vtt: 'WEBVTT\n\n' }),
    );
  });

  it('does not publish subtitles when the video source changed during transcription', async () => {
    mocks.assetJob.getForTranscription
      .mockResolvedValueOnce(videoAsset)
      .mockResolvedValueOnce({ ...videoAsset, originalPath: '/uploads/user-id/replaced.mp4' });

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Failed);
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });

  it('does not publish subtitles when the asset disappeared during transcription', async () => {
    mocks.assetJob.getForTranscription.mockResolvedValueOnce(videoAsset).mockResolvedValueOnce(undefined);

    await expect(sut.transcribeAsset('asset-id')).resolves.toBe(JobStatus.Failed);
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });

  it('propagates worker failures without writing a partial transcript', async () => {
    mocks.transcription.transcribe.mockRejectedValue(new TranscriptionUnavailableError('worker down'));

    await expect(sut.transcribeAsset('asset-id')).rejects.toThrow('worker down');
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });

  it('propagates unusable media input instead of storing an empty transcript', async () => {
    mocks.media.extractTranscriptionAudio.mockRejectedValue(new Error('FFmpeg failed'));

    await expect(sut.transcribeAsset('asset-id')).rejects.toThrow('FFmpeg failed');
    expect(mocks.subtitle.upsert).not.toHaveBeenCalled();
  });
});

describe('TranscriptionService subtitles API', () => {
  let sut: TranscriptionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TranscriptionService));
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { transcription: settings } });
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-id']));
    mocks.subtitle.getByAssetId.mockResolvedValue({
      id: 'subtitle-id',
      assetId: 'asset-id',
      language: 'zh',
      modelName: 'faster-whisper:tiny',
      cueCount: 2,
      droppedCueCount: 1,
      vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n\n',
      updatedAt: new Date('2026-10-15T12:00:00Z'),
      updateId: 'update-id',
    } as never);
  });

  it('returns subtitle metadata after checking asset read access', async () => {
    await expect(sut.getSubtitle(authStub.admin, 'asset-id')).resolves.toEqual({
      assetId: 'asset-id',
      language: 'zh',
      modelName: 'faster-whisper:tiny',
      cueCount: 2,
      droppedCueCount: 1,
      updatedAt: '2026-10-15T12:00:00.000Z',
    } as never);
    expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['asset-id']), undefined);
  });

  it('reports an asset without a transcript as not found', async () => {
    mocks.subtitle.getByAssetId.mockResolvedValue(undefined);
    await expect(sut.getSubtitle(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(NotFoundException);

    mocks.subtitle.getByAssetId.mockResolvedValue({ cueCount: 0 } as never);
    await expect(sut.getSubtitle(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to read subtitles without access to the asset', async () => {
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

    await expect(sut.getSubtitle(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.subtitle.getByAssetId).not.toHaveBeenCalled();
  });

  it('returns the WebVTT track', async () => {
    await expect(sut.getSubtitleTrack(authStub.admin, 'asset-id')).resolves.toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n\n',
    );
  });

  it('reports a missing or empty track as not found instead of returning an empty document', async () => {
    mocks.subtitle.getByAssetId.mockResolvedValue(undefined);
    await expect(sut.getSubtitleTrack(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(NotFoundException);

    mocks.subtitle.getByAssetId.mockResolvedValue({ cueCount: 0, vtt: 'WEBVTT\n\n' } as never);
    await expect(sut.getSubtitleTrack(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('queues transcription instead of transcribing inside the request', async () => {
    await expect(sut.requestTranscription(authStub.admin, 'asset-id')).resolves.toEqual({ queued: true });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.Transcription, data: { id: 'asset-id' } });
    expect(mocks.media.probe).not.toHaveBeenCalled();
  });

  it('rejects transcription requests while the feature is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { transcription: { ...settings, enabled: false } } });

    await expect(sut.requestTranscription(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('requires update access to generate or delete subtitles', async () => {
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

    await expect(sut.requestTranscription(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.deleteSubtitle(authStub.admin, 'asset-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.subtitle.deleteByAssetId).not.toHaveBeenCalled();
  });

  it('deletes stored subtitles', async () => {
    await expect(sut.deleteSubtitle(authStub.admin, 'asset-id')).resolves.toBeUndefined();
    expect(mocks.subtitle.deleteByAssetId).toHaveBeenCalledWith('asset-id');
  });
});
