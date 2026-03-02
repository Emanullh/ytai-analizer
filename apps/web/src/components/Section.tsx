import { ReactNode } from "react";

interface SectionProps {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export default function Section({ title, hint, actions, children }: SectionProps) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
        </div>
        {actions ? <div>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
