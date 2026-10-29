"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Lekha's calendar: a styled replacement for the browser date input.
 * DateInput picks one day (works inside forms through a hidden input). DateRangeInput picks a range
 * and reports it as soon as the second day is chosen, so filters apply without an Apply button.
 * Dates are plain YYYY-MM-DD strings in the workspace's calendar.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s?: string | null) => {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
};
const todayLocal = () => {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
};
const addDays = (s: string, days: number) => {
  const p = parse(s)!;
  const d = new Date(Date.UTC(p.y, p.m, p.d + days));
  return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
export const formatPretty = (s?: string | null) => {
  const p = parse(s);
  return p ? `${p.d} ${MONTHS[p.m].slice(0, 3)} ${p.y}` : "";
};

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);
  return ref;
}

function Calendar({
  month,
  onMonth,
  isSelected,
  inRange,
  onPick,
  min,
  max,
}: {
  month: { y: number; m: number };
  onMonth: (m: { y: number; m: number }) => void;
  isSelected: (day: string) => boolean;
  inRange?: (day: string) => boolean;
  onPick: (day: string) => void;
  min?: string;
  max?: string;
}) {
  const today = todayLocal();
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => iso(month.y, month.m, i + 1))] as (string | null)[];
  }, [month]);
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(month.y, month.m + delta, 1));
    onMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  };
  return (
    <div className="w-[min(19.5rem,calc(100vw-3rem))]">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-sunken">
          <ChevronLeft className="size-5" />
        </button>
        <div className="display text-xl font-bold" aria-live="polite">
          {MONTHS[month.m]} <span className="text-ink-3">{month.y}</span>
        </div>
        <button type="button" onClick={() => shift(1)} aria-label="Next month" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-sunken">
          <ChevronRight className="size-5" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-3" aria-hidden>
        {DOW.map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1" role="grid" aria-label={`${MONTHS[month.m]} ${month.y}`}>
        {cells.map((day, i) =>
          day ? (
            <button
              key={day}
              type="button"
              disabled={(min && day < min) || (max && day > max) || false}
              aria-pressed={isSelected(day)}
              aria-label={formatPretty(day)}
              onClick={() => onPick(day)}
              className={cn(
                "num mx-auto inline-flex size-10 items-center justify-center rounded-full text-[15px] transition-colors disabled:opacity-30",
                isSelected(day)
                  ? "bg-ink font-semibold text-surface"
                  : inRange?.(day)
                    ? "bg-mustard/45 font-medium"
                    : day === today
                      ? "font-semibold ring-2 ring-inset ring-ink/70 hover:bg-sunken"
                      : "hover:bg-sunken",
              )}
            >
              {Number(day.slice(8))}
            </button>
          ) : (
            <span key={`x${i}`} />
          ),
        )}
      </div>
    </div>
  );
}

const trigger =
  "flex h-12 w-full items-center gap-2.5 rounded-[var(--radius-field)] bg-white px-4 text-left text-[16px] text-ink ring-1 ring-inset ring-line focus:outline-none focus-visible:ring-2 focus-visible:ring-ink data-[invalid=true]:ring-2 data-[invalid=true]:ring-red";

const panel =
  "absolute left-0 top-[calc(100%+0.5rem)] z-50 rounded-[24px] bg-surface p-3 shadow-[0_18px_48px_rgb(29_29_27/0.22)] ring-1 ring-line animate-rise";

/** One date. Controlled (value + onChange) or uncontrolled (defaultValue) with `name` for forms. */
export function DateInput({
  value,
  defaultValue,
  onChange,
  name,
  id,
  required,
  min,
  max,
  placeholder = "Choose a date",
  className,
  quick = true,
  ...aria
}: {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  id?: string;
  required?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  quick?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value ?? inner;
  const [open, setOpen] = useState(false);
  const start = parse(current) ?? parse(todayLocal())!;
  const [month, setMonth] = useState({ y: start.y, m: start.m });
  const ref = useDismiss(open, () => setOpen(false));
  const autoId = useId();
  const set = (v: string) => {
    if (value === undefined) setInner(v);
    onChange?.(v);
    setOpen(false);
  };
  const today = todayLocal();
  return (
    <div ref={ref} className={cn("relative", className)}>
      {name && <input type="hidden" name={name} value={current} required={required} />}
      <button
        type="button"
        id={id ?? autoId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={aria["aria-describedby"]}
        data-invalid={aria["aria-invalid"] ? "true" : undefined}
        onClick={() => {
          const p = parse(current) ?? parse(today)!;
          setMonth({ y: p.y, m: p.m });
          setOpen((o) => !o);
        }}
        className={trigger}
      >
        <CalendarDays className="size-[18px] shrink-0 text-ink-3" />
        <span className={cn("num truncate", !current && "text-ink-3/80")}>{current ? formatPretty(current) : placeholder}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Choose a date" className={panel}>
          <Calendar month={month} onMonth={setMonth} isSelected={(d) => d === current} onPick={set} min={min} max={max} />
          {quick && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
              {[
                { label: "Today", v: today },
                { label: "Yesterday", v: addDays(today, -1) },
              ].map((q) => (
                <button key={q.label} type="button" onClick={() => set(q.v)} className="h-9 rounded-full bg-sunken px-3 text-sm font-medium hover:bg-line">
                  {q.label}
                </button>
              ))}
              {!required && current && (
                <button type="button" onClick={() => set("")} className="ml-auto h-9 rounded-full px-3 text-sm font-medium text-ink-2 hover:bg-sunken">
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A date range that reports as soon as the second day is picked (or a preset is tapped). */
export function DateRangeInput({
  from,
  to,
  onChange,
  presets = [],
  label = "Date range",
  className,
}: {
  from?: string;
  to?: string;
  onChange: (range: { from: string; to: string }) => void;
  presets?: { label: string; from: string; to: string }[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const start = parse(to ?? from) ?? parse(todayLocal())!;
  const [month, setMonth] = useState({ y: start.y, m: start.m });
  const ref = useDismiss(open, () => {
    setOpen(false);
    setAnchor(null);
  });
  const done = (r: { from: string; to: string }) => {
    setOpen(false);
    setAnchor(null);
    onChange(r);
  };
  const pick = (day: string) => {
    if (!anchor) return setAnchor(day);
    done(day < anchor ? { from: day, to: anchor } : { from: anchor, to: day });
  };
  const lo = anchor ?? from;
  const hi = anchor ?? to;
  const text = from || to ? `${formatPretty(from) || "Start"} – ${formatPretty(to) || "Today"}` : label;

  return (
    <div ref={ref} className={cn("relative", className)}>
      <div className={cn("flex h-11 items-center rounded-full bg-surface ring-1 ring-inset ring-line", (from || to) && "ring-ink")}>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-full pl-4 pr-3 text-sm font-medium"
        >
          <CalendarDays className="size-4 shrink-0 text-ink-3" />
          <span className="num truncate">{text}</span>
        </button>
        {(from || to) && (
          <button type="button" aria-label="Clear dates" onClick={() => done({ from: "", to: "" })} className="mr-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-sunken">
            <X className="size-4" />
          </button>
        )}
      </div>
      {open && (
        <div role="dialog" aria-label={label} className={cn(panel, "w-max")}>
          <p className="mb-2 px-1 text-[13px] text-ink-3">{anchor ? "Now pick the last day" : "Pick the first day"}</p>
          <div>
            <Calendar
              month={month}
              onMonth={setMonth}
              isSelected={(d) => d === lo || d === hi}
              inRange={(d) => Boolean(lo && hi && d > lo && d < hi)}
              onPick={pick}
            />
          </div>
          {presets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
              {presets.map((p) => (
                <button key={p.label} type="button" onClick={() => done({ from: p.from, to: p.to })} className="h-9 rounded-full bg-sunken px-3 text-sm font-medium hover:bg-line">
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
