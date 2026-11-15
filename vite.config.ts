import { createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/** Dev-only: serve demo audio for the browser preview mode (src/dev/mock.ts). */
function demoAudio(): Plugin {
  const dir = process.env.RESONA_DEMO_DIR;
  return {
    name: "resona-demo-audio",
    apply: "serve",
    configureServer(server) {
      if (!dir) return;
      const root = normalize(dir);
      server.middlewares.use("/__demo", (req, res, next) => {
        const file = normalize(join(root, decodeURIComponent((req.url ?? "").split("?")[0])));
        if (!file.startsWith(root) || !existsSync(file)) return next();
        const type = file.endsWith(".flac") ? "audio/flac" : file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
        res.setHeader("Content-Type", type);
        createReadStream(file).pipe(res);
      });
    },
  };
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss(), demoAudio()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/worker/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 900,
  },
});
