import { ReactNode } from "react";
import Tooltip from "./Tooltip";

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

export default function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1">
        <p className="text-xs text-slate-500">{label}</p>
        {hint ? (
          <Tooltip content={hint}>
            <button
              type="button"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
              aria-label={`Hint ${label}`}
            >
              ?
            </button>
          </Tooltip>
        ) : null}
      </div>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </article>
  );
}
