import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { createStretcher, type Stretcher } from './stretch';

/**
 * 逆再生。HTMLAudioElement は負の再生速度を鳴らせないので、Web Audio で自前で鳴らす。
 *
 * ファイル全体はデコードしない。現在位置から過去へ向かって数秒ずつ mediabunny でデコードし、
 * 反転して AudioBufferSourceNode を AudioContext の時計に合わせて隙間なく並べる。先読みは数秒分だけ。
 * 速度を変えるときは、反転済みの PCM に stretch.ts のタイムストレッチをかけて（ピッチは保つ）、
 * AudioBufferSourceNode は等速で鳴らす。ストレッチは 1 回の再生を通して 1 つの Stretcher を使い続けるので、
 * チャンクのつなぎ目で波形が途切れない（つなぎ目のクロスフェードは不要）。
 */

/** 最初のチャンクは短くして、再生開始までの待ちを減らす（元の音声の秒数） */
const FIRST_CHUNK_SEC = 1;
/** 通常のチャンクの長さ（元の音声の秒数）。速度に応じて伸縮する（CHUNK_MIN_SEC 〜 CHUNK_MAX_SEC） */
const CHUNK_SEC = 5;
const CHUNK_MIN_SEC = 2;
const CHUNK_MAX_SEC = 20;
/** これだけ先（再生時間）までスケジュールしておく */
const LOOKAHEAD_SEC = 4;
/** 末尾にこれより短い端数が残るなら、最後のチャンクに含める */
const MIN_TAIL_SEC = 0.2;
/** 開始・停止のクリックノイズ防止のフェード */
const FADE_SEC = 0.005;
/** 再生開始を AudioContext の時計より少し先にする */
const START_DELAY_SEC = 0.04;
/** スケジューラを起こす間隔 */
const KICK_MS = 150;

export interface ReversePlayerOptions {
  /** 再生を続けられなくなった（デコード失敗など）。日本語のメッセージ。再生は既に止まっている */
  onError: (message: string) => void;
}

interface Opened {
  input: Input;
  sink: AudioSampleSink;
  sampleRate: number;
  channels: number;
}

interface Placed {
  /** この塊を鳴らし始める AudioContext の時刻 */
  ctxStart: number;
  /** この塊の前までにスケジュールした出力の長さ（秒） */
  outOffset: number;
  /** この塊の出力の長さ（秒） */
  dur: number;
}

export class ReversePlayer {
  private ctx: AudioContext | null = null;
  private opening: Promise<Opened> | null = null;
  private opened: Opened | null = null;
  private disposed = false;

  // ---- 再生 1 回分（start から stop まで）の状態 ----
  private gen = 0;
  private pumpingGen = -1;
  private active = false;
  private lastPos = 0;
  private startSrc = 0;
  private rate = 1;
  private cursor = 0; // 次にデコードする区間の終端（元の音声の秒）
  private exhausted = false;
  private first = true;
  private nextTime = 0; // 次の塊を並べる AudioContext の時刻
  private outScheduled = 0;
  private placed: Placed[] = [];
  private stretcher: Stretcher | null = null;
  private master: GainNode | null = null;
  private nodes = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** sampleRate: 元の音声のサンプルレート。AudioContext を同じレートで作ると、再生時のリサンプルが入らない */
  constructor(
    private readonly file: File,
    private readonly sampleRate: number,
    private readonly opts: ReversePlayerOptions,
  ) {}

  static isSupported(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  /** いま鳴らしているか（開始処理中も含む）。false の間は position() が止まった位置を返す */
  get isActive(): boolean {
    return this.active;
  }

  /** 先頭（0 秒）まで鳴らし終えた */
  get finished(): boolean {
    const ctx = this.ctx;
    return this.active && this.exhausted && this.pumpingGen !== this.gen && !!ctx && ctx.currentTime >= this.nextTime - 0.001;
  }

  /** いまの再生位置（元の音声の秒）。止まっているときは最後の位置 */
  position(): number {
    const ctx = this.ctx;
    if (!this.active || !ctx) return this.lastPos;
    const t = ctx.currentTime;
    let elapsed = 0;
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if (p.ctxStart <= t) {
        elapsed = p.outOffset + Math.min(t - p.ctxStart, p.dur);
        break;
      }
    }
    // 古い塊は捨てる（直近の数個だけ残せば位置を求められる）
    while (this.placed.length > 4 && this.placed[1].ctxStart <= t - 1) this.placed.shift();
    return Math.max(0, this.startSrc - elapsed * this.rate);
  }

  /**
   * fromSec から過去に向かって鳴らし始める。ユーザー操作の中（クリック・キー）から呼ぶこと
   * （AudioContext は操作の中でないと再生が始まらない）。失敗は onError に通知する。
   */
  async start(fromSec: number, rate: number): Promise<void> {
    if (this.disposed) return;
    this.halt();
    const gen = ++this.gen;
    this.lastPos = fromSec;
    this.active = true; // 開始処理中も rAF から止まった位置が読めるよう、先に立てておく
    this.exhausted = fromSec <= 0;
    this.startSrc = fromSec;
    this.rate = rate;
    this.placed = [];
    try {
      const ctx = this.ensureContext();
      void ctx.resume();
      const o = await this.open();
      if (gen !== this.gen) return;

      this.cursor = fromSec;
      this.first = true;
      this.nextTime = 0;
      this.outScheduled = 0;
      this.stretcher =
        rate === 1 ? null : createStretcher({ channels: o.channels, sampleRate: o.sampleRate, rate });
      const master = ctx.createGain();
      master.connect(ctx.destination);
      this.master = master;
      this.timer = setInterval(() => void this.pump(gen), KICK_MS);
      await this.pump(gen);
    } catch (e) {
      if (gen !== this.gen) return;
      this.fail(e);
    }
  }

  /** 止めて、止めた位置（元の音声の秒）を返す */
  stop(): number {
    const pos = this.position();
    this.halt();
    this.lastPos = pos;
    return pos;
  }

  dispose(): void {
    this.disposed = true;
    this.halt();
    this.opened?.input.dispose();
    this.opened = null;
    this.opening = null;
    const ctx = this.ctx;
    this.ctx = null;
    void ctx?.close().catch(() => {});
  }

  // ---------------------------------------------------------------------------

  private fail(e: unknown): void {
    this.halt();
    const detail = e instanceof Error ? e.message : String(e);
    this.opts.onError(`逆再生できませんでした（${detail}）。`);
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      if (!ReversePlayer.isSupported()) throw new Error('このブラウザは Web Audio に対応していません');
      try {
        this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      } catch {
        this.ctx = new AudioContext(); // ブラウザが対応しないレートは既定のまま（再生時にリサンプルされる）
      }
    }
    return this.ctx;
  }

  /** 再生を止めて後始末する（直前の世代の非同期処理は gen の不一致で捨てられる） */
  private halt(): void {
    this.gen++;
    this.active = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    const master = this.master;
    const nodes = this.nodes;
    this.master = null;
    this.nodes = new Set();
    this.stretcher = null;
    this.placed = [];
    if (ctx && master) {
      // クリックが出ないよう短くフェードアウトしてから切る
      try {
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + FADE_SEC);
      } catch {
        // ignore
      }
      setTimeout(() => {
        for (const n of nodes) {
          try {
            n.stop();
          } catch {
            // 既に止まっている
          }
          n.disconnect();
        }
        master.disconnect();
      }, FADE_SEC * 1000 + 30);
    }
  }

  private open(): Promise<Opened> {
    this.opening ??= (async () => {
      const input = new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error('音声トラックがありません');
        if (!(await track.canDecode())) throw new Error('このブラウザでは音声をデコードできません');
        const o = {
          input,
          sink: new AudioSampleSink(track),
          sampleRate: track.sampleRate,
          channels: track.numberOfChannels,
        };
        if (this.disposed) input.dispose();
        else this.opened = o;
        return o;
      } catch (e) {
        input.dispose();
        this.opening = null;
        throw e;
      }
    })();
    return this.opening;
  }

  /** 先読みが足りていれば何もしない。足りなければ次のチャンクをデコードして並べる */
  private async pump(gen: number): Promise<void> {
    if (this.pumpingGen === gen) return;
    const ctx = this.ctx;
    const o = this.opened;
    if (!ctx || !o || gen !== this.gen) return;
    this.pumpingGen = gen;
    try {
      while (gen === this.gen && !this.exhausted && this.nextTime - ctx.currentTime < LOOKAHEAD_SEC) {
        const len = this.first ? FIRST_CHUNK_SEC : Math.min(CHUNK_MAX_SEC, Math.max(CHUNK_MIN_SEC, CHUNK_SEC * this.rate));
        const hi = this.cursor;
        let lo = Math.max(0, hi - len);
        if (lo < MIN_TAIL_SEC) lo = 0;
        const planes = await this.decodeReversed(o, lo, hi);
        if (gen !== this.gen) return;
        const last = lo <= 0;
        let out: Float32Array[] = planes;
        if (this.stretcher) {
          out = this.stretcher.push(planes);
          if (last) {
            const rest = this.stretcher.flush();
            out = out.map((p, c) => {
              const joined = new Float32Array(p.length + rest[c].length);
              joined.set(p);
              joined.set(rest[c], p.length);
              return joined;
            });
          }
        }
        this.place(ctx, o, out);
        this.cursor = lo;
        this.first = false;
        if (last) this.exhausted = true;
      }
    } catch (e) {
      if (gen === this.gen) this.fail(e);
    } finally {
      if (this.pumpingGen === gen) this.pumpingGen = -1;
    }
  }

  /** [lo, hi) 秒をデコードして、フレームの並びを反転した planar を返す */
  private async decodeReversed(o: Opened, lo: number, hi: number): Promise<Float32Array[]> {
    const sr = o.sampleRate;
    const startFrame = Math.round(lo * sr);
    const n = Math.max(0, Math.round(hi * sr) - startFrame);
    const planes = Array.from({ length: o.channels }, () => new Float32Array(n));
    for await (const sample of o.sink.samples(lo, hi)) {
      try {
        // samples() は区間の外のフレームも含みうるので、絶対フレーム番号で切る
        const abs0 = Math.round(sample.timestamp * sr);
        const from = Math.max(abs0, startFrame) - abs0;
        const to = Math.min(abs0 + sample.numberOfFrames, startFrame + n) - abs0;
        if (to <= from) continue;
        const dst = abs0 + from - startFrame;
        for (let c = 0; c < o.channels; c++) {
          const plane = c < sample.numberOfChannels ? c : 0;
          sample.copyTo(planes[c].subarray(dst, dst + (to - from)), {
            planeIndex: plane,
            format: 'f32-planar',
            frameOffset: from,
            frameCount: to - from,
          });
        }
      } finally {
        sample.close();
      }
    }
    for (const p of planes) p.reverse();
    return planes;
  }

  /** 出力の塊を AudioContext の時計に合わせて並べる */
  private place(ctx: AudioContext, o: Opened, planes: Float32Array[]): void {
    const n = planes.length > 0 ? planes[0].length : 0;
    if (n === 0 || !this.master) return;
    const buffer = ctx.createBuffer(o.channels, n, o.sampleRate);
    for (let c = 0; c < o.channels; c++) buffer.copyToChannel(planes[c] as Float32Array<ArrayBuffer>, c);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.master);
    // 間に合わなかったときだけ隙間があく（位置の計算は placed の時刻を使うのでずれない）
    const when = Math.max(this.nextTime, ctx.currentTime + (this.placed.length === 0 ? START_DELAY_SEC : 0.02));
    if (this.placed.length === 0) {
      this.master.gain.setValueAtTime(0, when);
      this.master.gain.linearRampToValueAtTime(1, when + FADE_SEC);
    }
    node.start(when);
    this.nodes.add(node);
    node.onended = () => {
      this.nodes.delete(node);
      node.disconnect();
    };
    this.placed.push({ ctxStart: when, outOffset: this.outScheduled, dur: buffer.duration });
    this.outScheduled += buffer.duration;
    this.nextTime = when + buffer.duration;
  }
}
