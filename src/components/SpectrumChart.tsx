import { useMemo, useRef, useState } from "react";
import { formatHz } from "../lib/format";
import type { Spectrum } from "../lib/types";

interface Series {
  key: "original" | "enhanced";
  label: string;
  color: string;
  data: Spectrum;
}

const W = 640;
const H = 200;
const PAD = { l: 40, r: 74, t: 12, b: 26 };
const FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/**
 * Long-term average spectrum, original vs enhanced, on a log-frequency axis.
 * Shows what processing changed: removed noise floor, restored top octave.
 * Hover shows a crosshair with both values; a table view is available.
 */
export function SpectrumChart({ original, enhanced }: { original: Spectrum; enhanced?: Spectrum }) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const series: Series[] = useMemo(
    () => [
      { key: "original", label: "Original", color: "var(--series-original)", data: original },
      ...(enhanced ? [{ key: "enhanced" as const, label: "Enhanced", color: "var(--series-enhanced)", data: enhanced }] : []),
    ],
    [original, enhanced],
  );

  const fMin = 20;
  const fMax = Math.max(...series.map((s) => s.data.freqs[s.data.freqs.length - 1] ?? 20000));
  const all = series.flatMap((s) => s.data.db).filter(Number.isFinite);
  const top = Math.ceil((Math.max(...all) + 3) / 10) * 10;
  const bottom = Math.max(top - 100, Math.floor((Math.min(...all) - 3) / 10) * 10);

  const x = (f: number) => PAD.l + ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))) * (W - PAD.l - PAD.r);
  const y = (db: number) => PAD.t + ((top - Math.max(bottom, Math.min(top, db))) / (top - bottom)) * (H - PAD.t - PAD.b);
  const path = (s: Spectrum) => s.freqs.map((f, i) => `${i ? "L" : "M"}${x(f).toFixed(1)},${y(s.db[i]).toFixed(1)}`).join("");

  const dbTicks: number[] = [];
  for (let v = top; v >= bottom; v -= 20) dbTicks.push(v);

  const hoverF = hoverX === null ? null : 10 ** (Math.log10(fMin) + ((hoverX - PAD.l) / (W - PAD.l - PAD.r)) * (Math.log10(fMax) - Math.log10(fMin)));
  const valueAt = (s: Spectrum, f: number) => {
    let i = 0;
    while (i < s.freqs.length - 1 && s.freqs[i + 1] < f) i++;
    return s.db[i];
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    setHoverX(px >= PAD.l && px <= W - PAD.r ? px : null);
  };

  const lastY = (s: Spectrum) => y(s.db[s.db.length - 1]);
  // Direct labels at the right end; nudge apart when they would collide.
  const labelYs = series.map((s) => lastY(s.data));
  if (labelYs.length === 2 && Math.abs(labelYs[0] - labelYs[1]) < 12) {
    const mid = (labelYs[0] + labelYs[1]) / 2;
    const up = labelYs[0] <= labelYs[1] ? 0 : 1;
    labelYs[up] = mid - 6;
    labelYs[1 - up] = mid + 6;
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs text-ink-2" aria-label="Legend">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <button type="button" className="text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => setTable((t) => !t)}>
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-[200px] overflow-auto rounded-lg border border-line">
          <table className="tabular w-full text-xs">
            <thead className="sticky top-0 bg-panel-2 text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Frequency</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-1.5 text-right font-medium">
                    {s.label} (dB)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {original.freqs
                .map((f, i) => ({ f, i }))
                .filter((_, i) => i % 8 === 0)
                .map(({ f, i }) => (
                  <tr key={f} className="border-t border-line text-ink-2">
                    <td className="px-3 py-1">{formatHz(f)}</td>
                    {series.map((s) => (
                      <td key={s.key} className="px-3 py-1 text-right">
                        {s.data.db[i]?.toFixed(1)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label="Average spectrum of the original and enhanced audio"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverX(null)}
        >
          {dbTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="fill-[var(--ink-3)] text-[9px]">
                {v}
              </text>
            </g>
          ))}
          {FREQ_TICKS.filter((f) => f <= fMax).map((f) => (
            <text key={f} x={x(f)} y={H - 8} textAnchor="middle" className="fill-[var(--ink-3)] text-[9px]">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          ))}
          <text x={PAD.l - 6} y={PAD.t - 2} textAnchor="end" className="fill-[var(--ink-3)] text-[8px]">
            dB
          </text>
          {series.map((s) => (
            <path key={s.key} d={path(s.data)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s, i) => (
            <text key={`l-${s.key}`} x={W - PAD.r + 6} y={labelYs[i] + 3} className="fill-[var(--ink-2)] text-[10px] font-medium">
              {s.label}
            </text>
          ))}
          {hoverX !== null && hoverF !== null && (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeDasharray="3 3" />
              {series.map((s) => (
                <circle key={s.key} cx={hoverX} cy={y(valueAt(s.data, hoverF))} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
              ))}
              <g transform={`translate(${Math.min(hoverX + 10, W - PAD.r - 128)},${PAD.t + 4})`}>
                <rect width={124} height={18 + series.length * 14} rx={6} fill="var(--bg-elev)" stroke="var(--line-strong)" />
                <text x={8} y={13} className="fill-[var(--ink)] text-[10px] font-semibold">
                  {formatHz(hoverF)}
                </text>
                {series.map((s, i) => (
                  <g key={s.key} transform={`translate(8,${26 + i * 14})`}>
                    <rect y={-6} width={8} height={2} rx={1} fill={s.color} />
                    <text x={14} className="fill-[var(--ink-2)] text-[10px]">
                      {s.label}
                    </text>
                    <text x={108} textAnchor="end" className="tabular fill-[var(--ink)] text-[10px]">
                      {valueAt(s.data, hoverF).toFixed(1)} dB
                    </text>
                  </g>
                ))}
              </g>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
