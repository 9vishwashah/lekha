import { describe, expect, it } from "vitest";
import { type Word, looksScrambled, wordsToGrid } from "@/lib/import/statement";
import { detectHeader, parseRows, summarise } from "@/lib/import/parse";

/** Places words on a line: [text, x0, x1] at a given y (top), height 8. */
const line = (page: number, y: number, parts: [string, number, number][]): Word[] =>
  parts.map(([text, x0, x1]) => ({ page, text, x0, x1, y0: y, y1: y + 8 }));

const HEADER = (page: number, y: number) =>
  line(page, y, [
    ["Date", 20, 40], ["Tran", 80, 98], ["Id", 101, 108], ["Transaction", 180, 225], ["Particulars", 228, 270],
    ["Withdrawal", 340, 385], ["(INR)", 388, 410], ["Deposits", 430, 465], ["(INR)", 468, 490], ["Balance", 505, 535], ["(INR)", 538, 560],
  ]);

const passbook: Word[] = [
  ...line(1, 40, [["Account", 20, 50], ["Details", 53, 80], ["Transaction", 280, 330], ["Period:", 333, 360], ["01-09-2026", 363, 405]]),
  ...line(1, 60, [["Opening", 20, 50], ["date", 53, 70], ["of", 73, 80], ["account", 83, 110]]),
  ...HEADER(1, 100),
  ...line(1, 120, [["01-09-2026", 20, 65], ["S80901755", 80, 120], ["UPI~0817~DR~CHALO~", 140, 300], ["15.00", 390, 410], ["1,430.58", 525, 560]]),
  ...line(1, 140, [["01-09-2026", 20, 65], ["S96404769", 80, 120], ["UPI~6244~DR~VISHWA", 140, 300], ["75.00", 390, 410], ["1,355.58", 525, 560]]),
  ...line(1, 149, [["ALP~IPOS~shop", 140, 220]]), // wrapped narration
  ...line(1, 170, [["05-09-2026", 20, 65], ["S82715435", 80, 120], ["UPI~1966~CR~SADATTVA", 140, 300], ["6,000.00", 455, 490], ["7,355.58", 525, 560]]),
  ...line(1, 190, [["05-09-2026", 20, 65], ["S94802783", 80, 120], ["UPI~1723~DR~Om", 140, 280], ["sai", 345, 360], ["110.00", 385, 410], ["7,245.58", 525, 560]]),
  ...line(1, 400, [["Page", 280, 300], ["1", 303, 308]]),
  // Page 2 repeats the header
  ...HEADER(2, 30),
  ...line(2, 50, [["06-09-2026", 20, 65], ["S16139850", 80, 120], ["NEFT-IN-LITTLE", 140, 300], ["2,000.00", 455, 490], ["9,245.58", 525, 560]]),
  ...line(2, 300, [["This", 20, 40], ["is", 43, 50], ["a", 53, 56], ["computer", 59, 100], ["generated", 103, 140], ["statement", 143, 180]]),
];

describe("bank statement PDFs", () => {
  it("turns positioned words into the importer's grid: header, one row per transaction", () => {
    const g = wordsToGrid(passbook)!;
    expect(g.grid[0]).toEqual(["Date", "Tran Id", "Transaction Particulars", "Withdrawal (INR)", "Deposits (INR)", "Balance (INR)"]);
    expect(g.rows).toBe(5);
  });

  it("maps bank headings and reads every row correctly", () => {
    const g = wordsToGrid(passbook)!;
    const h = detectHeader(g.grid);
    expect(h.mapping).toMatchObject({ date: 0, reference: 1, payee: 2, debit: 3, credit: 4, balance: 5 });
    const rows = parseRows(g.grid, h.headerRow, h.mapping);
    expect(rows.map((r) => [r.date, r.direction, r.amount, r.reference])).toEqual([
      ["2026-09-01", "out", "15.00", "S80901755"],
      ["2026-09-01", "out", "75.00", "S96404769"],
      ["2026-09-05", "in", "6000.00", "S82715435"],
      ["2026-09-05", "out", "110.00", "S94802783"],
      ["2026-09-06", "in", "2000.00", "S16139850"],
    ]);
    expect(rows.every((r) => r.status === "ok")).toBe(true);
    const s = summarise(rows);
    expect(s.credits).toBe(800000n);
    expect(s.debits).toBe(20000n);
  });

  it("joins a wrapped narration to its row, and keeps stray words out of amount columns", () => {
    const g = wordsToGrid(passbook)!;
    expect(g.grid[2][2]).toBe("UPI~6244~DR~VISHWA ALP~IPOS~shop");
    expect(g.grid[4][2]).toBe("UPI~1723~DR~Om sai");
    expect(g.grid[4][3]).toBe("110.00");
  });

  it("splits a single Amount column with Dr/Cr into debit and credit", () => {
    const words = [
      ...line(1, 10, [["Txn", 20, 35], ["Date", 38, 55], ["Narration", 100, 150], ["Amount", 300, 340], ["Dr/Cr", 360, 385]]),
      ...line(1, 30, [["02/10/2026", 20, 65], ["Rent", 100, 130], ["12,000.00", 300, 340], ["Dr", 365, 375]]),
      ...line(1, 50, [["03/10/2026", 20, 65], ["Salary", 100, 135], ["50,000.00", 300, 340], ["Cr", 365, 375]]),
    ];
    const g = wordsToGrid(words)!;
    const h = detectHeader(g.grid);
    const rows = parseRows(g.grid, h.headerRow, h.mapping);
    expect(rows.map((r) => [r.date, r.direction, r.amount])).toEqual([
      ["2026-10-02", "out", "12000.00"],
      ["2026-10-03", "in", "50000.00"],
    ]);
  });

  it("returns nothing when there is no statement table", () => {
    expect(wordsToGrid(line(1, 10, [["Hello", 0, 30], ["world", 35, 60]]))).toBeNull();
  });

  it("recognises scrambled PDF text so OCR is used instead", () => {
    expect(looksScrambled(line(1, 0, [['!"#', 0, 10], ["$%!&'()", 20, 40], ["$%!&*!+\",-&'.!%\",+/0!%*", 50, 120], ["1,\"2)%!3!04(567", 130, 170]]))).toBe(true);
    expect(looksScrambled(passbook)).toBe(false);
  });
});
