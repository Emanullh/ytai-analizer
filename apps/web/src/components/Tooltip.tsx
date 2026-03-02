import { ReactNode, useId, useState } from "react";

type TooltipSide = "top" | "right" | "bottom" | "left";

const sideClassByValue: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  bottom: "left-1/2 top-full mt-2 -translate-x-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2"
};

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

export default function Tooltip({ content, children, side = "top", className = "" }: TooltipProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`relative inline-flex ${className}`.trim()}
      aria-describedby={tooltipId}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute z-50 max-w-sm rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lg transition ${
          open ? "visible opacity-100" : "invisible opacity-0"
        } ${sideClassByValue[side]}`}
      >
        {content}
      </span>
    </span>
  );
}
