import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleX, FileAudio, FolderInput, FolderOpen, Plus, Square, Trash2, Wand2 } from "lucide-react";
import { STAGE_LABELS, formatTime } from "../lib/format";
import { hasAnyStage } from "../lib/presets";
import { jobForFile, useStore } from "../store";
import { pickFiles, pickFolder } from "./DropZone";
import { Button, IconButton, ProgressBar, cx } from "./ui";
import { api } from "../lib/api";

export function FileQueue() {
  const files = useStore((s) => s.files);
  const jobs = useStore((s) => s.jobs);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const removeFile = useStore((s) => s.removeFile);
  const clearFiles = useStore((s) => s.clearFiles);
  const enhance = useStore((s) => s.enhance);
  const cancelFile = useStore((s) => s.cancelFile);
  const addFiles = useStore((s) => s.addFiles);
  const stages = useStore((s) => s.stages);
  const engineInfo = useStore((s) => s.engineInfo);
  const exts = useStore((s) => s.appInfo?.audioExtensions ?? []);

  const active = files.filter((f) => {
    const j = jobForFile(f, jobs);
    return j && (j.status === "queued" || j.status === "running");
  }).length;
  const done = files.filter((f) => jobForFile(f, jobs)?.status === "done").length;

  return (
    <section className="flex h-[236px] shrink-0 flex-col border-t border-line bg-elev" aria-label="Files and queue">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Files</h2>
        <span className="tabular text-xs text-ink-3">
          {files.length} · {done} enhanced{active ? ` · ${active} in progress` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void pickFiles(exts, addFiles)}>
            <Plus size={14} /> Add files
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void pickFolder(addFiles)}>
            <FolderInput size={14} /> Add folder
          </Button>
          {active > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void api.cancelAllJobs()}>
              <Square size={13} /> Cancel all
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={clearFiles} disabled={!files.length}>
            <Trash2 size={14} /> Clear
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Imported files">
        {files.map((f) => {
          const job = jobForFile(f, jobs);
          const busy = job && (job.status === "queued" || job.status === "running");
          const selected = f.id === selectedId;
          return (
            <li
              key={f.id}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              onClick={() => select(f.id)}
              onKeyDown={(e) => e.key === "Enter" && select(f.id)}
              className={cx(
                "group mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                selected ? "bg-accent-soft" : "hover:bg-panel-2",
              )}
            >
              <span className="shrink-0">
                {job?.status === "done" ? (
                  <CircleCheck size={16} className="text-ok" />
                ) : job?.status === "failed" ? (
                  <CircleX size={16} className="text-danger" />
                ) : (
                  <FileAudio size={16} className={selected ? "text-brand" : "text-ink-3"} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cx("truncate text-[13px]", selected ? "font-medium text-ink" : "text-ink-2")} title={f.path}>
                  {f.name}
                </div>
                {busy ? (
                  <div className="mt-1 flex items-center gap-2">
                    <ProgressBar value={job!.progress} indeterminate={job!.status === "queued"} className="flex-1" />
                    <span className="tabular w-28 truncate text-right text-[11px] text-ink-3">
                      {job!.status === "queued" ? "Queued" : `${STAGE_LABELS[job!.stage] ?? job!.stage} ${Math.round(job!.progress * 100)}%`}
                    </span>
                  </div>
                ) : (
                  <div className="truncate text-[11px] text-ink-3">
                    {job?.status === "failed"
                      ? job.error?.message
                      : job?.status === "cancelled"
                        ? "Cancelled"
                        : job?.status === "done"
                          ? `Saved · ${job.output}`
                          : f.analysis
                            ? `${formatTime(f.analysis.info.duration)} · ${f.analysis.info.sampleRate / 1000} kHz`
                            : f.analyzing
                              ? "Analysing…"
                              : (f.analysisError ?? "Ready")}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                {busy ? (
                  <IconButton label="Cancel" onClick={(e) => (e.stopPropagation(), void cancelFile(f.id))}>
                    <Square size={13} />
                  </IconButton>
                ) : (
                  <IconButton
                    label="Enhance this file"
                    disabled={!engineInfo || !hasAnyStage(stages)}
                    onClick={(e) => (e.stopPropagation(), void enhance([f.id]))}
                  >
                    <Wand2 size={14} />
                  </IconButton>
                )}
                {job?.status === "done" && (
                  <IconButton label="Show in folder" onClick={(e) => (e.stopPropagation(), void revealItemInDir(job.output).catch(() => undefined))}>
                    <FolderOpen size={14} />
                  </IconButton>
                )}
                <IconButton label="Remove from list" disabled={!!busy} onClick={(e) => (e.stopPropagation(), removeFile(f.id))}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
