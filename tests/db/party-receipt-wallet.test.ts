import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { loadBooksInput } from "./books-load";
import { computeBooks } from "@/lib/domain/books";
import { BILL_DIRECTION, buildStatement, type Perspective } from "@/lib/domain/ledger";

/**
 * Money in on a client ledger that names a wallet is one entry that both ledgers read: the client's
 * balance goes down and the bank's goes up, together, and stays that way through edit, void and
 * reversal because there is no second entry to keep in step.
 */
const OWNER = "user_party_wallet";
const j = (v: unknown) => JSON.stringify(v);
const r = (rupees: number) => BigInt(Math.round(rupees * 100));
let db: Db;
let ws: string;
let metro: string;
let bank: string;
let client: string;

/** A ledger's balance exactly as its screen shows it: its own entries plus those naming it as wallet. */
async function balance(ledger: string, perspective: Perspective) {
  const rows = await as(db, OWNER, (q) =>
    q<{ seq: number; txn_date: string; direction: "in" | "out"; amount: string; kind: "regular"; is_cash: boolean; affects_party: boolean; status: "posted" }>(
      "select seq, txn_date::text, direction, amount, kind, is_cash, affects_party, status from public.transactions where ledger_id = $1 or (wallet_ledger_id = $1 and is_cash)",
      [ledger],
    ),
  );
  return buildStatement({ perspective, opening_balance: "0" }, rows).closing;
}
const books = async () => computeBooks(await loadBooksInput(db, ws, OWNER));
const post = (x: Record<string, unknown>) => rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: metro, txn_date: "2026-02-01", status: "posted", ...x })]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Dhiraj Enterprises", "Vishwa", null]);
  client = (await as(db, OWNER, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'INDRAJEET SAINI', 'business', $2) returning id`, [ws, OWNER])))[0].id;
  metro = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Metro Group", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
  bank = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Rishabh Sales Creative Bank", ledger_type: "basic", wallet_kind: "bank", opening_balance: "0" })]);
});

describe("Metro Group pays into Rishabh Sales Creative Bank", () => {
  it("bill to party: Indrajeet owes ₹11,70,000, the bank is untouched", async () => {
    await post({ kind: "invoice", direction: BILL_DIRECTION.toParty, tax: { taxable_amount: "1000000", gst_applicable: true, gst_rate: "18", tds_applicable: true, tds_rate: "1", tds_base: "taxable" } });
    expect(await balance(metro, "party")).toBe(r(1170000));
    expect(await balance(bank, "cashbook")).toBe(0n);
  });

  let receipt: string;
  it("money in ₹10,00,000 into the bank: Indrajeet owes ₹1,70,000 and the bank holds ₹10,00,000", async () => {
    receipt = (await post({ kind: "regular", direction: "in", amount: "1000000", payment_mode: "bank_transfer", wallet_ledger_id: bank })).id;
    expect(await balance(metro, "party")).toBe(r(170000));
    expect(await balance(bank, "cashbook")).toBe(r(1000000));
    const b = await books();
    expect(b.wallets.find((w) => w.id === bank)!.balance).toBe(r(1000000));
    expect(b.positions.get(client)).toBe(r(170000));
    expect(b.uncategorised).toBe(0n);
    expect(b.uncategorisedEntries).toHaveLength(0);
    expect(b.pocket).toBe(0n);
    expect(b.difference).toBe(0n);
    const rows = await as(db, OWNER, (q) => q("select id from public.transactions where workspace_id = $1 and kind = 'regular'", [ws]));
    expect(rows).toHaveLength(1); // one entry, read by both ledgers: nothing to fall out of step
  });

  it("editing the amount moves both balances together", async () => {
    await rpc(db, OWNER, "public.amend_transaction($1, $2::jsonb)", [receipt, j({ amount: "1100000" })]);
    expect(await balance(metro, "party")).toBe(r(70000));
    expect(await balance(bank, "cashbook")).toBe(r(1100000));
  });

  it("reversing it puts both back, and the reversal goes through the same bank", async () => {
    await rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [receipt, "Bounced", "2026-02-03"]);
    expect(await balance(metro, "party")).toBe(r(1170000));
    expect(await balance(bank, "cashbook")).toBe(0n);
    expect((await books()).difference).toBe(0n);
  });

  it("voiding a receipt takes it out of both", async () => {
    const t = (await post({ kind: "regular", direction: "in", amount: "500000", wallet_ledger_id: bank })).id;
    await rpc(db, OWNER, "public.void_transaction($1, $2)", [t, "Wrong"]);
    expect(await balance(metro, "party")).toBe(r(1170000));
    expect(await balance(bank, "cashbook")).toBe(0n);
  });

  it("an older receipt with no wallet can be pointed at the bank afterwards", async () => {
    const t = (await post({ kind: "regular", direction: "in", amount: "200000" })).id;
    expect(await balance(bank, "cashbook")).toBe(0n);
    await rpc(db, OWNER, "public.classify_entry($1, $2::jsonb)", [t, j({ wallet_ledger_id: bank })]);
    expect(await balance(bank, "cashbook")).toBe(r(200000));
    expect(await balance(metro, "party")).toBe(r(970000));
  });

  it("only a cash or bank ledger can be the wallet", async () => {
    await expect(post({ kind: "regular", direction: "in", amount: "1", wallet_ledger_id: metro })).rejects.toThrow(/cash or bank/);
  });
});
