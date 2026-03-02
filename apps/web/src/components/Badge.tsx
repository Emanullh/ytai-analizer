import { ReactNode } from "react";

type BadgeVariant = "neutral" | "success" | "warning" | "danger" | "info";

const variantClassByValue: Record<BadgeVariant, string> = {
  neutral: "bg-slate-100 text-slate-700",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-rose-100 text-rose-700",
  info: "bg-sky-100 text-sky-700"
};

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
}

export default function Badge({ children, variant = "neutral" }: BadgeProps) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${variantClassByValue[variant]}`}>{children}</span>;
}
