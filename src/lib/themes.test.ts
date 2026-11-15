import { describe, expect, it } from "vitest";
import { THEMES, resolveTheme } from "./themes";

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("themes", () => {
  it("have unique ids", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  for (const t of THEMES) {
    describe(t.name, () => {
      const k = t.tokens;
      it("primary text is highly readable (WCAG AAA on every surface)", () => {
        for (const s of [k.bg, k.elev, k.panel, k.panel2]) expect(contrast(k.ink, s)).toBeGreaterThanOrEqual(7);
      });
      it("secondary text meets WCAG AA", () => {
        for (const s of [k.bg, k.elev, k.panel]) expect(contrast(k.ink2, s)).toBeGreaterThanOrEqual(4.5);
      });
      it("muted text stays legible", () => {
        for (const s of [k.bg, k.elev, k.panel]) expect(contrast(k.ink3, s)).toBeGreaterThanOrEqual(3.5);
      });
      it("text on accent buttons meets WCAG AA", () => {
        expect(contrast(k.accentInk, k.accent)).toBeGreaterThanOrEqual(4.5);
      });
      it("accent-colored text is readable", () => {
        for (const s of [k.bg, k.panel]) expect(contrast(k.accentText, s)).toBeGreaterThanOrEqual(4.5);
      });
      it("data series are visible against the panel", () => {
        expect(contrast(k.original, k.panel)).toBeGreaterThanOrEqual(3);
        expect(contrast(k.enhanced, k.panel)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("resolves system and legacy values", () => {
    expect(resolveTheme("system", true).id).toBe("solarized-light");
    expect(resolveTheme("system", false).id).toBe("solarized-dark");
    expect(resolveTheme("dark", false).id).toBe("solarized-dark");
    expect(resolveTheme("light", false).id).toBe("solarized-light");
    expect(resolveTheme("nope", false).id).toBe("solarized-dark");
    expect(resolveTheme(undefined, false).id).toBe("solarized-dark");
  });
});
