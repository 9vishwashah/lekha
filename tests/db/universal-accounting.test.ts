import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { computeBooks, type BooksInput } from "@/lib/domain/books";

/**
 * The ten everyday scenarios, one after another in one workspace, through the same database
 * functions the Universal Entry Composer calls. After every step:
 *
 *   Cash + Bank + what people owe you = what you owe people + opening capital + profit
 *
 * (Advances are part of what someone owes you, so they sit inside the debtors figure.)
 */
const OWNER = "user_universal";
const j = (v: unknown) => JSON.stringify(v);
const r = (rupees: number) => BigInt(Math.round(rupees * 100));

let db: Db;
let ws: string;
let food: string;
let cash: string;
let bank: string;
const people: Record<string, string> = {};

async function load(): Promise<BooksInput> {
  return as(db, OWNER, async (q) => {
    const rows = <T>(sql: string) => q<T>(sql, [ws]);
    const iso = <T extends Record<string, unknown>>(x: T, ...keys: string[]) => {
      const out: Record<string, unknown> = { ...x };
      for (const k of keys) out[k] = (x[k] as Date).toISOString().slice(0, 10);
      return out as T;
    };
    const payers = await rows<{ shared_expense_id: string; participant_id: string; amount_paid: string }>("select p.* from public.shared_expense_payers p join public.shared_expenses e on e.id = p.shared_expense_id where e.workspace_id = $1");
    const shares = await rows<{ shared_expense_id: string; participant_id: string; share_amount: string }>("select s.* from public.shared_expense_shares s join public.shared_expenses e on e.id = s.shared_expense_id where e.workspace_id = $1");
    const allocations = await rows<{ advance_id: string; alloc_date: Date }>("select * from public.advance_allocations where workspace_id = $1");
    return {
      ledgers: await rows("select * from public.ledgers where workspace_id = $1"),
      txns: (await rows<BooksInput["txns"][number]>("select * from public.transactions where workspace_id = $1")).map((t) => iso(t, "txn_date")),
      tax: await rows("select * from public.transaction_tax_details where workspace_id = $1"),
      taxSettlements: await rows("select * from public.tax_settlements where workspace_id = $1"),
      invoices: (await rows<BooksInput["invoices"][number]>("select * from public.invoices where workspace_id = $1")).map((i) => iso(i, "invoice_date")),
      payments: await rows("select * from public.invoice_payments where workspace_id = $1"),
      expenses: (await rows<BooksInput["expenses"][number]>("select e.*, c.name as category from public.expenses e join public.expense_categories c on c.id = e.category_id where e.workspace_id = $1")).map((e) => iso(e, "expense_date")),
      advances: (await rows<BooksInput["advances"][number] & { id: string }>("select * from public.advances where workspace_id = $1")).map((a) => ({
        ...a,
        allocations: allocations.filter((x) => x.advance_id === a.id).map((x) => iso(x as unknown as Record<string, unknown>, "alloc_date")) as never,
      })),
      splitGroups: await rows("select * from public.split_groups where workspace_id = $1"),
      participants: await rows("select * from public.ledger_participants where workspace_id = $1"),
      sharedExpenses: (await rows<BooksInput["sharedExpenses"][number]>("select * from public.shared_expenses where workspace_id = $1")).map((e) => ({
        ...iso(e, "txn_date"),
        payers: payers.filter((x) => x.shared_expense_id === e.id),
        shares: shares.filter((x) => x.shared_expense_id === e.id),
      })),
      settlements: await rows("select * from public.settlements where workspace_id = $1"),
    } as BooksInput;
  });
}

/** Asserts the sheet after a step and that it balances with no plug. */
async function expectBooks(want: { cash: number; bank: number; debtors: number; creditors: number; profit: number; who?: Record<string, number> }) {
  const b = computeBooks(await load());
  expect(b.cash).toBe(r(want.cash));
  expect(b.bank).toBe(r(want.bank));
  expect(b.debtors).toBe(r(want.debtors));
  expect(b.creditors).toBe(r(want.creditors));
  expect(b.capital).toBe(r(10969));
  expect(b.profit).toBe(r(want.profit));
  for (const [name, amount] of Object.entries(want.who ?? {})) expect(b.positions.get(people[name]) ?? 0n).toBe(r(amount));
  // No plugs: nothing parked outside the wallets, nothing uncategorised.
  expect(b.pocket).toBe(0n);
  expect(b.uncategorised).toBe(0n);
  expect(b.cash + b.bank + b.debtors).toBe(b.creditors + b.capital + b.profit);
  expect(b.difference).toBe(0n);
  return b;
}

const pay = (who: string, direction: "paid" | "received", amount: string, wallet: string) =>
  rpc(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: ws, contractor_id: people[who], direction, amount, txn_date: "2026-11-08", ledger_id: wallet })]);
const split = (x: Record<string, unknown>) =>
  rpc(db, OWNER, "public.create_split_expense($1::jsonb)", [j({ workspace_id: ws, expense_date: "2026-11-08", category_id: food, ...x })]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Universal", "Vishwa", null]);
  const one = async <T>(sql: string, params: unknown[] = [ws]) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
  food = (await one<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1")).id;
  cash = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'")).id;
  bank = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'bank'")).id;
  for (const name of ["Namya", "Suraj", "Sumit", "Aagam", "Dad"]) {
    people[name] = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, $2, 'personal', $3) returning id`, [ws, name, OWNER])).id;
  }
});

describe("the ten scenarios, step by step", () => {
  it("1. opening wallets: cash 1,000 and bank 9,969", async () => {
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [cash, j({ opening_balance: "1000" })]);
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [bank, j({ opening_balance: "9969" })]);
    await expectBooks({ cash: 1000, bank: 9969, debtors: 0, creditors: 0, profit: 0 });
  });

  it("2. Payment · paid to Namya: 2,699 for Lenskart on their behalf is owed back, not a cost", async () => {
    await pay("Namya", "paid", "2699", bank);
    await expectBooks({ cash: 1000, bank: 7270, debtors: 2699, creditors: 0, profit: 0, who: { Namya: 2699 } });
  });

  it("3. Payment · my expense: lunch 300 from cash", async () => {
    await rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: ws, category_id: food, expense_date: "2026-11-08", title: "Lunch", amount: "300", ledger_id: cash })]);
    await expectBooks({ cash: 700, bank: 7270, debtors: 2699, creditors: 0, profit: -300 });
  });

  it("4. Payment · expense split three ways: dinner 1,500, only my 500 is a cost", async () => {
    await split({ title: "Dinner", amount: "1500", your_share: "500", ledger_id: bank, people: [{ contractor_id: people.Namya, amount: "500" }, { contractor_id: people.Suraj, amount: "500" }] });
    await expectBooks({ cash: 700, bank: 5770, debtors: 3699, creditors: 0, profit: -800, who: { Namya: 3199, Suraj: 500 } });
  });

  it("5. Book entry · bill on Sumit: 5,500 income, owed, no money moves", async () => {
    await rpc(db, OWNER, "public.record_client_bill($1::jsonb)", [j({ workspace_id: ws, contractor_id: people.Sumit, amount: "5500", description: "Website", txn_date: "2026-11-08" })]);
    await expectBooks({ cash: 700, bank: 5770, debtors: 9199, creditors: 0, profit: 4700, who: { Sumit: 5500 } });
  });

  it("6. Book entry · Aagam bills me 2,000 on credit", async () => {
    await split({ title: "Design work", amount: "2000", your_share: "2000", paid_by_contractor_id: people.Aagam, people: [{ contractor_id: people.Aagam, amount: "0" }] });
    await expectBooks({ cash: 700, bank: 5770, debtors: 9199, creditors: 2000, profit: 2700, who: { Aagam: -2000 } });
  });

  it("7. Book entry · Aagam paid 400 for my cab", async () => {
    await split({ title: "Airport cab", amount: "400", your_share: "400", paid_by_contractor_id: people.Aagam, people: [{ contractor_id: people.Aagam, amount: "0" }] });
    await expectBooks({ cash: 700, bank: 5770, debtors: 9199, creditors: 2400, profit: 2300, who: { Aagam: -2400 } });
  });

  it("8. Received · Sumit pays 3,000 into the bank: no new income", async () => {
    await pay("Sumit", "received", "3000", bank);
    await expectBooks({ cash: 700, bank: 8770, debtors: 6199, creditors: 2400, profit: 2300, who: { Sumit: 2500 } });
  });

  it("9. Received · borrowed 1,000 cash from Dad: owed back, not income", async () => {
    await pay("Dad", "received", "1000", cash);
    await expectBooks({ cash: 1700, bank: 8770, debtors: 6199, creditors: 3400, profit: 2300, who: { Dad: -1000 } });
  });

  it("10. Payment · paid Aagam back 1,400", async () => {
    await pay("Aagam", "paid", "1400", bank);
    await expectBooks({ cash: 1700, bank: 7370, debtors: 6199, creditors: 2000, profit: 2300, who: { Aagam: -1000 } });
  });

  it("and a transfer: 500 from bank to cash changes nothing but where it sits", async () => {
    await rpc(db, OWNER, "public.record_transfer($1::jsonb)", [j({ workspace_id: ws, from_ledger_id: bank, to_ledger_id: cash, amount: "500", txn_date: "2026-11-08" })]);
    await expectBooks({ cash: 2200, bank: 6870, debtors: 6199, creditors: 2000, profit: 2300 });
  });

  it("and a party-to-party settle: Namya pays Aagam 1,000 for me", async () => {
    await rpc(db, OWNER, "public.record_party_transfer($1::jsonb)", [j({ workspace_id: ws, from_contractor_id: people.Namya, to_contractor_id: people.Aagam, amount: "1000", txn_date: "2026-11-08" })]);
    await expectBooks({ cash: 2200, bank: 6870, debtors: 5199, creditors: 1000, profit: 2300, who: { Namya: 2199, Aagam: 0 } });
  });

  it("and direct income: 750 cash sale straight into the wallet", async () => {
    await rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: cash, txn_date: "2026-11-08", direction: "in", kind: "regular", status: "posted", amount: "750", nature: "income", description: "Cash sale" })]);
    await expectBooks({ cash: 2950, bank: 6870, debtors: 5199, creditors: 1000, profit: 3050 });
  });
});

describe("the new entries stay whole", () => {
  it("half a transfer cannot be voided, reversed or recategorised; the transfer voids together", async () => {
    const t = await rpc<{ id: string }>(db, OWNER, "public.record_transfer($1::jsonb)", [j({ workspace_id: ws, from_ledger_id: cash, to_ledger_id: bank, amount: "100", txn_date: "2026-11-08" })]);
    const half = (await as(db, OWNER, (q) => q<{ id: string }>("select id from public.transactions where transfer_id = $1 limit 1", [t.id])))[0].id;
    await expect(rpc(db, OWNER, "public.delete_transaction($1)", [half])).rejects.toThrow(/half of a transfer/);
    await expect(rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [half, "x", "2026-11-08"])).rejects.toThrow(/half of a transfer/);
    await expect(rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [half, j({ nature: "income" })])).rejects.toThrow(/transfer/);
    await rpc(db, OWNER, "public.delete_transfer($1)", [t.id]);
    await expectBooks({ cash: 2950, bank: 6870, debtors: 5199, creditors: 1000, profit: 3050 });
  });

  it("a transfer needs two different wallets, both your own", async () => {
    await expect(rpc(db, OWNER, "public.record_transfer($1::jsonb)", [j({ workspace_id: ws, from_ledger_id: cash, to_ledger_id: cash, amount: "1", txn_date: "2026-11-08" })])).rejects.toThrow(/two different/);
  });

  it("voiding one side of a party-to-party settle voids both", async () => {
    const s = await rpc<{ id: string }>(db, OWNER, "public.record_party_transfer($1::jsonb)", [j({ workspace_id: ws, from_contractor_id: people.Sumit, to_contractor_id: people.Dad, amount: "200", txn_date: "2026-11-08" })]);
    const side = (await as(db, OWNER, (q) => q<{ id: string }>("select id from public.settlements where contra_id = $1 limit 1", [s.id])))[0].id;
    await rpc(db, OWNER, "public.delete_settlement($1)", [side]);
    await expectBooks({ cash: 2950, bank: 6870, debtors: 5199, creditors: 1000, profit: 3050 });
  });

  it("a corrected bill is still a bill", async () => {
    const bill = await rpc<{ id: string; ledger_id: string }>(db, OWNER, "public.record_client_bill($1::jsonb)", [j({ workspace_id: ws, contractor_id: people.Suraj, amount: "100", txn_date: "2026-11-08" })]);
    const ps = await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [bill.ledger_id]));
    await rpc(db, OWNER, "public.correct_shared_expense($1, $2::jsonb)", [bill.id, j({ ledger_id: bill.ledger_id, txn_date: "2026-11-08", description: "Bill", total_amount: "150", split_method: "exact", payers: [{ participant_id: ps[0].id, amount: "150" }], shares: [{ participant_id: ps[1].id, amount: "150" }] })]);
    await expectBooks({ cash: 2950, bank: 6870, debtors: 5349, creditors: 1000, profit: 3200 });
  });

  it("a double submit records one transfer", async () => {
    const p = j({ workspace_id: ws, from_ledger_id: bank, to_ledger_id: cash, amount: "10", txn_date: "2026-11-08", idempotency_key: "transfer-key-1" });
    const a = await rpc<{ id: string }>(db, OWNER, "public.record_transfer($1::jsonb)", [p]);
    const b = await rpc<{ id: string; duplicate: boolean }>(db, OWNER, "public.record_transfer($1::jsonb)", [p]);
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
  });
});
