import { JpegFrameSplitter } from 'src/utils/mjpeg';

const jpeg = (...bytes: number[]) => Buffer.from([0xff, 0xd8, ...bytes, 0xff, 0xd9]);

describe('JpegFrameSplitter', () => {
  it('extracts several frames delivered in one chunk', () => {
    const splitter = new JpegFrameSplitter();
    const frames = splitter.push(Buffer.concat([jpeg(1), jpeg(2, 3), jpeg(4)]));
    expect(frames.map((frame) => [...frame])).toEqual([[...jpeg(1)], [...jpeg(2, 3)], [...jpeg(4)]]);
    expect(splitter.pending).toBe(0);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const splitter = new JpegFrameSplitter();
    const frame = jpeg(9, 9, 9, 9);
    const frames = [
      ...splitter.push(frame.subarray(0, 1)),
      ...splitter.push(frame.subarray(1, 3)),
      ...splitter.push(frame.subarray(3, -1)),
      ...splitter.push(frame.subarray(-1)),
    ];
    expect(frames).toHaveLength(1);
    expect([...frames[0]]).toEqual([...frame]);
  });

  it('does not emit a truncated frame', () => {
    const splitter = new JpegFrameSplitter();
    const frame = jpeg(1, 2, 3);
    expect(splitter.push(Buffer.concat([frame, frame.subarray(0, -2)]))).toHaveLength(1);
    expect(splitter.pending).toBe(frame.length - 2);
  });

  it('ignores leading noise and keeps a possible partial marker', () => {
    const splitter = new JpegFrameSplitter();
    // Noise whose last byte is 0xff: that byte must survive until the next chunk completes the marker.
    expect(splitter.push(Buffer.from([0x00, 0x11, 0xff]))).toHaveLength(0);
    expect(splitter.pending).toBe(1);
    const frames = splitter.push(Buffer.from([0xd8, 0x01, 0xff, 0xd9]));
    expect([...frames[0]]).toEqual([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  });

  it('handles an empty stream', () => {
    const splitter = new JpegFrameSplitter();
    expect(splitter.push(Buffer.alloc(0))).toEqual([]);
    expect(splitter.pending).toBe(0);
  });
});
