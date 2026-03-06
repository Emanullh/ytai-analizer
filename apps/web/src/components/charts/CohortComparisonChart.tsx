import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { asNumber, asString } from "../../lib/artifactUtils";

interface CohortComparisonChartProps {
  cohorts: Record<string, unknown>[];
}

const DIMENSION_COLORS: Record<string, string> = {
  duration_bucket: "#6366f1",
  faceCountBucket: "#f59e0b",
  hasBigText: "#10b981",
  promise_type_primary: "#ec4899",
};

export default function CohortComparisonChart({ cohorts }: CohortComparisonChartProps) {
  const { data, dimensions } = useMemo(() => {
    const dims = new Set<string>();
    const mapped = cohorts.map((c) => {
      const dimension = asString(c.dimension) ?? "?";
      const bucket = asString(c.bucket) ?? "?";
      dims.add(dimension);
      return {
        label: `${dimension}: ${bucket}`,
        dimension,
        bucket,
        medianResidual: asNumber(c.medianResidual) ?? 0,
        n: asNumber(c.n) ?? 0,
      };
    });
    return { data: mapped, dimensions: Array.from(dims) };
  }, [cohorts]);

  if (data.length === 0) return null;

  return (
    <div className="w-full" style={{ height: Math.max(240, data.length * 28 + 60) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toFixed(3)} />
          <YAxis
            type="category"
            dataKey="label"
            width={180}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => (v.length > 25 ? `${v.slice(0, 23)}...` : v)}
          />
          <Tooltip
            formatter={(value, _name, props) => [
              `${typeof value === "number" ? value.toFixed(4) : String(value ?? "-")} (n=${props?.payload?.n ?? "?"})`,
              "Median Residual",
            ]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Bar dataKey="medianResidual" radius={[0, 4, 4, 0]}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={DIMENSION_COLORS[entry.dimension] ?? "#94a3b8"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
        {dimensions.map((dim) => (
          <span key={dim} className="inline-flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: DIMENSION_COLORS[dim] ?? "#94a3b8" }}
              aria-hidden="true"
            />
            {dim}
          </span>
        ))}
      </div>
    </div>
  );
}
