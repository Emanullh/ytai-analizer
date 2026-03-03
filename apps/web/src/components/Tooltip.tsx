import { ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipSide = "top" | "right" | "bottom" | "left";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

const OFFSET = 8;

function computePosition(
  anchor: DOMRect,
  tooltip: DOMRect,
  side: TooltipSide
): { top: number; left: number } {
  switch (side) {
    case "top":
      return {
        top: anchor.top - tooltip.height - OFFSET,
        left: anchor.left + anchor.width / 2 - tooltip.width / 2,
      };
    case "bottom":
      return {
        top: anchor.bottom + OFFSET,
        left: anchor.left + anchor.width / 2 - tooltip.width / 2,
      };
    case "left":
      return {
        top: anchor.top + anchor.height / 2 - tooltip.height / 2,
        left: anchor.left - tooltip.width - OFFSET,
      };
    case "right":
      return {
        top: anchor.top + anchor.height / 2 - tooltip.height / 2,
        left: anchor.right + OFFSET,
      };
  }
}

function clampToViewport(pos: { top: number; left: number }, tooltip: DOMRect) {
  const pad = 6;
  return {
    top: Math.max(pad, Math.min(pos.top, window.innerHeight - tooltip.height - pad)),
    left: Math.max(pad, Math.min(pos.left, window.innerWidth - tooltip.width - pad)),
  };
}

export default function Tooltip({ content, children, side = "top", className = "" }: TooltipProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ top: 0, left: 0 });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (!anchor || !tip) return;
    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pos = computePosition(anchorRect, tipRect, side);
    const clamped = clampToViewport(pos, tipRect);
    setStyle({ top: clamped.top, left: clamped.left });
  }, [side]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  const portalContent = open
    ? createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={style}
          className={`pointer-events-none fixed z-[9999] max-w-sm rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lg transition ${
            open ? "visible opacity-100" : "invisible opacity-0"
          }`}
        >
          {content}
        </span>,
        document.body
      )
    : null;

  return (
    <>
      <span
        ref={anchorRef}
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
      </span>
      {portalContent}
    </>
  );
}
