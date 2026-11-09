import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { loadBooksInput } from "./books-load";
import { computeBooks } from "@/lib/domain/books";

/**
 * A client pays ₹11,70,000 into the bank and deducts ₹10,000 TDS on an ₹11,80,000 invoice
 * (₹10,00,000 + 18% GST, TDS at 1%). The invoice is fully settled, the bank gets only the cash,
 * and the ₹10,000 becomes TDS credit.
 */
const OWNER = "user_tds_owner";
const j = (v: unknown) => JSON.stringify(v);
const r = (rupees: number) => BigInt(Math.round(rupees * 100));
let db: Db;
let ws: string;
let bank: string;
let client: string;
let n = 0;

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const books = async () => computeBooks(await loadBooksInput(db, ws, OWNER));
const invoice = async (ledger: string | null) => {
  const id = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [
    j({ workspace_id: ws, invoice_type: "gst", invoice_date: "2026-02-01", contractor_id: client, ledger_id: ledger, client_name: "Metro Group", place_of_supply: "27", gst_enabled: true, items: [{ name: "Work", quantity: "1", rate: "1000000", tax_rate: "18", hsn: "9954" }] }),
  ]);
  await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, String(++n).padStart(43, "t"), null]);
  return id;
};
const pay = (id: string, x: Record<string, unknown>) =>
  rpc<{ id: string }>(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ paid_on: "2026-02-10", mode: "bank_transfer", wallet_ledger_id: bank, ...x })]);
const inv = (id: string) => one<{ amount_received: string; paid_at: string | null; grand_total: string }>("select amount_received, paid_at, grand_total from public.invoices where id = $1", [id]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Dhiraj Enterprises", "Vishwa", null]);
  await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Dhiraj", state_code: "27", gst_registered: true, gstin: "27ABCDE1234F1Z5" })]);
  bank = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Rishabh Sales Creative", ledger_type: "basic", wallet_kind: "bank", opening_balance: "0" })]);
  client = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Metro Group', 'business', $2) returning id`, [ws, OWNER])).id;
});

describe("TDS deducted on an invoice payment", () => {
  it("on a client ledger: the invoice is paid, the bank gets the cash, the ledger settles, TDS is a credit", async () => {
    const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Metro Group", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
    const id = await invoice(ledger);
    expect(Number((await inv(id)).grand_total)).toBe(1180000);
    await pay(id, { amount: "1170000", tds_deducted: "10000" });
    const i = await inv(id);
    expect(Number(i.amount_received)).toBe(1180000);
    expect(i.paid_at).not.toBeNull();
    const b = await books();
    expect(b.wallets.find((w) => w.id === bank)!.balance).toBe(r(1170000));
    expect(b.positions.get(client) ?? 0n).toBe(0n);
    expect(b.tdsReceivable).toBe(r(10000));
    expect(b.gstPayable).toBe(r(180000));
    expect(b.profit).toBe(r(1000000));
    expect(b.difference).toBe(0n);
  });

  it("with no ledger: the same, through the invoice itself", async () => {
    const before = await books();
    const id = await invoice(null);
    await pay(id, { amount: "1170000", tds_deducted: "10000" });
    const b = await books();
    expect(b.wallets.find((w) => w.id === bank)!.balance - before.wallets.find((w) => w.id === bank)!.balance).toBe(r(1170000));
    expect(b.tdsReceivable - before.tdsReceivable).toBe(r(10000));
    expect(b.positions.get(client) ?? 0n).toBe(0n);
    expect(b.difference).toBe(0n);
  });

  it("cash plus TDS cannot go past the balance unless confirmed as excess", async () => {
    const id = await invoice(null);
    await expect(pay(id, { amount: "1175000", tds_deducted: "10000" })).rejects.toThrow(/more than the balance/);
  });

  it("reversing the payment brings back the debt and takes back the TDS credit", async () => {
    const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Metro 2", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
    const before = await books();
    const id = await invoice(ledger);
    const p = await pay(id, { amount: "1170000", tds_deducted: "10000" });
    await rpc(db, OWNER, "public.reverse_invoice_payment($1, $2, $3)", [p.id, "Bounced", "correction"]);
    expect(Number((await inv(id)).amount_received)).toBe(0);
    const b = await books();
    expect(b.tdsReceivable).toBe(before.tdsReceivable);
    expect((b.positions.get(client) ?? 0n) - (before.positions.get(client) ?? 0n)).toBe(r(1180000));
    expect(b.difference).toBe(0n);
  });

  it("the TDS entry on the ledger cannot be voided or reversed on its own", async () => {
    const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Metro 3", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
    const id = await invoice(ledger);
    const p = await pay(id, { amount: "1170000", tds_deducted: "10000" });
    const t = await one<{ tds_transaction_id: string }>("select tds_transaction_id from public.invoice_payments where id = $1", [p.id]);
    await expect(rpc(db, OWNER, "public.delete_transaction($1)", [t.tds_transaction_id])).rejects.toThrow(/TDS on an invoice payment|invoice/);
  });

  it("a negative TDS is refused", async () => {
    const id = await invoice(null);
    await expect(pay(id, { amount: "1000", tds_deducted: "-5" })).rejects.toThrow();
  });
});
