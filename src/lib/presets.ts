// Mirrors worker/resona_worker/presets.py. Keep both in sync.
import type { PresetId, Stages } from "./types";

export interface PresetDef {
  id: PresetId;
  name: string;
  tagline: string;
  stages: Stages;
}

export const PRESETS: Record<Exclude<PresetId, "custom">, PresetDef> = {
  music: {
    id: "music",
    name: "Music",
    tagline: "Full mixes — repair, gentle de-hiss, restore air",
    stages: {
      declip: { enabled: true },
      denoise: { enabled: true, engine: "spectral", strength: 0.35 },
      vocal: { enabled: false, amountDb: 2 },
      bandwidth: { enabled: true, strength: 0.5 },
    },
  },
  vocals: {
    id: "vocals",
    name: "Vocals",
    tagline: "Speech, podcasts, a cappella — AI noise removal",
    stages: {
      declip: { enabled: true },
      denoise: { enabled: true, engine: "dfn", strength: 0.85 },
      vocal: { enabled: false, amountDb: 3 },
      bandwidth: { enabled: true, strength: 0.4 },
    },
  },
  restoration: {
    id: "restoration",
    name: "Restoration",
    tagline: "Old & degraded recordings — stronger repair",
    stages: {
      declip: { enabled: true },
      denoise: { enabled: true, engine: "spectral", strength: 0.7 },
      vocal: { enabled: true, amountDb: 2 },
      bandwidth: { enabled: true, strength: 0.65 },
    },
  },
};

export const PRESET_ORDER: PresetId[] = ["music", "vocals", "restoration", "custom"];

export const cloneStages = (s: Stages): Stages => JSON.parse(JSON.stringify(s)) as Stages;

/** Which models a stage configuration needs. */
export function requiredModels(stages: Stages): string[] {
  const needs = (stages.denoise.enabled && stages.denoise.engine === "dfn") || stages.vocal.enabled;
  return needs ? ["deepfilternet3"] : [];
}

export function hasAnyStage(stages: Stages): boolean {
  return stages.declip.enabled || stages.denoise.enabled || stages.vocal.enabled || stages.bandwidth.enabled;
}
