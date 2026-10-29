import { describe, expect, it } from "vitest";
import { divRound, formatINR, toDecimal, toPaise } from "@/lib/domain/money";
import { computeTax, explainTax, taxFromAmounts } from "@/lib/domain/tax";
import { type LedgerRow, aggregate, buildStatement, describeBalance } from "@/lib/domain/ledger";
import {
  computeShares,
  expenseEffect,
  maxRepayment,
  participantBalances,
  simplifyDebts,
  viewerSummary,
  type SettlementRecord,
  type SharedExpenseRecord,
} from "@/lib/domain/split";
import { advancePosition, assertAllocationFits } from "@/lib/domain/advances";
import { taxSummary } from "@/lib/domain/tax-summary";
import { financialYear, periodRange } from "@/lib/domain/dates";

const p = toPaise;

describe("money", () => {
  it("parses Indian-formatted amounts exactly", () => {
    expect(p("1,17,000.00")).toBe(11_700_000n);
    expect(p("₹ 10,00,000")).toBe(100_000_000n);
    expect(p("0.1")).toBe(10n);
    expect(p(0.1 + 0.2)).toBe(30n); // binary float noise is snapped once, at the boundary
  });
  it("rejects more than two decimals", () => {
    expect(() => p("10.005")).toThrow();
    expect(p("10.500")).toBe(1050n);
  });
  it("formats with lakh/crore grouping", () => {
    expect(formatINR(11_700_000n)).toBe("₹1,17,000");
    expect(formatINR(11_700_050n)).toBe("₹1,17,000.50");
    expect(formatINR(11_700_000n, { paise: true })).toBe("₹1,17,000.00");
    expect(formatINR(-5_000n)).toBe("−₹50");
    expect(formatINR(1_234_567_890_12n)).toBe("₹1,23,45,67,890.12");
    expect(toDecimal(-123n)).toBe("-1.23");
  });
  it("rounds half away from zero like PostgreSQL", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
  });
});

describe("tax engine", () => {
  it("reproduces the Rishabh Sales workbook example", () => {
    const t = computeTax({
      taxable: p("1000000"),
      gstApplicable: true,
      gstType: "intra",
      gstRate: "18",
      tdsApplicable: true,
      tdsRate: "1",
      tdsBase: "taxable",
    });
    expect(t.gst).toBe(p("180000"));
    expect(t.cgst).toBe(p("90000"));
    expect(t.sgst).toBe(p("90000"));
    expect(t.gross).toBe(p("1180000"));
    expect(t.tds).toBe(p("10000"));
    expect(t.net).toBe(p("1170000"));
    expect(formatINR(t.net)).toBe("₹11,70,000");
  });

  it("supports a configurable TDS base", () => {
    const t = computeTax({
      taxable: p("1000000"),
      gstApplicable: true,
      gstType: "inter",
      gstRate: "18",
      tdsApplicable: true,
      tdsRate: "2",
      tdsBase: "gross",
    });
    expect(t.igst).toBe(p("180000"));
    expect(t.cgst + t.sgst).toBe(0n);
    expect(t.tds).toBe(p("23600"));
    expect(t.net).toBe(p("1156400"));
  });

  it("rounds odd paise consistently and keeps CGST + SGST = GST", () => {
    const t = computeTax({
      taxable: p("333.33"),
      gstApplicable: true,
      gstType: "intra",
      gstRate: "18",
      tdsApplicable: true,
      tdsRate: "0.1",
      tdsBase: "taxable",
    });
    expect(t.gst).toBe(p("60.00")); // 59.9994 -> 60.00
    expect(t.cgst + t.sgst).toBe(t.gst);
    expect(t.tds).toBe(p("0.33"));
    expect(t.net).toBe(t.gross - t.tds);
  });

  it("does nothing when GST and TDS do not apply", () => {
    const t = computeTax({
      taxable: p("500"),
      gstApplicable: false,
      gstType: "intra",
      gstRate: "18",
      tdsApplicable: false,
      tdsRate: "1",
      tdsBase: "taxable",
    });
    expect(t.gstType).toBe("none");
    expect(t.net).toBe(p("500"));
  });

  it("keeps imported amounts and derives effective rates", () => {
    const t = taxFromAmounts(p("1000000"), p("180000"), p("10000"), "intra");
    expect(t.net).toBe(p("1170000"));
    expect(t.gstRateMilli).toBe(18_000n);
    expect(t.tdsRateMilli).toBe(1_000n);
  });

  it("explains every step", () => {
    const t = computeTax({
      taxable: p("1000000"),
      gstApplicable: true,
      gstType: "intra",
      gstRate: "18",
      tdsApplicable: true,
      tdsRate: "1",
      tdsBase: "taxable",
    });
    const lines = explainTax(t, (x) => formatINR(x));
    expect(lines.at(-1)).toBe("Net after TDS = ₹11,80,000 − ₹10,000 = ₹11,70,000");
  });
});

const row = (seq: number, date: string, direction: "in" | "out", amount: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  seq,
  txn_date: date,
  direction,
  amount,
  kind: "regular",
  is_cash: true,
  affects_party: true,
  status: "posted",
  ...extra,
});

describe("ledger statement", () => {
  const rows = [
    row(3, "2026-04-05", "out", "2000"),
    row(1, "2026-04-01", "in", "10000"),
    row(2, "2026-04-01", "out", "1500.50"),
    row(4, "2026-04-06", "in", "999", { status: "draft" }),
    row(5, "2026-04-07", "out", "700", { status: "void" }),
    row(6, "2026-04-08", "in", "5000", { kind: "invoice", is_cash: false }),
  ];

  it("computes running and closing balances from opening + credits − debits", () => {
    const s = buildStatement({ perspective: "cashbook", opening_balance: "1000" }, rows);
    expect(s.lines.map((l) => l.row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.lines.map((l) => toDecimal(l.running))).toEqual([
      "11000.00",
      "9499.50",
      "7499.50",
      "7499.50",
      "7499.50",
      "7499.50",
    ]);
    expect(s.closing).toBe(p("7499.50"));
    expect(s.totals.moneyIn).toBe(p("10000"));
    expect(s.totals.moneyOut).toBe(p("3500.50"));
    expect(s.totals.billsIn).toBe(p("5000"));
    expect(s.totals).toMatchObject({ postedCount: 4, draftCount: 1, voidCount: 1 });
  });

  it("orders same-day entries by sequence number", () => {
    const s = buildStatement({ perspective: "cashbook", opening_balance: "0" }, [
      row(2, "2026-01-01", "out", "50"),
      row(1, "2026-01-01", "in", "100"),
    ]);
    expect(s.lines.map((l) => toDecimal(l.running))).toEqual(["100.00", "50.00"]);
  });

  it("carries earlier entries into the opening balance of a date range", () => {
    const s = buildStatement({ perspective: "cashbook", opening_balance: "1000" }, rows, { from: "2026-04-05" });
    expect(s.opening).toBe(p("9499.50"));
    expect(s.closing).toBe(p("7499.50"));
    expect(s.lines[0].row.seq).toBe(3);
  });

  it("reads party balances from the party's side, including bills", () => {
    const s = buildStatement({ perspective: "party", opening_balance: "0" }, [
      row(1, "2026-04-01", "out", "50000", { kind: "advance_given" }),
      row(2, "2026-04-10", "in", "117000", { kind: "invoice", is_cash: false }),
      row(3, "2026-04-11", "out", "40000"),
      row(4, "2026-04-12", "out", "18000", { kind: "tax_settlement", affects_party: false }),
    ]);
    expect(s.closing).toBe(p("-27000"));
    expect(describeBalance("party", s.closing, "Ramesh").label).toBe("You owe Ramesh");
  });

  it("never calls a positive cashbook balance a debt", () => {
    expect(describeBalance("cashbook", 500n).label).toBe("Balance");
  });

  it("nets a reversal to zero", () => {
    const s = buildStatement({ perspective: "cashbook", opening_balance: "0" }, [
      row(1, "2026-04-01", "out", "250"),
      row(2, "2026-04-02", "in", "250", { kind: "reversal" }),
    ]);
    expect(s.closing).toBe(0n);
  });

  it("keeps cash and party balances apart when aggregating", () => {
    const cash = buildStatement({ perspective: "cashbook", opening_balance: "100" }, []);
    const party = buildStatement({ perspective: "party", opening_balance: "-40" }, []);
    expect(aggregate([cash, party])).toMatchObject({ cashBalance: p("100"), receivable: 0n, payable: p("40") });
  });
});

describe("split engine", () => {
  const V = "vishwa";
  const S = "suraj";
  const R = "rahul";

  const expense = (id: string, total: string, payers: [string, string][], shares: [string, string][]): SharedExpenseRecord => ({
    id,
    status: "posted",
    total_amount: total,
    payers: payers.map(([participant_id, amount_paid]) => ({ participant_id, amount_paid })),
    shares: shares.map(([participant_id, share_amount]) => ({ participant_id, share_amount })),
  });
  const settle = (id: string, from: string, to: string, amount: string): SettlementRecord => ({
    id,
    status: "posted",
    from_participant_id: from,
    to_participant_id: to,
    amount,
  });

  it("splits ₹100 dinner equally: Suraj owes Vishwa ₹50, not ₹100", () => {
    const shares = computeShares(p("100"), "equal", [{ participantId: V }, { participantId: S }]);
    expect(shares.map((s) => s.amount)).toEqual([p("50"), p("50")]);
    const e = expense("e1", "100", [[V, "100"]], shares.map((s) => [s.participantId, toDecimal(s.amount)]));
    const b = participantBalances([V, S], [e], []);
    const debts = simplifyDebts(b, [V, S]);
    expect(debts).toEqual([{ from: S, to: V, amount: p("50") }]);
    const vishwa = viewerSummary(V, b, debts, [e]);
    const suraj = viewerSummary(S, b, debts, [e]);
    expect(vishwa).toMatchObject({ youPaid: p("100"), yourShare: p("50"), net: p("50") });
    expect(suraj).toMatchObject({ youPaid: 0n, yourShare: p("50"), net: p("-50") });
    // Same canonical record, opposite signs.
    expect(vishwa.net + suraj.net).toBe(0n);
    expect(vishwa.totalShared).toBe(suraj.totalShared);
  });

  it("handles uneven shares, partial and full repayment", () => {
    const e = expense("e1", "1000", [[V, "1000"]], [[V, "400"], [S, "600"]]);
    let b = participantBalances([V, S], [e], []);
    expect(maxRepayment(b, S, V)).toBe(p("600"));
    b = participantBalances([V, S], [e], [settle("s1", S, V, "200")]);
    expect(b.get(S)?.net).toBe(p("-400"));
    expect(maxRepayment(b, S, V)).toBe(p("400"));
    b = participantBalances([V, S], [e], [settle("s1", S, V, "200"), settle("s2", S, V, "400")]);
    expect(b.get(S)?.net).toBe(0n);
    expect(b.get(V)?.net).toBe(0n);
    expect(maxRepayment(b, S, V)).toBe(0n);
    expect(simplifyDebts(b, [V, S])).toEqual([]);
  });

  it("never treats a repayment as an expense", () => {
    const e = expense("e1", "100", [[V, "100"]], [[V, "50"], [S, "50"]]);
    const b = participantBalances([V, S], [e], [settle("s1", S, V, "50")]);
    const summary = viewerSummary(V, b, [], [e]);
    expect(summary.totalShared).toBe(p("100"));
    expect(summary.yourShare).toBe(p("50"));
  });

  it("supports percentages, share units and exact amounts that reconcile to the total", () => {
    const pct = computeShares(p("100"), "percent", [
      { participantId: V, input: "33.333" },
      { participantId: S, input: "33.333" },
      { participantId: R, input: "33.334" },
    ]);
    expect(pct.reduce((a, s) => a + s.amount, 0n)).toBe(p("100"));
    const units = computeShares(p("100"), "shares", [
      { participantId: V, input: "2" },
      { participantId: S, input: "1" },
    ]);
    expect(units.map((s) => toDecimal(s.amount))).toEqual(["66.67", "33.33"]);
    expect(() =>
      computeShares(p("100"), "exact", [
        { participantId: V, input: "60" },
        { participantId: S, input: "30" },
      ]),
    ).toThrow(/short/);
    expect(() =>
      computeShares(p("100"), "percent", [
        { participantId: V, input: "60" },
        { participantId: S, input: "30" },
      ]),
    ).toThrow(/100/);
  });

  it("gives leftover paise deterministically in an equal split", () => {
    const shares = computeShares(p("100"), "equal", [{ participantId: V }, { participantId: S }, { participantId: R }]);
    expect(shares.map((s) => toDecimal(s.amount))).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("handles multiple payers and one person covering another's share", () => {
    const e1 = expense("e1", "900", [[V, "600"], [S, "300"]], [[V, "300"], [S, "300"], [R, "300"]]);
    const e2 = expense("e2", "200", [[R, "200"]], [[V, "200"], [S, "0"], [R, "0"]]);
    const b = participantBalances([V, S, R], [e1, e2], []);
    expect(b.get(V)?.net).toBe(p("100"));
    expect(b.get(S)?.net).toBe(0n);
    expect(b.get(R)?.net).toBe(p("-100"));
    expect([...b.values()].reduce((a, x) => a + x.net, 0n)).toBe(0n);
    expect(simplifyDebts(b, [V, S, R])).toEqual([{ from: R, to: V, amount: p("100") }]);
    expect(expenseEffect(e2, V)).toEqual({ paid: 0n, share: p("200"), effect: p("-200") });
  });

  it("accumulates many expenses into one balance and ignores void ones", () => {
    const list = [
      expense("e1", "100", [[V, "100"]], [[V, "50"], [S, "50"]]),
      expense("e2", "300", [[S, "300"]], [[V, "150"], [S, "150"]]),
      { ...expense("e3", "999", [[V, "999"]], [[S, "999"]]), status: "void" as const },
    ];
    const b = participantBalances([V, S], list, []);
    expect(b.get(V)?.net).toBe(p("-100"));
  });
});

describe("advances", () => {
  const advance = { amount: "50000", status: "active" as const, given_date: "2026-04-01", expected_recovery_date: "2026-05-01" };

  it("tracks partial recovery, adjustment and overdue status", () => {
    const pos = advancePosition(
      advance,
      [
        { kind: "recovery", amount: "10000", status: "active" },
        { kind: "adjustment", amount: "15000", status: "active" },
        { kind: "recovery", amount: "5000", status: "void" },
      ],
      "2026-06-01",
    );
    expect(pos).toMatchObject({ recovered: p("10000"), adjusted: p("15000"), outstanding: p("25000"), status: "partially_recovered", overdue: true });
    expect(() => assertAllocationFits(pos, p("25000.01"))).toThrow();
    expect(() => assertAllocationFits(pos, p("25000"))).not.toThrow();
  });

  it("labels an advance fully adjusted against a bill", () => {
    const pos = advancePosition(advance, [{ kind: "adjustment", amount: "50000", status: "active" }], "2026-04-02");
    expect(pos.status).toBe("adjusted");
    expect(pos.outstanding).toBe(0n);
    expect(pos.overdue).toBe(false);
  });
});

describe("tax summary", () => {
  const taxRow = (date: string, extra = {}) => ({
    txn_date: date,
    status: "posted" as const,
    reversed: false,
    invoice_date: null,
    taxable_amount: "1000000",
    cgst_amount: "90000",
    sgst_amount: "90000",
    igst_amount: "0",
    gst_amount: "180000",
    tds_amount: "10000",
    gross_amount: "1180000",
    net_amount: "1170000",
    ...extra,
  });

  it("groups by month, excludes reversed entries and tracks GST paid", () => {
    const s = taxSummary(
      [taxRow("2026-04-10"), taxRow("2026-04-20", { reversed: true }), taxRow("2026-05-02", { invoice_date: "2026-04-30" })],
      [{ txn_date: "2026-05-15", period_month: "2026-04-01", tax_type: "gst", amount: "180000", status: "posted", reversed: false }],
      "invoice",
    );
    expect(s.months).toHaveLength(1);
    expect(s.total.gst).toBe(p("360000"));
    expect(s.total.net).toBe(p("2340000"));
    expect(s.gstOutstanding).toBe(p("180000"));
    const byPayment = taxSummary([taxRow("2026-05-02", { invoice_date: "2026-04-30" })], [], "payment");
    expect(byPayment.months[0].month).toBe("2026-05");
  });
});

describe("dates", () => {
  it("uses an April financial year", () => {
    expect(financialYear("2026-03-31")).toMatchObject({ from: "2025-04-01", to: "2026-03-31", label: "FY 2025–26" });
    expect(financialYear("2026-04-01").from).toBe("2026-04-01");
    expect(periodRange("week", "2026-10-28")).toEqual({ from: "2026-10-26", to: "2026-10-28" });
  });
});
