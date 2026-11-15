import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import WaveSurfer from "wavesurfer.js";

export interface WaveformHandle {
  setTime: (t: number) => void;
}

interface Props {
  peaks: number[];
  duration: number;
  color: string;
  progressColor: string;
  height?: number;
  onSeek: (t: number) => void;
}

/**
 * WaveSurfer renders pre-computed peaks (from the worker) and handles
 * click/drag seeking. Playback itself is driven by ABPlayer, so both lanes
 * stay sample-aligned; we only push the playhead position here.
 */
export const Waveform = forwardRef<WaveformHandle, Props>(function Waveform(
  { peaks, duration, color, progressColor, height = 96, onSeek },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const seekRef = useRef(onSeek);
  useEffect(() => {
    seekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    if (!container.current || !peaks.length || !(duration > 0)) return;
    const instance = WaveSurfer.create({
      container: container.current,
      height,
      waveColor: color,
      progressColor,
      cursorColor: "var(--ink)",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: false,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      peaks: [Float32Array.from(peaks)],
      duration,
    });
    instance.on("interaction", (t) => seekRef.current(t));
    ws.current = instance;
    return () => {
      instance.destroy();
      ws.current = null;
    };
  }, [peaks, duration, height, color, progressColor]);

  useImperativeHandle(ref, () => ({
    setTime: (t: number) => {
      const w = ws.current;
      if (w && Number.isFinite(t)) w.setTime(Math.min(t, duration));
    },
  }));

  return <div ref={container} className="w-full cursor-pointer" />;
});
