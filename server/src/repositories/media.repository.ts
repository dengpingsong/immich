import { Injectable } from '@nestjs/common';
import { ExifDateTime, exiftool, WriteTags } from 'exiftool-vendored';
import ffmpeg, { FfprobeData, FfprobeStream } from 'fluent-ffmpeg';
import _ from 'lodash';
import { Duration } from 'luxon';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import sharp from 'sharp';
import { ORIENTATION_TO_SHARP_ROTATION } from 'src/constants';
import { Exif } from 'src/database';
import { AssetEditActionItem } from 'src/dtos/editing.dto';
import {
  AacProfile,
  Av1Profile,
  ColorMatrix,
  ColorPrimaries,
  Colorspace,
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  H264Profile,
  HevcProfile,
  LogLevel,
  RawExtractedFormat,
  TranscodeHardwareAcceleration,
} from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import {
  DecodeToBufferOptions,
  GenerateThumbhashOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  ProbeOptions,
  TranscodeCommand,
  VideoInfo,
  VideoPacketInfo,
} from 'src/types';
import { handlePromiseError } from 'src/utils/misc';
import { JpegFrameSplitter } from 'src/utils/mjpeg';
import { TRANSCRIPTION_SAMPLE_RATE, TranscriptionChunk, validateTranscriptionChunk } from 'src/utils/transcription';
import { createAffineMatrix } from 'src/utils/transform';

const probe = (input: string, options: string[]): Promise<FfprobeData> =>
  new Promise((resolve, reject) =>
    ffmpeg.ffprobe(input, options, (error, data) => (error ? reject(error) : resolve(data))),
  );

const pascalCase = (str: string) => _.upperFirst(_.camelCase(str.toLowerCase()));

type ProgressEvent = {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
};

export type ExtractResult = {
  buffer: Buffer;
  format: RawExtractedFormat;
};

/**
 * `child.kill()` on a process that already exited emits an `error` event (ESRCH). fluent-ffmpeg's own
 * error handler then calls its end callback without the output rings and throws a TypeError, which is
 * an uncaught exception that takes the whole worker down. Never signal a finished process.
 */
const isProcessRunning = (command: unknown): boolean => {
  const child = (command as { ffmpegProc?: ChildProcess }).ffmpegProc;
  return child !== undefined && child.exitCode === null && child.signalCode === null;
};

@Injectable()
export class MediaRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MediaRepository.name);
    sharp.concurrency(0);
    sharp.cache({ files: 0 });
  }

  /**
   *
   * @param input file path to the input image
   * @returns ExtractResult if succeeded, or null if failed
   */
  async extract(input: string): Promise<ExtractResult | null> {
    for (const { tag, format } of [
      { tag: 'JpgFromRaw2', format: RawExtractedFormat.Jpeg },
      { tag: 'JpgFromRaw', format: RawExtractedFormat.Jpeg },
      { tag: 'PreviewJXL', format: RawExtractedFormat.Jxl },
      { tag: 'PreviewImage', format: RawExtractedFormat.Jpeg },
    ]) {
      try {
        const buffer = await exiftool.extractBinaryTagToBuffer(tag, input);
        this.logger.debug(`Successfully extracted ${tag} buffer from image`);
        return { buffer, format };
      } catch (error: any) {
        this.logger.debug(`Could not extract ${tag} buffer from image: ${error}`);
      }
    }
    return null;
  }

  async writeExif(tags: Partial<Exif>, output: string): Promise<boolean> {
    try {
      const tagsToWrite: WriteTags = {
        ExifImageWidth: tags.exifImageWidth,
        ExifImageHeight: tags.exifImageHeight,
        DateTimeOriginal: tags.dateTimeOriginal && ExifDateTime.fromMillis(tags.dateTimeOriginal.getTime()),
        ModifyDate: tags.modifyDate && ExifDateTime.fromMillis(tags.modifyDate.getTime()),
        TimeZone: tags.timeZone,
        GPSLatitude: tags.latitude,
        GPSLongitude: tags.longitude,
        ProjectionType: tags.projectionType,
        City: tags.city,
        Country: tags.country,
        Make: tags.make,
        Model: tags.model,
        LensModel: tags.lensModel,
        Fnumber: tags.fNumber?.toFixed(1),
        FocalLength: tags.focalLength?.toFixed(1),
        ISO: tags.iso,
        ExposureTime: tags.exposureTime,
        ProfileDescription: tags.profileDescription,
        ColorSpace: tags.colorspace,
        Rating: tags.rating === null ? 0 : tags.rating,
        // specially convert Orientation to numeric Orientation# for exiftool
        'Orientation#': tags.orientation ? Number(tags.orientation) : undefined,
      };

      await exiftool.write(output, tagsToWrite, {
        ignoreMinorErrors: true,
        writeArgs: ['-overwrite_original'],
      });
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not write exif data to image: ${error.message}`);
      return false;
    }
  }

  async copyTagGroup(tagGroup: string, source: string, target: string): Promise<boolean> {
    try {
      await exiftool.write(
        target,
        {},
        {
          ignoreMinorErrors: true,
          writeArgs: ['-TagsFromFile', source, `-${tagGroup}:all>${tagGroup}:all`, '-overwrite_original'],
        },
      );
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not copy tag data to image: ${error.message}`);
      return false;
    }
  }

  decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {
    return this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });
  }

  private applyEdits(pipeline: sharp.Sharp, edits: AssetEditActionItem[]): sharp.Sharp {
    const crop = edits.find((edit) => edit.action === 'crop');
    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.parameters.x),
        top: Math.round(crop.parameters.y),
        width: Math.round(crop.parameters.width),
        height: Math.round(crop.parameters.height),
      });
    }

    const affineEditOperations = edits.filter((edit) => edit.action !== 'crop');
    if (affineEditOperations.length > 0) {
      const { a, b, c, d } = createAffineMatrix(affineEditOperations);
      pipeline = pipeline.affine([
        [a, b],
        [c, d],
      ]);
    }

    return pipeline;
  }

  async generateThumbnail(input: string | Buffer, options: GenerateThumbnailOptions, output: string): Promise<void> {
    await this.getImageDecodingPipeline(input, options)
      .toFormat(options.format, {
        quality: options.quality,
        // this is default in libvips (except the threshold is 90), but we need to set it manually in sharp
        chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
        progressive: options.progressive,
      })
      .toFile(output);
  }

  private getImageDecodingPipeline(input: string | Buffer, options: DecodeToBufferOptions) {
    let pipeline = sharp(input, {
      // some invalid images can still be processed by sharp, but we want to fail on them by default to avoid crashes
      failOn: options.processInvalidImages ? 'none' : 'error',
      limitInputChannels: false,
      limitInputPixels: false,
      raw: options.raw,
      unlimited: true,
    })
      .pipelineColorspace(options.colorspace === Colorspace.Srgb ? 'srgb' : 'rgb16')
      .withIccProfile(options.colorspace);

    if (!options.raw) {
      const { angle, flip, flop } = options.orientation ? ORIENTATION_TO_SHARP_ROTATION[options.orientation] : {};
      pipeline = pipeline.rotate(angle);
      if (flip) {
        pipeline = pipeline.flip();
      }

      if (flop) {
        pipeline = pipeline.flop();
      }
    }

    if (options.edits && options.edits.length > 0) {
      pipeline = this.applyEdits(pipeline, options.edits);
    }

    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'outside', withoutEnlargement: true });
    }
    return pipeline;
  }

  async generateThumbhash(input: string | Buffer, options: GenerateThumbhashOptions): Promise<Buffer> {
    const { rgbaToThumbHash } = await import('thumbhash');

    const { data, info } = await this.getImageDecodingPipeline(input, {
      colorspace: options.colorspace,
      processInvalidImages: options.processInvalidImages,
      raw: options.raw,
      edits: options.edits,
    })
      .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    return Buffer.from(rgbaToThumbHash(info.width, info.height, data));
  }

  async probe(input: string, options?: ProbeOptions): Promise<VideoInfo> {
    const results = await probe(input, options?.countFrames ? ['-count_packets'] : []); // gets frame count quickly: https://stackoverflow.com/a/28376817
    return {
      format: {
        formatName: results.format.format_name,
        formatLongName: results.format.format_long_name,
        duration: this.parseFloat(results.format.duration),
        bitrate: this.parseInt(results.format.bit_rate),
      },
      videoStreams: results.streams
        .filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => {
          const height = this.parseInt(stream.height);
          const dar = this.getDar(stream.display_aspect_ratio);
          return {
            index: stream.index,
            height,
            width: dar ? Math.round(height * dar) : this.parseInt(stream.width),
            codecName: stream.codec_name === 'h265' ? 'hevc' : (stream.codec_name ?? null),
            profile: this.parseVideoProfile(stream.codec_name, stream.profile as string | undefined) ?? null,
            level: this.parseOptionalInt(stream.level),
            frameCount: this.parseInt(options?.countFrames ? stream.nb_read_packets : stream.nb_frames),
            frameRate: this.parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
            timeBase: this.parseRational(stream.time_base)?.den ?? null,
            rotation: this.parseInt(stream.rotation),
            bitrate: this.parseInt(stream.bit_rate),
            pixelFormat: stream.pix_fmt || 'yuv420p',
            colorPrimaries: this.parseEnum(ColorPrimaries, stream.color_primaries) ?? ColorPrimaries.Unknown,
            colorMatrix: this.parseEnum(ColorMatrix, stream.color_space) ?? ColorMatrix.Unknown,
            colorTransfer: this.parseEnum(ColorTransfer, stream.color_transfer) ?? ColorTransfer.Unknown,
            dvProfile: this.parseOptionalInt(stream.dv_profile) as DvProfile | null,
            dvLevel: this.parseOptionalInt(stream.dv_level),
            dvBlSignalCompatibilityId: this.parseOptionalInt(
              stream.dv_bl_signal_compatibility_id,
            ) as DvSignalCompatibility | null,
          };
        }),
      audioStreams: results.streams
        .filter((stream) => stream.codec_type === 'audio')
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => ({
          index: stream.index,
          codecName: stream.codec_name ?? null,
          profile:
            stream.codec_name === 'aac' ? this.parseEnum(AacProfile, stream.profile as string | undefined) : null,
          bitrate: this.parseInt(stream.bit_rate),
        })),
    };
  }

  /**
   * Needed for accurate segments, especially when remuxing, seeking and/or VFR is involved.
   * Scanning packets for keyframes in JS is much faster than -skip_frame nokey since it avoids decoding the video.
   */
  probePackets(input: string, streamIndex: number): Promise<VideoPacketInfo | null> {
    const ffprobe = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        String(streamIndex),
        '-show_entries',
        'packet=pts,duration,flags',
        '-of',
        'csv=p=0',
        input,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let totalDuration = 0;
    const keyframePts: number[] = [];
    const keyframeAccDuration: number[] = [];
    const keyframeOwnDuration: number[] = [];
    const postDiscard: { pts: number; duration: number }[] = [];
    const parseLine = (line: string) => {
      if (!line) {
        return;
      }
      const [ptsStr, durationStr, flags] = line.split(',', 3);
      const pts = Number.parseInt(ptsStr);
      const duration = Number.parseInt(durationStr);
      if (Number.isNaN(pts) || Number.isNaN(duration) || !flags) {
        return;
      }
      // Discarded packets don't contribute to packet count, but still contribute to video duration
      totalDuration += duration;
      if (flags[1] !== 'D') {
        postDiscard.push({ pts, duration });
      }
      if (flags[0] === 'K') {
        keyframePts.push(pts);
        keyframeAccDuration.push(totalDuration);
        // VFR content can have variable duration keyframes,
        // so we need to track their duration separately for accurate segment boundaries.
        // Non-keyframes are accounted for in totalDuration.
        keyframeOwnDuration.push(duration);
      }
    };

    let stderr = '';
    let remainder = '';
    ffprobe.stderr.setEncoding('utf8');
    ffprobe.stderr.on('data', (chunk: string) => (stderr += chunk));
    ffprobe.stdout.setEncoding('utf8');
    ffprobe.stdout.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      lines[0] = remainder + lines[0];
      remainder = lines.pop() as string;
      for (const line of lines) {
        parseLine(line);
      }
    });

    return new Promise<VideoPacketInfo | null>((resolve, reject) => {
      ffprobe.on('error', reject);
      ffprobe.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`));
        }
        parseLine(remainder);
        if (postDiscard.length === 0) {
          return resolve(null);
        }

        resolve({
          totalDuration,
          packetCount: postDiscard.length,
          outputFrames: this.cfrOutputFrames(postDiscard, postDiscard.length / totalDuration),
          keyframePts,
          keyframeAccDuration,
          keyframeOwnDuration,
        });
      });
    });
  }

  /** Accurate input seeking decodes from the preceding keyframe; never use thumbnail selection here. */
  async extractVideoFaceFrame(
    input: string,
    timestampMs: number,
    options: { accel?: TranscodeHardwareAcceleration; accelDecode?: boolean } = {},
  ): Promise<Buffer> {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      throw new Error('Invalid video face timestamp');
    }

    const useCuda = options.accel === TranscodeHardwareAcceleration.Nvenc && options.accelDecode !== false;
    try {
      return await this.runVideoFaceFrame(input, timestampMs, useCuda);
    } catch (error: any) {
      if (!useCuda) {
        throw error;
      }
      // Hardware decode can fail for codecs the GPU cannot handle; fall back to software decoding
      // rather than failing the whole face detection job.
      this.logger.warn(`CUDA-accelerated frame extraction failed, retrying in software: ${error?.message ?? error}`);
      return this.runVideoFaceFrame(input, timestampMs, false);
    }
  }

  /**
   * Decodes every face-sampling frame of a video with ONE FFmpeg process and yields them in order.
   *
   * Spawning a process per sampled frame made the sampler spend most of its time on process start-up,
   * so all frames come from a single decode. The stream deliberately does NOT probe the file first: a
   * probe is an extra pass over a slow disk, and ffprobe has no timeout here, so an interrupted probe
   * left a zombie child and hung the job forever. The `fps` filter emits on the sampling grid, which
   * makes frame N exactly N * interval.
   */
  async *streamVideoFaceFrames(
    input: string,
    options: {
      intervalMs: number;
      maxFrames?: number;
      accel?: TranscodeHardwareAcceleration;
      accelDecode?: boolean;
      keyframesOnly?: boolean;
    },
  ): AsyncGenerator<{ timestampMs: number; buffer: Buffer }> {
    const { intervalMs, maxFrames = 0 } = options;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('Invalid video face interval');
    }
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 0) {
      throw new Error('Invalid video face frame cap');
    }

    const fps = 1000 / intervalMs;
    const useCuda = options.accel === TranscodeHardwareAcceleration.Nvenc && options.accelDecode !== false;
    const keyframesOnly = options.keyframesOnly === true;
    // Per-stream state: several videos are sampled concurrently, so this must not live on the instance.
    const progress = { frames: 0 };
    try {
      yield* this.runVideoFaceStream(input, intervalMs, fps, maxFrames, useCuda, progress, keyframesOnly);
    } catch (error: any) {
      // Hardware decoding can reject codecs the GPU cannot handle; only a stream that never produced a
      // frame can be replayed without duplicating work.
      if (!useCuda || progress.frames > 0) {
        throw error;
      }
      this.logger.warn(`CUDA-accelerated frame decoding failed, retrying in software: ${error?.message ?? error}`);
      yield* this.runVideoFaceStream(input, intervalMs, fps, maxFrames, false, progress, keyframesOnly);
    }
  }

  private async *runVideoFaceStream(
    input: string,
    intervalMs: number,
    fps: number,
    maxFrames: number,
    useCuda: boolean,
    progress: { frames: number },
    keyframesOnly: boolean,
  ): AsyncGenerator<{ timestampMs: number; buffer: Buffer }> {
    const scale = "scale=w='max(2,trunc(min(1080,iw*sar)/2)*2)':h='max(2,trunc(ih*min(1,1080/(iw*sar))/2)*2)',setsar=1";
    // Sample first, then scale, so only the frames that are actually used get resized.
    const filter = `${useCuda ? 'hwdownload,format=nv12,' : ''}fps=${fps},${scale}`;
    // Bound decoder threads: many videos are sampled at once, and an unbounded decoder thread count per
    // process exhausts the container's thread/PID budget.
    const inputOptions: string[] = ['-threads', '2'];
    if (useCuda) {
      inputOptions.push('-hwaccel_output_format', 'cuda', '-hwaccel', 'cuda');
    }
    if (keyframesOnly) {
      // Sampling every N seconds does not need every frame: decoding only key frames cuts the pass to
      // about a third. The `fps` filter still emits on the exact sampling grid, so timestamps stay true.
      inputOptions.push('-skip_frame', 'nokey');
    }

    const output = new PassThrough();
    let failure: Error | undefined;
    const outputOptions = ['-map 0:v:0', '-an', '-sn', `-vf ${filter}`];
    if (maxFrames > 0) {
      outputOptions.push('-frames:v', String(maxFrames));
    }
    outputOptions.push('-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '2');

    const command = ffmpeg(input, { niceness: 10, timeout: 1800 })
      .inputOptions(inputOptions)
      .outputOptions(outputOptions)
      .output(output)
      .on('error', (error: Error) => {
        failure = error;
        output.destroy();
      });
    command.run();

    const splitter = new JpegFrameSplitter();
    let index = 0;
    try {
      for await (const chunk of output) {
        for (const buffer of splitter.push(chunk as Buffer)) {
          progress.frames++;
          yield { timestampMs: index++ * intervalMs, buffer };
          if (maxFrames > 0 && index >= maxFrames) {
            return;
          }
        }
      }
    } finally {
      // Stop decoding as soon as the consumer is done: frame cap reached, job cancelled, or error.
      if (isProcessRunning(command)) {
        command.kill('SIGKILL');
      }
      output.destroy();
    }

    if (progress.frames === 0) {
      // Never report success with nothing decoded: the job must be retried and stay visible instead of
      // silently recording "no faces" for a video that was never looked at.
      throw failure ?? new Error(`Video frame stream produced no frames for ${input}`);
    }
  }

  private async runVideoFaceFrame(input: string, timestampMs: number, useCuda: boolean): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const scale = "scale=w='max(2,trunc(min(1080,iw*sar)/2)*2)':h='max(2,trunc(ih*min(1,1080/(iw*sar))/2)*2)',setsar=1";
    const inputOptions = ['-ss', String(timestampMs / 1000)];
    if (useCuda) {
      // Decode on the GPU, then download the single frame before the CPU-side scaling and JPEG encode.
      inputOptions.unshift('-hwaccel_output_format', 'cuda', '-hwaccel', 'cuda');
    }
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input, { niceness: 10, timeout: 120 })
        .inputOptions(inputOptions)
        .outputOptions([
          '-map 0:v:0',
          '-frames:v 1',
          '-an',
          '-sn',
          `-vf ${useCuda ? 'hwdownload,format=nv12,' : ''}${scale}`,
          '-f image2pipe',
          '-c:v mjpeg',
          '-q:v 2',
        ])
        .output(output)
        .on('error', reject)
        .on('end', () => resolve())
        .run();
    });
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      throw new Error(`No video frame at ${timestampMs}ms`);
    }
    return buffer;
  }

  /** Bounded mono PCM16 LE for ASR. No original-file writes and no full-video audio buffering. */
  async extractTranscriptionAudio(
    input: string,
    chunk: TranscriptionChunk,
    audioStreamIndex: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    validateTranscriptionChunk(chunk);
    if (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0) {
      throw new Error('Invalid transcription audio stream');
    }
    signal?.throwIfAborted();
    const maxBytes = Math.ceil((chunk.durationMs / 1000) * TRANSCRIPTION_SAMPLE_RATE) * 2;
    const buffers: Buffer[] = [];
    let size = 0;
    const output = new Writable({
      write(buffer: Buffer, _encoding, callback) {
        size += buffer.length;
        if (size > maxBytes) {
          callback(new Error('Transcription audio exceeded chunk limit'));
          return;
        }
        buffers.push(buffer);
        callback();
      },
    });
    const command = ffmpeg(input, { niceness: 10, timeout: 120 })
      .inputOptions(['-ss', String(chunk.startMs / 1000)])
      .outputOptions([
        `-map 0:${audioStreamIndex}`,
        '-vn',
        '-sn',
        '-dn',
        '-threads 1',
        '-ac 1',
        `-ar ${TRANSCRIPTION_SAMPLE_RATE}`,
        // Preserve audio delays as silence instead of moving speech to the beginning of the window.
        `-af aresample=${TRANSCRIPTION_SAMPLE_RATE}:async=1:first_pts=0`,
        `-t ${chunk.durationMs / 1000}`,
        '-c:a pcm_s16le',
        '-f s16le',
      ])
      .output(output);
    const abort = () => {
      if (isProcessRunning(command)) {
        command.kill('SIGKILL');
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        command
          .on('start', () => {
            // Cancellation can arrive while fluent-ffmpeg resolves executable capabilities before spawning.
            if (signal?.aborted) {
              abort();
            }
          })
          .on('error', reject)
          .on('end', () => resolve())
          .run();
      });
      signal?.throwIfAborted();
      return Buffer.concat(buffers, size);
    } finally {
      signal?.removeEventListener('abort', abort);
      output.destroy();
    }
  }

  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {
    if (!options.twoPass) {
      return new Promise((resolve, reject) => {
        this.configureFfmpegCall(input, output, options)
          .on('error', reject)
          .on('end', () => resolve())
          .run();
      });
    }

    if (typeof output !== 'string') {
      throw new TypeError('Two-pass transcoding does not support writing to a stream');
    }

    // two-pass allows for precise control of bitrate at the cost of running twice
    // recommended for vp9 for better quality and compression
    return new Promise((resolve, reject) => {
      // first pass output is not saved as only the .log file is needed
      this.configureFfmpegCall(input, '/dev/null', options)
        .addOptions('-pass', '1')
        .addOptions('-passlogfile', output)
        .addOptions('-f null')
        .on('error', reject)
        .on('end', () => {
          // second pass
          this.configureFfmpegCall(input, output, options)
            .addOptions('-pass', '2')
            .addOptions('-passlogfile', output)
            .on('error', reject)
            .on('end', () => handlePromiseError(fs.unlink(`${output}-0.log`), this.logger))
            .on('end', () => handlePromiseError(fs.rm(`${output}-0.log.mbtree`, { force: true }), this.logger))
            .on('end', () => resolve())
            .run();
        })
        .run();
    });
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    const { width = 0, height = 0, hasAlpha = false } = await sharp(input, { unlimited: true }).metadata();
    return { width, height, isTransparent: hasAlpha };
  }

  private configureFfmpegCall(input: string, output: string | Writable, options: TranscodeCommand) {
    const ffmpegCall = ffmpeg(input, { niceness: 10 })
      .inputOptions(options.inputOptions)
      .outputOptions(options.outputOptions)
      .output(output)
      .on('start', (command: string) => this.logger.debug(command))
      .on('error', (error, _, stderr) => this.logger.error(stderr || error));

    const { frameCount, percentInterval } = options.progress;
    const frameInterval = Math.ceil(frameCount / (100 / percentInterval));
    if (this.logger.isLevelEnabled(LogLevel.Debug) && frameCount && frameInterval) {
      let lastProgressFrame: number = 0;
      ffmpegCall.on('progress', (progress: ProgressEvent) => {
        if (progress.frames - lastProgressFrame < frameInterval) {
          return;
        }

        lastProgressFrame = progress.frames;
        const percent = ((progress.frames / frameCount) * 100).toFixed(2);
        const ms = progress.currentFps ? Math.floor((frameCount - progress.frames) / progress.currentFps) * 1000 : 0;
        const duration = ms ? Duration.fromMillis(ms).rescale().toHuman({ unitDisplay: 'narrow' }) : '';
        const outputText = output instanceof Writable ? 'stream' : output.split('/').pop();
        this.logger.debug(
          `Transcoding ${percent}% done${duration ? `, estimated ${duration} remaining` : ''} for output ${outputText}`,
        );
      });
    }

    return ffmpegCall;
  }

  private parseInt(value: string | number | undefined): number {
    return Number.parseInt(value as string) || 0;
  }

  private parseFloat(value: string | number | undefined): number {
    // eslint-disable-next-line unicorn/prefer-number-coercion
    return Number.parseFloat(value as string) || 0;
  }

  private parseOptionalInt(value: string | number | undefined): number | null {
    const parsed = Number.parseInt(value as string);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseEnum<E extends Record<string, number | string>>(enumObj: E, value?: string) {
    return value ? ((enumObj[pascalCase(value)] as Extract<E[keyof E], number> | undefined) ?? null) : null;
  }

  /** Parse a rational like "60000/1001" or "1/600" into `{ num, den }`. */
  private parseRational(value: string | undefined): { num: number; den: number } | null {
    if (value) {
      const [num, den = 1] = value.split('/').map(Number);
      if (num && den) {
        return { num, den };
      }
    }
    return null;
  }

  private parseFrameRate(value: string | undefined): number | null {
    const r = this.parseRational(value);
    return r ? r.num / r.den : null;
  }

  private getDar(dar: string | undefined): number {
    if (dar) {
      const [darW, darH] = dar.split(':').map(Number);
      if (darW && darH) {
        return darW / darH;
      }
    }

    return 0;
  }

  private parseVideoProfile(codec?: string, profile?: string) {
    switch (codec) {
      case 'h264': {
        return this.parseEnum(H264Profile, profile);
      }
      case 'h265':
      case 'hevc': {
        return this.parseEnum(HevcProfile, profile);
      }
      case 'av1': {
        return this.parseEnum(Av1Profile, profile);
      }
      default: {
        return null;
      }
    }
  }

  private compareStreams(a: FfprobeStream, b: FfprobeStream): number {
    const d = (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0);
    if (d !== 0) {
      return d;
    }
    return this.parseInt(b.bit_rate) - this.parseInt(a.bit_rate);
  }

  /* Ported from https://code.ffmpeg.org/FFmpeg/FFmpeg/src/commit/5c44245878e235ae64fe87fb9877644856d33d1d/fftools/ffmpeg_filter.c
   * SPDX-License-Identifier: LGPL-2.1-or-later
   * Copyright (c) FFmpeg authors and contributors — https://ffmpeg.org/
   * Modifications: TS port operating on probe-derived packet metadata rather than decoded AVFrames. */
  private cfrOutputFrames(packets: { pts: number; duration: number }[], slotsPerTick: number) {
    packets.sort((a, b) => a.pts - b.pts);
    const firstPts = packets[0].pts;
    let outputFrames = 0;
    let nextPts = 0;
    const history = [0, 0, 0];
    for (const pkt of packets) {
      const syncIpts = (pkt.pts - firstPts) * slotsPerTick;
      const duration = pkt.duration * slotsPerTick;
      let delta0 = syncIpts - nextPts;
      const delta = delta0 + duration;

      if (delta0 < 0 && delta > 0) {
        delta0 = 0;
      }

      let nb = 1;
      let nbPrev = 0;
      if (delta < -1.1) {
        nb = 0;
      } else if (delta > 1.1) {
        nb = Math.round(delta);
        if (delta0 > 1.1) {
          nbPrev = Math.round(delta0 - 0.6);
        }
      }
      outputFrames += nb;
      nextPts += nb;
      history[2] = history[1];
      history[1] = history[0];
      history[0] = nbPrev;
    }
    const median = history.sort((a, b) => a - b)[1];
    return outputFrames + median;
  }
}
