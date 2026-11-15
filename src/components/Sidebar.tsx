import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Cpu,
  FolderOpen,
  History,
  Mic,
  Music2,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { ReactNode } from "react";
import { PRESETS, PRESET_ORDER, hasAnyStage } from "../lib/presets";
import type { ExportFormat, PresetId } from "../lib/types";
import { jobForFile, useStore } from "../store";
import { Logo } from "./Logo";
import { Badge, Button, IconButton, Segmented, Select, Slider, Switch, cx } from "./ui";

const PRESET_ICONS: Record<PresetId, ReactNode> = {
  music: <Music2 size={16} />,
  vocals: <Mic size={16} />,
  restoration: <History size={16} />,
  custom: <SlidersHorizontal size={16} />,
};

const FORMATS: Array<{ value: ExportFormat; label: string; ffmpeg?: boolean; lossless: boolean }> = [
  { value: "flac", label: "FLAC", lossless: true },
  { value: "wav", label: "WAV", lossless: true },
  { value: "aiff", label: "AIFF", lossless: true },
  { value: "mp3", label: "MP3", lossless: false },
  { value: "ogg", label: "Ogg Vorbis", lossless: false },
  { value: "opus", label: "Opus", lossless: false },
  { value: "m4a", label: "AAC (.m4a)", ffmpeg: true, lossless: false },
  { value: "alac", label: "ALAC (.m4a)", ffmpeg: true, lossless: true },
];

function Section({ step, title, children, aside }: { step: number; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="px-5 py-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-soft text-[10px] text-brand">{step}</span>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stage({
  title,
  kind,
  hint,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  kind: "AI" | "DSP" | "AI+DSP";
  hint: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className={cx("rounded-xl border px-3.5 py-3 transition-colors", enabled ? "border-line-strong bg-panel-2" : "border-line")}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[14px] font-medium">
            {title}
            <Badge tone={kind === "DSP" ? "dsp" : "ai"}>{kind}</Badge>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{hint}</p>
        </div>
        <Switch checked={enabled} onChange={onToggle} label={title} />
      </div>
      {enabled && children && <div className="animate-in mt-3 space-y-3">{children}</div>}
    </div>
  );
}

export function Sidebar() {
  const { preset, stages, setPreset, updateStage, settings, updateSettings, outputDir, setOutputDir, engineInfo, appInfo } =
    useStore();
  const files = useStore((s) => s.files);
  const selectedId = useStore((s) => s.selectedId);
  const jobs = useStore((s) => s.jobs);
  const enhance = useStore((s) => s.enhance);
  const openSettings = useStore((s) => s.openSettings);
  const engineError = useStore((s) => s.engineError);
  const setup = useStore((s) => s.setup);

  const hasFfmpeg = !!engineInfo?.ffmpeg.path;
  const selected = files.find((f) => f.id === selectedId);
  const selectedJob = jobForFile(selected, jobs);
  const selectedBusy = selectedJob && (selectedJob.status === "queued" || selectedJob.status === "running");
  const pending = files.filter((f) => {
    const j = jobForFile(f, jobs);
    return !j || j.status === "failed" || j.status === "cancelled";
  });
  const format = FORMATS.find((f) => f.value === settings?.format) ?? FORMATS[0];

  const pickFolder = async () => {
    const dir = await open({ directory: true, defaultPath: outputDir || undefined, title: "Choose output folder" });
    if (typeof dir === "string") await setOutputDir(dir);
  };

  const devices = engineInfo?.devices.onnxDevices ?? [];
  // "auto" resolves to CPU for the current model (fastest in our measurements).
  const deviceLabel = settings?.device === "auto" || !devices.includes(settings?.device ?? "") ? "cpu" : settings?.device;

  return (
    <aside className="flex h-full w-[364px] shrink-0 flex-col border-r border-line bg-elev">
      <header className="brand-gradient flex items-center gap-3 border-b border-line px-5 py-4">
        <Logo size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold tracking-tight">Resona</div>
          <div className="text-[11px] text-ink-3">AI audio restoration · v{appInfo?.version ?? "0.1.0"}</div>
        </div>
        <IconButton label="Settings" onClick={() => openSettings("general")}>
          <Settings size={19} strokeWidth={1.9} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        <Section step={1} title="Preset">
          <div className="grid grid-cols-2 gap-2">
            {PRESET_ORDER.map((id) => {
              const def = id === "custom" ? null : PRESETS[id];
              const active = preset === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPreset(id)}
                  className={cx(
                    "group flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all",
                    active
                      ? "border-accent/60 bg-accent-soft shadow-[0_0_0_1px_var(--accent-soft)]"
                      : "border-line hover:border-line-strong hover:bg-panel-2",
                  )}
                >
                  <span className={cx("flex items-center gap-1.5 text-[13px] font-semibold", active ? "text-brand" : "text-ink")}>
                    {PRESET_ICONS[id]}
                    {def?.name ?? "Custom"}
                  </span>
                  <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">
                    {def?.tagline ?? "Your own combination of stages"}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section step={2} title="Processing" aside={preset === "custom" ? <Badge>Custom</Badge> : null}>
          <div className="space-y-2.5">
            <Stage
              title="Repair clipping"
              kind="DSP"
              hint="Rebuilds flattened peaks with AR interpolation. Skipped automatically when no clipping is found."
              enabled={stages.declip.enabled}
              onToggle={(v) => updateStage("declip", { enabled: v })}
            />
            <Stage
              title="Noise reduction"
              kind={stages.denoise.engine === "dfn" ? "AI" : "DSP"}
              hint={
                stages.denoise.engine === "dfn"
                  ? "DeepFilterNet3 neural denoiser — best for speech and vocals."
                  : "Music-safe spectral de-hiss with a gain floor; protects instruments."
              }
              enabled={stages.denoise.enabled}
              onToggle={(v) => updateStage("denoise", { enabled: v })}
            >
              <Segmented
                label="Noise reduction engine"
                size="sm"
                value={stages.denoise.engine}
                onChange={(v) => updateStage("denoise", { engine: v })}
                options={[
                  { value: "spectral", label: "Music-safe", title: "Spectral de-hiss (DSP)" },
                  { value: "dfn", label: "AI · DeepFilterNet3", title: "Neural speech/vocal denoiser" },
                ]}
              />
              <Slider
                label="Strength"
                min={0.05}
                max={1}
                step={0.05}
                value={stages.denoise.strength}
                onChange={(v) => updateStage("denoise", { strength: v })}
                format={(v) =>
                  stages.denoise.engine === "dfn" && v >= 0.99 ? "Max" : `${Math.round(v * 100)}%`
                }
              />
            </Stage>
            <Stage
              title="Vocal clarity"
              kind="AI"
              hint="Isolates the centre vocal with DeepFilterNet3 and lifts it — instruments are never removed."
              enabled={stages.vocal.enabled}
              onToggle={(v) => updateStage("vocal", { enabled: v })}
            >
              <Slider
                label="Vocal lift"
                min={0.5}
                max={6}
                step={0.5}
                value={stages.vocal.amountDb}
                onChange={(v) => updateStage("vocal", { amountDb: v })}
                format={(v) => `+${v.toFixed(1)} dB`}
              />
            </Stage>
            <Stage
              title="Bandwidth extension"
              kind="DSP"
              hint="Detects codec/low-rate cut-offs and synthesises the missing top octave. Estimates, not recovered data."
              enabled={stages.bandwidth.enabled}
              onToggle={(v) => updateStage("bandwidth", { enabled: v })}
            >
              <Slider
                label="Intensity"
                min={0.1}
                max={1}
                step={0.05}
                value={stages.bandwidth.strength}
                onChange={(v) => updateStage("bandwidth", { strength: v })}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </Stage>
          </div>
        </Section>

        <Section step={3} title="Output">
          {settings && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Select
                  label="Format"
                  className="min-w-0 flex-1"
                  value={settings.format}
                  onChange={(v) => updateSettings({ format: v })}
                  options={FORMATS.map((f) => ({
                    value: f.value,
                    label: f.ffmpeg && !hasFfmpeg ? `${f.label} — needs FFmpeg` : f.label,
                    disabled: f.ffmpeg && !hasFfmpeg,
                  }))}
                />
                {format.lossless && format.value !== "alac" ? (
                  <Select
                    label="Bit depth"
                    className="w-[108px]"
                    value={settings.bitDepth}
                    onChange={(v) => updateSettings({ bitDepth: v })}
                    options={[
                      { value: 16, label: "16-bit" },
                      { value: 24, label: "24-bit" },
                      ...(format.value === "flac" ? [] : [{ value: 32 as const, label: "32-bit float" }]),
                    ]}
                  />
                ) : format.value === "alac" ? null : (
                  <Select
                    label="Bitrate"
                    className="w-[108px]"
                    value={settings.bitrateKbps}
                    onChange={(v) => updateSettings({ bitrateKbps: v })}
                    options={[128, 192, 256, 320].map((k) => ({ value: k, label: `${k} kbps` }))}
                  />
                )}
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 py-1 pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={outputDir}>
                  {outputDir || "Choose a folder"}
                </span>
                <IconButton label="Show output folder" onClick={() => outputDir && void revealItemInDir(outputDir).catch(() => undefined)}>
                  <FolderOpen size={15} />
                </IconButton>
                <Button size="sm" variant="ghost" onClick={pickFolder}>
                  Change
                </Button>
              </div>
            </div>
          )}
        </Section>
      </div>

      <footer className="space-y-3 border-t border-line p-5">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!selected || !!selectedBusy || !hasAnyStage(stages) || !engineInfo}
          onClick={() => selected && enhance([selected.id])}
        >
          <Wand2 size={18} />
          {selectedBusy ? "Enhancing…" : "Enhance"}
        </Button>
        {pending.length > 1 && (
          <Button className="w-full" disabled={!engineInfo || !hasAnyStage(stages)} onClick={() => enhance(pending.map((f) => f.id))}>
            <Sparkles size={15} />
            Enhance all ({pending.length})
          </Button>
        )}
        <button
          type="button"
          onClick={() => openSettings("engine")}
          className="flex w-full items-center gap-2 rounded-lg px-1 text-left text-xs text-ink-3 transition-colors hover:text-ink"
        >
          <span
            className={cx(
              "h-2 w-2 shrink-0 rounded-full",
              engineInfo ? "bg-ok" : setup.running ? "animate-pulse bg-warn" : "bg-danger",
            )}
          />
          <Cpu size={13} />
          <span className="truncate">
            {engineInfo
              ? `AI engine ready · ${(deviceLabel ?? "cpu").toUpperCase()}`
              : setup.running
                ? `Setting up AI engine… ${setup.title}`
                : engineError && appInfo?.python
                  ? "AI engine error — open settings"
                  : "AI engine not installed — set up"}
          </span>
        </button>
      </footer>
    </aside>
  );
}
