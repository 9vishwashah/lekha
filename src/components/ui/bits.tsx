import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const WALLET_COLORS = ["mustard", "lavender", "tea", "pink", "tangerine", "sky", "red", "ink"] as const;
export type WalletColor = (typeof WALLET_COLORS)[number];

/** Solid colour + readable text for each wallet colour (contrast checked against WCAG AA). */
export const WALLET: Record<WalletColor, { bg: string; fg: string; sub: string; chip: string }> = {
  mustard: { bg: "bg-mustard", fg: "text-ink", sub: "text-ink/65", chip: "bg-ink/10" },
  lavender: { bg: "bg-lavender", fg: "text-ink", sub: "text-ink/70", chip: "bg-ink/10" },
  tea: { bg: "bg-tea", fg: "text-seashell", sub: "text-seashell/70", chip: "bg-white/12" },
  pink: { bg: "bg-pink", fg: "text-ink", sub: "text-ink/65", chip: "bg-ink/10" },
  tangerine: { bg: "bg-tangerine", fg: "text-ink", sub: "text-ink/70", chip: "bg-ink/10" },
  sky: { bg: "bg-sky", fg: "text-ink", sub: "text-ink/65", chip: "bg-ink/10" },
  red: { bg: "bg-red", fg: "text-white", sub: "text-white/75", chip: "bg-white/15" },
  ink: { bg: "bg-ink", fg: "text-seashell", sub: "text-seashell/60", chip: "bg-white/10" },
};

export const walletOf = (color: string | null | undefined) => WALLET[(color as WalletColor) in WALLET ? (color as WalletColor) : "mustard"];

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "in" | "out" | "warn" | "ink" | "outline";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
        tone === "neutral" && "bg-sunken text-ink-2",
        tone === "in" && "bg-[#d9eae5] text-in",
        tone === "out" && "bg-[#f6dcda] text-out",
        tone === "warn" && "bg-[#f7e9b8] text-[#6b5409]",
        tone === "ink" && "bg-ink text-surface",
        tone === "outline" && "ring-1 ring-inset ring-current",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 sm:p-6", className)}>{children}</div>;
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <h2 className="display text-[1.6rem] font-bold sm:text-3xl">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  kicker,
  actions,
  children,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-6 pt-2 sm:flex-row sm:items-end sm:justify-between sm:pb-8">
      <div className="min-w-0">
        {kicker && <div className="mb-2 text-sm font-medium text-ink-2">{kicker}</div>}
        <h1 className="display text-[2.6rem] font-extrabold sm:text-6xl">{title}</h1>
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  body,
  action,
  art,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  art?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-[var(--radius-card)] border-2 border-dashed border-line p-6 sm:p-8">
      {art}
      <div>
        <h3 className="display text-2xl font-bold">{title}</h3>
        <p className="mt-1.5 max-w-prose text-[15px] text-ink-2">{body}</p>
      </div>
      {action}
    </div>
  );
}

export function Avatar({ name, className, tone = "sunken" }: { name: string; className?: string; tone?: "sunken" | "ink" | "light" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
        tone === "sunken" && "bg-sunken text-ink",
        tone === "ink" && "bg-ink text-surface",
        tone === "light" && "bg-white/70 text-ink",
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}

export function Stat({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[13px] font-medium opacity-70">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <div className="mt-1 text-[13px] opacity-70">{hint}</div>}
    </div>
  );
}
