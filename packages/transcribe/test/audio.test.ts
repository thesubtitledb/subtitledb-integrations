import { describe, expect, it } from 'vitest';
import { type AudioDecoder, downmix, extractAudio, resampleLinear } from '../src/audio.js';
import { TranscribeError } from '../src/errors.js';

describe('downmix', () => {
  it('passes a single channel through untouched', () => {
    expect(Array.from(downmix([new Float32Array([1, 2, 3])]))).toEqual([1, 2, 3]);
  });

  it('averages several channels', () => {
    const mono = downmix([new Float32Array([0, 2]), new Float32Array([2, 0])]);
    expect(Array.from(mono)).toEqual([1, 1]);
  });
});

describe('resampleLinear', () => {
  it('returns the input untouched when the rate already matches', () => {
    const input = new Float32Array([1, 2]);
    expect(resampleLinear(input, 16_000, 16_000)).toBe(input);
  });

  it('halves the length when halving the rate, interpolating linearly', () => {
    const half = resampleLinear(new Float32Array([0, 1, 2, 3]), 32_000, 16_000);
    expect(Array.from(half)).toEqual([0, 3]);
  });
});

describe('extractAudio', () => {
  const decoder = (): AudioDecoder => ({
    decodeAudioData: async () => ({
      numberOfChannels: 1,
      sampleRate: 32_000,
      getChannelData: () => new Float32Array([0, 1, 0, 1]),
    }),
  });

  it('reads, decodes, downmixes and resamples to 16 kHz', async () => {
    const fetchStub = (async () =>
      new Response(new ArrayBuffer(8), { status: 200 })) as unknown as typeof fetch;
    const pcm = await extractAudio(
      { currentSrc: 'https://example.test/clip.webm', src: '' },
      { fetch: fetchStub, decoder },
    );
    // Four samples at 32 kHz resample to two at 16 kHz.
    expect(pcm.length).toBe(2);
  });

  it('refuses a media element with no source, before touching the network', async () => {
    await expect(extractAudio({ currentSrc: '', src: '' })).rejects.toMatchObject({
      code: 'no_source',
    });
  });

  it('reads the source override instead of the element, for a media a fetch cannot read', async () => {
    // The element plays a cross-origin URL a fetch is blocked from reading; the audio
    // is read from the CORS-readable copy the caller passed instead.
    let asked = '';
    const fetchStub = (async (url: string) => {
      asked = url;
      return new Response(new ArrayBuffer(8), { status: 200 });
    }) as unknown as typeof fetch;
    const pcm = await extractAudio(
      { currentSrc: 'https://blocked.test/redirected.mp4', src: '' },
      { fetch: fetchStub, decoder },
      undefined,
      'https://cors.test/same-clip.mp4',
    );
    expect(asked).toBe('https://cors.test/same-clip.mp4');
    expect(pcm.length).toBe(2);
  });

  it('falls back to the element source when no override is given', async () => {
    let asked = '';
    const fetchStub = (async (url: string) => {
      asked = url;
      return new Response(new ArrayBuffer(8), { status: 200 });
    }) as unknown as typeof fetch;
    await extractAudio(
      { currentSrc: 'https://example.test/clip.webm', src: '' },
      { fetch: fetchStub, decoder },
    );
    expect(asked).toBe('https://example.test/clip.webm');
  });

  it('reports an unreadable, likely cross-origin, source', async () => {
    const bad = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await extractAudio(
      { currentSrc: 'https://other.test/clip.webm', src: '' },
      { fetch: bad, decoder },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err.code).toBe('audio_unreadable');
  });

  it('reports a non-ok response as a fetch failure', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      extractAudio({ currentSrc: 'https://example.test/x', src: '' }, { fetch: bad, decoder }),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });
});
