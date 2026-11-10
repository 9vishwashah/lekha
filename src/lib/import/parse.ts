import { type Paise, toDecimal, tryPaise } from "@/lib/domain/money";

/**
 * Spreadsheet import. Pure functions over a grid of cell values, so the same code runs on the
 * server (first read) and in the browser (re-mapping without re-uploading).
 *
 * Nothing is silently dropped: every row comes back with a status and the reasons for it.
 * Totals and running-balance cells are never imported; balances are recalculated afterwards.
 */
export type Cell = string | number | boolean | null;
export type Grid = Cell[][];

export const FIELDS = ["srno", "date", "payee", "credit", "debit", "bill", "gst", "tds", "after_tds", "balance", "reference"] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, number>>;

export const FIELD_LABEL: Record<Field, string> = {
  srno: "Sr. No.",
  date: "Date",
  payee: "Payee / Name",
  credit: "Credit (Money In)",
  debit: "Debit (Money Out)",
  bill: "Bill amount",
  gst: "GST",
  tds: "TDS",
  after_tds: "After TDS",
  balance: "Balance (ignored)",
  reference: "Reference",
};

const SYNONYMS: Record<Field, string[]> = {
  srno: ["sr no", "srno", "sr", "s no", "sno", "serial", "sl no", "no"],
  date: ["date", "dt", "txn date", "transaction date", "entry date", "tran date", "post date", "posting date", "value date"],
  payee: ["payee", "name", "particulars", "party", "description", "narration", "details", "payee name", "transaction particulars", "transaction details", "transaction remarks", "remarks"],
  credit: ["credit", "cr", "received", "money in", "receipt", "receipts", "credit amount", "credits", "deposit", "deposits", "deposit amt", "deposit amount", "credit amt"],
  debit: ["debit", "dr", "paid", "money out", "payment", "payments", "debit amount", "debits", "withdrawal", "withdrawals", "withdrawal amt", "withdrawal amount", "debit amt"],
  bill: ["bill amt", "bill amount", "bill", "taxable", "taxable amount", "invoice amount", "basic amount"],
  gst: ["gst", "gst amount", "igst", "tax"],
  tds: ["tds", "tds amount"],
  after_tds: ["after tds", "net", "net amount", "amount after tds", "net payable"],
  balance: ["balance", "bal", "running balance", "closing balance"],
  reference: ["ref", "reference", "ref no", "cheque no", "utr", "receipt no", "voucher no", "tran id", "transaction id", "txn id", "chq no", "chq ref no", "cheque ref no", "chq ref", "ref no cheque no", "utr no"],
};

const normalise = (v: Cell) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Finds the most likely header row in the first 30 rows and maps its columns. */
export function detectHeader(grid: Grid): { headerRow: number; mapping: Mapping; confidence: number } {
  let best = { headerRow: -1, mapping: {} as Mapping, confidence: 0 };
  const limit = Math.min(grid.length, 30);
  for (let r = 0; r < limit; r++) {
    const mapping: Mapping = {};
    grid[r].forEach((cell, c) => {
      const text = normalise(cell);
      if (!text) return;
      // Bank statements add the currency to headings: "Withdrawal (INR)", "Balance (Rs.)".
      const bare = text.replace(/\b(inr|rs|in rs|in inr)\b/g, "").replace(/\s+/g, " ").trim();
      for (const field of FIELDS) {
        if (mapping[field] !== undefined) continue;
        if (SYNONYMS[field].includes(text) || SYNONYMS[field].includes(bare)) {
          mapping[field] = c;
          return;
        }
      }
    });
    const score = Object.keys(mapping).length + (mapping.date !== undefined ? 1 : 0);
    if (score > best.confidence) best = { headerRow: r, mapping, confidence: score };
  }
  return best;
}

export function guessLayout(mapping: Mapping): "basic" | "taxation" {
  return mapping.bill !== undefined || mapping.gst !== undefined || mapping.tds !== undefined ? "taxation" : "basic";
}

// ---------------------------------------------------------------------------------------------
// Dates: Excel serials, Date-derived ISO strings, and Indian DD/MM/YYYY text.
// ---------------------------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const validDate = (y: number, m: number, d: number) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

export function parseDate(value: Cell): string | null {
  if (value === null || value === "" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    // Excel 1900 date system serial (with the 1900 leap-year bug already baked into the epoch).
    if (value < 20000 || value > 80000) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    return validDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const text = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(text);
  if (m) return validDate(fullYear(+m[3]), +m[2], +m[1]); // Indian order: day first
  m = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,9})[\s\-/,]*(\d{2}|\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return validDate(fullYear(+m[3]), month, +m[1]);
  }
  return null;
}

function parseAmount(value: Cell): { paise: Paise | null; error?: string } {
  if (value === null || value === "" || value === "-" || value === 0) return { paise: null };
  if (typeof value === "boolean") return { paise: null, error: "Amount is not a number" };
  const cleaned = typeof value === "number" ? value : value.replace(/\((.*)\)/, "-$1").replace(/rs\.?|inr/gi, "");
  const paise = tryPaise(cleaned as string | number);
  if (paise === null) return { paise: null, error: `"${value}" is not an amount` };
  if (paise === 0n) return { paise: null };
  return { paise };
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------
export type RowStatus = "ok" | "warning" | "invalid" | "summary" | "blank";

export interface ParsedRow {
  row: number; // 1-based spreadsheet row
  status: RowStatus;
  messages: string[];
  date: string | null;
  payee: string | null;
  reference: string | null;
  direction: "in" | "out" | null;
  amount: string | null;
  tax: { taxable_amount: string; gst_amount: string; tds_amount: string } | null;
  raw: Cell[];
}

export interface ParseOptions {
  fillMissingDates?: boolean;
  /** Treat bill rows without cash as bills received (in) or raised (out). */
  billDirection?: "in" | "out";
}

const SUMMARY = /\b(total|grand total|sub ?total|closing|opening balance|balance b ?f|balance c ?f|b ?f|c ?f|carried forward|brought forward)\b/i;

export function parseRows(grid: Grid, headerRow: number, mapping: Mapping, options: ParseOptions = {}): ParsedRow[] {
  const out: ParsedRow[] = [];
  const seen = new Map<string, number>();
  let lastDate: string | null = null;
  const cell = (r: Cell[], f: Field) => (mapping[f] === undefined ? null : (r[mapping[f]!] ?? null));

  for (let i = headerRow + 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const result: ParsedRow = {
      row: i + 1,
      status: "ok",
      messages: [],
      date: null,
      payee: null,
      reference: null,
      direction: null,
      amount: null,
      tax: null,
      raw,
    };
    out.push(result);

    if (raw.every((c) => c === null || String(c).trim() === "")) {
      result.status = "blank";
      continue;
    }

    const payeeCell = cell(raw, "payee");
    result.payee = payeeCell === null ? null : String(payeeCell).trim() || null;
    const refCell = cell(raw, "reference");
    result.reference = refCell === null ? null : String(refCell).trim() || null;

    const credit = parseAmount(cell(raw, "credit"));
    const debit = parseAmount(cell(raw, "debit"));
    const bill = parseAmount(cell(raw, "bill"));
    const gst = parseAmount(cell(raw, "gst"));
    const tds = parseAmount(cell(raw, "tds"));
    const afterTds = parseAmount(cell(raw, "after_tds"));
    for (const [label, r] of [["Credit", credit], ["Debit", debit], ["Bill amount", bill], ["GST", gst], ["TDS", tds]] as const) {
      if (r.error) result.messages.push(`${label}: ${r.error}`);
    }

    const dateCell = cell(raw, "date");
    result.date = parseDate(dateCell);
    const textCells = raw.filter((c) => typeof c === "string").join(" ");

    // Totals and carried-forward lines are reported, never imported.
    const onlyFigures = !result.date && !result.payee && dateCell === null && raw.some((c) => typeof c === "number");
    if (SUMMARY.test(textCells) || onlyFigures) {
      result.status = "summary";
      result.messages.push("Looks like a total or balance line, skipped");
      continue;
    }

    if (!result.date) {
      if (dateCell !== null && String(dateCell).trim() !== "") {
        result.messages.push(`Date "${dateCell}" was not recognised`);
      } else if (options.fillMissingDates && lastDate) {
        result.date = lastDate;
        result.messages.push("Date was empty, used the previous row's date");
      } else {
        result.messages.push("Date is missing");
      }
    }
    if (result.date) lastDate = result.date;

    if (credit.paise !== null && credit.paise < 0n) result.messages.push("Credit is negative");
    if (debit.paise !== null && debit.paise < 0n) result.messages.push("Debit is negative");
    if (credit.paise !== null && debit.paise !== null) {
      result.messages.push("Row has both credit and debit; split it into two rows");
    } else if (credit.paise !== null) {
      result.direction = "in";
      result.amount = toDecimal(credit.paise);
    } else if (debit.paise !== null) {
      result.direction = "out";
      result.amount = toDecimal(debit.paise);
    }

    if (bill.paise !== null) {
      const g = gst.paise ?? 0n;
      const t = tds.paise ?? 0n;
      if (bill.paise < 0n || g < 0n || t < 0n) result.messages.push("Tax amounts cannot be negative");
      result.tax = { taxable_amount: toDecimal(bill.paise), gst_amount: toDecimal(g), tds_amount: toDecimal(t) };
      const net = bill.paise + g - t;
      if (afterTds.paise !== null && afterTds.paise !== net) {
        result.messages.push(`Sheet's After TDS is ${toDecimal(afterTds.paise)} but bill + GST − TDS is ${toDecimal(net)}; the calculated value is used`);
        result.status = "warning";
      }
      if (!result.direction) result.direction = options.billDirection ?? "in";
    } else if (gst.paise !== null || tds.paise !== null) {
      result.messages.push("GST or TDS is filled in without a bill amount");
    }

    if (!result.amount && !result.tax && result.messages.length === 0) {
      result.messages.push("No amount in credit, debit or bill columns");
    }

    const blocking = result.messages.filter(
      (m) => !m.startsWith("Sheet's After TDS") && !m.startsWith("Date was empty"),
    );
    if (blocking.length) {
      result.status = "invalid";
      continue;
    }

    // A reference (bank transaction id, cheque no.) tells apart two same-day payments of the same amount.
    const key = `${result.date}|${result.direction}|${result.amount ?? result.tax?.taxable_amount}|${(result.payee ?? "").toLowerCase()}|${result.reference ?? ""}`;
    const earlier = seen.get(key);
    if (earlier) {
      result.status = "warning";
      result.messages.push(`Looks the same as row ${earlier}`);
    } else seen.set(key, result.row);
    if (result.messages.length && result.status === "ok") result.status = "warning";
  }
  return out;
}

export function summarise(rows: ParsedRow[]) {
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  let credits = 0n;
  let debits = 0n;
  for (const r of rows) {
    if ((r.status === "ok" || r.status === "warning") && r.amount) {
      const v = tryPaise(r.amount) ?? 0n;
      if (r.direction === "in") credits += v;
      else debits += v;
    }
  }
  return {
    ok: count("ok"),
    warning: count("warning"),
    invalid: count("invalid"),
    summary: count("summary"),
    blank: count("blank"),
    importable: count("ok") + count("warning"),
    credits,
    debits,
  };
}

/** Payload rows for import_transactions(); only ok and warning rows, in sheet order. */
export function toImportRows(rows: ParsedRow[]) {
  return rows
    .filter((r) => r.status === "ok" || r.status === "warning")
    .map((r) => ({
      row: r.row,
      txn_date: r.date,
      direction: r.direction,
      amount: r.amount,
      // Bank statement narrations can be long; keep within the stored field sizes.
      description: r.payee?.slice(0, 500) ?? null,
      counterparty: r.payee?.slice(0, 160) ?? null,
      reference_no: r.reference?.slice(0, 80) ?? null,
      ...(r.tax ? { tax: r.tax } : {}),
    }));
}
