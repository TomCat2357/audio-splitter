// テスト用音声の生成。
// - makeWav(): 1 秒ごとに音程が変わるサイン波の WAV (16bit ステレオ 44.1kHz) を作る
// - encodeFromWav(): WAV から m4a / mp3 を作る（mediabunny + wasm エンコーダ）
// CLI として実行すると test-fixtures/ に test.wav / test.m4a / test.mp3 (各 65 秒) を書き出す。
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Mp3OutputFormat, Mp4OutputFormat,
  Output, Quality, canEncodeAudio,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

/** 1 秒ごとに音程 (220Hz から 40Hz ずつ上昇、12 秒周期) が変わるサイン波 WAV */
export function makeWav(seconds, { sampleRate = 44100, channels = 2 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, dataBytes, true);
  let phase = 0;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const sec = Math.floor(i / sampleRate);
    const freq = 220 + 40 * (sec % 12);
    phase += (2 * Math.PI * freq) / sampleRate;
    const s = Math.round(Math.sin(phase) * 0.4 * 32767);
    for (let c = 0; c < channels; c++) { v.setInt16(o, s, true); o += 2; }
  }
  return new Uint8Array(buf);
}

/** WAV のバイト列から 'm4a' | 'mp3' を作る */
export async function encodeFromWav(wavBytes, format, bitrate = 96000) {
  const codec = format === 'm4a' ? 'aac' : 'mp3';
  if (!(await canEncodeAudio(codec))) {
    if (codec === 'aac') registerAacEncoder(); else registerMp3Encoder();
  }
  const input = new Input({ source: new BufferSource(wavBytes), formats: ALL_FORMATS });
  const output = new Output({
    format: format === 'm4a' ? new Mp4OutputFormat() : new Mp3OutputFormat(),
    target: new BufferTarget(),
  });
  const conv = await Conversion.init({
    input, output, showWarnings: false,
    audio: { codec, quality: new Quality({ bitrate }) },
  });
  if (!conv.isValid) throw new Error('fixture conversion invalid');
  await conv.execute();
  input.dispose();
  return new Uint8Array(output.target.buffer);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = 'test-fixtures';
  mkdirSync(dir, { recursive: true });
  const wav = makeWav(65);
  writeFileSync(`${dir}/test.wav`, wav);
  writeFileSync(`${dir}/test.m4a`, await encodeFromWav(wav, 'm4a'));
  writeFileSync(`${dir}/test.mp3`, await encodeFromWav(wav, 'mp3'));
  console.log(`wrote ${dir}/test.wav, test.m4a, test.mp3 (65s each)`);
}
