import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ComparePanel } from "./components/ComparePanel";
import { DropZone } from "./components/DropZone";
import { FileQueue } from "./components/FileQueue";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { isTauri } from "./lib/api";
import { analyzePending, useStore } from "./store";

export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const files = useStore((s) => s.files);
  const selectedId = useStore((s) => s.selectedId);
  const engineInfo = useStore((s) => s.engineInfo);
  const addFiles = useStore((s) => s.addFiles);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  // Files imported before the engine was ready get analysed once it is.
  useEffect(() => {
    if (engineInfo) analyzePending();
  }, [engineInfo]);

  // Native drag & drop (gives real file system paths, including folders).
  useEffect(() => {
    if (!isTauri()) return;
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "enter" || t === "over") setDragging(true);
      else if (t === "leave") setDragging(false);
      else if (t === "drop") {
        setDragging(false);
        void addFiles(e.payload.paths);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [addFiles]);

  const selected = files.find((f) => f.id === selectedId);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        <LoaderCircle className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? <ComparePanel key={selected.id} file={selected} /> : <DropZone dragging={dragging} />}
        </div>
        {files.length > 0 && <FileQueue />}
        {dragging && files.length > 0 && (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-accent-soft backdrop-blur-[2px]">
            <div className="text-lg font-semibold text-brand">Drop to add to the list</div>
          </div>
        )}
      </main>
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
