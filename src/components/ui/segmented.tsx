"use client";
import { cn } from "@/lib/cn";

/** Pill segmented control (radio group semantics). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; tone?: "in" | "out" }[];
  label: string;
  className?: string;
  size?: "md" | "lg";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-1 rounded-full bg-sunken p-1", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-full px-3 font-medium transition-colors",
              size === "lg" ? "h-12 text-[15px]" : "h-10 text-sm",
              active
                ? o.tone === "in"
                  ? "bg-tea text-seashell"
                  : o.tone === "out"
                    ? "bg-red text-white"
                    : "bg-ink text-surface"
                : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
