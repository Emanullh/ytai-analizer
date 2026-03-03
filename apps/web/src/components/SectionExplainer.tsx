import { ReactNode, useState } from "react";

interface SectionExplainerProps {
  children: ReactNode;
}

export default function SectionExplainer({ children }: SectionExplainerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-sky-800"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0 text-sky-500"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
        <span>{open ? "Ocultar explicación" : "¿Qué significa esta sección?"}</span>
        <span className="ml-auto text-[10px] text-sky-500">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="border-t border-sky-200 px-3 py-2 text-xs leading-relaxed text-sky-900">
          {children}
        </div>
      ) : null}
    </div>
  );
}
