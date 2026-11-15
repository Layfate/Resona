// Color themes. Each theme is a full set of semantic tokens applied as CSS
// custom properties on <html>. Series colors (Original / Enhanced) were checked
// with the dataviz palette validator against each theme's panel surface, and
// text contrast is enforced by themes.test.ts.

export type ThemeId =
  | "solarized-dark"
  | "solarized-light"
  | "dark-modern"
  | "light-modern"
  | "clay-dark"
  | "clay-light"
  | "graphite"
  | "paper"
  | "resona-cyan";

export interface ThemeTokens {
  bg: string; // main canvas
  elev: string; // sidebar & bottom bar
  panel: string; // cards
  panel2: string; // inputs, hovered rows
  line: string;
  lineStrong: string;
  ink: string; // primary text
  ink2: string; // secondary text
  ink3: string; // muted text
  accent: string; // fills (buttons, switches, progress)
  accentStrong: string; // hover fill
  accentInk: string; // text/icons on accent fills
  accentText: string; // accent used as text on bg/panels
  accentSoft: string; // tinted selection backgrounds
  danger: string;
  warn: string;
  ok: string;
  original: string; // data series: original audio
  enhanced: string; // data series: enhanced audio
  waveIdle: string;
  logoTile: string; // background behind the gold logo mark
  shadow: string;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  description: string;
  scheme: "dark" | "light";
  tokens: ThemeTokens;
}

const darkShadow = "0 1px 0 rgb(255 255 255 / 0.03) inset, 0 10px 30px -14px rgb(0 0 0 / 0.55)";
const lightShadow = "0 1px 2px rgb(0 0 0 / 0.05), 0 8px 24px -14px rgb(0 0 0 / 0.16)";

export const THEMES: ThemeDef[] = [
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Low-glare, warm-tinted dark. Easy on the eyes for long sessions.",
    scheme: "dark",
    tokens: {
      bg: "#002b36",
      elev: "#01303c",
      panel: "#073642",
      panel2: "#0b3e4b",
      line: "#104755",
      lineStrong: "#1f5a69",
      ink: "#eee8d5",
      ink2: "#a3b1b1",
      ink3: "#839496",
      accent: "#2aa198",
      accentStrong: "#3bb5ab",
      accentInk: "#002b36",
      accentText: "#4cc3b8",
      accentSoft: "rgb(42 161 152 / 0.16)",
      danger: "#f0605d",
      warn: "#d9a92a",
      ok: "#9fb33c",
      original: "#e0622a",
      enhanced: "#2aa198",
      waveIdle: "#1d4b57",
      logoTile: "#002b36",
      shadow: darkShadow,
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "The classic cream paper look with the same calm accents.",
    scheme: "light",
    tokens: {
      bg: "#fdf6e3",
      elev: "#f5eedb",
      panel: "#fffcf2",
      panel2: "#f3ecd8",
      line: "#e6dfca",
      lineStrong: "#d2c9b0",
      ink: "#073642",
      ink2: "#4f646b",
      ink3: "#61757b",
      accent: "#1f7f78",
      accentStrong: "#196b65",
      accentInk: "#ffffff",
      accentText: "#1a746d",
      accentSoft: "rgb(42 161 152 / 0.14)",
      danger: "#c62a27",
      warn: "#8f6c00",
      ok: "#5f6e00",
      original: "#cb4b16",
      enhanced: "#2aa198",
      waveIdle: "#e2dac3",
      logoTile: "#002b36",
      shadow: lightShadow,
    },
  },
  {
    id: "dark-modern",
    name: "Dark Modern",
    description: "Neutral code-editor dark with a blue accent.",
    scheme: "dark",
    tokens: {
      bg: "#1f1f1f",
      elev: "#181818",
      panel: "#252526",
      panel2: "#2b2b2c",
      line: "#2e2e2e",
      lineStrong: "#3f3f3f",
      ink: "#e6e6e6",
      ink2: "#b8b8b8",
      ink3: "#949494",
      accent: "#0078d4",
      accentStrong: "#1a86dc",
      accentInk: "#ffffff",
      accentText: "#4daafc",
      accentSoft: "rgb(0 120 212 / 0.2)",
      danger: "#f48771",
      warn: "#cca700",
      ok: "#89d185",
      original: "#c27a12",
      enhanced: "#3794ff",
      waveIdle: "#3a3a3a",
      logoTile: "#181818",
      shadow: darkShadow,
    },
  },
  {
    id: "light-modern",
    name: "Light Modern",
    description: "Clean code-editor light with a blue accent.",
    scheme: "light",
    tokens: {
      bg: "#f8f8f8",
      elev: "#f3f3f3",
      panel: "#ffffff",
      panel2: "#f1f1f1",
      line: "#e5e5e5",
      lineStrong: "#cecece",
      ink: "#1f1f1f",
      ink2: "#4a4a4a",
      ink3: "#646464",
      accent: "#005fb8",
      accentStrong: "#0258a8",
      accentInk: "#ffffff",
      accentText: "#005fb8",
      accentSoft: "rgb(0 95 184 / 0.1)",
      danger: "#c72e0f",
      warn: "#8a6100",
      ok: "#2e7d32",
      original: "#b5650d",
      enhanced: "#005fb8",
      waveIdle: "#dcdcdc",
      logoTile: "#1f1f1f",
      shadow: lightShadow,
    },
  },
  {
    id: "clay-dark",
    name: "Clay Dark",
    description: "Warm charcoal with a terracotta accent — soft and relaxed.",
    scheme: "dark",
    tokens: {
      bg: "#262624",
      elev: "#1f1e1d",
      panel: "#30302e",
      panel2: "#383835",
      line: "#3b3a37",
      lineStrong: "#4d4b47",
      ink: "#f5f4ef",
      ink2: "#c7c3b8",
      ink3: "#a29e93",
      accent: "#b9583a",
      accentStrong: "#c96442",
      accentInk: "#ffffff",
      accentText: "#e5916f",
      accentSoft: "rgb(217 119 87 / 0.16)",
      danger: "#f07a6a",
      warn: "#e0b04f",
      ok: "#8fc28f",
      original: "#c96442",
      enhanced: "#4a8fd6",
      waveIdle: "#45443f",
      logoTile: "#1f1e1d",
      shadow: darkShadow,
    },
  },
  {
    id: "clay-light",
    name: "Clay Light",
    description: "Warm ivory paper with a terracotta accent.",
    scheme: "light",
    tokens: {
      bg: "#faf9f5",
      elev: "#f3f1ea",
      panel: "#ffffff",
      panel2: "#f2f0e8",
      line: "#e6e3d8",
      lineStrong: "#d2cec0",
      ink: "#1f1e1d",
      ink2: "#55534e",
      ink3: "#6b6862",
      accent: "#b5562f",
      accentStrong: "#a14b28",
      accentInk: "#ffffff",
      accentText: "#a64e2a",
      accentSoft: "rgb(193 95 60 / 0.12)",
      danger: "#b42318",
      warn: "#8a5a00",
      ok: "#2f6b3a",
      original: "#c15f3c",
      enhanced: "#2f6db5",
      waveIdle: "#e3dfd2",
      logoTile: "#262624",
      shadow: lightShadow,
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "Minimal monochrome dark — content first, no color noise.",
    scheme: "dark",
    tokens: {
      bg: "#212121",
      elev: "#171717",
      panel: "#2a2a2a",
      panel2: "#303030",
      line: "#353535",
      lineStrong: "#474747",
      ink: "#ececec",
      ink2: "#b8b8b8",
      ink3: "#949494",
      accent: "#ececec",
      accentStrong: "#ffffff",
      accentInk: "#0d0d0d",
      accentText: "#ffffff",
      accentSoft: "rgb(255 255 255 / 0.09)",
      danger: "#f87171",
      warn: "#e5b84f",
      ok: "#6fcf97",
      original: "#cf7436",
      enhanced: "#3a95d0",
      waveIdle: "#3d3d3d",
      logoTile: "#171717",
      shadow: darkShadow,
    },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Minimal monochrome light — crisp white with black accents.",
    scheme: "light",
    tokens: {
      bg: "#ffffff",
      elev: "#f9f9f9",
      panel: "#ffffff",
      panel2: "#f3f3f3",
      line: "#e6e6e6",
      lineStrong: "#d0d0d0",
      ink: "#0d0d0d",
      ink2: "#4d4d4d",
      ink3: "#666666",
      accent: "#0d0d0d",
      accentStrong: "#333333",
      accentInk: "#ffffff",
      accentText: "#0d0d0d",
      accentSoft: "rgb(0 0 0 / 0.06)",
      danger: "#c0262d",
      warn: "#8a5a00",
      ok: "#1f7a46",
      original: "#c2622d",
      enhanced: "#1f78b4",
      waveIdle: "#e2e2e2",
      logoTile: "#0d0d0d",
      shadow: lightShadow,
    },
  },
  {
    id: "resona-cyan",
    name: "Resona Cyan",
    description: "The original deep navy with vivid cyan accents.",
    scheme: "dark",
    tokens: {
      bg: "#090c11",
      elev: "#0e131a",
      panel: "#111821",
      panel2: "#151d28",
      line: "#1f2a37",
      lineStrong: "#2b3a4c",
      ink: "#e6edf5",
      ink2: "#a9b6c6",
      ink3: "#7f8ea2",
      accent: "#22d3ee",
      accentStrong: "#06b6d4",
      accentInk: "#04151a",
      accentText: "#22d3ee",
      accentSoft: "rgb(34 211 238 / 0.12)",
      danger: "#f87171",
      warn: "#fbbf24",
      ok: "#34d399",
      original: "#cf7a2a",
      enhanced: "#139bb4",
      waveIdle: "#2a3646",
      logoTile: "#0b1520",
      shadow: darkShadow,
    },
  },
];

export const DEFAULT_THEME: ThemeId = "solarized-dark";
export const SYSTEM_PAIR: { dark: ThemeId; light: ThemeId } = { dark: "solarized-dark", light: "solarized-light" };

const CSS_VARS: Record<keyof ThemeTokens, string> = {
  bg: "--bg",
  elev: "--bg-elev",
  panel: "--panel",
  panel2: "--panel-2",
  line: "--line",
  lineStrong: "--line-strong",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  accent: "--accent",
  accentStrong: "--accent-strong",
  accentInk: "--accent-ink",
  accentText: "--accent-text",
  accentSoft: "--accent-soft",
  danger: "--danger",
  warn: "--warn",
  ok: "--ok",
  original: "--series-original",
  enhanced: "--series-enhanced",
  waveIdle: "--wave-idle",
  logoTile: "--logo-tile",
  shadow: "--shadow",
};

/** Map a stored setting ("system", a theme id, or legacy "dark"/"light") to a theme. */
export function resolveTheme(setting: string | undefined, prefersLight: boolean): ThemeDef {
  let id = setting ?? DEFAULT_THEME;
  if (id === "system") id = prefersLight ? SYSTEM_PAIR.light : SYSTEM_PAIR.dark;
  if (id === "dark") id = "solarized-dark";
  if (id === "light") id = "solarized-light";
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyThemeTokens(theme: ThemeDef, root: HTMLElement = document.documentElement) {
  for (const [key, cssVar] of Object.entries(CSS_VARS)) {
    root.style.setProperty(cssVar, theme.tokens[key as keyof ThemeTokens]);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
}
