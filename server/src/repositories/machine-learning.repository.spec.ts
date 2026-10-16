import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineLearningConfig } from 'src/dtos/config.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository';

const config = (overrides: Partial<MachineLearningConfig> = {}) =>
  ({
    enabled: true,
    urls: ['http://npu-worker:3003'],
    facialRecognitionUrls: [],
    clipUrls: [],
    availabilityChecks: { enabled: false, interval: 1000, timeout: 1000 },
    ...overrides,
  }) as MachineLearningConfig;

describe('MachineLearningRepository request routing', () => {
  let sut: MachineLearningRepository;
  let requested: string[];
  let imagePath: string;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ml-routing-'));
    imagePath = join(directory, 'image.jpg');
    await writeFile(imagePath, Buffer.from('image'));

    requested = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: URL) => {
        requested.push(url.origin);
        return Promise.resolve(
          Response.json({ 'facial-recognition': [], clip: 'embedding', imageWidth: 1, imageHeight: 1 }),
        );
      }),
    );
    // The repository logs through the shared logger interface; the routing assertions do not care
    // about its output, only that calls do not explode.
    sut = new MachineLearningRepository(
      new Proxy(
        {},
        {
          get: () => vi.fn(),
        },
      ) as unknown as LoggingRepository,
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('routes face detection to its own worker when configured', async () => {
    sut.setup(
      config({ facialRecognitionUrls: ['http://gpu-face-worker:3003'], clipUrls: ['http://gpu-clip-worker:3003'] }),
    );

    await sut.detectFaces(Buffer.from('image'), { modelName: 'buffalo_l', minScore: 0.7 });
    await sut.encodeImage(imagePath, { enabled: true, modelName: 'ViT-B-32__openai' });

    expect(requested).toEqual(['http://gpu-face-worker:3003', 'http://gpu-clip-worker:3003']);
  });

  it('sends every request to the general worker when no CLIP worker is configured', async () => {
    sut.setup(config());

    await sut.detectFaces(Buffer.from('image'), { modelName: 'buffalo_l', minScore: 0.7 });
    await sut.encodeImage(imagePath, { enabled: true, modelName: 'ViT-B-32__openai' });

    expect(requested).toEqual(['http://npu-worker:3003', 'http://npu-worker:3003']);
  });

  it('routes CLIP to the configured worker while other models stay on the general one', async () => {
    sut.setup(config({ clipUrls: ['http://gpu-worker:3003'] }));

    await sut.detectFaces(Buffer.from('image'), { modelName: 'buffalo_l', minScore: 0.7 });
    await sut.encodeImage(imagePath, { enabled: true, modelName: 'ViT-B-32__openai' });

    expect(requested).toEqual(['http://npu-worker:3003', 'http://gpu-worker:3003']);
  });

  it('reports a failure when every CLIP worker is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    sut.setup(config({ clipUrls: ['http://gpu-worker:3003'] }));

    await expect(sut.encodeImage(imagePath, { enabled: true, modelName: 'ViT-B-32__openai' })).rejects.toThrow(
      'failed for all URLs',
    );
  });
});
