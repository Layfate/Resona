import { describe, expect, it } from "vitest";
import { abGains, basename, formatDb, formatHz, formatTime, matchGain, stem } from "./format";
import { PRESETS, hasAnyStage, requiredModels } from "./presets";

describe("format", () => {
  it("formats time", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(75.4)).toBe("1:15");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });

  it("formats frequencies and levels", () => {
    expect(formatHz(16000)).toBe("16 kHz");
    expect(formatHz(15500)).toBe("15.5 kHz");
    expect(formatHz(440)).toBe("440 Hz");
    expect(formatDb(-14.04, "LUFS")).toBe("−14.0 LUFS");
    expect(formatDb(1.5)).toBe("+1.5 dB");
    expect(formatDb(null)).toBe("—");
  });

  it("splits paths on both separators", () => {
    expect(basename("C:\\Music\\a b.flac")).toBe("a b.flac");
    expect(basename("/home/u/x.mp3")).toBe("x.mp3");
    expect(stem("/home/u/x.y.mp3")).toBe("x.y");
  });
});

describe("loudness matching", () => {
  it("computes gain between loudness values", () => {
    expect(matchGain(-20, -14)).toBeCloseTo(10 ** (6 / 20));
    expect(matchGain(null, -14)).toBe(1);
    expect(matchGain(-80, 0)).toBeCloseTo(10 ** (24 / 20)); // capped
  });

  it("never boosts above unity in A/B", () => {
    const louderB = abGains(-20, -14);
    expect(louderB.a).toBe(1);
    expect(louderB.b).toBeCloseTo(10 ** (-6 / 20));
    const louderA = abGains(-10, -14);
    expect(louderA.a).toBeCloseTo(10 ** (-4 / 20));
    expect(louderA.b).toBe(1);
  });
});

describe("presets", () => {
  it("vocals preset requires DeepFilterNet3, music does not", () => {
    expect(requiredModels(PRESETS.vocals.stages)).toEqual(["deepfilternet3"]);
    expect(requiredModels(PRESETS.music.stages)).toEqual([]);
    expect(requiredModels(PRESETS.restoration.stages)).toEqual(["deepfilternet3"]);
    expect(hasAnyStage(PRESETS.music.stages)).toBe(true);
  });
});
