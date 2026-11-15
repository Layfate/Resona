/**
 * Synchronised A/B player.
 *
 * Both versions play simultaneously from the same position; switching only
 * crossfades two gain nodes (≈10 ms), so the comparison is instant and
 * sample-aligned. Loudness matching is applied as a static gain per side.
 *
 * Short files are decoded into AudioBuffers (sample-accurate). Very long files
 * fall back to two <audio> elements to avoid holding gigabytes of PCM in memory.
 */

export type Side = "a" | "b";
type Mode = "buffer" | "media";

const LONG_FILE_SECONDS = 25 * 60;
const FADE = 0.008; // seconds (time constant of the A/B crossfade)

export class ABPlayer {
  private ctx: AudioContext | null = null;
  private mode: Mode = "buffer";
  private buffers: Partial<Record<Side, AudioBuffer>> = {};
  private media: Partial<Record<Side, HTMLAudioElement>> = {};
  private gains: Partial<Record<Side, GainNode>> = {};
  private nodes: Partial<Record<Side, AudioBufferSourceNode>> = {};
  private startCtxTime = 0;
  private startOffset = 0;
  private loadToken: Record<Side, number> = { a: 0, b: 0 };
  private durations: Partial<Record<Side, number>> = {};

  playing = false;
  active: Side = "a";
  private levels: Record<Side, number> = { a: 1, b: 1 };
  private volume = 0.9;
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "playback" });
      for (const side of ["a", "b"] as Side[]) {
        const g = this.ctx.createGain();
        g.gain.value = 0;
        g.connect(this.ctx.destination);
        this.gains[side] = g;
      }
    }
    return this.ctx;
  }

  has(side: Side): boolean {
    return this.mode === "buffer" ? !!this.buffers[side] : !!this.media[side];
  }

  get duration(): number {
    return Math.max(this.durations.a ?? 0, this.durations.b ?? 0);
  }

  get currentTime(): number {
    if (this.mode === "media") {
      const el = this.media[this.active] ?? this.media.a;
      return el ? el.currentTime : 0;
    }
    if (!this.playing || !this.ctx) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  /** Load one side. `durationHint` (seconds) selects buffer vs media mode. */
  async load(side: Side, url: string, durationHint = 0): Promise<void> {
    const token = ++this.loadToken[side];
    const wasPlaying = this.playing;
    const pos = this.currentTime;
    if (wasPlaying) this.pause();
    this.unload(side);
    if (side === "a") {
      this.mode = durationHint > LONG_FILE_SECONDS ? "media" : "buffer";
    }
    if (this.mode === "media") {
      const el = new Audio();
      el.preload = "auto";
      el.src = url;
      await new Promise<void>((resolve, reject) => {
        el.addEventListener("loadedmetadata", () => resolve(), { once: true });
        el.addEventListener("error", () => reject(new Error("This file cannot be played back.")), { once: true });
      });
      if (token !== this.loadToken[side]) return;
      el.addEventListener("ended", () => this.handleEnded());
      this.media[side] = el;
      this.durations[side] = el.duration;
    } else {
      const ctx = this.context();
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Could not read audio (${resp.status})`);
      const data = await resp.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      if (token !== this.loadToken[side]) return;
      this.buffers[side] = buffer;
      this.durations[side] = buffer.duration;
    }
    if (!this.has(this.active)) this.active = "a";
    this.applyGains(true);
    this.seek(Math.min(pos, this.duration));
    if (wasPlaying) this.play();
  }

  unload(side: Side): void {
    this.stopNode(side);
    const el = this.media[side];
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    delete this.media[side];
    delete this.buffers[side];
    delete this.durations[side];
    if (side === this.active && side === "b") this.active = "a";
  }

  async play(): Promise<void> {
    if (!this.has("a") && !this.has("b")) return;
    if (this.currentTime >= this.duration - 0.01) this.startOffset = 0;
    if (this.mode === "media") {
      const t = this.currentTime;
      for (const el of Object.values(this.media)) {
        if (!el) continue;
        el.currentTime = t;
        void el.play();
      }
      this.playing = true;
      this.applyGains(true);
      return;
    }
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    const when = ctx.currentTime + 0.03; // schedule both sides at the same instant
    for (const side of ["a", "b"] as Side[]) {
      const buf = this.buffers[side];
      if (!buf) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.gains[side]!);
      const offset = Math.min(this.startOffset, buf.duration);
      node.start(when, offset);
      this.nodes[side] = node;
    }
    this.startCtxTime = when;
    this.playing = true;
    this.applyGains(true);
  }

  pause(): void {
    if (!this.playing) return;
    const t = this.currentTime;
    this.playing = false;
    if (this.mode === "media") {
      Object.values(this.media).forEach((el) => el?.pause());
    } else {
      this.stopNode("a");
      this.stopNode("b");
    }
    this.startOffset = Math.max(0, Math.min(t, this.duration));
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(seconds: number): void {
    const t = Math.max(0, Math.min(seconds, this.duration || 0));
    if (this.mode === "media") {
      Object.values(this.media).forEach((el) => {
        if (el) el.currentTime = t;
      });
      this.startOffset = t;
      return;
    }
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.startOffset = t;
    if (wasPlaying) void this.play();
  }

  setActive(side: Side): void {
    if (!this.has(side)) return;
    if (this.mode === "media" && this.playing && side !== this.active) {
      const from = this.media[this.active];
      const to = this.media[side];
      if (from && to && Math.abs(from.currentTime - to.currentTime) > 0.04) to.currentTime = from.currentTime;
    }
    this.active = side;
    this.applyGains(false);
  }

  /** Static per-side gains (linear), e.g. for loudness-matched comparison. */
  setLevels(a: number, b: number): void {
    this.levels = { a, b };
    this.applyGains(false);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGains(false);
  }

  /** Called from the UI's animation loop; detects the end of playback. */
  tick(): void {
    if (this.mode === "buffer" && this.playing && this.currentTime >= this.duration) {
      this.handleEnded();
    }
  }

  dispose(): void {
    this.pause();
    this.unload("a");
    this.unload("b");
    void this.ctx?.close();
    this.ctx = null;
    this.gains = {};
  }

  private handleEnded(): void {
    this.pause();
    this.startOffset = 0;
    if (this.mode === "media") Object.values(this.media).forEach((el) => el && (el.currentTime = 0));
    this.onEnded?.();
  }

  private stopNode(side: Side): void {
    const n = this.nodes[side];
    if (n) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
      delete this.nodes[side];
    }
  }

  private applyGains(immediate: boolean): void {
    for (const side of ["a", "b"] as Side[]) {
      const target = side === this.active ? this.volume * this.levels[side] : 0;
      if (this.mode === "media") {
        const el = this.media[side];
        if (el) el.volume = Math.max(0, Math.min(1, target));
        continue;
      }
      const g = this.gains[side];
      if (!g || !this.ctx) continue;
      const now = this.ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      if (immediate) g.gain.setValueAtTime(target, now);
      else g.gain.setTargetAtTime(target, now, FADE);
    }
  }
}
