import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { BadgeCheck, Download, ExternalLink, Gauge, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { formatBytes, formatDb } from "../lib/format";
import type { ModelInfo, Settings } from "../lib/types";
import { useStore } from "../store";
import { EngineSetup } from "./EngineSetup";
import { ThemePicker } from "./ThemePicker";
import { Badge, Button, Dialog, Field, ProgressBar, Segmented, Select, Switch, cx } from "./ui";

const TABS = [
  { id: "general", label: "Appearance & output" },
  { id: "processing", label: "Processing" },
  { id: "engine", label: "AI engine" },
  { id: "models", label: "Models" },
  { id: "about", label: "About" },
];

function PathField({
  label,
  hint,
  value,
  placeholder,
  onChange,
  directory,
}: {
  label: string;
  hint?: ReactNode;
  value: string | null;
  placeholder: string;
  onChange: (v: string | null) => void;
  directory?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <span className="max-w-[230px] truncate rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-xs text-ink-2" title={value ?? ""}>
          {value || placeholder}
        </span>
        <Button
          size="sm"
          onClick={async () => {
            const p = await open({ directory: !!directory, multiple: false, title: label });
            if (typeof p === "string") onChange(p);
          }}
        >
          Browse
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Reset
          </Button>
        )}
      </div>
    </Field>
  );
}

function General({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const outputDir = useStore((st) => st.outputDir);
  const setOutputDir = useStore((st) => st.setOutputDir);
  return (
    <div className="divide-y divide-line">
      <div className="pb-4">
        <div className="text-sm font-medium text-ink">Color theme</div>
        <div className="mb-3 mt-0.5 text-xs text-ink-3">Applied instantly. Every theme is checked for readable contrast.</div>
        <ThemePicker value={s.theme} onChange={(id) => set({ theme: id })} />
      </div>
      <PathField label="Output folder" value={outputDir} placeholder="Music/Resona" directory onChange={(v) => v && void setOutputDir(v)} />
      <Field label="File name suffix" hint="Appended to the original name, e.g. song_resona.flac">
        <input
          className="h-9 w-40 rounded-lg border border-line bg-panel-2 px-2.5 text-sm outline-none focus:border-accent"
          value={s.filenameSuffix}
          maxLength={40}
          onChange={(e) => set({ filenameSuffix: e.target.value })}
        />
      </Field>
      <Field label="Overwrite existing outputs" hint="Off: a numbered name is used instead. The input file is never overwritten.">
        <Switch checked={s.overwrite} onChange={(v) => set({ overwrite: v })} label="Overwrite existing outputs" />
      </Field>
    </div>
  );
}

function Processing({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const engineInfo = useStore((st) => st.engineInfo);
  const devices = engineInfo?.devices.onnxDevices ?? ["cpu"];
  const deviceNames: Record<string, string> = {
    auto: "Automatic",
    cpu: "CPU",
    cuda: "NVIDIA CUDA",
    directml: "DirectML (GPU)",
    coreml: "Apple Core ML",
    rocm: "AMD ROCm",
  };
  return (
    <div className="divide-y divide-line">
      <Field
        label="Compute device"
        hint="Used by AI models. DSP stages always run on the CPU. Unavailable devices fall back to CPU automatically."
      >
        <Select
          label="Compute device"
          value={s.device}
          onChange={(v) => set({ device: v })}
          options={["auto", ...devices.filter((d) => d !== "auto")].map((d) => ({ value: d, label: deviceNames[d] ?? d }))}
        />
      </Field>
      <Field label="Output sample rate" hint="Automatic keeps the source rate, or uses 48 kHz when extending low-rate audio.">
        <Select
          label="Output sample rate"
          value={s.sampleRate}
          onChange={(v) => set({ sampleRate: v })}
          options={[
            { value: 0, label: "Automatic" },
            { value: 44100, label: "44.1 kHz" },
            { value: 48000, label: "48 kHz" },
            { value: 88200, label: "88.2 kHz" },
            { value: 96000, label: "96 kHz" },
          ]}
        />
      </Field>
      <Field
        label="Loudness"
        hint="Match keeps the original loudness (recommended). Normalize targets a fixed level. Peaks are always limited."
      >
        <Segmented
          label="Loudness mode"
          value={s.loudnessMode}
          onChange={(v) => set({ loudnessMode: v })}
          options={[
            { value: "match", label: "Match original" },
            { value: "normalize", label: "Normalize" },
            { value: "off", label: "Off" },
          ]}
        />
      </Field>
      {s.loudnessMode === "normalize" && (
        <Field label="Target loudness">
          <Select
            label="Target loudness"
            value={s.targetLufs}
            onChange={(v) => set({ targetLufs: v })}
            options={[-9, -11, -14, -16, -18, -20, -23].map((v) => ({ value: v, label: formatDb(v, "LUFS", 0) }))}
          />
        </Field>
      )}
      <Field label="True-peak ceiling" hint="The limiter keeps inter-sample peaks below this level to prevent clipping.">
        <Select
          label="True-peak ceiling"
          value={s.truePeakDb}
          onChange={(v) => set({ truePeakDb: v })}
          options={[-0.1, -0.5, -1, -1.5, -2].map((v) => ({ value: v, label: formatDb(v, "dBTP") }))}
        />
      </Field>
      <Field label="Files processed in parallel" hint="Keep at 1 when using a GPU.">
        <Select
          label="Parallel files"
          value={s.concurrency}
          onChange={(v) => set({ concurrency: v })}
          options={[1, 2, 3, 4].map((v) => ({ value: v, label: String(v) }))}
        />
      </Field>
      <Field label="Chunk length" hint="Long files are processed in overlapping chunks. Shorter chunks use less memory.">
        <Select
          label="Chunk length"
          value={s.chunkSeconds}
          onChange={(v) => set({ chunkSeconds: v })}
          options={[10, 20, 30, 60].map((v) => ({ value: v, label: `${v} s` }))}
        />
      </Field>
      <Field label="CPU threads for AI" hint="0 lets ONNX Runtime decide.">
        <Select
          label="CPU threads"
          value={s.threads}
          onChange={(v) => set({ threads: v })}
          options={[0, 1, 2, 4, 8, 16].map((v) => ({ value: v, label: v === 0 ? "Automatic" : String(v) }))}
        />
      </Field>
    </div>
  );
}

function Engine({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const { appInfo, engineInfo, engineLoading, refreshEngine, toast } = useStore();
  const [removing, setRemoving] = useState(false);
  return (
    <div className="space-y-5">
      {engineInfo && (
        <div className="rounded-xl border border-line bg-panel-2 p-4 text-[13px]">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <BadgeCheck size={16} className="text-ok" /> Engine ready
            <Button size="sm" variant="ghost" className="ml-auto" disabled={engineLoading} onClick={() => void refreshEngine(true)}>
              <RefreshCw size={13} className={cx(engineLoading && "animate-spin")} /> Re-check
            </Button>
          </div>
          <dl className="selectable grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">Variant</dt>
            <dd>{appInfo?.engine?.variant ?? (appInfo?.python?.source === "dev" ? "development environment" : "custom interpreter")}</dd>
            <dt className="text-ink-3">Python</dt>
            <dd className="truncate">
              {engineInfo.python} · {engineInfo.executable}
            </dd>
            <dt className="text-ink-3">ONNX Runtime</dt>
            <dd>{engineInfo.devices.onnxruntime ?? "not installed"}</dd>
            <dt className="text-ink-3">Compute devices</dt>
            <dd>{engineInfo.devices.onnxDevices.join(", ") || "none"}</dd>
            <dt className="text-ink-3">FFmpeg</dt>
            <dd className="truncate">{engineInfo.ffmpeg.version ?? "not found (MP3/WAV/FLAC/OGG/Opus/AIFF still work)"}</dd>
          </dl>
        </div>
      )}
      <EngineSetup />
      <div className="divide-y divide-line border-t border-line">
        <PathField
          label="FFmpeg binary"
          hint="Optional. Enables AAC/ALAC export and decoding of formats like M4A or WMA. Auto-detected on PATH."
          value={s.ffmpegPath}
          placeholder="Auto-detect"
          onChange={(v) => set({ ffmpegPath: v })}
        />
        <PathField
          label="Custom Python interpreter"
          hint="Advanced: use your own environment instead of the managed engine (needs numpy, scipy, soundfile, onnxruntime)."
          value={s.pythonPath}
          placeholder="Managed engine"
          onChange={(v) => set({ pythonPath: v })}
        />
        {appInfo?.engine && (
          <Field label="Remove engine" hint="Deletes the managed runtime. Models and settings are kept.">
            <Button
              size="sm"
              variant="danger"
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                try {
                  await api.removeEngine();
                  await refreshEngine(true);
                } catch (e) {
                  toast({ kind: "error", title: "Could not remove engine", detail: errorMessage(e) });
                } finally {
                  setRemoving(false);
                }
              }}
            >
              <Trash2 size={13} /> Remove
            </Button>
          </Field>
        )}
      </div>
    </div>
  );
}

function ModelRow({ m }: { m: ModelInfo }) {
  const { modelProgress, installModel, refreshEngine, toast } = useStore();
  const progress = modelProgress[m.id];
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      await api.modelAction("verify", m.id);
      toast({ kind: "success", title: `${m.name} verified`, detail: "All files match their SHA-256 checksums." });
    } catch (e) {
      toast({ kind: "error", title: "Verification failed", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold">{m.name}</span>
            <Badge tone="ai">{m.engine.toUpperCase()}</Badge>
            {m.experimental && <Badge tone="warn">Experimental</Badge>}
            {m.installed ? <Badge tone="ok">Installed</Badge> : <Badge>Not installed</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-ink-3">
            v{m.version} · {formatBytes(m.size)} · {m.sample_rate / 1000} kHz · {m.license}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {m.installed ? (
            <>
              <Button size="sm" disabled={busy} onClick={verify}>
                {busy ? <LoaderCircle size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verify
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api.modelAction("remove", m.id).catch(() => undefined);
                  await refreshEngine(true);
                }}
              >
                <Trash2 size={13} />
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={progress !== undefined} onClick={() => void installModel(m.id)}>
              <Download size={13} /> Download
            </Button>
          )}
        </div>
      </div>
      {progress !== undefined && <ProgressBar value={progress} className="mt-3" />}
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{m.description}</p>
      <p className="mt-2 rounded-lg bg-warn/8 px-3 py-2 text-xs leading-relaxed text-ink-2">
        <span className="font-semibold text-warn">Limitations: </span>
        {m.limitations}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => void openUrl(m.source)}>
          <ExternalLink size={12} /> Source
        </button>
        <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => void openUrl(m.license_url)}>
          <ExternalLink size={12} /> License
        </button>
        <span className="selectable">{m.paper}</span>
      </div>
      <div className="selectable mt-2 truncate font-mono text-[10.5px] text-ink-3" title={m.sha256}>
        sha256 {m.sha256}
      </div>
    </div>
  );
}

function Models() {
  const engineInfo = useStore((s) => s.engineInfo);
  if (!engineInfo) return <p className="text-[13px] text-ink-3">Install the AI engine first.</p>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-3">
        Models are downloaded from pinned, immutable URLs and verified with SHA-256 before use. They are stored in{" "}
        <span className="selectable text-ink-2">{engineInfo.modelsDir}</span>.
      </p>
      {engineInfo.models.map((m) => (
        <ModelRow key={m.id} m={m} />
      ))}
      <div className="rounded-xl border border-dashed border-line p-4 text-xs leading-relaxed text-ink-3">
        <div className="mb-1 font-semibold text-ink-2">Planned</div>
        Neural music super-resolution (e.g. AudioSR, Apollo) and stem-aware vocal enhancement (Demucs) are on the roadmap as
        optional PyTorch-based models. They are not part of this release.
      </div>
    </div>
  );
}

function About() {
  const { appInfo, toast } = useStore();
  const [bench, setBench] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  return (
    <div className="space-y-4 text-[13px] leading-relaxed text-ink-2">
      <div>
        <div className="text-[15px] font-semibold text-ink">Resona {appInfo?.version}</div>
        <p>Free and open-source (MIT) AI audio restoration. Everything runs locally — no account, no cloud.</p>
      </div>
      <div className="rounded-xl border border-line p-4">
        <div className="mb-1 font-semibold text-ink">Honest limits</div>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          <li>No tool can recover information that lossy compression or clipping destroyed; Resona estimates plausible content.</li>
          <li>Bandwidth extension is DSP-based (spectral band replication), not a neural super-resolution model.</li>
          <li>DeepFilterNet3 is trained on speech: use it for vocals/speech, or the music-safe denoiser for full mixes.</li>
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => appInfo && void revealItemInDir(appInfo.paths.logs).catch(() => undefined)}>
          Open logs
        </Button>
        <Button size="sm" onClick={() => void openUrl("https://github.com/Layfate/Resona")}>
          <ExternalLink size={13} /> GitHub
        </Button>
        <Button
          size="sm"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              setBench(await api.runBenchmark(30));
            } catch (e) {
              toast({ kind: "error", title: "Benchmark failed", detail: errorMessage(e) });
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? <LoaderCircle size={13} className="animate-spin" /> : <Gauge size={13} />} Run benchmark
        </Button>
      </div>
      {bench && (
        <table className="tabular w-full text-xs">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 text-left font-medium">Stage (30 s stereo)</th>
              <th className="py-1 text-right font-medium">Time</th>
              <th className="py-1 text-right font-medium">Speed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries((bench.stages ?? {}) as Record<string, { seconds: number; realtime: number }>).map(([k, v]) => (
              <tr key={k} className="border-t border-line">
                <td className="py-1">{k}</td>
                <td className="py-1 text-right">{v.seconds.toFixed(2)} s</td>
                <td className="py-1 text-right">{v.realtime}× realtime</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { settingsOpen, closeSettings, settingsTab, settings, updateSettings } = useStore();
  const [tab, setTab] = useState(settingsTab);
  const [lastOpenTab, setLastOpenTab] = useState(settingsTab);
  if (settingsTab !== lastOpenTab) {
    setLastOpenTab(settingsTab);
    setTab(settingsTab);
  }
  if (!settings) return null;
  const set = (p: Partial<Settings>) => void updateSettings(p);
  return (
    <Dialog open={settingsOpen} onClose={closeSettings} title="Settings" wide>
      <div className="flex min-h-[520px]">
        <nav className="w-44 shrink-0 border-r border-line p-2" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id}
              className={cx(
                "mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                tab === t.id ? "bg-accent-soft font-medium text-brand" : "text-ink-2 hover:bg-panel-2 hover:text-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto px-6 py-4">
          {tab === "general" && <General s={settings} set={set} />}
          {tab === "processing" && <Processing s={settings} set={set} />}
          {tab === "engine" && <Engine s={settings} set={set} />}
          {tab === "models" && <Models />}
          {tab === "about" && <About />}
        </div>
      </div>
    </Dialog>
  );
}
