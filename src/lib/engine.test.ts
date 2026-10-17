import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { strFromU8, unzipSync } from 'fflate';
import { encodeFromWav, makeWav } from '../../scripts/make-fixtures.mjs';
import { getEncodeSupport, isAbortError, probeFile, runJob } from './engine';
import { zipParts } from './zip';
import type { OutputPart } from './types';

// 注意: Node には AAC / MP3 の「デコーダ」が無い（WebCodecs が無い）ため、
// 「m4a -> m4a」「mp3 -> mp3」のような再エンコードは Node ではテストできない（テスト対象外）。
// 再エンコードは WAV (PCM) を入力にしてテストする。m4a / mp3 入力は無劣化コピーのみテストする。
// m4a / mp3 入力の再エンコードはブラウザ（Chrome / Edge）で手動確認する。

const makeFile = (bytes: Uint8Array, name: string, type: string) =>
  new File([bytes as BlobPart], name, { type });

async function inspect(part: OutputPart) {
  const input = new Input({
    source: new BufferSource(new Uint8Array(await part.blob.arrayBuffer())),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    return {
      duration: await input.computeDuration(),
      channels: track!.numberOfChannels,
      codec: await track!.getCodec(),
      format: (await input.getFormat()).name,
    };
  } finally {
    input.dispose();
  }
}

let wavFile: File;
let m4aFile: File;
let mp3File: File;
let shortWav: File;

beforeAll(async () => {
  const wav = makeWav(65);
  wavFile = makeFile(wav, 'test.wav', 'audio/wav');
  m4aFile = makeFile(await encodeFromWav(wav, 'm4a'), 'test.m4a', 'audio/mp4');
  mp3File = makeFile(await encodeFromWav(wav, 'mp3'), 'test.mp3', 'audio/mpeg');
  shortWav = makeFile(makeWav(30), '会議録音.wav', 'audio/wav');
});

describe('probeFile', () => {
  it('reads m4a', async () => {
    const info = await probeFile(m4aFile);
    expect(info.containerLabel).toBe('MP4');
    expect(info.codec).toBe('aac');
    expect(info.durationSec).toBeGreaterThan(64.9);
    expect(info.durationSec).toBeLessThan(65.2);
    expect(info.numberOfChannels).toBe(2);
    expect(info.sampleRate).toBe(44100);
    expect(info.hasVideo).toBe(false);
    expect(info.copyFormat?.ext).toBe('m4a');
    expect(info.audioBitrate).toBeGreaterThan(50000);
  });
  it('reads mp3 and wav', async () => {
    const mp3 = await probeFile(mp3File);
    expect(mp3.containerLabel).toBe('MP3');
    expect(mp3.copyFormat?.ext).toBe('mp3');
    const wav = await probeFile(wavFile);
    expect(wav.containerLabel).toBe('WAVE');
    expect(wav.codec).toBe('pcm-s16');
    expect(wav.copyFormat?.ext).toBe('wav');
    expect(wav.canDecode).toBe(true);
    expect(wav.audioBitrate).toBeGreaterThan(1_400_000);
    expect(wav.audioBitrate).toBeLessThan(1_420_000);
  });
  it('throws a Japanese error for non-audio files', async () => {
    const f = new File(['これは音声ではありません。ただのテキストです。'.repeat(50)], 'memo.txt', {
      type: 'text/plain',
    });
    const err = await probeFile(f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/読み込めませんでした/);
  });
  it('throws a Japanese error for an empty file', async () => {
    await expect(probeFile(new File([], 'empty.m4a'))).rejects.toThrow(/[ぁ-ん]/);
  });
});

describe('runJob: copy split', () => {
  const cases: [string, () => File][] = [
    ['m4a', () => m4aFile],
    ['mp3', () => mp3File],
    ['wav', () => wavFile],
  ];
  for (const [name, getFile] of cases) {
    it(`splits ${name} into 20s parts without re-encoding`, async () => {
      const file = getFile();
      const info = await probeFile(file);
      const seen: OutputPart[] = [];
      const progress: number[] = [];
      const parts = await runJob(file, info, { kind: 'points', points: [20, 40] }, { kind: 'copy' }, {
        onPart: (p) => seen.push(p),
        onProgress: (p) => progress.push(p.overall),
      });
      expect(parts).toHaveLength(3);
      expect(seen).toHaveLength(3);
      const ext = info.copyFormat!.ext;
      expect(parts.map((p) => p.fileName)).toEqual([`test_01.${ext}`, `test_02.${ext}`, `test_03.${ext}`]);
      expect(parts[0].blob.type).toBe(info.copyFormat!.mime);
      for (const [i, p] of parts.entries()) {
        const expected = i < 2 ? 20 : info.durationSec - 40;
        expect(p.index).toBe(i);
        expect(p.durationSec).toBeGreaterThan(expected - 0.1);
        expect(p.durationSec).toBeLessThan(expected + 0.15);
        const m = await inspect(p);
        expect(Math.abs(m.duration - p.durationSec)).toBeLessThan(0.01);
      }
      expect(progress[progress.length - 1]).toBeCloseTo(1, 5);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] - 1e-9);
      }
    });
  }

  it('no split (empty points) gives one file with a non-overwriting name', async () => {
    const info = await probeFile(m4aFile);
    const parts = await runJob(m4aFile, info, { kind: 'points', points: [] }, { kind: 'copy' });
    expect(parts).toHaveLength(1);
    expect(parts[0].fileName).toBe('test_compressed.m4a');
    expect(parts[0].durationSec).toBeGreaterThan(64.9);
  });
});

describe('runJob: encode', () => {
  it('WAV -> m4a with split', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [10, 20] },
      { kind: 'encode', format: 'm4a', bitrate: 64000, mono: false },
    );
    expect(parts).toHaveLength(3);
    expect(parts[0].fileName).toBe('会議録音_01.m4a');
    for (const p of parts) {
      expect(p.durationSec).toBeGreaterThan(9.8);
      expect(p.durationSec).toBeLessThan(10.3);
      const m = await inspect(p);
      expect(m.codec).toBe('aac');
      expect(m.format).toBe('MP4');
      expect(m.channels).toBe(2);
      // 64kbps なので 10 秒で 80KB 前後（WAV は 1.7MB）
      expect(p.blob.size).toBeLessThan(120_000);
      expect(p.blob.size).toBeGreaterThan(40_000);
    }
  });

  it('WAV -> mp3 with split', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [15] },
      { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false },
    );
    expect(parts).toHaveLength(2);
    expect(parts[1].fileName).toBe('会議録音_02.mp3');
    for (const p of parts) {
      const m = await inspect(p);
      expect(m.codec).toBe('mp3');
      expect(m.format).toBe('MP3');
      expect(p.durationSec).toBeGreaterThan(14.8);
      expect(p.durationSec).toBeLessThan(15.3);
    }
  });

  // 回帰テスト: 開始位置がサンプル境界からわずかにずれると、mediabunny が MP3 出力の先頭に足す
  // 無音の詰め物が 0 フレームになり "frameOffset out of range" で落ちていた（サイズ上限モードで発生）。
  it('WAV -> mp3 with split points that are not aligned to sample frames', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [1.3333333, 6.6666, 24.4755] },
      { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false },
    );
    expect(parts).toHaveLength(4);
    for (const p of parts) expect((await inspect(p)).codec).toBe('mp3');
  });

  // 回帰テスト: モノラル化（リサンプラが入る）+ 半端な分割点でも MP3 が落ちない
  it('WAV -> mono mp3 with split points that are not aligned to sample frames', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [1.3333333, 6.6666, 24.4755] },
      { kind: 'encode', format: 'mp3', bitrate: 64000, mono: true },
    );
    expect(parts).toHaveLength(4);
    for (const p of parts) expect((await inspect(p)).channels).toBe(1);
  });

  it('mono: true produces 1 channel (m4a and mp3)', async () => {
    const info = await probeFile(shortWav);
    for (const format of ['m4a', 'mp3'] as const) {
      const parts = await runJob(
        shortWav,
        info,
        { kind: 'points', points: [] },
        { kind: 'encode', format, bitrate: 48000, mono: true },
      );
      expect(parts).toHaveLength(1);
      expect(parts[0].fileName).toBe(`会議録音_compressed.${format}`);
      expect((await inspect(parts[0])).channels).toBe(1);
    }
  });

  it('fails with a Japanese message when the browser cannot decode', async () => {
    const info = await probeFile(shortWav);
    await expect(
      runJob(
        shortWav,
        { ...info, canDecode: false },
        { kind: 'points', points: [] },
        { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false },
      ),
    ).rejects.toThrow(/Chrome/);
  });

  it('fails with a Japanese message when copy is impossible', async () => {
    const info = await probeFile(shortWav);
    await expect(
      runJob(shortWav, { ...info, copyFormat: null }, { kind: 'points', points: [] }, { kind: 'copy' }),
    ).rejects.toThrow(/形式を変換・圧縮する/);
  });
});

// WAV / FLAC / Opus への変換。入力は WAV（Node で読めるのは WAV だけ）。
// Opus は Node では書き出せない（wasm 版が無く WebCodecs も無い）ので、失敗のしかたをテストする。
// m4a / mp3 入力からの変換と、ブラウザでの Opus 書き出しはブラウザで手動確認する。
async function sampleRateOf(part: OutputPart) {
  const input = new Input({
    source: new BufferSource(new Uint8Array(await part.blob.arrayBuffer())),
    formats: ALL_FORMATS,
  });
  try {
    return (await input.getPrimaryAudioTrack())!.sampleRate;
  } finally {
    input.dispose();
  }
}

describe('runJob: convert to WAV / FLAC', () => {
  const kinds = [
    { format: 'wav', codec: 'pcm-s16', container: 'WAVE' },
    { format: 'flac', codec: 'flac', container: 'FLAC' },
  ] as const;

  for (const { format, codec, container } of kinds) {
    describe(format, () => {
      const spec = (extra: object = {}) =>
        ({ kind: 'encode', format, bitrate: 0, mono: false, ...extra }) as const;

      it('splits into parts with the right format, codec and length', async () => {
        const info = await probeFile(shortWav);
        const parts = await runJob(shortWav, info, { kind: 'points', points: [10, 20] }, spec());
        expect(parts).toHaveLength(3);
        expect(parts[0].fileName).toBe(`会議録音_01.${format}`);
        expect(parts[0].blob.type).toBe(format === 'wav' ? 'audio/wav' : 'audio/flac');
        for (const p of parts) {
          const m = await inspect(p);
          expect(m.codec).toBe(codec);
          expect(m.format).toBe(container);
          expect(m.channels).toBe(2);
          expect(p.durationSec).toBeGreaterThan(9.8);
          expect(p.durationSec).toBeLessThan(10.3);
          expect(await sampleRateOf(p)).toBe(44100);
        }
        if (format === 'wav') {
          // 16bit ステレオ 44.1kHz の 10 秒 = 1.76MB
          expect(parts[0].blob.size).toBeGreaterThan(1_700_000);
          expect(parts[0].blob.size).toBeLessThan(1_800_000);
        } else {
          expect(parts[0].blob.size).toBeLessThan(1_700_000); // 可逆圧縮なので WAV より小さい
        }
      });

      it('no split gives a "_converted" name', async () => {
        const info = await probeFile(shortWav);
        const parts = await runJob(shortWav, info, { kind: 'points', points: [] }, spec());
        expect(parts).toHaveLength(1);
        expect(parts[0].fileName).toBe(`会議録音_converted.${format}`);
      });

      it('mono and 16 kHz', async () => {
        const info = await probeFile(shortWav);
        const parts = await runJob(
          shortWav,
          info,
          { kind: 'points', points: [10] },
          spec({ mono: true, sampleRate: 16000 }),
        );
        expect(parts).toHaveLength(2);
        for (const p of parts) {
          const m = await inspect(p);
          expect(m.codec).toBe(codec);
          expect(m.channels).toBe(1);
          expect(await sampleRateOf(p)).toBe(16000);
        }
        if (format === 'wav') {
          // 16kHz モノラル 10 秒 = 320000 バイト + ヘッダ
          expect(parts[0].blob.size).toBeGreaterThan(320_000);
          expect(parts[0].blob.size).toBeLessThan(320_200);
        }
      });

      // 回帰テスト: MP3 と同様、半端な開始位置で先頭の詰め物が 0 フレームになってもエンコーダが落ちない
      it('does not fail at split points that are not aligned to sample frames', async () => {
        const info = await probeFile(shortWav);
        const parts = await runJob(
          shortWav,
          info,
          { kind: 'points', points: [1.3333333, 6.6666, 24.4755] },
          spec({ sampleRate: 16000 }),
        );
        expect(parts).toHaveLength(4);
        const want = [1.3333333, 6.6666 - 1.3333333, 24.4755 - 6.6666, 30 - 24.4755];
        for (const [i, p] of parts.entries()) {
          expect((await inspect(p)).codec).toBe(codec);
          expect(Math.abs(p.durationSec - want[i])).toBeLessThan(0.1);
        }
      });
    });
  }

  it('maxSize: every part is <= maxBytes (WAV and FLAC)', async () => {
    const info = await probeFile(wavFile); // 65s
    for (const format of ['wav', 'flac'] as const) {
      const maxBytes = 1_000_000;
      const parts = await runJob(
        wavFile,
        info,
        { kind: 'maxSize', maxBytes },
        { kind: 'encode', format, bitrate: 0, mono: false, sampleRate: 22050 },
      );
      expect(parts.length).toBeGreaterThanOrEqual(2);
      for (const p of parts) expect(p.blob.size).toBeLessThanOrEqual(maxBytes);
      expect(parts[0].startSec).toBe(0);
      expect(parts[parts.length - 1].endSec).toBeCloseTo(info.durationSec, 5);
      expect(parts.map((p) => p.fileName)).toEqual(
        parts.map((_, i) => `test_${String(i + 1).padStart(2, '0')}.${format}`),
      );
    }
  });
});

describe('Opus (Ogg)', () => {
  it('is not available in Node, and getEncodeSupport says so', async () => {
    const support = await getEncodeSupport();
    expect(support.ogg).toBe(false);
    expect(support.wav).toBe(true);
    expect(support.flac).toBe(true);
    expect(support.m4a).toBe(true);
    expect(support.mp3).toBe(true);
  });

  it('runJob fails with a user-facing Japanese message', async () => {
    const info = await probeFile(shortWav);
    const err = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [10] },
      { kind: 'encode', format: 'ogg', bitrate: 48000, mono: false },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/このブラウザでは Opus を書き出せません/);
    expect(err.message).not.toMatch(/no_encodable|undefined|TypeError/);
  });
});

describe('runJob: maxSize', () => {
  it('every part is <= maxBytes (encode)', async () => {
    const info = await probeFile(wavFile); // 65s
    const maxBytes = 150_000; // 64kbps = 8000B/s -> 約 18 秒/パート
    const parts = await runJob(
      wavFile,
      info,
      { kind: 'maxSize', maxBytes },
      { kind: 'encode', format: 'm4a', bitrate: 64000, mono: false },
    );
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.length).toBeLessThanOrEqual(6);
    for (const p of parts) expect(p.blob.size).toBeLessThanOrEqual(maxBytes);
    // 連続していて全体を覆う
    expect(parts[0].startSec).toBe(0);
    expect(parts[parts.length - 1].endSec).toBeCloseTo(info.durationSec, 5);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].startSec).toBeCloseTo(parts[i - 1].endSec, 5);
    }
    expect(parts.map((p) => p.fileName)).toEqual(parts.map((_, i) => `test_0${i + 1}.m4a`));
  });

  it('recovers when the initial estimate is far too optimistic (copy of 16-bit PCM)', async () => {
    // info.audioBitrate を 1/4 に偽装 -> 初回見積もりが外れて再試行が必要になる
    const info = { ...(await probeFile(wavFile)), audioBitrate: (44100 * 16 * 2) / 4 };
    const maxBytes = 2_000_000;
    const parts = await runJob(wavFile, info, { kind: 'maxSize', maxBytes }, { kind: 'copy' });
    for (const p of parts) expect(p.blob.size).toBeLessThanOrEqual(maxBytes);
    expect(parts.length).toBeGreaterThanOrEqual(6);
    expect(parts[parts.length - 1].endSec).toBeCloseTo(info.durationSec, 5);
  });

  it('fails with a Japanese message when maxBytes is too small', async () => {
    const info = await probeFile(shortWav);
    await expect(
      runJob(
        shortWav,
        info,
        { kind: 'maxSize', maxBytes: 100 },
        { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false },
      ),
    ).rejects.toThrow(/サイズ上限/);
  });
});

describe('runJob: abort', () => {
  it('rejects with AbortError when aborted before start', async () => {
    const info = await probeFile(shortWav);
    const ac = new AbortController();
    ac.abort();
    const err = await runJob(shortWav, info, { kind: 'points', points: [10] }, { kind: 'copy' }, {
      signal: ac.signal,
    }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('stops after the first part when aborted from onPart', async () => {
    const info = await probeFile(wavFile);
    const ac = new AbortController();
    const got: OutputPart[] = [];
    const err = await runJob(wavFile, info, { kind: 'points', points: [10, 20, 30, 40] }, { kind: 'copy' }, {
      signal: ac.signal,
      onPart: (p) => {
        got.push(p);
        ac.abort();
      },
    }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(got).toHaveLength(1);
  });

  it('cancels a conversion in progress', async () => {
    const info = await probeFile(wavFile);
    const ac = new AbortController();
    const err = await runJob(
      wavFile,
      info,
      { kind: 'points', points: [] },
      { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false },
      {
        signal: ac.signal,
        onProgress: (p) => {
          if (p.overall > 0.05) ac.abort();
        },
      },
    ).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });
});

describe('runJob: export at a changed speed', () => {
  const wavSpec = (speed: number, extra: object = {}) =>
    ({ kind: 'encode', format: 'wav', bitrate: 0, mono: false, speed, ...extra }) as const;

  for (const [speed, expected] of [
    [2, 15],
    [0.5, 60],
  ] as const) {
    it(`WAV x${speed}: output length is about 1/${speed} of the original`, async () => {
      const info = await probeFile(shortWav);
      const parts = await runJob(shortWav, info, { kind: 'points', points: [] }, wavSpec(speed));
      expect(parts).toHaveLength(1);
      expect(Math.abs(parts[0].durationSec - expected)).toBeLessThan(0.3);
      const m = await inspect(parts[0]);
      expect(m.codec).toBe('pcm-s16');
      expect(m.channels).toBe(2);
      expect(Math.abs(m.duration - expected)).toBeLessThan(0.3);
    });
  }

  it('splits on the original time axis; each part is 1/speed long', async () => {
    const info = await probeFile(shortWav);
    const progress: number[] = [];
    const parts = await runJob(shortWav, info, { kind: 'points', points: [10, 20] }, wavSpec(2), {
      onProgress: (p) => progress.push(p.overall),
    });
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => [p.startSec, p.endSec])).toEqual([
      [0, 10],
      [10, 20],
      [20, info.durationSec],
    ]);
    for (const p of parts) expect(Math.abs(p.durationSec - (p.endSec - p.startSec) / 2)).toBeLessThan(0.1);
    expect(progress[progress.length - 1]).toBeCloseTo(1, 5);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] - 1e-9);
  });

  it('works with mono and a changed sample rate', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [1.3333333, 6.6666] },
      wavSpec(1.5, { mono: true, sampleRate: 22050 }),
    );
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect((await inspect(p)).channels).toBe(1);
      expect(await sampleRateOf(p)).toBe(22050);
      expect(Math.abs(p.durationSec - (p.endSec - p.startSec) / 1.5)).toBeLessThan(0.1);
    }
  });

  it('works with m4a and flac output', async () => {
    const info = await probeFile(shortWav);
    for (const [format, codec] of [
      ['m4a', 'aac'],
      ['flac', 'flac'],
    ] as const) {
      const parts = await runJob(
        shortWav,
        info,
        { kind: 'points', points: [] },
        { kind: 'encode', format, bitrate: 64000, mono: false, speed: 1.5 },
      );
      expect((await inspect(parts[0])).codec).toBe(codec);
      expect(Math.abs(parts[0].durationSec - 20)).toBeLessThan(0.3);
    }
  });

  it('maxSize: parts fit the limit and their total is about 1/speed long', async () => {
    const info = await probeFile(shortWav);
    const maxBytes = 400_000;
    const parts = await runJob(shortWav, info, { kind: 'maxSize', maxBytes }, wavSpec(2));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.blob.size).toBeLessThanOrEqual(maxBytes);
    const total = parts.reduce((n, p) => n + p.durationSec, 0);
    expect(Math.abs(total - 15)).toBeLessThan(0.5);
    // 分割点は元の時間軸でつながっている
    for (let i = 1; i < parts.length; i++) expect(parts[i].startSec).toBeCloseTo(parts[i - 1].endSec, 6);
  });

  it('can be aborted', async () => {
    const info = await probeFile(shortWav);
    const ac = new AbortController();
    ac.abort();
    await expect(
      runJob(shortWav, info, { kind: 'points', points: [] }, wavSpec(2), { signal: ac.signal }),
    ).rejects.toSatisfy(isAbortError);
  });
});

describe('runJob: export at a changed pitch', () => {
  it('pitch only: the length stays the same', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [10] },
      { kind: 'encode', format: 'wav', bitrate: 0, mono: false, pitchRatio: 2 ** (5 / 12) },
    );
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(Math.abs(p.durationSec - (p.endSec - p.startSec))).toBeLessThan(0.1);
      expect((await inspect(p)).codec).toBe('pcm-s16');
    }
  });

  it('tape mode (speed and pitch together): length is 1/speed', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(
      shortWav,
      info,
      { kind: 'points', points: [] },
      { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false, speed: 2, pitchRatio: 2 },
    );
    expect(Math.abs(parts[0].durationSec - 15)).toBeLessThan(0.3);
    expect((await inspect(parts[0])).codec).toBe('mp3');
  });
});

describe('zipParts', () => {
  it('stores parts uncompressed with Japanese names intact', async () => {
    const info = await probeFile(shortWav);
    const parts = await runJob(shortWav, info, { kind: 'points', points: [10] }, { kind: 'copy' });
    const blob = await zipParts(parts);
    expect(blob.type).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['会議録音_01.wav', '会議録音_02.wav']);
    expect(files['会議録音_01.wav'].byteLength).toBe(parts[0].blob.size);
    // store なので ZIP は中身の合計より少しだけ大きい
    expect(blob.size).toBeLessThan(parts[0].blob.size + parts[1].blob.size + 1000);
    expect(strFromU8(files['会議録音_01.wav'].subarray(0, 4))).toBe('RIFF');
  });
});
