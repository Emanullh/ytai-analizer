import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";

interface PercentileDistributionChartProps {
  videos: Array<{ performance?: { percentile?: number | null } | null }>;
}

const BUCKET_COLORS = ["#f43f5e", "#f59e0b", "#6366f1", "#10b981"];

export default function PercentileDistributionChart({ videos }: PercentileDistributionChartProps) {
  const data = useMemo(() => {
    const buckets = [
      { label: "0-25", min: 0, max: 0.25, count: 0 },
      { label: "25-50", min: 0.25, max: 0.5, count: 0 },
      { label: "50-75", min: 0.5, max: 0.75, count: 0 },
      { label: "75-100", min: 0.75, max: 1.01, count: 0 },
    ];
    for (const v of videos) {
      const pct = v.performance?.percentile;
      if (typeof pct !== "number" || Number.isNaN(pct)) continue;
      const normalized = pct <= 1 ? pct : pct / 100;
      const bucket = buckets.find((b) => normalized >= b.min && normalized < b.max);
      if (bucket) bucket.count++;
    }
    return buckets;
  }, [videos]);

  const total = data.reduce((s, b) => s + b.count, 0);
  if (total === 0) return null;

  return (
    <div className="w-full" style={{ height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip
            formatter={(value) => [`${typeof value === "number" ? value : String(value ?? "-")} videos`, "Count"]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((_entry, idx) => (
              <Cell key={idx} fill={BUCKET_COLORS[idx]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
