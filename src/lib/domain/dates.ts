/**
 * Dates are calendar dates (YYYY-MM-DD) in the workspace timezone, Asia/Kolkata by default.
 * Financial year starts in April unless the workspace says otherwise.
 */
export const DEFAULT_TZ = "Asia/Kolkata";

export function todayISO(timeZone = DEFAULT_TZ, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parts(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

export function financialYear(date: string, fyStartMonth = 4) {
  const { y, m } = parts(date);
  const startYear = m >= fyStartMonth ? y : y - 1;
  const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;
  const endYear = fyStartMonth === 1 ? startYear : startYear + 1;
  return {
    from: iso(startYear, fyStartMonth, 1),
    to: iso(endYear, endMonth, daysInMonth(endYear, endMonth)),
    label: fyStartMonth === 1 ? `${startYear}` : `FY ${startYear}–${String(endYear).slice(2)}`,
  };
}

export type PeriodKey = "today" | "week" | "month" | "fy" | "all" | "custom";

export function periodRange(key: PeriodKey, today: string, fyStartMonth = 4, custom?: { from?: string; to?: string }) {
  const { y, m, d } = parts(today);
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "week": {
      // Weeks start on Monday.
      const dt = new Date(Date.UTC(y, m - 1, d));
      const dow = (dt.getUTCDay() + 6) % 7;
      dt.setUTCDate(dt.getUTCDate() - dow);
      return { from: dt.toISOString().slice(0, 10), to: today };
    }
    case "month":
      return { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) };
    case "fy": {
      const fy = financialYear(today, fyStartMonth);
      return { from: fy.from, to: fy.to };
    }
    case "custom":
      return { from: custom?.from || undefined, to: custom?.to || undefined };
    default:
      return { from: undefined, to: undefined };
  }
}

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  fy: "This financial year",
  all: "All time",
  custom: "Custom range",
};

/** 28/10/2026 */
export function formatDate(date: string | null | undefined): string {
  if (!date) return "";
  const { y, m, d } = parts(date.slice(0, 10));
  return `${pad(d)}/${pad(m)}/${y}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 28 Oct 2026, or 28 Oct when in the current year. */
export function formatDateShort(date: string, today?: string): string {
  const { y, m, d } = parts(date.slice(0, 10));
  const sameYear = today ? parts(today).y === y : false;
  return sameYear ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

export function monthLabel(monthKey: string): string {
  const { y, m } = parts(`${monthKey}-01`);
  return `${MONTHS[m - 1]} ${y}`;
}

export function formatDateTime(ts: string | Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(typeof ts === "string" ? new Date(ts) : ts);
}

export function relativeTime(ts: string | Date, now = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(ts).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export const isISODate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** "24th October 2026", for formal documents. */
export function formatDateLong(date: string): string {
  const { y, m, d } = parts(date.slice(0, 10));
  const suffix = d % 100 >= 11 && d % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[d % 10] ?? "th";
  return `${d}${suffix} ${new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)))} ${y}`;
}
