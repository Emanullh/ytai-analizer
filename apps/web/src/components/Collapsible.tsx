import { ReactNode, useState } from "react";

interface CollapsibleProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export default function Collapsible({ title, children, defaultOpen = false }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-slate-800"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-xs text-slate-500">{open ? "Ocultar" : "Mostrar"}</span>
      </button>
      {open ? <div className="border-t border-slate-200 p-3">{children}</div> : null}
    </section>
  );
}
