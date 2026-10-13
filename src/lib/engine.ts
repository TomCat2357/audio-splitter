import {
  ALL_FORMATS,
  AdtsOutputFormat,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  type AudioCodec,
  type AudioSample,
  type OutputFormat,
} from 'mediabunny';
import type {
  AudioInfo,
  EncodeFormat,
  JobCallbacks,
  OutputPart,
  OutputSpec,
  SplitPlan,
} from './types';
import {
  MIN_SEGMENT_SEC,
  SAFETY_FACTOR,
  buildPartName,
  estimateOutputBytesPerSec,
  segmentsFromPoints,
  singleSuffixFor,
} from './plan';

// ---------------------------------------------------------------------------
// 出力形式の定義
// ---------------------------------------------------------------------------

interface CopyTarget {
  ext: string;
  mime: string;
  label: string;
  make: () => OutputFormat;
}

const COPY_TARGETS = {
  m4a: { ext: 'm4a', mime: 'audio/mp4', label: 'M4A', make: () => new Mp4OutputFormat() },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', label: 'MP3', make: () => new Mp3OutputFormat() },
  wav: { ext: 'wav', mime: 'audio/wav', label: 'WAV', make: () => new WavOutputFormat() },
  ogg: { ext: 'ogg', mime: 'audio/ogg', label: 'Ogg', make: () => new OggOutputFormat() },
  flac: { ext: 'flac', mime: 'audio/flac', label: 'FLAC', make: () => new FlacOutputFormat() },
  aac: { ext: 'aac', mime: 'audio/aac', label: 'AAC (ADTS)', make: () => new AdtsOutputFormat() },
  webm: { ext: 'webm', mime: 'audio/webm', label: 'WebM', make: () => new WebMOutputFormat() },
  mka: { ext: 'mka', mime: 'audio/x-matroska', label: 'Matroska 音声', make: () => new MkvOutputFormat() },
} satisfies Record<string, CopyTarget>;

type CopyKey = keyof typeof COPY_TARGETS;

/** 入力コンテナ名（InputFormat.name）→ 同じコンテナで出す形式 */
const CONTAINER_TO_COPY: Record<string, CopyKey> = {
  MP4: 'm4a',
  'QuickTime File Format': 'm4a',
  MP3: 'mp3',
  WAVE: 'wav',
  Ogg: 'ogg',
  FLAC: 'flac',
  ADTS: 'aac',
  WebM: 'webm',
  Matroska: 'mka',
};

/** コンテナが使えないときにコーデックから選ぶ */
const CODEC_TO_COPY: [test: (codec: string) => boolean, key: CopyKey][] = [
  [(c) => c === 'aac', 'm4a'],
  [(c) => c === 'mp3', 'mp3'],
  [(c) => c === 'opus' || c === 'vorbis', 'ogg'],
  [(c) => c === 'flac', 'flac'],
  [(c) => c.startsWith('pcm'), 'wav'],
];

function pickCopyFormat(containerName: string, codec: AudioCodec): AudioInfo['copyFormat'] {
  const supports = (key: CopyKey) =>
    COPY_TARGETS[key].make().getSupportedAudioCodecs().includes(codec);
  let key: CopyKey | null = null;
  const byContainer = CONTAINER_TO_COPY[containerName];
  if (byContainer && supports(byContainer)) key = byContainer;
  if (!key) {
    for (const [test, k] of CODEC_TO_COPY) {
      if (test(codec) && supports(k)) {
        key = k;
        break;
      }
    }
  }
  if (!key) return null;
  const t = COPY_TARGETS[key];
  return { ext: t.ext, mime: t.mime, label: t.label };
}

function copyKeyFromExt(ext: string): CopyKey {
  return (Object.keys(COPY_TARGETS) as CopyKey[]).find((k) => COPY_TARGETS[k].ext === ext)!;
}

const ENCODE_TARGETS: Record<
  EncodeFormat,
  { codec: AudioCodec; ext: string; mime: string; make: () => OutputFormat }
> = {
  m4a: { codec: 'aac', ext: 'm4a', mime: 'audio/mp4', make: () => new Mp4OutputFormat() },
  mp3: { codec: 'mp3', ext: 'mp3', mime: 'audio/mpeg', make: () => new Mp3OutputFormat() },
  ogg: { codec: 'opus', ext: 'ogg', mime: 'audio/ogg', make: () => new OggOutputFormat() },
  wav: { codec: 'pcm-s16', ext: 'wav', mime: 'audio/wav', make: () => new WavOutputFormat() },
  flac: { codec: 'flac', ext: 'flac', mime: 'audio/flac', make: () => new FlacOutputFormat() },
};

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

const FORMAT_HELP = '対応形式: m4a / mp3 / wav / ogg / flac / mp4 動画など。';

function abortError(): Error {
  const e = new Error('処理を中断しました。');
  e.name = 'AbortError';
  return e;
}

/** runJob が中断されたときに投げるエラーかどうか */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/** 動画入りファイルでパケット統計に使うパケット数（全パケットを舐めないため） */
const PACKET_STATS_SAMPLE = 500;

export async function probeFile(file: File): Promise<AudioInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let format;
    try {
      format = await input.getFormat();
    } catch {
      throw new Error(`このファイルは音声・動画として読み込めませんでした。${FORMAT_HELP}`);
    }

    let track;
    let videoTrack;
    try {
      track = await input.getPrimaryAudioTrack();
      videoTrack = await input.getPrimaryVideoTrack();
    } catch {
      throw new Error(`ファイルの内容を読み取れませんでした（壊れている可能性があります）。${FORMAT_HELP}`);
    }
    if (!track) {
      throw new Error('このファイルには音声トラックがありません。音声を含むファイルを選んでください。');
    }
    const codec = await track.getCodec();
    if (!codec) {
      throw new Error(`このファイルの音声形式には対応していません。${FORMAT_HELP}`);
    }

    let durationSec: number;
    try {
      durationSec = await track.computeDuration();
    } catch {
      throw new Error('ファイルの長さを取得できませんでした。ファイルが壊れている可能性があります。');
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('音声の長さが 0 秒のため処理できません。');
    }

    const hasVideo = videoTrack !== null;
    let audioBitrate = (file.size * 8) / durationSec;
    if (hasVideo) {
      try {
        const stats = await track.computePacketStats(PACKET_STATS_SAMPLE);
        if (Number.isFinite(stats.averageBitrate) && stats.averageBitrate > 0) {
          audioBitrate = stats.averageBitrate;
        }
      } catch {
        audioBitrate = (await track.getAverageBitrate()) ?? audioBitrate;
      }
    }

    let canDecode = false;
    try {
      canDecode = await track.canDecode();
    } catch {
      canDecode = false;
    }

    return {
      fileName: file.name,
      fileSize: file.size,
      containerLabel: format.name,
      codec,
      durationSec,
      sampleRate: track.sampleRate,
      numberOfChannels: track.numberOfChannels,
      hasVideo,
      audioBitrate,
      copyFormat: pickCopyFormat(format.name, codec),
      canDecode,
    };
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// エンコーダ登録（WebCodecs で不可なら wasm 版を遅延読み込み）
// ---------------------------------------------------------------------------

const registered = new Set<AudioCodec>();

const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Opus が受け付けるサンプルレート（これ以外は 48kHz にする）。実際に使えるかは canEncodeAudio で確かめる */
const OPUS_RATES = [48000, 24000, 16000, 12000, 8000];
/** wasm FLAC エンコーダなどが扱えるチャンネル数の上限 */
const MAX_PCM_CHANNELS = 8;

interface EncodeParams {
  codec: AudioCodec;
  numberOfChannels: number;
  sampleRate: number;
  /** 非可逆形式（M4A / MP3 / Opus）だけ */
  bitrate: number | null;
}

/** WAV / FLAC のように、ビットレートではなくサンプルレートとチャンネル数で大きさが決まる形式 */
const isPcmCodec = (codec: AudioCodec) => codec === 'pcm-s16' || codec === 'flac';

function encodeCheckOptions(p: EncodeParams) {
  return {
    numberOfChannels: p.numberOfChannels,
    sampleRate: p.sampleRate,
    ...(p.bitrate !== null ? { bitrate: p.bitrate } : {}),
  };
}

async function ensureEncoder(p: EncodeParams): Promise<void> {
  if (p.codec === 'pcm-s16' || registered.has(p.codec)) return; // WAV はエンコーダ不要
  const native = await canEncodeAudio(p.codec, encodeCheckOptions(p));
  if (native) return;
  if (p.codec === 'aac') {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  } else if (p.codec === 'mp3') {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
  } else if (p.codec === 'flac') {
    const { registerFlacEncoder } = await import('@mediabunny/flac-encoder');
    registerFlacEncoder();
  } else {
    // Opus には wasm 版が無い。ブラウザが対応していなければ書き出せない
    throw new Error(OPUS_UNSUPPORTED);
  }
  registered.add(p.codec);
}

const OPUS_UNSUPPORTED =
  'このブラウザでは Opus を書き出せません。M4A（AAC）か MP3 を選ぶか、Chrome / Edge / Firefox で開いてください。';

async function canEncodeOpus(channels: number, sampleRate: number, bitrate: number): Promise<boolean> {
  try {
    return await canEncodeAudio('opus', { numberOfChannels: channels, sampleRate, bitrate });
  } catch {
    return false;
  }
}

let supportPromise: Promise<Record<EncodeFormat, boolean>> | null = null;

/**
 * 再エンコードで書き出せる形式。WAV は常に可、M4A / MP3 / FLAC はブラウザ標準で不可でも
 * wasm 版に切り替えるので可。Opus は wasm 版が無く、ブラウザの対応次第。
 * 画面は起動時に 1 回呼ぶ（結果は使い回す）。
 */
export function getEncodeSupport(): Promise<Record<EncodeFormat, boolean>> {
  supportPromise ??= (async () => ({
    m4a: true,
    mp3: true,
    wav: true,
    flac: true,
    ogg: (await canEncodeOpus(2, 48000, 64000)) || (await canEncodeOpus(1, 48000, 64000)),
  }))();
  return supportPromise;
}

async function resolveEncodeParams(
  info: AudioInfo,
  output: Extract<OutputSpec, { kind: 'encode' }>,
): Promise<EncodeParams> {
  const target = ENCODE_TARGETS[output.format];
  const codec = target.codec;

  if (isPcmCodec(codec)) {
    // サンプルレートは指定どおり（無ければ元のまま）。チャンネル数は元のまま（扱えない数なら 2ch）
    const numberOfChannels = output.mono
      ? 1
      : info.numberOfChannels <= MAX_PCM_CHANNELS
        ? info.numberOfChannels
        : 2;
    return { codec, numberOfChannels, sampleRate: output.sampleRate ?? info.sampleRate, bitrate: null };
  }

  const numberOfChannels = output.mono ? 1 : Math.min(info.numberOfChannels, 2);
  const bitrate = output.bitrate;
  if (codec === 'opus') {
    // 実際に受け付ける値をブラウザに確かめる。元のレートが使えなければ 48kHz
    const candidates = [info.sampleRate, 48000].filter((r, i, a) => OPUS_RATES.includes(r) && a.indexOf(r) === i);
    for (const sampleRate of candidates) {
      if (await canEncodeOpus(numberOfChannels, sampleRate, bitrate)) {
        return { codec, numberOfChannels, sampleRate, bitrate };
      }
    }
    throw new Error(OPUS_UNSUPPORTED);
  }
  const rates = codec === 'mp3' ? MP3_RATES : AAC_RATES;
  const sampleRate = rates.includes(info.sampleRate) ? info.sampleRate : 44100;
  return { codec, numberOfChannels, sampleRate, bitrate };
}

// ---------------------------------------------------------------------------
// 1 パートの変換
// ---------------------------------------------------------------------------

interface PartResult {
  bytes: Uint8Array;
  durationSec: number;
}

/**
 * 1 パートの変換。
 *
 * サンプルレートやチャンネル数を変える変換では、先頭の詰め物（0 フレーム）がリサンプラに渡る時点で
 * "frameOffset out of range" で落ちることがある（`process` での除外はリサンプラより後ろなので間に合わない）。
 * 切り出し開始位置がサンプル境界からわずかにずれたときに起きるので、その場合に限り開始位置を
 * 半フレームだけ後ろにずらしてやり直す（ずらすと詰め物は不要になる。長さにして 0.01 ミリ秒ほど）。
 */
async function convertSegment(
  input: Input,
  info: AudioInfo,
  output: OutputSpec,
  seg: { start: number; end: number },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PartResult> {
  try {
    return await convertSegmentOnce(input, info, output, seg, onProgress, signal);
  } catch (e) {
    if (isAbortError(e) || !describeError(e).includes('frameOffset out of range')) throw e;
    const shifted = { start: seg.start + 0.5 / info.sampleRate, end: seg.end };
    return await convertSegmentOnce(input, info, output, shifted, onProgress, signal);
  }
}

async function convertSegmentOnce(
  input: Input,
  info: AudioInfo,
  output: OutputSpec,
  seg: { start: number; end: number },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PartResult> {
  if (signal?.aborted) throw abortError();

  let format: OutputFormat;
  let encodeParams: EncodeParams | null = null;
  if (output.kind === 'copy') {
    format = COPY_TARGETS[copyKeyFromExt(info.copyFormat!.ext)].make();
  } else {
    encodeParams = await resolveEncodeParams(info, output);
    format = ENCODE_TARGETS[output.format].make();
    await ensureEncoder(encodeParams);
  }

  const out = new Output({ format, target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output: out,
    showWarnings: false,
    trim: { start: seg.start, end: seg.end },
    video: { discard: true },
    ...(encodeParams
      ? {
          audio: {
            codec: encodeParams.codec,
            ...(encodeParams.bitrate !== null
              ? { quality: new Quality({ bitrate: encodeParams.bitrate }) }
              : {}),
            numberOfChannels: encodeParams.numberOfChannels,
            sampleRate: encodeParams.sampleRate,
            forceTranscode: true,
            // MP3 など時刻情報を持てない形式では、mediabunny が先頭に無音の詰め物サンプルを足す。
            // 開始位置がサンプル境界からわずかにずれるとその長さが 0 フレームになり、
            // エンコーダが "frameOffset out of range" で落ちるため、空のサンプルは捨てる。
            process: (sample: AudioSample) => (sample.numberOfFrames > 0 ? sample : null),
          },
        }
      : { copy: { mode: 'forced' as const, shiftTolerance: Infinity } }),
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(', ');
    throw new Error(
      `この区間を出力できませんでした（${reasons || '原因不明'}）。` +
        '「形式を変換・圧縮する」（再エンコード）を試すか、Chrome / Edge で開いてください。',
    );
  }

  // execute() の前にセットしないと発火しない
  conversion.onProgress = (p) => onProgress(Math.min(1, Math.max(0, p)));

  const onAbort = () => {
    void conversion.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (e instanceof ConversionCanceledError || signal?.aborted) throw abortError();
    throw new Error(`変換中にエラーが発生しました: ${describeError(e)}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw abortError();

  const buffer = out.target.buffer;
  if (!buffer) throw new Error('出力データが生成されませんでした。');
  const bytes = new Uint8Array(buffer);

  // 出力ファイルの実際の長さを測る（失敗したら区間長で代用）
  let durationSec = seg.end - seg.start;
  try {
    const check = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
    try {
      const d = await check.computeDuration();
      if (Number.isFinite(d) && d > 0) durationSec = d;
    } finally {
      check.dispose();
    }
  } catch {
    // ignore
  }
  return { bytes, durationSec };
}

// ---------------------------------------------------------------------------
// runJob
// ---------------------------------------------------------------------------

type Emit = (doneSec: number, partIndex: number, estimatedParts: number) => void;
type Seg = { start: number; end: number };

export async function runJob(
  file: File,
  info: AudioInfo,
  plan: SplitPlan,
  output: OutputSpec,
  cb: JobCallbacks = {},
): Promise<OutputPart[]> {
  if (output.kind === 'copy' && !info.copyFormat) {
    throw new Error(
      `この音声（${info.codec}）は、元の形式のままでは書き出せません。` +
        '「形式を変換・圧縮する」（再エンコード）を使ってください。',
    );
  }
  if (output.kind === 'encode' && !info.canDecode) {
    throw new Error(
      `この音声（${info.codec}）は、このブラウザでは読み取れないため変換・圧縮できません。` +
        'Chrome または Edge で開き直すか、変換や圧縮をせずに分割だけ行ってください。',
    );
  }
  if (output.kind === 'encode' && output.format === 'ogg' && !(await getEncodeSupport()).ogg) {
    throw new Error(OPUS_UNSUPPORTED);
  }
  if (cb.signal?.aborted) throw abortError();

  const singleSuffix = singleSuffixFor(output);
  const ext =output.kind === 'copy' ? info.copyFormat!.ext : ENCODE_TARGETS[output.format].ext;
  const mime = output.kind === 'copy' ? info.copyFormat!.mime : ENCODE_TARGETS[output.format].mime;
  const total = info.durationSec;
  const parts: OutputPart[] = [];

  const emit: Emit = (doneSec, partIndex, estimatedParts) => {
    cb.onProgress?.({
      overall: Math.min(1, Math.max(0, doneSec / total)),
      partIndex,
      estimatedParts,
    });
  };

  const finish = (index: number, nameTotal: number, seg: Seg, r: PartResult): OutputPart => {
    const part: OutputPart = {
      index,
      fileName: buildPartName(info.fileName, index, nameTotal, ext, singleSuffix),
      blob: new Blob([r.bytes as BlobPart], { type: mime }),
      startSec: seg.start,
      endSec: seg.end,
      durationSec: r.durationSec,
    };
    parts.push(part);
    cb.onPart?.(part);
    return part;
  };

  // Input は全パートで使い回す（BlobSource なので必要な範囲だけ読む）。終わったら dispose。
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (plan.kind === 'points') {
      const segs = segmentsFromPoints(plan.points, total);
      let done = 0;
      emit(0, 0, segs.length);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const len = seg.end - seg.start;
        const base = done;
        const r = await convertSegment(
          input,
          info,
          output,
          seg,
          (f) => emit(base + f * len, i, segs.length),
          cb.signal,
        );
        done += len;
        finish(i, segs.length, seg, r);
        emit(done, Math.min(i + 1, segs.length - 1), segs.length);
      }
    } else {
      await runMaxSize(input, info, plan.maxBytes, output, cb.signal, emit, finish);
    }
  } finally {
    input.dispose();
  }

  // maxSize は総数が事後にしか分からないので、ファイル名を総数ベースで確定し直す
  // （onPart で渡した OutputPart と同じオブジェクトを更新する）。
  if (plan.kind === 'maxSize') {
    for (const p of parts) p.fileName = buildPartName(info.fileName, p.index, parts.length, ext, singleSuffix);
  }
  return parts;
}

/** maxSize の 1 パートあたりの試行上限 */
const MAX_ATTEMPTS = 6;

async function runMaxSize(
  input: Input,
  info: AudioInfo,
  maxBytes: number,
  output: OutputSpec,
  signal: AbortSignal | undefined,
  emit: Emit,
  finish: (index: number, nameTotal: number, seg: Seg, r: PartResult) => OutputPart,
): Promise<void> {
  const total = info.durationSec;
  if (!(maxBytes > 0)) throw new Error('サイズ上限が不正です。');
  let bps = estimateOutputBytesPerSec(info, output);
  if (!(bps > 0)) bps = info.fileSize / total || 1;

  let pos = 0;
  let index = 0;
  const estimateParts = () =>
    index + Math.max(1, Math.ceil((total - pos) / Math.max(MIN_SEGMENT_SEC, (maxBytes * SAFETY_FACTOR) / bps)));
  emit(0, 0, estimateParts());

  while (total - pos > 1e-3) {
    const remaining = total - pos;
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
      let segLen = (maxBytes * SAFETY_FACTOR) / bps;
      if (segLen < MIN_SEGMENT_SEC) {
        throw new Error(
          'サイズ上限が小さすぎて、1 パートに十分な長さを入れられません。' +
            '上限を大きくするか、ビットレートを下げてください。',
        );
      }
      if (segLen >= remaining) segLen = remaining;
      else if (remaining - segLen < MIN_SEGMENT_SEC) {
        // 端数が短すぎるときは、最初の試行に限り最後のパートへの吸収を試みる
        segLen = attempt === 0 ? remaining : Math.max(MIN_SEGMENT_SEC, remaining - MIN_SEGMENT_SEC);
      }
      const seg = { start: pos, end: pos + segLen };
      const est = estimateParts();
      const startPos = pos;
      const r = await convertSegment(
        input,
        info,
        output,
        seg,
        (f) => emit(startPos + f * segLen, index, est),
        signal,
      );
      const size = r.bytes.byteLength;
      const measured = size / segLen;
      if (size <= maxBytes) {
        // 実測値で次パートの見積もりを更新（可変ビットレート対応）。やや余裕を持たせる。
        bps = Math.max(measured * 1.03, 1);
        finish(index, est, seg, r); // 仮の総数。最終的な名前は runJob が付け直す
        pos = seg.end;
        index++;
        done = true;
        emit(pos, Math.min(index, estimateParts() - 1), estimateParts());
      } else {
        // 超過。実測値と超過率の大きい方で見積もりを引き上げ、同じ開始位置からやり直す
        bps = Math.max(measured * 1.03, bps * (size / (maxBytes * SAFETY_FACTOR)));
      }
    }
    if (!done) {
      throw new Error(
        `${index + 1} 番目のパートがサイズ上限に収まりませんでした（${MAX_ATTEMPTS} 回試行）。` +
          '上限を大きくするか、ビットレートを下げてください。',
      );
    }
  }
  emit(total, Math.max(0, index - 1), index);
}
