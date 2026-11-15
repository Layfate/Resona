// Small, pure formatting helpers (unit-tested in format.test.ts).

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatHz(hz: number): string {
  if (!Number.isFinite(hz)) return "—";
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.0+$/, "")} kHz` : `${Math.round(hz)} Hz`;
}

export function formatDb(db: number | null | undefined, unit = "dB", digits = 1): string {
  if (db === null || db === undefined || !Number.isFinite(db)) return "—";
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(digits)} ${unit}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

export function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

/** Linear gain that makes audio at `fromLufs` play at `toLufs` (capped to ±24 dB). */
export function matchGain(fromLufs: number | null | undefined, toLufs: number | null | undefined): number {
  if (fromLufs == null || toLufs == null || !Number.isFinite(fromLufs) || !Number.isFinite(toLufs)) return 1;
  const db = Math.max(-24, Math.min(24, toLufs - fromLufs));
  return 10 ** (db / 20);
}

/**
 * Gains for A/B so both sides play at the same loudness without ever boosting
 * above unity (which could clip): the louder side is attenuated instead.
 */
export function abGains(lufsA: number | null | undefined, lufsB: number | null | undefined): { a: number; b: number } {
  const g = matchGain(lufsA, lufsB); // gain to bring A to B's loudness
  return g <= 1 ? { a: g, b: 1 } : { a: 1, b: 1 / g };
}

export const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  starting: "Starting",
  load: "Decoding",
  analyze: "Analysing",
  declip: "Repairing clipping",
  model: "Loading model",
  process: "Enhancing",
  master: "Loudness & peaks",
  encode: "Writing file",
  done: "Done",
};
