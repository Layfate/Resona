import { create } from "zustand";
import { api, errorCode, errorMessage, events, isTauri, type JobRequest } from "./lib/api";
import { basename } from "./lib/format";
import { PRESETS, cloneStages, requiredModels } from "./lib/presets";
import { applyThemeTokens, resolveTheme } from "./lib/themes";
import type { Analysis, AppInfo, EngineEvent, EngineInfo, Job, PresetId, Settings, Stages } from "./lib/types";

export interface FileItem {
  id: string;
  path: string;
  name: string;
  analysis?: Analysis;
  analyzing: boolean;
  analysisError?: string;
  jobId?: string;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  title: string;
  detail?: string;
}

interface EngineSetupState {
  running: boolean;
  step: number;
  steps: number;
  title: string;
  log: string[];
  error: string | null;
}

interface State {
  ready: boolean;
  appInfo: AppInfo | null;
  engineInfo: EngineInfo | null;
  engineError: string | null;
  engineLoading: boolean;
  setup: EngineSetupState;
  settings: Settings | null;
  outputDir: string;
  files: FileItem[];
  selectedId: string | null;
  jobs: Record<string, Job>;
  preset: PresetId;
  stages: Stages;
  modelProgress: Record<string, number>;
  settingsOpen: boolean;
  settingsTab: string;
  toasts: Toast[];

  init: () => Promise<void>;
  refreshEngine: (refresh?: boolean) => Promise<void>;
  installEngine: (variant: string) => Promise<void>;
  installModel: (id: string) => Promise<boolean>;
  addFiles: (paths: string[]) => Promise<void>;
  removeFile: (id: string) => void;
  clearFiles: () => void;
  select: (id: string | null) => void;
  setPreset: (id: PresetId) => void;
  updateStage: <K extends keyof Stages>(key: K, patch: Partial<Stages[K]>) => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setOutputDir: (dir: string) => Promise<void>;
  enhance: (fileIds: string[]) => Promise<void>;
  cancelFile: (id: string) => Promise<void>;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
let fileSeq = 1;
const analysisQueue: string[] = [];
let analysisRunning = 0;

function applyTheme(theme: Settings["theme"] | undefined) {
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  applyThemeTokens(resolveTheme(theme, prefersLight));
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  appInfo: null,
  engineInfo: null,
  engineError: null,
  engineLoading: false,
  setup: { running: false, step: 0, steps: 4, title: "", log: [], error: null },
  settings: null,
  outputDir: "",
  files: [],
  selectedId: null,
  jobs: {},
  preset: "music",
  stages: cloneStages(PRESETS.music.stages),
  modelProgress: {},
  settingsOpen: false,
  settingsTab: "general",
  toasts: [],

  async init() {
    if (!isTauri()) {
      set({ ready: true, engineError: "Resona must run inside the desktop app." });
      return;
    }
    const [appInfo, settings, outputDir, jobs] = await Promise.all([
      api.appInfo(),
      api.getSettings(),
      api.defaultOutputDir(),
      api.listJobs(),
    ]);
    applyTheme(settings.theme);
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(get().settings?.theme));
    set({
      appInfo,
      settings,
      outputDir,
      jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
      ready: true,
      setup: { ...get().setup, running: appInfo.engineInstalling },
    });

    void events.onJobUpdate((job) => {
      const prev = get().jobs[job.id];
      set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
      if (prev && prev.status !== job.status) {
        const name = basename(job.input);
        if (job.status === "done") get().toast({ kind: "success", title: "Enhanced", detail: name });
        if (job.status === "failed") get().toast({ kind: "error", title: `Failed: ${name}`, detail: job.error?.message });
      }
    });
    void events.onEngineProgress((ev: EngineEvent) => {
      set((s) => ({
        setup: {
          running: !ev.done,
          step: ev.step,
          steps: ev.steps,
          title: ev.title,
          log: ev.line ? [...s.setup.log.slice(-200), ev.line] : s.setup.log,
          error: ev.error,
        },
      }));
    });
    void events.onModelProgress(({ id, progress }) => set((s) => ({ modelProgress: { ...s.modelProgress, [id]: progress } })));

    if (appInfo.python) await get().refreshEngine(false);
  },

  async refreshEngine(refresh = true) {
    set({ engineLoading: true });
    try {
      const [appInfo, engineInfo] = await Promise.all([api.appInfo(), api.engineInfo(refresh)]);
      set({ appInfo, engineInfo, engineError: null });
    } catch (e) {
      const appInfo = await api.appInfo().catch(() => get().appInfo);
      set({ appInfo, engineInfo: null, engineError: errorMessage(e) });
    } finally {
      set({ engineLoading: false });
    }
  },

  async installEngine(variant) {
    set({ setup: { running: true, step: 0, steps: 4, title: "Preparing", log: [], error: null } });
    try {
      await api.installEngine(variant);
      await get().refreshEngine(true);
      get().toast({ kind: "success", title: "AI engine ready", detail: `Installed the ${variant.toUpperCase()} engine.` });
      // DeepFilterNet3 is small (8 MB) and powers the AI stages; fetch it right away.
      const dfn = get().engineInfo?.models.find((m) => m.id === "deepfilternet3");
      if (dfn && !dfn.installed) await get().installModel("deepfilternet3");
    } catch (e) {
      if (errorCode(e) !== "cancelled") get().toast({ kind: "error", title: "Engine setup failed", detail: errorMessage(e) });
      set((s) => ({ setup: { ...s.setup, running: false, error: errorMessage(e) } }));
    }
  },

  async installModel(id) {
    set((s) => ({ modelProgress: { ...s.modelProgress, [id]: 0 } }));
    try {
      await api.modelAction("install", id);
      await get().refreshEngine(true);
      get().toast({ kind: "success", title: "Model installed", detail: "Downloaded and verified (SHA-256)." });
      return true;
    } catch (e) {
      get().toast({ kind: "error", title: "Model download failed", detail: errorMessage(e) });
      return false;
    } finally {
      set((s) => {
        const mp = { ...s.modelProgress };
        delete mp[id];
        return { modelProgress: mp };
      });
    }
  },

  async addFiles(paths) {
    if (!paths.length) return;
    let expanded: string[];
    try {
      expanded = await api.expandAudioPaths(paths);
    } catch (e) {
      get().toast({ kind: "error", title: "Could not read files", detail: errorMessage(e) });
      return;
    }
    if (!expanded.length) {
      get().toast({ kind: "info", title: "No supported audio files found" });
      return;
    }
    const existing = new Set(get().files.map((f) => f.path));
    const fresh: FileItem[] = expanded
      .filter((p) => !existing.has(p))
      .map((p) => ({ id: `f${fileSeq++}`, path: p, name: basename(p), analyzing: false }));
    if (!fresh.length) return;
    await api.allowFiles(fresh.map((f) => f.path)).catch(() => undefined);
    set((s) => ({ files: [...s.files, ...fresh], selectedId: s.selectedId ?? fresh[0].id }));
    if (!get().engineInfo) return;
    analysisQueue.push(...fresh.map((f) => f.id));
    pumpAnalysis();
  },

  removeFile(id) {
    set((s) => {
      const files = s.files.filter((f) => f.id !== id);
      const selectedId = s.selectedId === id ? (files[0]?.id ?? null) : s.selectedId;
      return { files, selectedId };
    });
  },

  clearFiles() {
    const busy = new Set(
      Object.values(get().jobs)
        .filter((j) => j.status === "queued" || j.status === "running")
        .map((j) => j.id),
    );
    set((s) => {
      const files = s.files.filter((f) => f.jobId && busy.has(f.jobId));
      return { files, selectedId: files[0]?.id ?? null };
    });
  },

  select(id) {
    set({ selectedId: id });
  },

  setPreset(id) {
    if (id === "custom") {
      set({ preset: "custom" });
      return;
    }
    set({ preset: id, stages: cloneStages(PRESETS[id].stages) });
  },

  updateStage(key, patch) {
    set((s) => ({ preset: "custom", stages: { ...s.stages, [key]: { ...s.stages[key], ...patch } } }));
  },

  async updateSettings(patch) {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ settings: next });
    if ("theme" in patch) applyTheme(next.theme);
    try {
      const saved = await api.saveSettings(next);
      set({ settings: saved });
      if ("pythonPath" in patch || "ffmpegPath" in patch) await get().refreshEngine(true);
    } catch (e) {
      get().toast({ kind: "error", title: "Could not save settings", detail: errorMessage(e) });
    }
  },

  async setOutputDir(dir) {
    set({ outputDir: dir });
    await get().updateSettings({ outputDir: dir });
  },

  async enhance(fileIds) {
    const { settings, stages, preset, outputDir, engineInfo } = get();
    if (!settings) return;
    if (!engineInfo) {
      get().openSettings("engine");
      return;
    }
    for (const model of requiredModels(stages)) {
      const info = engineInfo.models.find((m) => m.id === model);
      if (info && !info.installed) {
        get().toast({ kind: "info", title: `Downloading ${info.name}`, detail: "Required by the selected processing." });
        if (!(await get().installModel(model))) return;
      }
    }
    const files = get().files.filter((f) => fileIds.includes(f.id));
    if (!files.length) return;
    const spec = {
      preset,
      stages,
      format: settings.format,
      bitDepth: settings.bitDepth,
      bitrateKbps: settings.bitrateKbps,
      sampleRate: settings.sampleRate,
      device: settings.device,
      threads: settings.threads,
      chunkSeconds: settings.chunkSeconds,
      loudness: { mode: settings.loudnessMode, targetLufs: settings.targetLufs, truePeakDb: settings.truePeakDb },
    };
    const requests: JobRequest[] = files.map((f) => ({ input: f.path, outputDir, spec }));
    try {
      const jobs = await api.enqueueJobs(requests);
      set((s) => ({
        // Events may already have delivered newer states for these jobs; never overwrite them.
        jobs: { ...Object.fromEntries(jobs.map((j) => [j.id, j])), ...s.jobs },
        files: s.files.map((f) => {
          const idx = files.findIndex((x) => x.id === f.id);
          return idx >= 0 ? { ...f, jobId: jobs[idx]?.id } : f;
        }),
      }));
    } catch (e) {
      get().toast({ kind: "error", title: "Could not start processing", detail: errorMessage(e) });
    }
  },

  async cancelFile(id) {
    const f = get().files.find((x) => x.id === id);
    if (f?.jobId) await api.cancelJob(f.jobId);
  },

  openSettings(tab = "general") {
    set({ settingsOpen: true, settingsTab: tab });
  },
  closeSettings() {
    set({ settingsOpen: false });
  },

  toast(t) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === "error" ? 9000 : 4500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Analyse imported files two at a time (each analysis is a worker process). */
function pumpAnalysis() {
  const { getState, setState } = useStore;
  while (analysisRunning < 2 && analysisQueue.length) {
    const id = analysisQueue.shift()!;
    const file = getState().files.find((f) => f.id === id);
    if (!file) continue;
    analysisRunning++;
    setState((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, analyzing: true, analysisError: undefined } : f)) }));
    api
      .analyze(file.path)
      .then((analysis) => {
        setState((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, analysis, analyzing: false } : f)) }));
      })
      .catch((e) => {
        setState((s) => ({
          files: s.files.map((f) => (f.id === id ? { ...f, analyzing: false, analysisError: errorMessage(e) } : f)),
        }));
      })
      .finally(() => {
        analysisRunning--;
        pumpAnalysis();
      });
  }
}

/** Re-run analysis for files imported before the engine was available. */
export function analyzePending() {
  const files = useStore.getState().files.filter((f) => !f.analysis && !f.analyzing);
  analysisQueue.push(...files.map((f) => f.id));
  pumpAnalysis();
}

export function jobForFile(file: FileItem | undefined, jobs: Record<string, Job>): Job | undefined {
  return file?.jobId ? jobs[file.jobId] : undefined;
}
