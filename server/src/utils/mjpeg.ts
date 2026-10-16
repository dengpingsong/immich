/**
 * Splits an MJPEG byte stream into individual JPEG frames.
 *
 * The video face sampler decodes many frames with a single FFmpeg process and receives them as a
 * continuous `<SOI>…<EOI>` byte stream, so frames have to be cut out of arbitrary chunk boundaries.
 * A trailing incomplete frame is discarded: a truncated JPEG must never be sent to the model.
 */
const MARKER = 0xff;
const SOI_SECOND = 0xd8;
const EOI_SECOND = 0xd9;

/** `Buffer.indexOf` with a number only matches a single byte, so markers need explicit two-byte scans. */
const findMarker = (buffer: Buffer, second: number, from: number): number => {
  for (let index = from; index + 1 < buffer.length; index++) {
    if (buffer[index] === MARKER && buffer[index + 1] === second) {
      return index;
    }
  }
  return -1;
};

export class JpegFrameSplitter {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const start = findMarker(this.#buffer, SOI_SECOND, 0);
      if (start === -1) {
        // Keep at most the last byte: it could be the 0xff half of a marker split across chunks.
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 1));
        return frames;
      }
      if (start > 0) {
        this.#buffer = this.#buffer.subarray(start);
      }

      const end = findMarker(this.#buffer, EOI_SECOND, 2);
      if (end === -1) {
        return frames;
      }

      frames.push(this.#buffer.subarray(0, end + 2));
      this.#buffer = this.#buffer.subarray(end + 2);
    }
  }

  /** Remaining bytes, for diagnostics; an unfinished frame is never returned as a frame. */
  get pending(): number {
    return this.#buffer.length;
  }
}
