import { type Paise, sum, toPaise } from "./money";

/**
 * The one place balances are calculated. Ledger screens, the dashboard, reports, exports and the
 * public share page all call buildStatement(), so their totals always agree.
 *
 * Perspectives
 *   cashbook  closing = opening + cash in − cash out       (bills and tax-only rows excluded)
 *   party     closing = opening + out − in                 (positive: the party owes you)
 * Only posted rows count. Drafts and void rows are listed but never affect a total.
 */
export type Direction = "in" | "out";
export type TxnStatus = "draft" | "posted" | "void";
export type TxnKind =
  | "regular"
  | "invoice"
  | "tax_settlement"
  | "advance_given"
  | "advance_recovery"
  | "expense"
  | "reversal";
export type Perspective = "cashbook" | "party";

export interface LedgerRow {
  seq: number;
  txn_date: string; // YYYY-MM-DD
  direction: Direction;
  amount: string;
  kind: TxnKind;
  is_cash: boolean;
  affects_party: boolean;
  status: TxnStatus;
}

export interface StatementLine<T extends LedgerRow> {
  row: T;
  counted: boolean;
  effect: Paise;
  running: Paise;
}

export interface StatementTotals {
  moneyIn: Paise; // posted cash received
  moneyOut: Paise; // posted cash paid
  billsIn: Paise; // posted non-cash credits (e.g. bills received)
  billsOut: Paise; // posted non-cash debits
  postedCount: number;
  draftCount: number;
  voidCount: number;
}

export interface Statement<T extends LedgerRow> {
  perspective: Perspective;
  opening: Paise; // balance at the start of the range
  closing: Paise; // balance at the end of the range
  lines: StatementLine<T>[];
  totals: StatementTotals;
}

export interface DateRange {
  from?: string;
  to?: string;
}

/** Deterministic order: transaction date, then the ledger's own sequence number. */
export function compareRows(a: LedgerRow, b: LedgerRow): number {
  if (a.txn_date !== b.txn_date) return a.txn_date < b.txn_date ? -1 : 1;
  return a.seq - b.seq;
}

/** Signed effect of a row on the ledger balance, or null when it does not count. */
export function balanceEffect(row: LedgerRow, perspective: Perspective): Paise | null {
  if (row.status !== "posted") return null;
  const amount = toPaise(row.amount);
  if (perspective === "cashbook") {
    if (!row.is_cash) return null;
    return row.direction === "in" ? amount : -amount;
  }
  if (!row.affects_party) return null;
  return row.direction === "out" ? amount : -amount;
}

const inRange = (date: string, range: DateRange) =>
  (!range.from || date >= range.from) && (!range.to || date <= range.to);

export function buildStatement<T extends LedgerRow>(
  ledger: { perspective: Perspective; opening_balance: string },
  rows: readonly T[],
  range: DateRange = {},
): Statement<T> {
  const ordered = [...rows].sort(compareRows);
  let balance = toPaise(ledger.opening_balance);
  let opening = balance;
  const lines: StatementLine<T>[] = [];
  const totals: StatementTotals = {
    moneyIn: 0n,
    moneyOut: 0n,
    billsIn: 0n,
    billsOut: 0n,
    postedCount: 0,
    draftCount: 0,
    voidCount: 0,
  };

  for (const row of ordered) {
    const effect = balanceEffect(row, ledger.perspective);
    if (range.from && row.txn_date < range.from) {
      if (effect !== null) balance += effect;
      opening = balance;
      continue;
    }
    if (!inRange(row.txn_date, range)) continue;

    if (effect !== null) balance += effect;
    lines.push({ row, counted: effect !== null, effect: effect ?? 0n, running: balance });

    if (row.status === "draft") totals.draftCount += 1;
    else if (row.status === "void") totals.voidCount += 1;
    else {
      totals.postedCount += 1;
      const amount = toPaise(row.amount);
      if (row.is_cash) {
        if (row.direction === "in") totals.moneyIn += amount;
        else totals.moneyOut += amount;
      } else if (row.direction === "in") totals.billsIn += amount;
      else totals.billsOut += amount;
    }
  }

  return { perspective: ledger.perspective, opening, closing: balance, lines, totals };
}

/** Plain-language meaning of a balance. A cashbook balance is never described as a debt. */
export function describeBalance(perspective: Perspective, balance: Paise, partyName?: string | null) {
  const party = partyName?.trim() || "The party";
  if (perspective === "cashbook") {
    return {
      label: balance < 0n ? "Overspent" : "Balance",
      hint: "Opening balance + money in − money out",
      tone: balance < 0n ? ("negative" as const) : ("neutral" as const),
    };
  }
  if (balance === 0n) return { label: "Settled", hint: "Nothing outstanding", tone: "neutral" as const };
  return balance > 0n
    ? { label: `${party} owes you`, hint: "Paid and billed to them, less received", tone: "positive" as const }
    : { label: `You owe ${party}`, hint: "Bills and receipts exceed what you paid", tone: "negative" as const };
}

/** Totals over many ledgers, kept separate by perspective so cash and party balances never mix. */
export function aggregate<T extends LedgerRow>(statements: Statement<T>[]) {
  const cash = statements.filter((s) => s.perspective === "cashbook");
  const party = statements.filter((s) => s.perspective === "party");
  return {
    moneyIn: sum(statements.map((s) => s.totals.moneyIn)),
    moneyOut: sum(statements.map((s) => s.totals.moneyOut)),
    cashBalance: sum(cash.map((s) => s.closing)),
    receivable: sum(party.map((s) => (s.closing > 0n ? s.closing : 0n))),
    payable: sum(party.map((s) => (s.closing < 0n ? -s.closing : 0n))),
  };
}

export const KIND_LABEL: Record<TxnKind, string> = {
  regular: "Entry",
  invoice: "Bill",
  tax_settlement: "Tax payment",
  advance_given: "Advance given",
  advance_recovery: "Advance recovered",
  expense: "Expense",
  reversal: "Reversal",
};
