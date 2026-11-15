import logoMark from "../assets/logo-mark.png";
import { cx } from "./ui";

/** The Resona mark (gold waveform) on its own tile so it reads on every theme. */
export function Logo({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center rounded-xl bg-logo-tile ring-1 ring-line-strong", className)}
      style={{ width: size, height: size }}
    >
      <img src={logoMark} alt="" aria-hidden width={size * 0.82} height={size * 0.82} draggable={false} />
    </span>
  );
}
