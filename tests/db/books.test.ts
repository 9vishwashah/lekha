import { beforeAll, describe, expect, it } from "vitest";
import { applyFrom, as, createDb, rpc, type Db, type Who } from "./harness";
import { computeBooks, profitAndLoss, type BooksInput } from "@/lib/domain/books";

let OWNER = "user_books_owner";
const j = (v: unknown) => JSON.stringify(v);
const p = (rupees: number) => BigInt(Math.round(rupees * 100));

let db: Db;
let token = 0;
let worlds = 0;

/** The same rows src/lib/server/books.ts loads, read as the signed-in owner. */
async function load(ws: string, who: Who = OWNER): Promise<BooksInput> {
  return as(db, who, async (q) => {
    const rows = <T>(sql: string) => q<T>(sql, [ws]);
    const payers = await rows<{ shared_expense_id: string; participant_id: string; amount_paid: string }>("select p.* from public.shared_expense_payers p join public.shared_expenses e on e.id = p.shared_expense_id where e.workspace_id = $1");
    const shares = await rows<{ shared_expense_id: string; participant_id: string; share_amount: string }>("select s.* from public.shared_expense_shares s join public.shared_expenses e on e.id = s.shared_expense_id where e.workspace_id = $1");
    const expenses = await rows<BooksInput["sharedExpenses"][number]>("select * from public.shared_expenses where workspace_id = $1");
    const advances = await rows<BooksInput["advances"][number] & { id: string }>("select id, ledger_id, amount, status from public.advances where workspace_id = $1");
    const allocations = await rows<{ advance_id: string; kind: string; amount: string; status: string; alloc_date: string; transaction_id: string | null }>("select * from public.advance_allocations where workspace_id = $1");
    const iso = <T extends Record<string, unknown>>(r: T, ...keys: string[]) => {
      const out: Record<string, unknown> = { ...r };
      for (const k of keys) out[k] = (r[k] as Date).toISOString().slice(0, 10);
      return out as T;
    };
    return {
      ledgers: await rows("select * from public.ledgers where workspace_id = $1"),
      txns: (await rows<BooksInput["txns"][number]>("select * from public.transactions where workspace_id = $1")).map((t) => iso(t, "txn_date")),
      tax: await rows("select * from public.transaction_tax_details where workspace_id = $1"),
      taxSettlements: await rows("select * from public.tax_settlements where workspace_id = $1"),
      invoices: (await rows<BooksInput["invoices"][number]>("select * from public.invoices where workspace_id = $1")).map((i) => iso(i, "invoice_date")),
      payments: await rows("select * from public.invoice_payments where workspace_id = $1"),
      expenses: (await rows<BooksInput["expenses"][number]>("select e.*, c.name as category from public.expenses e join public.expense_categories c on c.id = e.category_id where e.workspace_id = $1")).map((e) => iso(e, "expense_date")),
      advances: advances.map((a) => ({ ...a, allocations: allocations.filter((x) => x.advance_id === a.id).map((x) => iso(x, "alloc_date")) })),
      splitGroups: await rows("select * from public.split_groups where workspace_id = $1"),
      participants: await rows("select * from public.ledger_participants where workspace_id = $1"),
      sharedExpenses: expenses.map((e) => ({ ...iso(e, "txn_date"), payers: payers.filter((x) => x.shared_expense_id === e.id), shares: shares.filter((x) => x.shared_expense_id === e.id) })),
      settlements: await rows("select * from public.settlements where workspace_id = $1"),
    } as BooksInput;
  });
}

async function books(ws: string) {
  return computeBooks(await load(ws));
}

/** A fresh workspace with helpers for writing into it. */
async function world(name: string) {
  OWNER = `user_books_${++worlds}`;
  await rpc(db, OWNER, "public.save_my_profile($1, $2)", ["Owner Person", "9000000000"]);
  const ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", [name, "Owner", null]);
  const one = async <T>(sql: string, params: unknown[] = [ws]) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
  const category = (await one<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1")).id;
  const cash = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'")).id;
  const bank = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'bank'")).id;
  const client = async (nm: string) =>
    (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, $2, 'business', $3) returning id`, [ws, nm, OWNER])).id;
  const ledger = (x: Record<string, unknown>) => rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, opening_balance: "0", ...x })]);
  const post = (x: Record<string, unknown>) => rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ txn_date: "2026-10-01", direction: "in", kind: "regular", status: "posted", ...x })]);
  await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Books Co", state_code: "27", gst_registered: true, gstin: "27ABCDE1234F1Z5" })]);
  const invoice = async (x: { client?: string; ledger?: string; rate?: string; gst?: number; type?: string }) => {
    const id = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [
      j({
        workspace_id: ws,
        invoice_type: x.type ?? "service",
        invoice_date: "2026-10-05",
        contractor_id: x.client ?? null,
        ledger_id: x.ledger ?? null,
        client_name: "Client",
        place_of_supply: "27",
        gst_enabled: Boolean(x.gst),
        items: [{ name: "Work", quantity: "1", rate: x.rate ?? "1000", tax_rate: String(x.gst ?? 0), hsn: "9983" }],
      }),
    ]);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, String(++token).padStart(43, "t"), null]);
    return id;
  };
  return { ws, category, cash, bank, client, ledger, post, invoice };
}

const expectBalanced = (b: Awaited<ReturnType<typeof books>>) => expect(b.difference).toBe(0n);

beforeAll(async () => {
  db = await createDb();
});

describe("books", () => {
  it("a new workspace starts with two wallets and an even sheet", async () => {
    const w = await world("Empty");
    const b = await books(w.ws);
    expect(b.wallets.map((x) => x.kind).sort()).toEqual(["bank", "cash"]);
    expect(b.assets).toBe(0n);
    expectBalanced(b);
  });

  it("opening balances are capital, not profit", async () => {
    const w = await world("Opening");
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [w.bank, j({ opening_balance: "100000" })]);
    const party = await w.ledger({ name: "Old party", ledger_type: "basic", contractor_id: await w.client("Old"), opening_balance: "5000" });
    const b = await books(w.ws);
    expect(b.bank).toBe(p(100000));
    expect(b.debtors).toBe(p(5000));
    expect(b.capital).toBe(p(105000));
    expect(b.profit).toBe(0n);
    expect(party).toBeTruthy();
    expectBalanced(b);
  });

  it("an invoice is income before GST, the tax is owed, and paying it moves cash not profit", async () => {
    const w = await world("Invoice");
    const c = await w.client("Sumit");
    const id = await w.invoice({ client: c, rate: "1000", gst: 18, type: "service" });
    let b = await books(w.ws);
    const total = b.debtors;
    expect(total).toBe(p(1180));
    expect(b.gstPayable).toBe(p(180));
    expect(b.profit).toBe(p(1000));
    expectBalanced(b);
    await rpc(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "500", paid_on: "2026-10-06", mode: "upi" })]);
    b = await books(w.ws);
    expect(b.debtors).toBe(total - p(500));
    expect(b.bank).toBe(p(500)); // upi went to the bank wallet without being asked
    expectBalanced(b);
  });

  it("an invoice with no ledger still shows as owed, and one on a party ledger is not counted twice", async () => {
    const w = await world("Twice");
    const a = await w.client("Loose");
    const c = await w.client("Partied");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    await w.invoice({ client: a, rate: "5500" });
    await w.invoice({ client: c, ledger: party, rate: "2000" });
    const b = await books(w.ws);
    expect(b.debtors).toBe(p(7500));
    expect(b.positions.get(a)).toBe(p(5500));
    expect(b.positions.get(c)).toBe(p(2000));
    expectBalanced(b);
  });

  it("a payment on a party ledger names the wallet and is one entry, counted once", async () => {
    const w = await world("Pointer");
    const c = await w.client("Pays");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    const id = await w.invoice({ client: c, ledger: party, rate: "3000" });
    await rpc(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "3000", paid_on: "2026-10-06", mode: "cash" })]);
    const rows = await as(db, OWNER, (q) => q("select id from public.transactions where workspace_id = $1 and kind = 'regular'", [w.ws]));
    expect(rows).toHaveLength(1);
    const b = await books(w.ws);
    expect(b.cash).toBe(p(3000));
    expect(b.debtors).toBe(0n);
    expectBalanced(b);
  });

  it("reversing that payment puts the cash and the debt back", async () => {
    const w = await world("Refund");
    const c = await w.client("Refund Co");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    const id = await w.invoice({ client: c, ledger: party, rate: "3000" });
    const pay = await rpc<{ id: string }>(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "3000", paid_on: "2026-10-06", mode: "cash" })]);
    await rpc(db, OWNER, "public.reverse_invoice_payment($1, $2, $3)", [pay.id, "Bounced", "correction"]);
    const b = await books(w.ws);
    expect(b.cash).toBe(0n);
    expect(b.debtors).toBe(p(3000));
    expectBalanced(b);
  });

  it("a cancelled invoice leaves nothing behind, and a proforma never counted", async () => {
    const w = await world("Cancel");
    const c = await w.client("Cancels");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    const id = await w.invoice({ client: c, ledger: party, rate: "4000" });
    await w.invoice({ client: c, rate: "9000", type: "proforma" });
    await rpc(db, OWNER, "public.cancel_invoice($1, $2)", [id, "Wrong client"]);
    const b = await books(w.ws);
    expect(b.debtors).toBe(0n);
    expect(b.profit).toBe(0n);
    expectBalanced(b);
  });

  it("a contractor bill: cost before tax, GST credit, TDS held, net owed; then paid", async () => {
    const w = await world("Bill");
    const c = await w.client("Ramesh");
    const party = await w.ledger({ name: "Ramesh bills", ledger_type: "taxation", contractor_id: c });
    await w.post({ ledger_id: party, kind: "invoice", direction: "in", tax: { taxable_amount: "10000", gst_applicable: true, gst_rate: "18", tds_applicable: true, tds_rate: "1", tds_base: "taxable" } });
    let b = await books(w.ws);
    expect(b.creditors).toBe(p(11700)); // 10000 + 1800 GST − 100 TDS
    expect(b.gstCredit).toBe(p(1800));
    expect(b.tdsDue).toBe(p(100));
    expect(b.profit).toBe(-p(10000));
    expectBalanced(b);
    await w.post({ ledger_id: party, direction: "out", amount: "11700", wallet_ledger_id: w.bank });
    b = await books(w.ws);
    expect(b.creditors).toBe(0n);
    expect(b.bank).toBe(-p(11700));
    expectBalanced(b);
  });

  it("an advance is an asset once: in a party ledger it is already in their balance", async () => {
    const w = await world("Advance");
    const c = await w.client("Adv");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    await rpc(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: c, amount: "1000", given_date: "2026-10-01", ledger_id: party })]);
    await rpc(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: c, amount: "500", given_date: "2026-10-01", ledger_id: w.cash })]);
    const b = await books(w.ws);
    expect(b.debtors).toBe(p(1000));
    expect(b.advances).toBe(p(500));
    expect(b.cash).toBe(-p(500));
    expect(b.unassigned).toBe(-p(1000));
    expectBalanced(b);
  });

  it("an advance adjusted with no bill on record becomes a cost, not a lost asset", async () => {
    const w = await world("Adjust");
    const c = await w.client("Adj");
    const a = await rpc<{ id: string }>(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: c, amount: "800", given_date: "2026-10-01", ledger_id: w.cash })]);
    await rpc(db, OWNER, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: a.id, kind: "adjustment", amount: "800", alloc_date: "2026-10-02", bill_reference: "B-1" })]);
    const b = await books(w.ws);
    expect(b.advances).toBe(0n);
    expect(b.profit).toBe(-p(800));
    expectBalanced(b);
  });

  it("an expense is a cost once, whether or not it names a wallet", async () => {
    const w = await world("Expense");
    await rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: w.ws, category_id: w.category, expense_date: "2026-10-03", title: "Cement", amount: "700", ledger_id: w.cash })]);
    await rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: w.ws, category_id: w.category, expense_date: "2026-10-03", title: "Sand", amount: "300" })]);
    const b = await books(w.ws);
    expect(b.profit).toBe(-p(1000));
    expect(b.cash).toBe(-p(700));
    expect(b.unassigned).toBe(-p(300));
    expectBalanced(b);
  });

  it("refuses an expense through a party ledger, and a split through one", async () => {
    const w = await world("No party");
    const c = await w.client("X");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    await expect(rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: w.ws, category_id: w.category, expense_date: "2026-10-03", title: "T", amount: "1", ledger_id: party })])).rejects.toThrow(/twice/);
  });

  it("a split: your share is the cost, their share is owed, the cash leaves once", async () => {
    const w = await world("Split");
    const a = await w.client("A");
    const c = await w.client("B");
    const split = (x: Record<string, unknown>) => rpc<{ id: string }>(db, OWNER, "public.create_split_expense($1::jsonb)", [j({ workspace_id: w.ws, title: "Dinner", expense_date: "2026-10-04", category_id: w.category, ...x })]);
    await split({ amount: "1500", your_share: "500", ledger_id: w.bank, people: [{ contractor_id: a, amount: "500" }, { contractor_id: c, amount: "500" }] });
    await split({ amount: "900", your_share: "300", people: [{ contractor_id: a, amount: "600" }] }); // no wallet
    await split({ amount: "600", your_share: "200", paid_by_contractor_id: c, people: [{ contractor_id: c, amount: "400" }] }); // they paid
    const b = await books(w.ws);
    expect(b.bank).toBe(-p(1500));
    expect(b.unassigned).toBe(-p(900));
    expect(b.profit).toBe(-p(1000));
    expect(b.positions.get(a)).toBe(p(1100));
    expect(b.positions.get(c)).toBe(p(300)); // 500 owed to you less 200 you owe them: one person, one figure
    expect(b.debtors).toBe(p(1400));
    expect(b.creditors).toBe(0n);
    expectBalanced(b);
  });

  it("a voided split leaves nothing", async () => {
    const w = await world("Void split");
    const a = await w.client("A");
    const r = await rpc<{ id: string; expense_id: string }>(db, OWNER, "public.create_split_expense($1::jsonb)", [j({ workspace_id: w.ws, title: "D", expense_date: "2026-10-04", category_id: w.category, amount: "900", your_share: "300", ledger_id: w.cash, people: [{ contractor_id: a, amount: "600" }] })]);
    await rpc(db, OWNER, "public.void_expense($1, $2)", [r.expense_id, "Wrong"]);
    const b = await books(w.ws);
    expect(b.cash).toBe(0n);
    expect(b.debtors).toBe(0n);
    expect(b.profit).toBe(0n);
    expectBalanced(b);
  });

  it("client payments and old balances", async () => {
    const w = await world("Payments");
    const a = await w.client("A");
    await rpc(db, OWNER, "public.record_client_opening($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: a, amount: "1200", they_owe: true, txn_date: "2026-04-01" })]);
    await rpc(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: a, direction: "received", amount: "200", txn_date: "2026-10-02", ledger_id: w.bank })]);
    await rpc(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: w.ws, contractor_id: a, direction: "received", amount: "100", txn_date: "2026-10-02" })]);
    const b = await books(w.ws);
    expect(b.capital).toBe(p(1200));
    expect(b.debtors).toBe(p(900));
    expect(b.bank).toBe(p(200));
    expect(b.unassigned).toBe(p(100));
    expect(b.profit).toBe(0n);
    expect(b.uncategorised).toBe(0n);
    expectBalanced(b);
  });

  it("a named shared account: your share is a cost, what you paid for others is owed", async () => {
    const w = await world("Group");
    const a = await w.client("A");
    const c = await w.client("B");
    const l = await w.ledger({ name: "Trip", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [a, c] });
    const ps = await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [l]));
    await rpc(db, OWNER, "public.create_shared_expense($1::jsonb)", [j({ ledger_id: l, txn_date: "2026-10-01", description: "Hotel", total_amount: "3000", split_method: "exact", payers: [{ participant_id: ps[0].id, amount: "3000" }], shares: ps.map((x) => ({ participant_id: x.id, amount: "1000" })) })]);
    const b = await books(w.ws);
    expect(b.debtors).toBe(p(2000));
    expect(b.profit).toBe(-p(1000));
    expect(b.unassigned).toBe(-p(3000));
    expectBalanced(b);
  });

  it("tax paid clears the liability, and is neither cost nor income", async () => {
    const w = await world("Tax");
    const c = await w.client("T");
    await w.invoice({ client: c, rate: "1000", gst: 18, type: "service" });
    const before = await books(w.ws);
    const due = before.gstPayable;
    const taxLedger = await w.ledger({ name: "Tax wallet", ledger_type: "taxation", wallet_kind: "bank" });
    await rpc(db, OWNER, "public.record_tax_settlement($1::jsonb)", [j({ ledger_id: taxLedger, txn_date: "2026-10-20", tax_type: "gst", amount: Number(due) / 100, account_mapping: "gst_payable", period_month: "2026-10-01" })]);
    const b = await books(w.ws);
    expect(b.gstPayable).toBe(0n);
    expect(b.profit).toBe(before.profit);
    expectBalanced(b);
  });

  it("a wallet entry nobody has explained is not guessed into profit", async () => {
    const w = await world("Plain");
    const t = await w.post({ ledger_id: w.bank, direction: "in", amount: "50000", description: "Deposit" });
    let b = await books(w.ws);
    expect(b.profit).toBe(0n);
    expect(b.uncategorised).toBe(p(50000));
    expect(b.uncategorisedEntries).toHaveLength(1);
    expectBalanced(b);
    await rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [t.id, j({ nature: "capital" })]);
    b = await books(w.ws);
    expect(b.uncategorised).toBe(0n);
    expect(b.introduced).toBe(p(50000));
    expect(b.uncategorisedEntries).toHaveLength(0);
    await rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [t.id, j({ nature: "income" })]);
    b = await books(w.ws);
    expect(b.profit).toBe(p(50000));
    expectBalanced(b);
  });

  it("a reversed wallet entry nets to nothing and keeps what it was", async () => {
    const w = await world("Reversal");
    const t = await w.post({ ledger_id: w.bank, direction: "out", amount: "400", nature: "expense" });
    await rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [t.id, "Oops", "2026-10-02"]);
    const b = await books(w.ws);
    expect(b.bank).toBe(0n);
    expect(b.profit).toBe(0n);
    expectBalanced(b);
  });

  it("an older party entry can be told which wallet it went through", async () => {
    const w = await world("Tag");
    const c = await w.client("Tagged");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    const t = await w.post({ ledger_id: party, direction: "out", amount: "600" });
    expect((await books(w.ws)).unassigned).toBe(-p(600));
    await rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [t.id, j({ wallet_ledger_id: w.bank })]);
    const b = await books(w.ws);
    expect(b.unassigned).toBe(0n);
    expect(b.bank).toBe(-p(600));
    expectBalanced(b);
  });

  it("only cash books can be wallets, and a wallet entry cannot point at another wallet", async () => {
    const w = await world("Rules");
    const c = await w.client("R");
    const party = await w.ledger({ name: "P", ledger_type: "basic", contractor_id: c });
    await expect(w.post({ ledger_id: party, direction: "out", amount: "1", wallet_ledger_id: party })).rejects.toThrow(/cash or bank/);
    await expect(w.post({ ledger_id: w.cash, direction: "out", amount: "1", wallet_ledger_id: w.bank })).rejects.toThrow(/already in/);
    await expect(w.post({ ledger_id: party, direction: "out", amount: "1", nature: "income" })).rejects.toThrow(/categorised/);
  });

  it("a ledger made for a client is an account with them", async () => {
    const w = await world("Perspective");
    const c = await w.client("Regal");
    const l = await w.ledger({ name: "Regal", ledger_type: "basic", perspective: "cashbook", contractor_id: c });
    const row = await as(db, OWNER, (q) => q<{ perspective: string }>("select perspective from public.ledgers where id = $1", [l]));
    expect(row[0].perspective).toBe("party");
    await expect(w.ledger({ name: "Bad", ledger_type: "basic", wallet_kind: "bank", contractor_id: c })).rejects.toThrow(/no client/);
  });

  it("the period only moves profit, and a whole-time view equals the sheet", async () => {
    const w = await world("Period");
    const c = await w.client("P");
    await w.invoice({ client: c, rate: "1000" }); // 5 Oct
    await rpc(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: w.ws, category_id: w.category, expense_date: "2026-09-03", title: "Old", amount: "100" })]);
    const b = await books(w.ws);
    const oct = profitAndLoss(b.lines, { from: "2026-10-01", to: "2026-10-31" });
    expect(oct.totalIncome).toBe(p(1000));
    expect(oct.totalCosts).toBe(0n);
    expect(profitAndLoss(b.lines).profit).toBe(b.profit);
  });
});

describe("books on existing data", () => {
  it("turns a client's bills-only cash book into a party ledger, and leaves one holding cash", async () => {
    const old = await createDb({ until: "20261107001800" });
    const ws = await rpc<string>(old, OWNER, "public.create_workspace($1, $2, $3)", ["Old", "Owner", null]);
    const client = (await as(old, OWNER, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Regal', 'business', $2) returning id`, [ws, OWNER])))[0].id;
    const ledger = (name: string, extra = {}) => rpc<string>(old, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name, ledger_type: "basic", perspective: "cashbook", contractor_id: client, opening_balance: "0", ...extra })]);
    const empty = await ledger("Bills only");
    const withCash = await ledger("Has cash");
    await rpc(old, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: withCash, txn_date: "2026-10-01", direction: "in", kind: "regular", status: "posted", amount: "100" })]);
    const plain = await rpc<string>(old, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Petty cash", ledger_type: "basic", perspective: "cashbook", opening_balance: "0" })]);
    await applyFrom(old, "20261107001800");
    const row = async (id: string) => (await as(old, OWNER, (q) => q<{ perspective: string; wallet_kind: string | null }>("select perspective, wallet_kind from public.ledgers where id = $1", [id])))[0];
    expect((await row(empty)).perspective).toBe("party");
    expect((await row(withCash)).perspective).toBe("cashbook");
    expect((await row(withCash)).wallet_kind).toBeNull();
    expect((await row(plain)).wallet_kind).toBe("cash");
    const wallets = await as(old, OWNER, (q) => q<{ wallet_kind: string }>("select wallet_kind from public.ledgers where workspace_id = $1 and wallet_kind is not null", [ws]));
    expect(wallets.map((w) => w.wallet_kind).sort()).toEqual(["bank", "cash"]); // the existing cash wallet was reused
  });
});

describe("clients link both ways", () => {
  const VISHWA = "user_vishwa";
  const DAD = "user_dad";
  const profile = (who: string, name: string, username: string) =>
    as(db, who, async (q) => {
      await q("select public.save_my_profile($1, $2)", [name, "9000000001"]);
      await q("select public.set_my_username($1)", [username]);
    });

  it("linking someone puts you in their Client Accounts", async () => {
    await profile(VISHWA, "Vishwa Shah", "vishwa1");
    await profile(DAD, "Dad Shah", "dadshah");
    const mine = await rpc<string>(db, VISHWA, "public.create_workspace($1, $2, $3)", ["Mine", "Vishwa Shah", null]);
    const dads = await rpc<string>(db, DAD, "public.create_workspace($1, $2, $3)", ["Dad's", "Dad Shah", null]);
    const client = (await as(db, VISHWA, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Dad', 'personal', $2) returning id`, [mine, VISHWA])))[0].id;
    await rpc(db, VISHWA, "public.link_client_by_username($1, $2)", [client, "dadshah"]);
    const cards = await as(db, DAD, (q) => q<{ name: string; linked_user_id: string }>("select name, linked_user_id from public.contractors where workspace_id = $1", [dads]));
    expect(cards).toEqual([expect.objectContaining({ name: "Vishwa Shah", linked_user_id: VISHWA })]);
  });

  it("does not make a second card, and uses one they typed in themselves", async () => {
    const A = "user_a1";
    const B = "user_b1";
    await profile(A, "Asha Rao", "asharao");
    await profile(B, "Bhavin Rao", "bhavinrao");
    const wa = await rpc<string>(db, A, "public.create_workspace($1, $2, $3)", ["A", "Asha Rao", null]);
    const wb = await rpc<string>(db, B, "public.create_workspace($1, $2, $3)", ["B", "Bhavin Rao", null]);
    await as(db, B, (q) => q(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'asha rao', 'personal', $2)`, [wb, B]));
    const c = (await as(db, A, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Bhavin', 'personal', $2) returning id`, [wa, A])))[0].id;
    await rpc(db, A, "public.link_client_by_username($1, $2)", [c, "bhavinrao"]);
    const cards = await as(db, B, (q) => q<{ name: string; linked_user_id: string | null }>("select name, linked_user_id from public.contractors where workspace_id = $1", [wb]));
    expect(cards).toEqual([expect.objectContaining({ name: "asha rao", linked_user_id: A })]);
    // and nothing bounced back onto the first person
    const back = await as(db, A, (q) => q("select id from public.contractors where workspace_id = $1", [wa]));
    expect(back).toHaveLength(1);
  });

  it("someone with no workspace yet gets the card when they make one", async () => {
    const A = "user_a2";
    const B = "user_b2";
    await profile(A, "Chirag Vora", "chiragv");
    await profile(B, "Divya Vora", "divyav");
    const wa = await rpc<string>(db, A, "public.create_workspace($1, $2, $3)", ["A", "Chirag Vora", null]);
    const c = (await as(db, A, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Divya', 'personal', $2) returning id`, [wa, A])))[0].id;
    await rpc(db, A, "public.link_client_by_username($1, $2)", [c, "divyav"]);
    const wb = await rpc<string>(db, B, "public.create_workspace($1, $2, $3)", ["B", "Divya Vora", null]);
    const cards = await as(db, B, (q) => q<{ name: string }>("select name from public.contractors where workspace_id = $1", [wb]));
    expect(cards.map((x) => x.name)).toEqual(["Chirag Vora"]);
  });

  it("existing links get their cards when the migration runs", async () => {
    const old = await createDb({ until: "20261107001800" });
    await rpc(old, "user_e", "public.save_my_profile($1, $2)", ["Esha Old", "9000000002"]);
    await rpc(old, "user_f", "public.save_my_profile($1, $2)", ["Farhan Old", "9000000003"]);
    const we = await rpc<string>(old, "user_e", "public.create_workspace($1, $2, $3)", ["E", "Esha Old", null]);
    const wf = await rpc<string>(old, "user_f", "public.create_workspace($1, $2, $3)", ["F", "Farhan Old", null]);
    await old.query(`insert into public.contractors (workspace_id, name, kind, linked_user_id, created_by) values ($1, 'Farhan', 'personal', 'user_f', 'user_e')`, [we]);
    await applyFrom(old, "20261107001800");
    const cards = await as(old, "user_f", (q) => q<{ name: string }>("select name from public.contractors where workspace_id = $1", [wf]));
    expect(cards.map((x) => x.name)).toEqual(["Esha Old"]);
  });
});

