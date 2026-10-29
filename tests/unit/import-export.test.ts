import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

vi.mock("server-only", () => ({}));

import { readWorkbook } from "@/lib/import/workbook";
import { detectHeader, guessLayout, parseDate, parseRows, summarise, toImportRows } from "@/lib/import/parse";
import { basicWorkbook, taxationWorkbook } from "../fixtures/make-workbooks";
import { ledgerStatementTable, taxSummaryTable } from "@/lib/reports";
import { toCSV } from "@/lib/export/table";
import { toXLSX } from "@/lib/export/xlsx";
import { toPDF } from "@/lib/export/pdf";
import { buildStatement } from "@/lib/domain/ledger";
import { taxSummary } from "@/lib/domain/tax-summary";
import { toPaise } from "@/lib/domain/money";
import { openToken, sealToken, newToken } from "@/lib/server/tokens";

describe("date parsing", () => {
  it("handles Excel serials, ISO, DD/MM/YYYY and month names", () => {
    expect(parseDate(46115)).toBe("2026-04-03");
    expect(parseDate("2026-04-01")).toBe("2026-04-01");
    expect(parseDate("05/04/2026")).toBe("2026-04-05");
    expect(parseDate("6/4/26")).toBe("2026-04-06");
    expect(parseDate("06-Apr-26")).toBe("2026-04-06");
    expect(parseDate("12 September 2026")).toBe("2026-09-12");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("hello")).toBeNull();
  });
});

describe("basic workbook import", () => {
  it("finds the right sheet and header, and never silently drops a row", async () => {
    const { sheets, fileHash } = await readWorkbook(await basicWorkbook());
    expect(fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sheets.map((s) => s.name)).toEqual(["Notes", "Transactions"]);
    const sheet = sheets[1];
    const header = detectHeader(sheet.grid);
    expect(header.headerRow).toBe(2);
    expect(header.mapping).toMatchObject({ srno: 0, date: 1, payee: 2, credit: 3, debit: 4, balance: 5 });
    expect(guessLayout(header.mapping)).toBe("basic");

    const rows = parseRows(sheet.grid, header.headerRow, header.mapping);
    const byRow = new Map(rows.map((r) => [r.row, r]));
    expect(byRow.get(4)).toMatchObject({ status: "ok", date: "2026-04-01", direction: "in", amount: "50000.00" });
    expect(byRow.get(5)).toMatchObject({ status: "ok", date: "2026-04-03", direction: "out", amount: "8400.00" });
    expect(byRow.get(6)).toMatchObject({ status: "ok", amount: "12500.00" }); // missing SR. NO. is fine
    expect(byRow.get(7)?.status).toBe("blank");
    expect(byRow.get(9)?.status).toBe("warning"); // same date, amount and payee as row 8
    expect(byRow.get(10)?.status).toBe("invalid"); // 31/02 is not a date
    expect(byRow.get(11)?.messages.join()).toMatch(/both credit and debit/);
    expect(byRow.get(12)?.status).toBe("summary"); // TOTAL
    expect(byRow.get(13)?.status).toBe("summary"); // stray running balance cell

    const s = summarise(rows);
    expect(s).toMatchObject({ ok: 4, warning: 1, invalid: 2, summary: 2, blank: 1, importable: 5 });
    // Every non-blank spreadsheet row is accounted for.
    expect(s.ok + s.warning + s.invalid + s.summary + s.blank).toBe(sheet.grid.length - header.headerRow - 1);
    // The running balance column is never imported; balances are recalculated from entries.
    const payload = toImportRows(rows);
    expect(payload.every((r) => !("balance" in r))).toBe(true);
    const statement = buildStatement(
      { perspective: "cashbook", opening_balance: "0" },
      payload.map((r, i) => ({ seq: i + 1, txn_date: r.txn_date!, direction: r.direction!, amount: r.amount!, kind: "regular", is_cash: true, affects_party: true, status: "posted" })),
    );
    expect(statement.closing).toBe(toPaise("31500")); // matches the sheet's own final balance
  });

  it("can fill missing dates from the previous row when asked", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["DATE", "PAYEE", "CREDIT", "DEBIT"]);
    ws.addRow(["01/04/2026", "A", 100, null]);
    ws.addRow([null, "B", null, 40]);
    const { sheets } = await readWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const h = detectHeader(sheets[0].grid);
    expect(parseRows(sheets[0].grid, h.headerRow, h.mapping)[1].status).toBe("invalid");
    const filled = parseRows(sheets[0].grid, h.headerRow, h.mapping, { fillMissingDates: true })[1];
    expect(filled).toMatchObject({ status: "warning", date: "2026-04-01" });
  });
});

describe("taxation workbook import", () => {
  it("maps BILL AMT / GST / TDS / AFTER TDS and flags inconsistent sheet maths", async () => {
    const { sheets } = await readWorkbook(await taxationWorkbook());
    const sheet = sheets[0];
    const header = detectHeader(sheet.grid);
    expect(guessLayout(header.mapping)).toBe("taxation");
    const rows = parseRows(sheet.grid, header.headerRow, header.mapping, { billDirection: "out" });
    expect(rows[0]).toMatchObject({
      status: "ok",
      direction: "out",
      amount: null,
      tax: { taxable_amount: "1000000.00", gst_amount: "180000.00", tds_amount: "10000.00" },
    });
    expect(rows[1]).toMatchObject({ direction: "out", amount: "500000.00", tax: null });
    expect(rows[3].status).toBe("warning");
    expect(rows[3].messages[0]).toMatch(/234000.00/);
    expect(rows[4].status).toBe("summary");
  });
});

const txn = (seq: number, date: string, direction: "in" | "out", amount: string, extra = {}) => ({
  seq,
  voucher_no: `TX-${String(seq).padStart(4, "0")}`,
  txn_date: date,
  direction,
  amount,
  kind: "regular" as const,
  is_cash: true,
  affects_party: true,
  status: "posted" as const,
  description: `Entry ${seq}`,
  counterparty: "Ramesh",
  reference_no: "R1",
  ...extra,
});

describe("exports reconcile with the statement", () => {
  const ledger = { name: "Ramesh site", ledger_type: "basic", perspective: "cashbook" as const, opening_balance: "1000" };
  const txns = [
    txn(1, "2026-04-01", "in", "10000"),
    txn(2, "2026-04-02", "out", "2500.50"),
    txn(3, "2026-04-03", "out", "99", { status: "void" as const }),
    txn(4, "2026-04-04", "out", "1000", { status: "draft" as const }),
  ];

  it("uses the same totals as buildStatement and marks void and draft rows", () => {
    const table = ledgerStatementTable({ ledger, txns, range: {}, includeTax: false });
    const s = buildStatement(ledger, txns);
    expect(table.totals?.running).toBe(s.closing);
    expect(table.totals?.credit).toBe(toPaise("10000"));
    expect(table.totals?.debit).toBe(toPaise("2500.50"));
    expect(table.rows.find((r) => r.voucher === "TX-0003")?.description).toMatch(/VOID/);
    expect(table.rows.find((r) => r.voucher === "TX-0004")?.description).toMatch(/DRAFT/);
    expect(table.summary.find((x) => x.label.startsWith("Closing"))?.value).toBe("₹8,499.50");
  });

  it("hides fields a public link does not allow", () => {
    const table = ledgerStatementTable({ ledger, txns, range: {}, includeTax: false, includeBalance: false, includeReference: false, includeCounterparty: false, includeDrafts: false });
    const keys = table.columns.map((c) => c.key);
    expect(keys).not.toContain("reference");
    expect(keys).not.toContain("party");
    expect(keys).not.toContain("running");
    expect(table.summary.some((s) => s.label.includes("balance"))).toBe(false);
    expect(table.rows).toHaveLength(2); // public statements carry posted entries only
  });

  it("writes CSV with exact decimals, guards against formula injection, and keeps a BOM", () => {
    const table = ledgerStatementTable({ ledger, txns: [txn(1, "2026-04-01", "in", "10000", { description: "=HYPERLINK(1)" })], range: {}, includeTax: false });
    const csv = toCSV(table);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("10000.00");
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
  });

  it("produces a real XLSX whose numbers match", async () => {
    const table = ledgerStatementTable({ ledger, txns, range: {}, includeTax: false });
    const buffer = await toXLSX([table], { creator: "Test" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(new Uint8Array(buffer).buffer);
    const ws = wb.worksheets[0];
    const values: unknown[] = [];
    ws.eachRow((row) => values.push(...(row.values as unknown[])));
    expect(values).toContain(10000);
    expect(values).toContain(2500.5);
    expect(values).toContain(8499.5);
  });

  it("produces a landscape PDF for a taxation summary, with the rupee sign embedded", async () => {
    const summary = taxSummary(
      [{ txn_date: "2026-04-10", status: "posted", reversed: false, invoice_date: null, taxable_amount: "1000000", cgst_amount: "90000", sgst_amount: "90000", igst_amount: "0", gst_amount: "180000", tds_amount: "10000", gross_amount: "1180000", net_amount: "1170000" }],
      [],
      "invoice",
    );
    const table = taxSummaryTable(summary, { title: "Monthly tax summary", basis: "invoice", range: {} });
    expect(table.landscape).toBe(true);
    const pdf = await toPDF(table, { business: "Test", generatedAt: "today" });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
  });
});

describe("share tokens", () => {
  it("are unguessable and can be sealed and reopened only with the server key", () => {
    process.env.SHARE_LINK_SECRET = Buffer.alloc(32, 7).toString("base64");
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
    const sealed = sealToken(token)!;
    expect(sealed).not.toContain(token);
    expect(openToken(sealed)).toBe(token);
    process.env.SHARE_LINK_SECRET = Buffer.alloc(32, 8).toString("base64");
    expect(openToken(sealed)).toBeNull();
  });
});
