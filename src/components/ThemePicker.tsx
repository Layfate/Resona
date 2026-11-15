import { Check, MonitorSmartphone } from "lucide-react";
import { THEMES, resolveTheme, type ThemeDef } from "../lib/themes";
import { cx } from "./ui";

/** Miniature of the app (sidebar, waveform lanes, button) drawn in a theme's colors. */
function Preview({ theme }: { theme: ThemeDef }) {
  const k = theme.tokens;
  const bars = [5, 9, 14, 8, 12, 6, 10, 15, 7, 11, 5, 9];
  return (
    <div className="flex h-[84px] overflow-hidden rounded-lg" style={{ background: k.bg, boxShadow: `inset 0 0 0 1px ${k.line}` }} aria-hidden>
      <div className="flex w-[34%] flex-col gap-1.5 p-2" style={{ background: k.elev, borderRight: `1px solid ${k.line}` }}>
        <div className="h-1.5 w-3/4 rounded-full" style={{ background: k.ink }} />
        <div className="h-1.5 w-1/2 rounded-full" style={{ background: k.ink3 }} />
        <div className="mt-auto h-3.5 rounded" style={{ background: k.accent }} />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-2 p-2.5">
        {[k.original, k.enhanced].map((c) => (
          <div key={c} className="flex h-5 items-center gap-[2px] rounded px-1" style={{ background: k.panel }}>
            {bars.map((h, i) => (
              <span key={i} className="w-[3px] rounded-full" style={{ height: h, background: c }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const prefersLight = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches;
  const current = value === "system" ? "system" : resolveTheme(value, prefersLight).id;
  const card = (id: string, selected: boolean, label: string, desc: string, preview: React.ReactNode) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onChange(id)}
      className={cx(
        "group relative flex flex-col gap-2 rounded-xl border p-2.5 text-left transition-all",
        selected ? "border-accent ring-2 ring-accent/35" : "border-line hover:border-line-strong",
      )}
    >
      {preview}
      <div className="flex items-start gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{label}</div>
          <div className="text-[11.5px] leading-snug text-ink-3">{desc}</div>
        </div>
        {selected && (
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </div>
    </button>
  );
  const sys = resolveTheme("system", prefersLight);
  return (
    <div role="radiogroup" aria-label="Color theme" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {THEMES.map((t) => card(t.id, current === t.id, t.name, t.description, <Preview theme={t} />))}
      {card(
        "system",
        current === "system",
        "Match system",
        "Solarized Dark or Light, following your OS setting.",
        <div className="relative">
          <Preview theme={sys} />
          <span className="absolute right-2 top-2 rounded-md bg-black/40 p-1 text-white">
            <MonitorSmartphone size={13} />
          </span>
        </div>,
      )}
    </div>
  );
}
