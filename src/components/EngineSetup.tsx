import { Cpu, Download, LoaderCircle, MonitorCog, Square, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Button, ProgressBar, cx } from "./ui";

interface VariantDef {
  id: string;
  title: string;
  desc: string;
  size: string;
  icon: ReactNode;
  platforms: string[];
}

const VARIANTS: VariantDef[] = [
  {
    id: "cpu",
    title: "CPU",
    desc: "Works on every computer and is the fastest choice for the current models. Includes Core ML on Macs.",
    size: "≈ 100 MB download · 320 MB installed",
    icon: <Cpu size={16} />,
    platforms: ["windows", "macos", "linux"],
  },
  {
    id: "cuda",
    title: "NVIDIA GPU (CUDA)",
    desc: "GeForce / RTX with a recent driver. No speed-up for DeepFilterNet3 today; prepared for larger models.",
    size: "≈ 2.1 GB installed",
    icon: <Zap size={16} />,
    platforms: ["windows", "linux"],
  },
  {
    id: "directml",
    title: "Any GPU (DirectML)",
    desc: "AMD, Intel or NVIDIA graphics on Windows via DirectX 12. Experimental (not benchmarked).",
    size: "≈ 360 MB installed",
    icon: <MonitorCog size={16} />,
    platforms: ["windows"],
  },
];

/** One-time AI engine installation (private Python runtime + libraries). */
export function EngineSetup({ compact = false }: { compact?: boolean }) {
  const appInfo = useStore((s) => s.appInfo);
  const setup = useStore((s) => s.setup);
  const installEngine = useStore((s) => s.installEngine);
  const engineInfo = useStore((s) => s.engineInfo);
  const engineError = useStore((s) => s.engineError);
  const [chosen, setVariant] = useState<string | null>(null);
  const variant = chosen ?? appInfo?.recommendedVariant ?? "cpu";
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [setup.log.length]);

  const platform = appInfo?.platform ?? "windows";
  const options = VARIANTS.filter((v) => v.platforms.includes(platform));

  return (
    <div className={cx("panel", compact ? "p-5" : "p-0 border-0 shadow-none")}>
      <div className="mb-4">
        <div className="text-[15px] font-semibold">{engineInfo ? "Reinstall the AI engine" : "Set up the AI engine"}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
          A one-time download of a private Python runtime and audio/AI libraries into Resona's own folder. Your system is not
          modified, and everything runs offline afterwards.
        </p>
        {engineError && appInfo?.python && !setup.running && (
          <p className="selectable mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{engineError}</p>
        )}
      </div>

      {setup.running ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-[13px]">
            <LoaderCircle size={16} className="animate-spin text-brand" />
            <span className="font-medium">
              Step {Math.max(setup.step, 1)} of {setup.steps}: {setup.title}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void api.cancelEngineInstall()}>
              <Square size={12} /> Cancel
            </Button>
          </div>
          <ProgressBar value={Math.max(setup.step - 1, 0) / setup.steps + 0.1} />
          <pre
            ref={logRef}
            className="selectable h-32 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-ink-3"
          >
            {setup.log.join("\n") || "Starting…"}
          </pre>
        </div>
      ) : (
        <>
          <div className={cx("grid gap-2", options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {options.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={variant === v.id}
                onClick={() => setVariant(v.id)}
                className={cx(
                  "flex flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
                  variant === v.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong",
                )}
              >
                <span className={cx("flex items-center gap-1.5 text-[13px] font-semibold", variant === v.id && "text-brand")}>
                  {v.icon} {v.title}
                  {appInfo?.recommendedVariant === v.id && (
                    <span className="ml-auto rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold text-brand">Recommended</span>
                  )}
                </span>
                <span className="text-[11.5px] leading-snug text-ink-3">{v.desc}</span>
                <span className="text-[11px] text-ink-3">{v.size}</span>
              </button>
            ))}
          </div>
          {setup.error && <p className="selectable mt-3 text-xs text-danger">{setup.error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" onClick={() => void installEngine(variant)}>
              <Download size={15} /> {engineInfo ? "Reinstall" : "Install engine"}
            </Button>
            <span className="text-xs text-ink-3">
              The CPU engine processes a typical song ~30× faster than real time (measured on a desktop CPU).
            </span>
          </div>
        </>
      )}
    </div>
  );
}
