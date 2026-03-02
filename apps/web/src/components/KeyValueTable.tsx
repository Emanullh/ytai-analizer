import { ReactNode } from "react";
import Tooltip from "./Tooltip";

export interface KeyValueRow {
  key: string;
  label?: string;
  value: ReactNode;
  hint?: ReactNode;
}

interface KeyValueTableProps {
  rows: KeyValueRow[];
  emptyLabel?: string;
}

export default function KeyValueTable({ rows, emptyLabel = "No disponible" }: KeyValueTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Campo</th>
            <th className="px-3 py-2">Valor</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="px-3 py-2 text-slate-700">
                <div className="inline-flex items-center gap-1">
                  <span className="font-medium">{row.label ?? row.key}</span>
                  {row.hint ? (
                    <Tooltip content={row.hint}>
                      <button
                        type="button"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
                        aria-label={`Hint ${row.label ?? row.key}`}
                      >
                        ?
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2 text-slate-900">{row.value ?? <span className="text-slate-500">{emptyLabel}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
