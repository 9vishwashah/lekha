"use client";
import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";
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
export function MoneyInput({ className, big, ...props }: ComponentProps<"input"> & { big?: boolean }) {
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
        inputMode="decimal"
        autoComplete="off"
        className={cn(control, "num", big ? "display h-20 pl-11 text-[2.5rem] font-bold" : "h-12 pl-9 text-[16px]", className)}
        {...props}
      />
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
