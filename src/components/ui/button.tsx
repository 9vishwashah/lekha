import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "light";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex select-none items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-[transform,background-color,opacity] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-surface hover:bg-[#33322f]",
  secondary: "bg-surface text-ink ring-1 ring-inset ring-line hover:bg-white",
  ghost: "text-ink hover:bg-sunken",
  danger: "bg-red text-white hover:bg-[#b23736]",
  light: "bg-white/85 text-ink hover:bg-white",
};

const sizes: Record<Size, string> = {
  sm: "h-10 px-4 text-sm",
  md: "h-12 px-5 text-[15px]",
  lg: "h-14 px-7 text-base",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button type="button" className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

/** Round icon-only button. Always labelled for screen readers. */
export function IconButton({
  label,
  children,
  className,
  tone = "surface",
  ...props
}: ComponentProps<"button"> & { label: string; children: ReactNode; tone?: "surface" | "ink" | "clear" }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95",
        tone === "surface" && "bg-surface ring-1 ring-inset ring-line hover:bg-white",
        tone === "ink" && "bg-ink text-surface",
        tone === "clear" && "hover:bg-black/5",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
