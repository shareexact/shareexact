import { cn } from "@/lib/utils";

export function Spark({
  change,
  afterHours,
}: {
  change: number;
  afterHours: number;
}) {
  const pts = [0, change * 0.35, change * 0.7, change, change + afterHours * 0.4, change + afterHours];
  const min = Math.min(...pts, 0) - 0.4;
  const max = Math.max(...pts, 0) + 0.4;
  const w = 120;
  const h = 36;
  const path = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p - min) / (max - min)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = change + afterHours >= 0;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
      className={cn("overflow-visible", up ? "text-up" : "text-down")}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
