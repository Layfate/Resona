import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  Headphones,
  Info,
  LoaderCircle,
  Pause,
  Play,
  Scale,
  SkipBack,
  Square,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, fileUrl } from "../lib/api";
import { abGains, formatBytes, formatDb, formatHz, formatTime, STAGE_LABELS } from "../lib/format";
import { ABPlayer, type Side } from "../lib/player";
import { alpha, useThemeColors } from "../lib/useThemeColors";
import type { Analysis, Job, JobResult } from "../lib/types";
import { jobForFile, useStore, type FileItem } from "../store";
import { SpectrumChart } from "./SpectrumChart";
import { Badge, Button, IconButton, ProgressBar, Segmented, Switch, cx } from "./ui";
import { Waveform, type WaveformHandle } from "./Waveform";

function Card({ title, children, aside, className }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cx("panel p-4", className)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="tabular truncate text-[15px] font-semibold text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Diagnosis({ analysis }: { analysis: Analysis }) {
  const items: Array<{ tone: "warn" | "ok" | "neutral"; text: string; detail: string }> = [];
  const c = analysis.clipping;
  items.push(
    c.isClipped
      ? { tone: "warn", text: "Clipping detected", detail: `${(c.clippedFraction * 100).toFixed(2)}% of samples in ${c.runs} runs` }
      : {
          tone: "ok",
          text: "No hard clipping detected",
          detail: "Clipping that was later lossy-encoded (e.g. MP3) cannot be detected reliably",
        },
  );
  const bw = analysis.bandwidth;
  items.push(
    bw.bandLimited
      ? {
          tone: "warn",
          text: `Band-limited at ${formatHz(bw.cutoffHz)}`,
          detail: bw.cutoffHz < 12000 ? "Typical of low-bitrate or low-rate audio" : "Typical of lossy compression (e.g. MP3)",
        }
      : { tone: "ok", text: "Full bandwidth", detail: `Content up to ${formatHz(bw.nyquistHz)}` },
  );
  const nf = analysis.noiseFloorDb;
  if (nf !== null && Number.isFinite(nf)) {
    items.push(
      nf > -55
        ? { tone: "warn", text: "Audible noise floor", detail: `${formatDb(nf, "dBFS")} in quiet passages` }
        : { tone: "ok", text: "Low noise floor", detail: `${formatDb(nf, "dBFS")} in quiet passages` },
    );
  } else {
    items.push({ tone: "neutral", text: "Noise floor not measurable", detail: "No quiet passages to measure it in" });
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.text} className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0" aria-hidden>
            {it.tone === "warn" ? (
              <TriangleAlert size={15} className="text-warn" />
            ) : it.tone === "ok" ? (
              <CircleCheck size={15} className="text-ok" />
            ) : (
              <Info size={15} className="text-ink-3" />
            )}
          </span>
          <div>
            <div className="text-[13.5px] font-medium">
              <span className="sr-only">{it.tone === "warn" ? "Issue: " : it.tone === "ok" ? "OK: " : "Info: "}</span>
              {it.text}
            </div>
            <div className="text-xs text-ink-3">{it.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResultSummary({ result }: { result: JobResult }) {
  const t = result.timings;
  const used = Object.entries(result.stages)
    .filter(([, v]) => (v as { enabled: boolean }).enabled)
    .map(([k]) => k);
  const skipped = Object.entries(result.details)
    .filter(([, v]) => typeof v?.skipped === "string")
    .map(([k, v]) => `${k}: ${v.skipped as string}`);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Loudness" value={formatDb(result.outputLufs, "LUFS")} sub={`in ${formatDb(result.inputLufs, "LUFS")}`} />
        <Stat label="True peak" value={formatDb(result.outputTruePeakDb, "dBTP")} sub={`in ${formatDb(result.inputTruePeakDb, "dBTP")}`} />
        <Stat
          label="Speed"
          value={result.realtimeFactor ? `${result.realtimeFactor.toFixed(1)}× realtime` : "—"}
          sub={`${result.elapsed.toFixed(1)} s · ${result.device.toUpperCase()}`}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {used.map((s) => (
          <Badge key={s} tone={s === "vocal" || (s === "denoise" && result.stages.denoise.engine === "dfn") ? "ai" : "dsp"}>
            {s}
          </Badge>
        ))}
        <Badge>
          {result.sampleRateIn === result.sampleRateOut
            ? `${result.sampleRateOut / 1000} kHz`
            : `${result.sampleRateIn / 1000} → ${result.sampleRateOut / 1000} kHz`}
        </Badge>
        <Badge>
          {result.format.toUpperCase()} · {formatBytes(result.bytes)}
        </Badge>
      </div>
      {(skipped.length > 0 || result.warnings.length > 0) && (
        <ul className="space-y-1 text-xs text-ink-3">
          {skipped.map((s) => (
            <li key={s} className="flex gap-1.5">
              <Info size={13} className="mt-px shrink-0" /> {s}
            </li>
          ))}
          {result.warnings.map((w) => (
            <li key={w} className="flex gap-1.5 text-warn">
              <TriangleAlert size={13} className="mt-px shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs text-ink-3">
        <summary className="cursor-pointer select-none hover:text-ink">Stage timings</summary>
        <div className="tabular mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5">
          {Object.entries(t).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>{k}</span>
              <span>{v.toFixed(2)} s</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function JobStatusBar({ job, onCancel }: { job: Job; onCancel: () => void }) {
  if (job.status === "queued" || job.status === "running") {
    return (
      <div className="panel animate-in flex items-center gap-4 px-4 py-3">
        <LoaderCircle size={18} className="shrink-0 animate-spin text-brand" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between text-[13px]">
            <span className="font-medium">{job.status === "queued" ? "Waiting in queue" : (STAGE_LABELS[job.stage] ?? job.message)}</span>
            <span className="tabular text-ink-3">{Math.round(job.progress * 100)}%</span>
          </div>
          <ProgressBar value={job.progress} indeterminate={job.status === "queued"} />
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <Square size={13} /> Cancel
        </Button>
      </div>
    );
  }
  if (job.status === "failed") {
    return (
      <div className="animate-in flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/8 px-4 py-3 text-[13px]">
        <CircleAlert size={18} className="mt-px shrink-0 text-danger" />
        <div className="selectable min-w-0">
          <div className="font-medium text-danger">Processing failed</div>
          <div className="mt-0.5 text-ink-2">{job.error?.message ?? job.message}</div>
        </div>
      </div>
    );
  }
  return null;
}

export function ComparePanel({ file }: { file: FileItem }) {
  const jobs = useStore((s) => s.jobs);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const cancelFile = useStore((s) => s.cancelFile);
  const toast = useStore((s) => s.toast);
  const job = jobForFile(file, jobs);
  const result = job?.status === "done" ? job.result : null;
  const analysis = file.analysis;

  const colors = useThemeColors({ original: "--series-original", enhanced: "--series-enhanced", idle: "--wave-idle" });
  // Created lazily and only touched from effects / event handlers (never during render).
  const playerRef = useRef<ABPlayer | null>(null);
  const getPlayer = useCallback(() => (playerRef.current ??= new ABPlayer()), []);
  const laneA = useRef<WaveformHandle>(null);
  const laneB = useRef<WaveformHandle>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [chosenSide, setActive] = useState<Side>("a");
  const [aState, setAState] = useState<"loading" | "ready" | "error">("loading");
  // Path of the enhanced file currently loaded into side B (or that failed to load).
  const [bLoaded, setBLoaded] = useState<{ path: string; ok: boolean } | null>(null);
  const [volume, setVolume] = useState(0.9);

  useEffect(() => {
    const p = getPlayer();
    p.onEnded = () => {
      setPlaying(false);
      setTime(0);
      laneA.current?.setTime(0);
      laneB.current?.setTime(0);
    };
    return () => {
      p.dispose();
      playerRef.current = null;
    };
  }, [getPlayer]);

  const duration = analysis?.info.duration ?? result?.durationIn ?? 0;

  // Load the original (this component is keyed by file, so this runs once per file).
  useEffect(() => {
    const p = getPlayer();
    let cancelled = false;
    (async () => {
      try {
        let path = await api.playbackPath(file.path);
        try {
          await p.load("a", fileUrl(path), duration);
        } catch {
          path = await api.playbackPath(file.path, true); // decode via worker to WAV
          await p.load("a", fileUrl(path), duration);
        }
        if (!cancelled) setAState("ready");
      } catch (e) {
        if (!cancelled) {
          setAState("error");
          toast({ kind: "error", title: "Playback unavailable", detail: errorMessage(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  // Load the enhanced output once the job finishes.
  const outputPath = result?.output;
  useEffect(() => {
    const p = getPlayer();
    if (!outputPath) {
      p.unload("b");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let path = await api.playbackPath(outputPath);
        try {
          await p.load("b", fileUrl(path), duration);
        } catch {
          path = await api.playbackPath(outputPath, true);
          await p.load("b", fileUrl(path), duration);
        }
        if (!cancelled) {
          setBLoaded({ path: outputPath, ok: true });
          p.setActive("b");
          setActive("b");
        }
      } catch (e) {
        if (!cancelled) {
          setBLoaded({ path: outputPath, ok: false });
          toast({ kind: "error", title: "Cannot play the enhanced file", detail: errorMessage(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputPath]);

  const loaded = { a: aState === "ready", b: !!outputPath && bLoaded?.path === outputPath && bLoaded.ok };
  const loading = { a: aState === "loading", b: !!outputPath && bLoaded?.path !== outputPath };
  const active: Side = chosenSide === "b" && !loaded.b ? "a" : chosenSide;

  // Loudness-matched comparison.
  const matched = settings?.loudnessMatchedAb ?? true;
  const gains = useMemo(
    () => (matched && result ? abGains(result.inputLufs, result.outputLufs) : { a: 1, b: 1 }),
    [matched, result],
  );
  useEffect(() => {
    getPlayer().setLevels(gains.a, gains.b);
  }, [gains, getPlayer]);
  useEffect(() => {
    getPlayer().setVolume(volume);
  }, [volume, getPlayer]);

  // Animation loop: playhead + time display.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastText = 0;
    const loop = (ts: number) => {
      const p = getPlayer();
      p.tick();
      const t = p.currentTime;
      laneA.current?.setTime(t);
      laneB.current?.setTime(t);
      if (ts - lastText > 100) {
        setTime(t);
        lastText = ts;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, getPlayer]);

  const seek = useCallback((t: number) => {
    const p = getPlayer();
    p.seek(t);
    setTime(t);
    laneA.current?.setTime(t);
    laneB.current?.setTime(t);
  }, [getPlayer]);

  const togglePlay = useCallback(() => {
    const p = getPlayer();
    if (!p.has("a")) return;
    p.toggle();
    setPlaying(p.playing);
  }, [getPlayer]);

  const choose = useCallback((side: Side) => {
    const p = getPlayer();
    if (!p.has(side)) return;
    p.setActive(side);
    setActive(side);
  }, [getPlayer]);

  // Keyboard: Space play/pause, A/1 original, B/2 enhanced, arrows seek.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === " ") {
        e.preventDefault();
        togglePlay();
      } else if (k === "a" || k === "1") choose("a");
      else if (k === "b" || k === "2") choose("b");
      else if (k === "tab" && loaded.b) {
        e.preventDefault();
        choose(getPlayer().active === "a" ? "b" : "a");
      } else if (k === "arrowleft") seek(getPlayer().currentTime - 5);
      else if (k === "arrowright") seek(getPlayer().currentTime + 5);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, choose, seek, loaded.b, getPlayer]);

  const busy = job && (job.status === "queued" || job.status === "running");
  const info = analysis?.info;

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="selectable truncate text-lg font-semibold tracking-tight" title={file.path}>
            {file.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {info ? (
              <>
                <Badge>{info.format}</Badge>
                <Badge>{(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz</Badge>
                <Badge>{info.channels === 1 ? "Mono" : info.channels === 2 ? "Stereo" : `${info.channels} ch`}</Badge>
                <Badge>{formatTime(info.duration)}</Badge>
                {analysis?.loudnessLufs != null && <Badge>{formatDb(analysis.loudnessLufs, "LUFS")}</Badge>}
              </>
            ) : file.analyzing ? (
              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                <LoaderCircle size={13} className="animate-spin" /> Analysing…
              </span>
            ) : file.analysisError ? (
              <span className="text-xs text-danger">{file.analysisError}</span>
            ) : null}
          </div>
        </div>
        {result && (
          <Button size="sm" onClick={() => void revealItemInDir(result.output).catch(() => undefined)}>
            <FolderOpen size={14} /> Show file
          </Button>
        )}
      </div>

      {job && <JobStatusBar job={job} onCancel={() => void cancelFile(file.id)} />}

      {/* Waveforms + transport */}
      <section className="panel overflow-hidden">
        {[
          {
            side: "a" as const,
            label: "Original",
            peaks: analysis?.peaks,
            color: colors.original,
            ready: loaded.a,
            sub: analysis ? formatDb(result?.inputLufs ?? analysis.loudnessLufs, "LUFS") : "",
            ref: laneA,
          },
          {
            side: "b" as const,
            label: "Enhanced",
            peaks: result?.outputPeaks,
            color: colors.enhanced,
            ready: loaded.b,
            sub: result ? formatDb(result.outputLufs, "LUFS") : "",
            ref: laneB,
          },
        ].map((lane) => {
          const isActive = active === lane.side && lane.ready;
          return (
            <div
              key={lane.side}
              className={cx(
                "relative border-b border-line px-5 pb-3.5 pt-3 transition-colors",
                isActive ? "bg-panel-2" : "",
              )}
            >
              {isActive && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: lane.color }} />}
              <div className="mb-1.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={!lane.ready}
                  onClick={() => choose(lane.side)}
                  aria-pressed={isActive}
                  className={cx(
                    "flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[13px] font-semibold transition-colors disabled:cursor-default",
                    isActive ? "text-ink" : "text-ink-2 hover:text-ink",
                  )}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: lane.color }} />
                  {lane.label}
                  <kbd className="rounded border border-line px-1 text-[10px] font-medium text-ink-3">{lane.side.toUpperCase()}</kbd>
                </button>
                {isActive && (
                  <span className="flex items-center gap-1 text-[11px] text-brand">
                    <Headphones size={12} /> listening
                  </span>
                )}
                <span className="tabular ml-auto text-[11px] text-ink-3">{lane.sub}</span>
              </div>
              {lane.peaks && duration > 0 ? (
                <div className={cx("transition-opacity", !isActive && loaded.b && "opacity-60")}>
                  <Waveform
                    ref={lane.ref}
                    peaks={lane.peaks}
                    duration={duration}
                    color={alpha(lane.color, 0.42)}
                    progressColor={lane.color}
                    onSeek={seek}
                  />
                </div>
              ) : (
                <div className="flex h-[96px] items-center justify-center rounded-lg border border-dashed border-line text-[13px] text-ink-3">
                  {lane.side === "a"
                    ? file.analyzing
                      ? "Reading waveform…"
                      : "Waveform appears after analysis"
                    : busy
                      ? "Enhancing…"
                      : "Press Enhance to create the restored version"}
                </div>
              )}
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <IconButton label="Back to start" onClick={() => seek(0)} disabled={!loaded.a}>
            <SkipBack size={16} />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            title="Play / pause (Space)"
            onClick={togglePlay}
            disabled={!loaded.a}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_6px_18px_-6px_var(--accent)] transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
          >
            {loading.a ? (
              <LoaderCircle size={18} className="animate-spin" />
            ) : playing ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" className="translate-x-px" />
            )}
          </button>
          <span className="tabular w-[92px] text-[13px] text-ink-2">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <Segmented
            label="Listen to"
            value={active}
            onChange={choose}
            options={[
              { value: "a", label: "A · Original", title: "Original (A)" },
              { value: "b", label: loading.b ? "B · Loading…" : "B · Enhanced", title: "Enhanced (B)", disabled: !loaded.b },
            ]}
          />
          <label
            className="flex items-center gap-2 text-xs text-ink-2"
            title="Play both versions at the same integrated loudness, so you hear the processing rather than a volume change."
          >
            <Scale size={14} />
            Loudness-matched
            <Switch
              checked={matched}
              onChange={(v) => void updateSettings({ loudnessMatchedAb: v })}
              label="Loudness-matched comparison"
            />
          </label>
          {matched && result && (Math.abs(gains.a - 1) > 0.01 || Math.abs(gains.b - 1) > 0.01) && (
            <span className="tabular text-[11px] text-ink-3">
              ({gains.a < 1 ? `A ${formatDb(20 * Math.log10(gains.a))}` : `B ${formatDb(20 * Math.log10(gains.b))}`})
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Volume2 size={15} className="text-ink-3" />
            <input
              type="range"
              aria-label="Volume"
              className="slider w-24"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              style={{ ["--fill" as string]: `${volume * 100}%` }}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card title="Diagnosis">
          {analysis ? (
            <Diagnosis analysis={analysis} />
          ) : (
            <div className="text-[13px] text-ink-3">{file.analyzing ? "Analysing the recording…" : "No analysis yet."}</div>
          )}
        </Card>
        <Card title={result ? "Result" : "What happens next"}>
          {result ? (
            <ResultSummary result={result} />
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-2">
              Choose a preset and press <span className="font-semibold text-ink">Enhance</span>. Processing runs locally on your
              computer. Loudness is matched to the original and true peaks are kept below{" "}
              {formatDb(settings?.truePeakDb ?? -1, "dBTP")}, so the comparison is fair and nothing clips.
            </p>
          )}
        </Card>
      </div>

      {analysis && (
        <Card title="Average spectrum">
          <SpectrumChart original={result?.inputSpectrum ?? analysis.spectrum} enhanced={result?.outputSpectrum} />
        </Card>
      )}
    </div>
  );
}
