"use client";
import { useEffect, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { Field, Input } from "@/components/ui/field";
import { checkUsername } from "@/app/(app)/actions/workspace";
import { cn } from "@/lib/cn";

const FORMAT = /^[a-z0-9][a-z0-9_.]{2,19}$/;
const clean = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

/** A name from "Vishwa Shah" → "vishwashah", trimmed to the allowed characters. */
export function suggestUsername(fullName: string) {
  return fullName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 20);
}

/**
 * @username input with a live availability check. Usernames are how people add you to their
 * ledgers, so the field says straight away whether the one you typed is free.
 */
export function UsernameField({
  value,
  onChange,
  current,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Your existing username (always "available" to you). */
  current?: string | null;
  error?: string;
}) {
  const v = clean(value);
  const [checked, setChecked] = useState<{ name: string; available: boolean } | null>(null);
  const valid = FORMAT.test(v);

  useEffect(() => {
    if (!valid || v === current) return;
    let alive = true;
    const t = setTimeout(async () => {
      const available = await checkUsername(v);
      if (alive) setChecked({ name: v, available });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [v, valid, current]);

  const status: "idle" | "checking" | "free" | "taken" | "invalid" =
    !v ? "idle" : !valid ? "invalid" : v === current ? "free" : checked?.name !== v ? "checking" : checked.available ? "free" : "taken";
  const hint =
    status === "invalid"
      ? "3–20 letters, numbers, dots or underscores"
      : status === "taken"
        ? `@${v} is taken. Try another.`
        : status === "free"
          ? `@${v} is yours${v === current ? "" : " if you save now"}`
          : "People add you to ledgers by this name.";

  return (
    <Field label="Username" hint={error ? undefined : hint} error={error}>
      {(p) => (
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[16px] font-medium text-ink-3">
            @
          </span>
          <Input
            {...p}
            name="username"
            value={value}
            onChange={(e) => onChange(clean(e.target.value).replace(/[^a-z0-9_.]/g, ""))}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={20}
            className={cn("pl-9 pr-11", status === "taken" && "ring-2 ring-out")}
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2" aria-live="polite">
            {status === "checking" && <LoaderCircle className="size-4 animate-spin text-ink-3" aria-label="Checking" />}
            {status === "free" && <Check className="size-4 text-in" aria-label="Available" />}
            {(status === "taken" || status === "invalid") && <X className="size-4 text-out" aria-label="Not available" />}
          </span>
        </div>
      )}
    </Field>
  );
}
