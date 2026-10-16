import { Injectable } from '@nestjs/common';
import { LoggingRepository } from 'src/repositories/logging.repository';

export interface TranscriptionSegmentResponse {
  startMs: number;
  endMs: number;
  text: string;
  noSpeechProbability?: number | null;
  avgLogprob?: number | null;
}

export interface TranscriptionChunkResponse {
  chunkIndex: number;
  offsetMs: number;
  durationMs: number;
  status: 'ok' | 'no_speech';
  language?: string | null;
  languageProbability?: number | null;
  model: string;
  segments: TranscriptionSegmentResponse[];
}

export interface TranscribeAudioRequest {
  url: string;
  apiKey?: string;
  chunkIndex: number;
  offsetMs: number;
  durationMs: number;
  sampleRate: number;
  language?: string;
  audio: Buffer;
  signal?: AbortSignal;
}

export class TranscriptionUnavailableError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Client for the isolated transcription worker.
 *
 * The worker is an internal service: it has no asset permissions of its own and must never be exposed
 * to browsers, so every call is authenticated with the configured shared secret and the caller has
 * already checked asset access. Audio is sent per bounded chunk instead of as a whole file.
 */
@Injectable()
export class TranscriptionRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(TranscriptionRepository.name);
  }

  async transcribe(request: TranscribeAudioRequest): Promise<TranscriptionChunkResponse> {
    const form = new FormData();
    form.append(
      'entries',
      JSON.stringify({
        chunkIndex: request.chunkIndex,
        offsetMs: request.offsetMs,
        durationMs: request.durationMs,
        sampleRate: request.sampleRate,
        channels: 1,
        languageHint: request.language || null,
      }),
    );
    form.append('audio', new Blob([new Uint8Array(request.audio)], { type: 'application/octet-stream' }), 'chunk.pcm');

    let response: Response;
    try {
      response = await fetch(new URL('/transcribe', request.url), {
        method: 'POST',
        headers: request.apiKey ? { 'x-api-key': request.apiKey } : undefined,
        body: form,
        signal: request.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: any) {
      if (request.signal?.aborted) {
        throw error;
      }
      throw new TranscriptionUnavailableError(`Transcription worker is unreachable: ${error?.message ?? error}`);
    }

    const body = await response.text();
    if (!response.ok) {
      throw new TranscriptionUnavailableError(`Transcription worker returned ${response.status}: ${body.slice(0, 200)}`);
    }

    let parsed: TranscriptionChunkResponse;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TranscriptionUnavailableError('Transcription worker returned invalid JSON');
    }

    if (parsed.chunkIndex !== request.chunkIndex || !Array.isArray(parsed.segments)) {
      throw new TranscriptionUnavailableError('Transcription worker returned an unexpected response');
    }

    return parsed;
  }
}
