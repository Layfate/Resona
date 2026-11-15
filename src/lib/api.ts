// Typed wrappers around the Tauri commands exposed by src-tauri/src/commands.rs.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  Analysis,
  BackendError,
  EngineEvent,
  EngineInfo,
  EngineManifest,
  Job,
  ModelInfo,
  Settings,
} from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as BackendError).message);
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as BackendError).code);
  return undefined;
}

export interface JobRequest {
  input: string;
  outputDir: string;
  outputStem?: string;
  spec: Record<string, unknown>;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  engineInfo: (refresh = false) => invoke<EngineInfo>("engine_info", { refresh }),
  installEngine: (variant: string) => invoke<EngineManifest>("install_engine", { variant }),
  cancelEngineInstall: () => invoke<void>("cancel_engine_install"),
  removeEngine: () => invoke<void>("remove_engine"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  modelAction: (action: "list" | "install" | "verify" | "remove", id?: string) =>
    invoke<{ models?: ModelInfo[]; model?: ModelInfo }>("model_action", { action, id }),
  analyze: (path: string) => invoke<Analysis>("analyze_file", { path }),
  playbackPath: (path: string, force = false) => invoke<string>("playback_path", { path, force }),
  allowFiles: (paths: string[]) => invoke<void>("allow_files", { paths }),
  expandAudioPaths: (paths: string[]) => invoke<string[]>("expand_audio_paths", { paths }),
  defaultOutputDir: () => invoke<string>("default_output_dir"),
  enqueueJobs: (requests: JobRequest[]) => invoke<Job[]>("enqueue_jobs", { requests }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  cancelJob: (id: string) => invoke<boolean>("cancel_job", { id }),
  cancelAllJobs: () => invoke<void>("cancel_all_jobs"),
  clearJobs: (id?: string) => invoke<void>("clear_jobs", { id }),
  runBenchmark: (seconds = 30) => invoke<Record<string, unknown>>("run_benchmark", { seconds }),
};

export const events = {
  onJobUpdate: (cb: (job: Job) => void): Promise<UnlistenFn> => listen<Job>("jobs://update", (e) => cb(e.payload)),
  onEngineProgress: (cb: (ev: EngineEvent) => void): Promise<UnlistenFn> =>
    listen<EngineEvent>("engine://progress", (e) => cb(e.payload)),
  onModelProgress: (cb: (ev: { id: string; progress: number }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; progress: number }>("models://progress", (e) => cb(e.payload)),
};

export const fileUrl = (path: string) =>
  import.meta.env.DEV && import.meta.env.VITE_RESONA_MOCK === "1" ? path : convertFileSrc(path);
