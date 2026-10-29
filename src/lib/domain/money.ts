/**
 * Decimal-safe money. Amounts are held as bigint paise (1/100 of a rupee) so additions and
 * comparisons are exact. Values enter and leave as strings ("1234.50"), matching NUMERIC(14,2).
 */
export type Paise = bigint;

const MAX_PAISE = 99_999_999_999_999n; // 999,999,999,999.99

export class MoneyError extends Error {}

/** Parses "1,17,000.50", "1234", 1234.5 into paise. Rejects more than 2 decimals. */
export function toPaise(value: string | number | bigint | null | undefined): Paise {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value * 100n;
  const text = (typeof value === "number" ? numberToPlain(value) : value).replace(/[,\s₹]/g, "").trim();
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) throw new MoneyError(`"${value}" is not an amount`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new MoneyError("Use at most 2 decimal places");
  const paise = BigInt(whole || "0") * 100n + BigInt((frac + "00").slice(0, 2));
  if (paise > MAX_PAISE) throw new MoneyError("Amount is too large");
  return sign ? -paise : paise;
}

/** Safe parse that returns null instead of throwing. */
export function tryPaise(value: string | number | null | undefined): Paise | null {
  try {
    return toPaise(value);
  } catch {
    return null;
  }
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError("Amount is not a number");
  // Spreadsheet cells arrive as binary floats; snap to 2 decimals deliberately and only here.
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Paise to a plain decimal string for the database, e.g. 11700000n -> "117000.00". */
export function toDecimal(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export const sum = (values: Iterable<Paise>): Paise => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

export const abs = (p: Paise): Paise => (p < 0n ? -p : p);
export const min = (a: Paise, b: Paise): Paise => (a < b ? a : b);
export const max = (a: Paise, b: Paise): Paise => (a > b ? a : b);

/**
 * Rounds numerator / denominator to the nearest integer, halves away from zero.
 * Matches PostgreSQL NUMERIC round() so app previews equal what the database stores.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** Rates like "18", "1.5", "0.75" as integer thousandths of a percent (18 -> 18000). */
export function toRateMilli(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(text);
  if (!match) throw new MoneyError("Rate must be a number with up to 3 decimals");
  return BigInt(match[1]) * 1000n + BigInt(((match[2] ?? "") + "000").slice(0, 3));
}

/** amount * rate% rounded to paise. rateMilli is thousandths of a percent. */
export function percentOf(amount: Paise, rateMilli: bigint): Paise {
  return divRound(amount * rateMilli, 100_000n);
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,17,000 (or ₹1,17,000.50 when there are paise). Formats from the exact decimal string, never through a lossy float sum. */
export function formatINR(paise: Paise, options: { sign?: boolean; compact?: boolean; paise?: boolean } = {}): string {
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  let text: string;
  if (options.compact && absolute >= 10_000_000n) {
    text = compactINR(absolute);
  } else {
    // Intl only sees whole rupees as a safe integer; paise are appended exactly.
    const rupees = absolute / 100n;
    const whole = inrFormatter.format(Number(rupees)).replace(/\.00$/, "");
    const paisePart = absolute % 100n;
    // Whole rupees read cleaner without ".00"; real paise are always shown, never rounded away.
    text = paisePart === 0n && !options.paise ? whole : `${whole}.${paisePart.toString().padStart(2, "0")}`;
  }
  if (negative) return `−${text}`;
  return options.sign && paise > 0n ? `+${text}` : text;
}

function compactINR(absolute: Paise): string {
  const rupees = Number(absolute / 100n);
  if (rupees >= 1e7) return `₹${trimZeros((rupees / 1e7).toFixed(2))} Cr`;
  return `₹${trimZeros((rupees / 1e5).toFixed(2))} L`;
}

const trimZeros = (s: string) => s.replace(/\.?0+$/, "");

/** Splits a formatted amount into rupees and paise parts for display typography. */
export function splitINR(paise: Paise): { sign: string; whole: string; fraction: string } {
  const full = formatINR(abs(paise));
  const [whole, fraction] = full.split(".");
  return { sign: paise < 0n ? "−" : "", whole, fraction: fraction ?? "" };
}
