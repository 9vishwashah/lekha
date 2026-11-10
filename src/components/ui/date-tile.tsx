import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The date of an entry as a small tile (day over month), with a corner badge for which way the
 * money went: green arrow in, red arrow out. The year shows only when it is not this year.
 */
export function DateTile({ date, today, direction, className }: { date: string; today?: string; direction?: "in" | "out"; className?: string }) {
  const [y, m, d] = date.split("-");
  const otherYear = today ? today.slice(0, 4) !== y : false;
  return (
    <span className={cn("relative inline-flex size-12 shrink-0 flex-col items-center justify-center rounded-2xl bg-sunken font-semibold uppercase leading-tight", className)}>
      <span className="num text-[15px]">{Number(d)}</span>
      <span className="text-[10px] tracking-wide">{MONTHS[Number(m) - 1]}</span>
      {otherYear && <span className="num text-[9px] font-medium text-ink-3">{y}</span>}
      {direction && (
        <span
          className={cn("absolute -bottom-1 -right-1 inline-flex size-5 items-center justify-center rounded-full text-white ring-2 ring-surface", direction === "in" ? "bg-in" : "bg-out")}
          aria-label={direction === "in" ? "Money in" : "Money out"}
        >
          {direction === "in" ? <ArrowDownLeft className="size-3" strokeWidth={2.75} /> : <ArrowUpRight className="size-3" strokeWidth={2.75} />}
        </span>
      )}
    </span>
  );
}
