import { useEffect, useState } from "react";

/** Resolve CSS custom properties to concrete colors (canvas cannot use var()). */
export function useThemeColors<T extends Record<string, string>>(vars: T): Record<keyof T, string> {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, cs.getPropertyValue(v).trim() || "#888"])) as Record<
      keyof T,
      string
    >;
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return colors;
}

/** Mix a hex color with transparency (canvas-friendly rgba). */
export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
