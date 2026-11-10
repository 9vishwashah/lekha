import { type Cell, type Grid, parseDate } from "./parse";

/**
 * Bank statements as PDFs. A PDF has no cells, only words at positions (from the PDF's own text,
 * or from OCR when the text is scrambled or the page is a scan). This turns those words back into
 * the same grid an Excel sheet gives, so the rest of the import (column mapping, preview, checks)
 * is shared: header row first, then one row per transaction.
 *
 * Pure function over positions, so it is tested without a browser.
 */
export interface Word {
  page: number;
  text: string;
  x0: number;
  x1: number;
  y0: number; // top
  y1: number; // bottom
}

interface Line {
  page: number;
  y: number;
  height: number;
  words: Word[];
}

const HEADER_WORDS = [
  "date", "particulars", "narration", "description", "remarks", "details", "withdrawal", "withdrawals", "debit", "debits",
  "deposit", "deposits", "credit", "credits", "balance", "amount", "chq", "cheque", "ref", "reference", "tran", "txn", "transaction",
];
const AMOUNT_RE = /^-?\(?[₹]?\d{1,3}(,\d{2,3})*(\.\d{1,2})?\)?(cr|dr)?$|^-?\d+(\.\d{1,2})?(cr|dr)?$/i;
const isNoise = (t: string) => /^[|¦:;_\-–—~.,'"`]+$/.test(t);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z]/g, "");

function toLines(words: Word[]): Line[] {
  const byPage = new Map<number, Word[]>();
  for (const w of words) {
    if (!w.text.trim() || isNoise(w.text.trim())) continue;
    byPage.set(w.page, [...(byPage.get(w.page) ?? []), { ...w, text: w.text.trim() }]);
  }
  const lines: Line[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const ws = byPage.get(page)!.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const heights = ws.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    const tol = Math.max(heights[Math.floor(heights.length / 2)] ?? 8, 4) * 0.55;
    let current: Line | null = null;
    for (const w of ws) {
      const cy = (w.y0 + w.y1) / 2;
      if (current && Math.abs(cy - current.y) <= tol) {
        current.words.push(w);
        current.y = (current.y * (current.words.length - 1) + cy) / current.words.length;
      } else {
        current = { page, y: cy, height: w.y1 - w.y0, words: [w] };
        lines.push(current);
      }
    }
  }
  for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/** Single words of a line, also when the PDF gives a phrase as one piece ("Txn Date"). */
const tokensOf = (line: Line) => line.words.flatMap((w) => w.text.split(/\s+/)).map(norm).filter(Boolean);

const headerScore = (line: Line) => {
  const tokens = new Set(tokensOf(line));
  const hits = HEADER_WORDS.filter((h) => tokens.has(h)).length;
  return tokens.has("date") ? hits : 0;
};

/** Neighbouring words close together form one header cell ("Withdrawal (INR)", "Tran Id"). */
function headerCells(line: Line) {
  const cells: { text: string; x0: number; x1: number }[] = [];
  // About two and a half character widths: the space inside "Tran Id", not the gap between columns.
  const chars = line.words.reduce((n, w) => n + w.text.length, 0);
  const charWidth = line.words.reduce((n, w) => n + (w.x1 - w.x0), 0) / Math.max(chars, 1);
  const gap = Math.max(charWidth * 2.5, line.height * 0.9, 4);
  for (const w of line.words) {
    const last = cells[cells.length - 1];
    if (last && w.x0 - last.x1 <= gap) {
      last.text += ` ${w.text}`;
      last.x1 = w.x1;
    } else cells.push({ text: w.text, x0: w.x0, x1: w.x1 });
  }
  return cells;
}

function columnOf(word: Word, cols: { x0: number; x1: number }[]) {
  let best = -1;
  let bestOverlap = 0;
  cols.forEach((c, i) => {
    const overlap = Math.min(word.x1, c.x1) - Math.max(word.x0, c.x0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  });
  if (best >= 0) return best;
  const cx = (word.x0 + word.x1) / 2;
  let nearest = 0;
  cols.forEach((c, i) => {
    const d = Math.min(Math.abs(cx - c.x0), Math.abs(cx - c.x1), Math.abs(cx - (c.x0 + c.x1) / 2));
    const n = cols[nearest];
    const dn = Math.min(Math.abs(cx - n.x0), Math.abs(cx - n.x1), Math.abs(cx - (n.x0 + n.x1) / 2));
    if (d < dn) nearest = i;
  });
  return nearest;
}

export interface StatementGrid {
  grid: Grid;
  /** Transactions found (rows after the header). */
  rows: number;
}

/**
 * Builds the grid: finds the statement's header line (Date, Particulars, Withdrawal, Deposit,
 * Balance...), uses its positions as columns, starts a new row at every line with a date in the
 * date column, and joins wrapped description lines onto the row above. Repeated headers on later
 * pages, page numbers and footers are left out. Returns null when no statement table is found.
 */
export function wordsToGrid(words: Word[]): StatementGrid | null {
  const lines = toLines(words);
  let headerIndex = -1;
  let bestScore = 1; // need at least "date" and one other heading
  lines.forEach((l, i) => {
    const s = headerScore(l);
    if (s > bestScore) {
      bestScore = s;
      headerIndex = i;
    }
  });
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  const cols = headerCells(header);
  const dateCol = cols.findIndex((c) => /date/i.test(c.text));
  if (dateCol < 0) return null;
  const headerTokens = new Set(tokensOf(header));
  // A "Dr/Cr" or "Type" column holds a marker, not an amount.
  const markerCol = cols.map((c) => /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|txn type)$/i.test(c.text.trim()));
  const amountCol = cols.map((c, i) => !markerCol[i] && /withdraw|deposit|debit|credit|balance|amount|\bdr\b|\bcr\b/i.test(c.text));
  // Transaction id / cheque / reference columns hold a single value; the next words are description.
  const idCol = cols.map((c, i) => i !== dateCol && !amountCol[i] && /\b(id|ref|reference|chq|cheque|utr|no)\b/i.test(c.text));
  const nextTextColumn = (from: number) => {
    for (let i = from + 1; i < cols.length; i++) if (!amountCol[i] && !idCol[i]) return i;
    return from;
  };
  const nearestTextColumn = (from: number) => {
    let best = -1;
    cols.forEach((_, i) => {
      if (!amountCol[i] && i !== dateCol && (best < 0 || Math.abs(i - from) < Math.abs(best - from))) best = i;
    });
    return best < 0 ? from : best;
  };

  const grid: Grid = [cols.map((c) => c.text)];
  let open: { cells: string[]; line: Line } | null = null;
  const flush = () => {
    if (open) grid.push(open.cells.map((c): Cell => (c.trim() ? c.trim() : null)));
    open = null;
  };

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // A header repeated at the top of a later page.
    const tokens = tokensOf(line);
    if (tokens.length && tokens.filter((t) => headerTokens.has(t)).length >= Math.max(3, tokens.length * 0.6)) {
      flush();
      continue;
    }
    const cells = cols.map(() => "");
    const lineHasDate = line.words.some((w) => columnOf(w, cols) === dateCol && parseDate(w.text));
    for (const w of line.words) {
      let c = columnOf(w, cols);
      // Text that spills into an amount column belongs to the nearest text column (the description).
      if (amountCol[c] && !AMOUNT_RE.test(w.text)) c = nearestTextColumn(c);
      // An id column takes one word, and only on the transaction's first line.
      if (idCol[c] && (cells[c] || !lineHasDate)) c = nextTextColumn(c);
      cells[c] = cells[c] ? `${cells[c]} ${w.text}` : w.text;
    }
    // OCR often reads a leading "S" of an id as "$".
    cols.forEach((_, i) => {
      if (idCol[i] && cells[i]) cells[i] = cells[i].replace(/^\$+(?=S)/, "").replace(/^\$(?=[A-Z0-9])/, "S");
    });
    // Dates are sometimes split across two words ("01-09-2026 10:15" or "01 Sep 2026").
    const dateText = cells[dateCol].split(/\s+/);
    const date = parseDate(cells[dateCol]) ?? parseDate(dateText[0] ?? "") ?? parseDate(dateText.slice(0, 3).join(" "));
    if (date) {
      flush();
      open = { cells, line };
      continue;
    }
    if (!open) continue;
    const prev: Line = open.line;
    const near = line.page === prev.page && line.y - prev.y <= Math.max(prev.height, line.height) * 2.6;
    const hasAmount = cells.some((c, ci) => ci !== dateCol && c && AMOUNT_RE.test(c.replace(/\s/g, "")));
    if (near && !hasAmount) {
      cells.forEach((c, ci) => {
        if (c) open!.cells[ci] = open!.cells[ci] ? `${open!.cells[ci]} ${c}` : c;
      });
      open.line = line;
    } else flush();
  }
  flush();
  return splitAmountColumn({ grid, rows: grid.length - 1 });
}

/**
 * Statements with one "Amount" column and a Dr/Cr marker (a column, or a suffix like "1,000.00 Cr")
 * become separate Debit and Credit columns, which the importer understands.
 */
function splitAmountColumn(s: StatementGrid): StatementGrid {
  const head = s.grid[0].map((h) => norm(String(h ?? "")));
  const has = (re: RegExp) => head.some((h) => re.test(h));
  if (has(/^(debit|withdrawal|withdrawals|deposit|deposits|credit|debits|credits)/)) return s;
  const amount = head.findIndex((h) => /^amount/.test(h));
  if (amount < 0) return s;
  const marker = head.findIndex((h) => /^(drcr|crdr|type|txntype)$/.test(h));
  const grid: Grid = [[...s.grid[0], "Debit", "Credit"]];
  for (const row of s.grid.slice(1)) {
    const raw = String(row[amount] ?? "");
    const flag = `${marker >= 0 ? String(row[marker] ?? "") : ""} ${raw}`.toLowerCase();
    const value = raw.replace(/\s*(cr|dr)\.?$/i, "");
    const out = /\bdr\b|dr$|^-/.test(flag.trim()) || /\bdebit\b/.test(flag) ? [value.replace(/^-/, ""), null] : /\bcr\b|cr$|\bcredit\b/.test(flag) ? [null, value] : [null, null];
    grid.push([...row, ...(out as Cell[])]);
  }
  return { grid, rows: s.rows };
}

/** True when a PDF's own text is unreadable (scrambled fonts) and OCR is needed instead. */
export function looksScrambled(words: Word[]): boolean {
  const text = words.map((w) => w.text).join(" ");
  if (text.replace(/\s/g, "").length < 40) return true;
  const sensible = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  return sensible / Math.max(text.replace(/\s/g, "").length, 1) < 0.6;
}
