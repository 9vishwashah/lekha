"use client";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * A small dropdown: a button and a solid card of options. Closes on outside tap, Escape, or after
 * an option is chosen. `side` opens it above (for the sidebar foot) or below (headers).
 */
export function Menu({
  label,
  button,
  buttonClassName,
  children,
  side = "bottom",
  align = "start",
  className,
}: {
  label: string;
  button: ReactNode;
  buttonClassName?: string;
  children: (close: () => void) => ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={buttonClassName}
      >
        {button}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          className={cn(
            "absolute z-50 w-72 max-w-[calc(100vw-2rem)] origin-top animate-rise rounded-[24px] bg-surface p-2 shadow-[0_18px_48px_rgb(29_29_27/0.22)] ring-1 ring-line",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  href,
  className,
  danger,
}: {
  children: ReactNode;
  onSelect?: () => void;
  href?: string;
  className?: string;
  danger?: boolean;
}) {
  const cls = cn(
    "flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-[15px] font-medium transition-colors hover:bg-sunken focus:bg-sunken focus:outline-none",
    danger && "text-out",
    className,
  );
  return href ? (
    <Link role="menuitem" href={href} onClick={onSelect} className={cls}>
      {children}
    </Link>
  ) : (
    <button role="menuitem" type="button" onClick={onSelect} className={cls}>
      {children}
    </button>
  );
}
