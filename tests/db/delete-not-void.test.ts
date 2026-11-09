import { beforeAll, describe, expect, it } from "vitest";
import { applyFrom, as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_delete_owner";
const j = (v: unknown) => JSON.stringify(v);
let db: Db;
let ws: string;
let cash: string;
let category: string;
let client: string;

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params)).n);
const post = (x: Record<string, unknown>) => rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: cash, txn_date: "2026-02-01", kind: "regular", status: "posted", direction: "in", amount: "100", ...x })]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Deletes", "Owner", null]);
  cash = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'", [ws])).id;
  category = (await one<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1", [ws])).id;
  client = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Client', 'business', $2) returning id`, [ws, OWNER])).id;
});

describe("deleting instead of voiding", () => {
  it("an entry is gone from the database, with any reversal of it", async () => {
    const t = await post({});
    await rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [t.id, "x", "2026-02-02"]);
    await rpc(db, OWNER, "public.delete_transaction($1)", [t.id]);
    expect(await count("select id from public.transactions where id = $1 or reversal_of = $1", [t.id])).toBe(0);
  });

  it("the activity log keeps that it was deleted, by whom, but none of its content", async () => {
    const t = await post({ description: "Secret purpose", amount: "777" });
    await rpc(db, OWNER, "public.delete_transaction($1)", [t.id]);
    const log = await one<{ changes: Record<string, unknown>; actor_user_id: string }>("select changes, actor_user_id from public.audit_logs where entity_id = $1 and action = 'delete'", [t.id]);
    expect(log.actor_user_id).toBe(OWNER);
    expect(log.changes).toEqual({});
  });

  it("deleting an expense's entry from the ledger deletes the expense too", async () => {
    const e = await rpc<{ id: string; transaction_id: string }>(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: ws, category_id: category, expense_date: "2026-02-03", title: "Tea", amount: "40", ledger_id: cash })]);
    await rpc(db, OWNER, "public.delete_transaction($1)", [e.transaction_id]);
    expect(await count("select id from public.expenses where id = $1", [e.id])).toBe(0);
  });

  it("deleting an advance takes its recoveries and their entries with it", async () => {
    const a = await rpc<{ id: string; transaction_id: string }>(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: ws, contractor_id: client, amount: "1000", given_date: "2026-02-01", ledger_id: cash })]);
    const x = await rpc<{ transaction_id: string }>(db, OWNER, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: a.id, kind: "recovery", amount: "400", alloc_date: "2026-02-05" })]);
    await rpc(db, OWNER, "public.delete_advance($1)", [a.id]);
    expect(await count("select id from public.advances where id = $1", [a.id])).toBe(0);
    expect(await count("select id from public.advance_allocations where advance_id = $1", [a.id])).toBe(0);
    expect(await count("select id from public.transactions where id = any($1)", [[a.transaction_id, x.transaction_id]])).toBe(0);
  });

  it("deleting an invoice payment removes its cash and TDS entries and reopens the invoice", async () => {
    const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Client ledger", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Deletes", state_code: "27" })]);
    const id = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j({ workspace_id: ws, invoice_type: "service", invoice_date: "2026-02-01", contractor_id: client, ledger_id: ledger, client_name: "Client", items: [{ name: "Work", quantity: "1", rate: "1000" }] })]);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, "x".repeat(43), null]);
    const p = await rpc<{ id: string }>(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "990", tds_deducted: "10", paid_on: "2026-02-02", mode: "cash", wallet_ledger_id: cash })]);
    const pay = await one<{ transaction_id: string; tds_transaction_id: string }>("select transaction_id, tds_transaction_id from public.invoice_payments where id = $1", [p.id]);
    await rpc(db, OWNER, "public.delete_invoice_payment($1)", [p.id]);
    expect(await count("select id from public.invoice_payments where id = $1", [p.id])).toBe(0);
    expect(await count("select id from public.transactions where id = any($1)", [[pay.transaction_id, pay.tds_transaction_id]])).toBe(0);
    expect(Number((await one<{ amount_received: string }>("select amount_received from public.invoices where id = $1", [id])).amount_received)).toBe(0);
  });

  it("the old void functions no longer exist", async () => {
    await expect(rpc(db, OWNER, "public.void_transaction($1, $2)", [cash, "x"])).rejects.toThrow(/does not exist/);
    await expect(rpc(db, OWNER, "public.void_expense($1, $2)", [cash, "x"])).rejects.toThrow(/does not exist/);
  });
});

describe("entries voided before this change", () => {
  it("are removed from the database when the migration runs, and the books are unchanged", async () => {
    const old = await createDb({ until: "20261109002400" });
    const w = await rpc<string>(old, OWNER, "public.create_workspace($1, $2, $3)", ["Old", "Owner", null]);
    const q1 = async <T>(sql: string, params: unknown[] = []) => (await as(old, OWNER, (q) => q<T>(sql, params)))[0];
    const wallet = (await q1<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'", [w])).id;
    const cat = (await q1<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1", [w])).id;
    const keep = await rpc<{ id: string }>(old, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: wallet, txn_date: "2026-01-01", kind: "regular", status: "posted", direction: "in", amount: "500" })]);
    const gone = await rpc<{ id: string }>(old, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: wallet, txn_date: "2026-01-01", kind: "regular", status: "posted", direction: "in", amount: "300" })]);
    await rpc(old, OWNER, "public.void_transaction($1, $2)", [gone.id, "Wrong"]);
    const e = await rpc<{ id: string }>(old, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: w, category_id: cat, expense_date: "2026-01-02", title: "Old", amount: "50", ledger_id: wallet })]);
    await rpc(old, OWNER, "public.void_expense($1, $2)", [e.id, "Wrong"]);
    await applyFrom(old, "20261109002400");
    const left = await as(old, OWNER, (q) => q<{ id: string; status: string }>("select id, status from public.transactions where workspace_id = $1", [w]));
    expect(left).toEqual([{ id: keep.id, status: "posted" }]);
    expect(await as(old, OWNER, (q) => q("select id from public.expenses where workspace_id = $1", [w]))).toHaveLength(0);
  });
});
