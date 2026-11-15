// Shapes exchanged with the Rust backend and the Python worker.

/** A theme id from src/lib/themes.ts, or "system" (Solarized Dark/Light by OS preference). */
export type Theme = string;
export type LoudnessMode = "match" | "normalize" | "off";
export type PresetId = "music" | "vocals" | "restoration" | "custom";
export type DenoiseEngine = "spectral" | "dfn";
export type ExportFormat = "flac" | "wav" | "aiff" | "mp3" | "ogg" | "opus" | "m4a" | "alac";

export interface Settings {
  theme: Theme;
  device: string;
  threads: number;
  concurrency: number;
  outputDir: string | null;
  format: ExportFormat;
  bitDepth: 16 | 24 | 32;
  bitrateKbps: number;
  sampleRate: number;
  loudnessMode: LoudnessMode;
  targetLufs: number;
  truePeakDb: number;
  chunkSeconds: number;
  filenameSuffix: string;
  overwrite: boolean;
  loudnessMatchedAb: boolean;
  pythonPath: string | null;
  ffmpegPath: string | null;
}

export interface Stages {
  declip: { enabled: boolean };
  denoise: { enabled: boolean; engine: DenoiseEngine; strength: number };
  vocal: { enabled: boolean; amountDb: number };
  bandwidth: { enabled: boolean; strength: number };
}

export interface Paths {
  appData: string;
  config: string;
  cache: string;
  logs: string;
  models: string;
  engine: string;
  previews: string;
  worker: string;
}

export interface EngineManifest {
  variant: string;
  uvVersion: string;
  pythonVersion: string;
  installedAt: string;
  appVersion: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  paths: Paths;
  python: { path: string; source: "settings" | "engine" | "dev" } | null;
  engine: EngineManifest | null;
  engineInstalling: boolean;
  nvidiaGpu: boolean;
  variants: string[];
  recommendedVariant: string;
  audioExtensions: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  version: string;
  tasks: string[];
  engine: string;
  license: string;
  license_url: string;
  source: string;
  paper: string;
  url: string;
  sha256: string;
  size: number;
  sample_rate: number;
  description: string;
  limitations: string;
  experimental: boolean;
  installed: boolean;
  verified: boolean | null;
  path: string;
}

export interface EngineInfo {
  version: string;
  protocol: number;
  python: string;
  executable: string;
  devices: {
    platform: string;
    machine: string;
    python: string;
    cpuCount: number;
    onnxruntime: string | null;
    onnxDevices: string[];
    torch: unknown;
  };
  ffmpeg: { path: string | null; version: string | null };
  formats: Record<string, { label: string; lossless: boolean; ext: string; needs_ffmpeg: boolean }>;
  models: ModelInfo[];
  modelsDir: string;
}

export interface Spectrum {
  freqs: number[];
  db: number[];
}

export interface Analysis {
  clipping: { clippedFraction: number; runs: number; isClipped: boolean; longestRun: number };
  bandwidth: { cutoffHz: number; nyquistHz: number; bandLimited: boolean; dropDb: number };
  loudnessLufs: number | null;
  truePeakDbtp: number | null;
  noiseFloorDb: number | null;
  spectrum: Spectrum;
  peaks: number[];
  hints: string[];
  suggestedPreset: PresetId;
  info: {
    path: string;
    sampleRate: number;
    channels: number;
    frames: number;
    duration: number;
    format: string;
    subtype: string | null;
    decoder: string;
  };
}

export interface JobResult {
  output: string;
  format: string;
  encoder: string;
  bytes: number;
  sampleRateIn: number;
  sampleRateOut: number;
  channels: number;
  durationIn: number;
  durationOut: number;
  inputLufs: number | null;
  outputLufs: number | null;
  inputTruePeakDb: number | null;
  outputTruePeakDb: number | null;
  gainDb: number;
  limiterReductionDb: number;
  inputSpectrum: Spectrum;
  outputSpectrum: Spectrum;
  outputPeaks: number[];
  stages: Stages;
  details: Record<string, Record<string, unknown>>;
  device: string;
  timings: Record<string, number>;
  elapsed: number;
  realtimeFactor: number | null;
  warnings: string[];
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  input: string;
  output: string;
  status: JobStatus;
  progress: number;
  stage: string;
  message: string;
  error: { code: string; message: string } | null;
  result: JobResult | null;
  spec: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EngineEvent {
  step: number;
  steps: number;
  title: string;
  line: string | null;
  done: boolean;
  error: string | null;
}

export interface BackendError {
  code: string;
  message: string;
}
