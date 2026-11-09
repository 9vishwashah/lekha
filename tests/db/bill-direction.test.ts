import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { loadBooksInput } from "./books-load";
import { computeBooks, profitAndLoss } from "@/lib/domain/books";
import { BILL_DIRECTION, buildStatement } from "@/lib/domain/ledger";

/**
 * "Bill to party" must raise what the party owes you and count as income; "Bill from party" must
 * raise what you owe them and count as a cost. The entry form reads BILL_DIRECTION, so this pins
 * both the screen and the books.
 */
const OWNER = "user_bill_dir";
const j = (v: unknown) => JSON.stringify(v);
const r = (rupees: number) => BigInt(Math.round(rupees * 100));
let db: Db;
let ws: string;
let client: string;
let ledger: string;

const closing = async () => {
  const rows = await as(db, OWNER, (q) =>
    q<{ seq: number; txn_date: string; direction: "in" | "out"; amount: string; kind: "regular"; is_cash: boolean; affects_party: boolean; status: "posted" }>(
      "select seq, txn_date::text, direction, amount, kind, is_cash, affects_party, status from public.transactions where ledger_id = $1",
      [ledger],
    ),
  );
  return buildStatement({ perspective: "party", opening_balance: "0" }, rows).closing;
};
const bill = (direction: string) =>
  rpc(db, OWNER, "public.post_transaction($1::jsonb)", [
    j({ ledger_id: ledger, txn_date: "2026-02-01", direction, kind: "invoice", status: "posted", tax: { taxable_amount: "1000000", gst_applicable: true, gst_rate: "18", tds_applicable: true, tds_rate: "1", tds_base: "taxable" } }),
  ]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Dhiraj", "Vishwa", null]);
  client = (await as(db, OWNER, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Indrajeet Saini', 'business', $2) returning id`, [ws, OWNER])))[0].id;
  ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Metro Group", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
});

describe("which way a bill goes", () => {
  it("bill to party: they owe you ₹11,70,000 (after TDS), and ₹10,00,000 is income", async () => {
    await bill(BILL_DIRECTION.toParty);
    expect(await closing()).toBe(r(1170000));
    const b = computeBooks(await loadBooksInput(db, ws, OWNER));
    expect(b.positions.get(client)).toBe(r(1170000));
    expect(profitAndLoss(b.lines).directIncome).toEqual([{ label: "Bills raised", amount: r(1000000) }]);
    expect(b.gstPayable).toBe(r(180000));
    expect(b.tdsReceivable).toBe(r(10000));
    expect(b.difference).toBe(0n);
  });

  it("bill from party: you owe them, and it is a cost", async () => {
    await bill(BILL_DIRECTION.fromParty);
    expect(await closing()).toBe(0n); // the two bills cancel on the same ledger
    const pnl = profitAndLoss(computeBooks(await loadBooksInput(db, ws, OWNER)).lines);
    expect(pnl.directCosts).toEqual([{ label: "Bills received", amount: r(1000000) }]);
  });

  it("the client then pays the bill to them: money in settles it", async () => {
    await rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledger, txn_date: "2026-02-10", direction: "in", kind: "regular", status: "posted", amount: "1170000" })]);
    expect(await closing()).toBe(-r(1170000)); // only the bill from them is left: you owe them
  });
});
