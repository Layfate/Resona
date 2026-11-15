/**
 * Browser-only preview mode (development). Replaces the Tauri backend with
 * fixtures recorded from the real worker so the UI can be developed and
 * screenshotted without the desktop shell:
 *
 *   RESONA_DEMO_DIR=<folder with degraded.mp3 and degraded_resona.flac>
 *   VITE_RESONA_MOCK=1 npm run dev   ->   http://localhost:1420/?scenario=done
 *
 * Scenarios: empty | loaded | processing | done | settings | models
 * Optional: &theme=<theme id>
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import analysis from "./fixtures/analysis.json";
import result from "./fixtures/result.json";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "empty";
const DEMO = "/__demo/degraded.mp3";

const settings: Record<string, unknown> = {
  theme: params.get("theme") ?? "solarized-dark",
  device: "auto",
  threads: 0,
  concurrency: 1,
  outputDir: "C:\\Users\\you\\Music\\Resona",
  format: "flac",
  bitDepth: 24,
  bitrateKbps: 320,
  sampleRate: 0,
  loudnessMode: "match",
  targetLufs: -14,
  truePeakDb: -1,
  chunkSeconds: 20,
  filenameSuffix: "_resona",
  overwrite: false,
  loudnessMatchedAb: true,
  pythonPath: null,
  ffmpegPath: null,
};

const model = {
  id: "deepfilternet3",
  name: "DeepFilterNet3",
  version: "3.0 (2023-05-23)",
  tasks: ["denoise", "vocal"],
  engine: "onnx",
  license: "MIT OR Apache-2.0",
  license_url: "https://github.com/Rikorose/DeepFilterNet#license",
  source: "https://github.com/Rikorose/DeepFilterNet",
  paper: "Schröter et al., Interspeech 2023",
  url: "https://github.com/Rikorose/DeepFilterNet/raw/84d57ec2c08fe08e68a13fb32a58cd7092060a0f/models/DeepFilterNet3_onnx.tar.gz",
  sha256: "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616",
  size: 7983136,
  sample_rate: 48000,
  description:
    "Full-band (48 kHz) neural noise suppression using ERB-band gains plus deep filtering. Removes background noise, hiss, hum and room noise from speech and vocals in real time.",
  limitations:
    "Trained on speech. On full mixes it treats much of the instrumentation as noise, so Resona uses it with an attenuation limit for music, or to isolate vocals for clarity enhancement.",
  experimental: false,
  installed: true,
  verified: true,
  path: "C:\\Users\\you\\AppData\\Roaming\\io.github.resona\\models\\deepfilternet3",
};

const engineInfo = {
  version: "0.1.0",
  protocol: 1,
  python: "3.12.10",
  executable: "C:\\Users\\you\\AppData\\Roaming\\io.github.resona\\engine\\venv\\Scripts\\python.exe",
  devices: {
    platform: "Windows-11",
    machine: "AMD64",
    python: "3.12.10",
    cpuCount: 16,
    onnxruntime: "1.32.0",
    onnxDevices: ["cpu"],
    torch: null,
  },
  ffmpeg: { path: null, version: null },
  formats: {},
  models: [model],
  modelsDir: "C:\\Users\\you\\AppData\\Roaming\\io.github.resona\\models",
};

function job(status: string, progress: number, stage: string) {
  return {
    id: "job-1",
    input: DEMO,
    output: result.output,
    status,
    progress,
    stage,
    message: stage,
    error: null,
    result: status === "done" ? result : null,
    spec: {},
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

export function installMocks() {
  mockWindows("main");
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "app_info":
          return {
            version: "0.1.0",
            platform: "windows",
            arch: "x86_64",
            paths: { appData: "", config: "", cache: "", logs: "", models: "", engine: "", previews: "", worker: "" },
            python: { path: engineInfo.executable, source: "engine" },
            engine: { variant: "cpu", uvVersion: "0.12.19", pythonVersion: "3.12", installedAt: "", appVersion: "0.1.0" },
            engineInstalling: false,
            nvidiaGpu: true,
            variants: ["cpu", "cuda", "directml"],
            recommendedVariant: "cpu",
            audioExtensions: ["wav", "flac", "mp3", "ogg", "opus", "m4a", "aac", "aiff", "wma"],
          };
        case "get_settings":
          return settings;
        case "save_settings":
          Object.assign(settings, a.settings as object);
          return settings;
        case "default_output_dir":
          return settings.outputDir;
        case "list_jobs":
          return [];
        case "engine_info":
          return engineInfo;
        case "expand_audio_paths":
          return a.paths;
        case "analyze_file":
          await new Promise((r) => setTimeout(r, 150));
          return analysis;
        case "playback_path":
          return a.path;
        case "enqueue_jobs": {
          const final = scenario === "processing" ? job("running", 0.46, "process") : job("done", 1, "done");
          setTimeout(() => void emit("jobs://update", final), 300);
          return [job("queued", 0, "queued")];
        }
        case "model_action":
          return { models: [model], model };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

interface ScenarioStore {
  getState: () => {
    addFiles: (p: string[]) => Promise<void>;
    enhance: (ids: string[]) => Promise<void>;
    openSettings: (t?: string) => void;
    files: { id: string }[];
  };
}

/** Drive the UI into the requested scenario once the store is ready. */
export async function runScenario(store: ScenarioStore) {
  const s = store.getState;
  if (scenario === "settings") s().openSettings("general");
  if (scenario === "models") s().openSettings("models");
  if (["loaded", "processing", "done"].includes(scenario)) {
    await s().addFiles([DEMO]);
    if (scenario !== "loaded") {
      await new Promise((r) => setTimeout(r, 400));
      await s().enhance([s().files[0].id]);
    }
  }
}
