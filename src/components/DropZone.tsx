import { open } from "@tauri-apps/plugin-dialog";
import { FolderInput, Upload } from "lucide-react";
import { useStore } from "../store";
import { EngineSetup } from "./EngineSetup";
import { Logo } from "./Logo";
import { Button, cx } from "./ui";

export async function pickFiles(extensions: string[], addFiles: (p: string[]) => Promise<void>) {
  const picked = await open({
    multiple: true,
    title: "Add audio files",
    filters: [{ name: "Audio", extensions }],
  });
  if (picked) await addFiles(Array.isArray(picked) ? picked : [picked]);
}

export async function pickFolder(addFiles: (p: string[]) => Promise<void>) {
  const dir = await open({ directory: true, title: "Add a folder of audio files" });
  if (typeof dir === "string") await addFiles([dir]);
}

export function DropZone({ dragging }: { dragging: boolean }) {
  const addFiles = useStore((s) => s.addFiles);
  const appInfo = useStore((s) => s.appInfo);
  const engineInfo = useStore((s) => s.engineInfo);
  const engineLoading = useStore((s) => s.engineLoading);
  const exts = appInfo?.audioExtensions ?? ["wav", "flac", "mp3"];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-auto p-8">
      {/* Clicking anywhere opens the file picker; keyboard users use the buttons inside. */}
      <div
        onClick={() => void pickFiles(exts, addFiles)}
        className={cx(
          "brand-gradient group flex w-full max-w-2xl cursor-pointer flex-col items-center gap-5 rounded-3xl border-2 border-dashed px-10 py-14 text-center transition-all",
          dragging ? "scale-[1.01] border-accent bg-accent-soft" : "border-line-strong hover:border-accent/60",
        )}
      >
        <div className="relative">
          <div className="absolute inset-2 rounded-3xl bg-warn/25 blur-2xl transition-opacity group-hover:opacity-100" />
          <Logo size={88} className="relative rounded-3xl" />
        </div>
        <div>
          <div className="text-xl font-semibold tracking-tight">{dragging ? "Drop to add" : "Drop audio files or folders here"}</div>
          <div className="mt-1.5 text-sm text-ink-3">
            {exts
              .slice(0, 9)
              .map((e) => e.toUpperCase())
              .join(" · ")}{" "}
            and more — processed locally, nothing is uploaded.
          </div>
        </div>
        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" onClick={() => void pickFiles(exts, addFiles)}>
            <Upload size={15} /> Browse files
          </Button>
          <Button onClick={() => void pickFolder(addFiles)}>
            <FolderInput size={15} /> Add folder
          </Button>
        </div>
      </div>
      {!engineInfo && !engineLoading && (
        <div className="w-full max-w-2xl">
          <EngineSetup compact />
        </div>
      )}
    </div>
  );
}
