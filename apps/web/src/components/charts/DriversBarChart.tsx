import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import { asNumber, asString } from "../../lib/artifactUtils";

interface DriversBarChartProps {
  drivers: Record<string, unknown>[];
}

export default function DriversBarChart({ drivers }: DriversBarChartProps) {
  const data = useMemo(() => {
    return drivers
      .map((d) => {
        const feature = asString(d.feature) ?? "?";
        const effect =
          asNumber(d.absEffect) ?? asNumber(d.deltaMedianResidual) ?? asNumber(d.rho) ?? asNumber(d.effect) ?? 0;
        return { feature, effect };
      })
      .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
      .slice(0, 15);
  }, [drivers]);

  if (data.length === 0) return null;

  const maxAbsVal = Math.max(...data.map((d) => Math.abs(d.effect)), 0.01);

  return (
    <div className="w-full" style={{ height: Math.max(200, data.length * 32 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis
            type="number"
            domain={[-maxAbsVal * 1.1, maxAbsVal * 1.1]}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <YAxis
            type="category"
            dataKey="feature"
            width={220}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => (v.length > 30 ? `${v.slice(0, 28)}...` : v)}
          />
          <Tooltip
            formatter={(value: number) => [value.toFixed(4), "Effect"]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Bar dataKey="effect" radius={[0, 4, 4, 0]}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={entry.effect >= 0 ? "#10b981" : "#f43f5e"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
