import { type Paise, formatINR, splitINR } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

/**
 * The signature amount treatment: rupees set heavy, paise set light, like a price tag.
 * Every prominent figure uses it, so money reads the same on every screen.
 */
export function Amount({
  value,
  size = "md",
  tone = "inherit",
  sign = false,
  className,
}: {
  value: Paise;
  size?: "sm" | "md" | "lg" | "xl" | "hero";
  tone?: "inherit" | "in" | "out" | "auto";
  sign?: boolean;
  className?: string;
}) {
  const parts = splitINR(value);
  const toneClass =
    tone === "in"
      ? "text-in"
      : tone === "out"
        ? "text-out"
        : tone === "auto"
          ? value < 0n
            ? "text-out"
            : value > 0n
              ? "text-in"
              : ""
          : "";
  const sizeClass = {
    sm: "text-[15px] font-semibold",
    md: "text-xl font-semibold",
    lg: "display text-[2.25rem] font-bold",
    xl: "display text-[2.75rem] font-bold sm:text-6xl",
    hero: "display text-[3.25rem] font-extrabold sm:text-7xl",
  }[size];
  const prefix = sign && value > 0n ? "+" : parts.sign;
  return (
    <span className={cn("num whitespace-nowrap", sizeClass, toneClass, className)}>
      <span className="sr-only">{formatINR(value)}</span>
      <span aria-hidden>
        {prefix}
        {parts.whole}
        {parts.fraction && <span className="font-medium opacity-45">.{parts.fraction}</span>}
      </span>
    </span>
  );
}

/** Inline money for tables and secondary text. */
export function Money({ value, className, tone }: { value: Paise; className?: string; tone?: "in" | "out" }) {
  return (
    <span className={cn("num whitespace-nowrap", tone === "in" && "text-in", tone === "out" && "text-out", className)}>
      {formatINR(value)}
    </span>
  );
}
