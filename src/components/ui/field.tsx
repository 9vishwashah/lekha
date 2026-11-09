"use client";
import type { ComponentProps, ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-[var(--radius-field)] bg-white px-4 text-ink ring-1 ring-inset ring-line placeholder:text-ink-3/70 focus:outline-none focus:ring-2 focus:ring-ink disabled:bg-sunken aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-red";

export function Field({
  label,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  className?: string;
  optional?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink-2">
        {label}
        {optional && <span className="font-normal text-ink-3"> · optional</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-[13px] text-ink-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[13px] font-medium text-out">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, "h-12 text-[16px]", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-24 py-3 text-[16px]", className)} {...props} />;
}

const chevron =
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none'%3E%3Cpath stroke='%231d1d1b' stroke-width='1.6' d='m1 1.5 5 5 5-5'/%3E%3C/svg%3E\")]";

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(control, chevron, "h-12 appearance-none text-[16px] bg-[right_1rem_center] bg-no-repeat pr-10", className)} {...props}>
      {children}
    </select>
  );
}

/** Amount entry: numeric keyboard on phones, rupee prefix, no spinners. */
/** Digits, one decimal point with up to 2 places, and a leading minus: the plain amount. */
export function plainAmount(text: string) {
  const negative = text.trim().startsWith("-");
  const [whole = "", ...rest] = text.replace(/[^0-9.]/g, "").split(".");
  const decimals = rest.length ? "." + rest.join("").slice(0, 2) : "";
  return (negative ? "-" : "") + whole.replace(/^0+(?=\d)/, "") + decimals;
}

/** Indian grouping as you type: 1,17,000 and 11,70,000, never 117,000. */
export function groupIndian(plain: string) {
  const negative = plain.startsWith("-");
  const [whole, decimals] = (negative ? plain.slice(1) : plain).split(".");
  const last3 = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = head ? `${head},${last3}` : last3;
  return (negative ? "-" : "") + grouped + (decimals !== undefined ? `.${decimals}` : "");
}

/** "11.7 lakh", "1.25 crore" for big amounts, so the size reads at a glance. */
export function amountInWords(plain: string) {
  const n = Math.abs(Number(plain));
  if (!Number.isFinite(n) || n < 100000) return "";
  const trim = (v: number) => v.toFixed(2).replace(/\.?0+$/, "");
  return n >= 10000000 ? `${trim(n / 10000000)} crore` : `${trim(n / 100000)} lakh`;
}

/**
 * Amount entry: numeric keyboard on phones, rupee prefix, and Indian commas while typing so the
 * number of zeros is obvious. What the form and onChange receive stays the plain number (1170000),
 * so nothing that reads amounts has to know about the commas.
 */
export function MoneyInput({
  className,
  big,
  value,
  defaultValue,
  onChange,
  name,
  ...props
}: ComponentProps<"input"> & { big?: boolean }) {
  const controlled = value !== undefined;
  const [own, setOwn] = useState(() => plainAmount(String(defaultValue ?? "")));
  const plain = controlled ? plainAmount(String(value ?? "")) : own;
  const shown = groupIndian(plain);
  const words = amountInWords(plain);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  // Put the cursor back after the same number of digits it was after, once commas move.
  useLayoutEffect(() => {
    const el = input.current;
    if (caret.current === null || !el || el !== document.activeElement) return;
    let seen = 0;
    let at = 0;
    while (at < el.value.length && seen < caret.current) {
      if (/[0-9.\-]/.test(el.value[at])) seen += 1;
      at += 1;
    }
    el.setSelectionRange(at, at);
    caret.current = null;
  });

  return (
    <div className="relative">
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3",
          big ? "display text-3xl" : "text-[16px]",
        )}
      >
        ₹
      </span>
      <input
        ref={input}
        inputMode="decimal"
        autoComplete="off"
        className={cn(control, "num", big ? "display h-20 pl-11 text-[2.5rem] font-bold" : "h-12 pl-9 text-[16px]", words && (big ? "pr-32" : "pr-24"), className)}
        {...props}
        value={shown}
        onChange={(e) => {
          const el = e.target;
          const before = el.value.slice(0, el.selectionStart ?? el.value.length);
          caret.current = before.replace(/[^0-9.\-]/g, "").length;
          const next = plainAmount(el.value);
          if (!controlled) setOwn(next);
          // Callers read e.target.value: hand them the plain number; the box shows it grouped.
          el.value = next;
          onChange?.(e);
          el.value = groupIndian(next);
        }}
      />
      {words && (
        <span aria-hidden className={cn("pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-3", big ? "text-[15px] font-medium" : "text-[13px]")}>
          {words}
        </span>
      )}
      {name && <input type="hidden" name={name} value={plain} />}
    </div>
  );
}

export function Checkbox({ label, hint, className, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 py-1", className)}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[#1d1d1b]" {...props} />
      <span className="flex flex-col">
        <span className="text-[15px] font-medium">{label}</span>
        {hint && <span className="text-[13px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}
