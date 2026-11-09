import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { loadBooksInput } from "./books-load";
import { computeBooks, profitAndLoss } from "@/lib/domain/books";

/**
 * Accounting heads the way Tally uses them: a bank ledger whose plain money in counts as direct
 * income and money out as direct expense, expense categories that are direct or indirect, and
 * gross and net profit from them.
 */
const OWNER = "user_heads_owner";
const j = (v: unknown) => JSON.stringify(v);
const r = (rupees: number) => BigInt(Math.round(rupees * 100));

let db: Db;
let ws: string;
let bank: string;
let cash: string;
let billed: string;
const cats: Record<string, string> = {};

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const post = (x: Record<string, unknown>) =>
  rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: bank, txn_date: "2026-01-10", kind: "regular", status: "posted", ...x })]);
const books = async () => computeBooks(await loadBooksInput(db, ws, OWNER));
const setBooks = (id: string, p: Record<string, unknown>) => rpc(db, OWNER, "public.set_ledger_books($1, $2::jsonb)", [id, j(p)]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Dhiraj Enterprises", "Vishwa", null]);
  // A bank account that also records GST and TDS on what comes in: a taxation ledger kept as a wallet.
  bank = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Rishabh Sales Creative", ledger_type: "taxation", wallet_kind: "bank", opening_balance: "0" })]);
  cash = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'", [ws])).id;
  for (const c of await as(db, OWNER, (q) => q<{ id: string; name: string }>("select id, name from public.expense_categories where workspace_id = $1", [ws]))) cats[c.name] = c.id;
  await post({ direction: "in", amount: "1000000", description: "Received" });
  await post({ direction: "in", amount: "1000000", description: "Received" });
  billed = (await post({ direction: "in", amount: "1000000", tax: { taxable_amount: "1000000", gst_applicable: true, gst_rate: "18", tds_applicable: true, tds_rate: "1", tds_base: "taxable" } })).id;
  await post({ direction: "out", amount: "759000", description: "Labour" });
  await post({ direction: "out", amount: "200000", description: "Material" });
});

describe("a bank ledger's usual heads", () => {
  it("before: every plain entry is uncategorised, and a bill that does not match is flagged", async () => {
    const b = await books();
    expect(b.uncategorised).toBe(r(2041000));
    expect(b.uncategorisedEntries).toHaveLength(5);
    expect(b.taxMismatches).toHaveLength(1); // ₹10,00,000 entered, the bill says ₹11,70,000 after TDS
    expect(b.difference).toBe(0n);
  });

  it("after: money in is direct income and money out direct expense, for every unmarked entry", async () => {
    await setBooks(bank, { default_in_nature: "direct_income", default_out_nature: "direct_expense" });
    const b = await books();
    expect(b.uncategorised).toBe(0n);
    expect(b.uncategorisedEntries).toHaveLength(0);
    expect(b.bank).toBe(r(2041000));
    const pnl = profitAndLoss(b.lines);
    expect(pnl.grossProfit).toBe(r(2041000)); // the mismatched receipt counts as entered
    expect(pnl.profit).toBe(r(2041000));
    expect(b.difference).toBe(0n);
  });

  it("when the entry is the bill's figure after TDS, only the amount before tax is income", async () => {
    await rpc(db, OWNER, "public.amend_transaction($1, $2::jsonb)", [billed, j({ amount: "1170000" })]);
    const b = await books();
    expect(b.taxMismatches).toHaveLength(0);
    expect(b.gstPayable).toBe(r(180000));
    expect(b.tdsReceivable).toBe(r(10000));
    expect(b.profit).toBe(r(2041000)); // 20,00,000 + 10,00,000 before tax − 9,59,000
    expect(b.bank).toBe(r(2211000));
    expect(b.difference).toBe(0n);
  });

  it("an entry's own head wins over the ledger's", async () => {
    const t = await post({ direction: "in", amount: "50000", description: "Owner put money in" });
    await rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [t.id, j({ nature: "capital" })]);
    const b = await books();
    expect(b.introduced).toBe(r(50000));
    expect(b.profit).toBe(r(2041000));
    expect(b.difference).toBe(0n);
  });

  it("a reversed entry takes back exactly what it counted", async () => {
    const before = await books();
    const t = await post({ direction: "out", amount: "12345" });
    await rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [t.id, "Wrong", "2026-01-11"]);
    const b = await books();
    expect(b.profit).toBe(before.profit);
    expect(b.difference).toBe(0n);
  });

  it("a ledger with no heads set assumes nothing: a cash deposit is not income", async () => {
    const t = await rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: cash, txn_date: "2026-02-07", direction: "in", kind: "regular", status: "posted", amount: "100" })]);
    const b = await books();
    expect(b.uncategorisedEntries.map((x) => x.id)).toContain(t.id);
  });

  it("only a cash or bank ledger takes usual heads", async () => {
    const c = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Party', 'business', $2) returning id`, [ws, OWNER])).id;
    const party = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Party", ledger_type: "basic", contractor_id: c, opening_balance: "0" })]);
    await expect(setBooks(party, { default_in_nature: "direct_income" })).rejects.toThrow(/Only a cash or bank ledger/);
  });
});

describe("direct and indirect expenses", () => {
  it("labour and material start as direct; office as indirect; gross and net profit follow", async () => {
    const heads = await as(db, OWNER, (q) => q<{ name: string; head: string }>("select name, head from public.expense_categories where workspace_id = $1 order by name", [ws]));
    expect(heads.find((h) => h.name === "Labour")!.head).toBe("direct");
    expect(heads.find((h) => h.name === "Materials")!.head).toBe("direct");
    expect(heads.find((h) => h.name === "Office")!.head).toBe("indirect");
    const before = profitAndLoss((await books()).lines);
    const expense = (category: string, amount: string) =>
      rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: ws, category_id: cats[category], expense_date: "2026-03-01", title: category, amount, ledger_id: bank })]);
    await expense("Labour", "1000");
    await expense("Office", "300");
    const after = profitAndLoss((await books()).lines);
    expect(before.grossProfit - after.grossProfit).toBe(r(1000));
    expect(before.profit - after.profit).toBe(r(1300));
  });

  it("a category's head can be changed and the books follow", async () => {
    await rpc(db, OWNER, "public.set_category_head($1, $2)", [cats.Office, "direct"]);
    const pnl = profitAndLoss((await books()).lines);
    expect(pnl.directCosts.some((l) => l.label === "Office")).toBe(true);
    await expect(rpc(db, OWNER, "public.set_category_head($1, $2)", [cats.Office, "sideways"])).rejects.toThrow(/direct or indirect/);
  });

  it("a new category named Wages starts as direct", async () => {
    const row = await one<{ head: string }>(`insert into public.expense_categories (workspace_id, name) values ($1, 'Wages') returning head`, [ws]);
    expect(row.head).toBe("direct");
  });
});
