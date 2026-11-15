import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useStore } from "../store";
import { cx } from "./ui";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="panel animate-in pointer-events-auto flex gap-3 p-3.5">
          <span className="mt-px shrink-0">
            {t.kind === "success" ? (
              <CircleCheck size={17} className="text-ok" />
            ) : t.kind === "error" ? (
              <CircleAlert size={17} className="text-danger" />
            ) : (
              <Info size={17} className="text-brand" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cx("text-[13px] font-medium", t.kind === "error" && "text-danger")}>{t.title}</div>
            {t.detail && <div className="selectable mt-0.5 break-words text-xs text-ink-3">{t.detail}</div>}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 text-ink-3 hover:text-ink">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
