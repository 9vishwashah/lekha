import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_del_owner";
const MEMBER = "user_del_member";
const j = (v: unknown) => JSON.stringify(v);
let db: Db;
let ws: string;
let category: string;
let n = 0;

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const client = async (name: string) => (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, $2, 'business', $3) returning id`, [ws, name, OWNER])).id;
const ledger = (x: Record<string, unknown>) => rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: `L${++n}`, ledger_type: "basic", opening_balance: "0", ...x })]);
const post = (x: Record<string, unknown>) => rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ txn_date: "2026-10-01", direction: "in", kind: "regular", status: "posted", amount: "100", ...x })]);
const del = (id: string, name: string, who = OWNER) => rpc<{ entries: number }>(db, who, "public.delete_ledger($1, $2)", [id, name]);
const nameOf = async (id: string) => (await one<{ name: string }>("select name from public.ledgers where id = $1", [id])).name;
const exists = async (id: string) => Boolean(await one("select id from public.ledgers where id = $1", [id]));

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Del", "Owner", null]);
  category = (await one<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1", [ws])).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1, $2, 'member', 'Team')`, [ws, MEMBER]);
});

describe("deleting a ledger", () => {
  it("removes it and every entry in it, and keeps the audit trail", async () => {
    const l = await ledger({ contractor_id: await client("Gone") });
    const t = await post({ ledger_id: l });
    await post({ ledger_id: l, direction: "out", amount: "40" });
    await rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [t.id, "x", "2026-10-02"]);
    const r = await del(l, await nameOf(l));
    expect(r.entries).toBe(3);
    expect(await exists(l)).toBe(false);
    expect(await one("select id from public.transactions where ledger_id = $1", [l])).toBeUndefined();
    const audit = await one<{ n: number }>("select count(*)::int as n from public.audit_logs where ledger_id = $1 and action = 'delete'", [l]);
    expect(audit.n).toBeGreaterThan(0);
  });

  it("needs the name typed exactly (any case)", async () => {
    const l = await ledger({ name: "Site Work" });
    await expect(del(l, "Site")).rejects.toThrow(/Type the ledger name/);
    await del(l, "  site work ");
    expect(await exists(l)).toBe(false);
  });

  it("only owners and admins can delete", async () => {
    const l = await ledger({});
    await expect(del(l, await nameOf(l), MEMBER)).rejects.toThrow(/owners and admins/);
  });

  it("deletes a shared account with its expenses and repayments", async () => {
    const a = await client("Friend");
    const l = await ledger({ ledger_type: "personal", owner_name: "Owner", participant_client_ids: [a] });
    const ps = await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [l]));
    await rpc(db, OWNER, "public.create_shared_expense($1::jsonb)", [j({ ledger_id: l, txn_date: "2026-10-01", description: "x", total_amount: "100", split_method: "exact", payers: [{ participant_id: ps[0].id, amount: "100" }], shares: [{ participant_id: ps[1].id, amount: "100" }] })]);
    await rpc(db, OWNER, "public.record_settlement($1::jsonb)", [j({ ledger_id: l, from_participant_id: ps[1].id, to_participant_id: ps[0].id, amount: "40", txn_date: "2026-10-02" })]);
    await del(l, await nameOf(l));
    expect(await exists(l)).toBe(false);
  });

  it("refuses while an expense paid from it still counts, then allows once it is voided", async () => {
    const wallet = await ledger({ wallet_kind: "cash" });
    const e = await rpc<{ id: string }>(db, OWNER, "public.create_expense($1::jsonb)", [j({ workspace_id: ws, category_id: category, expense_date: "2026-10-03", title: "Tea", amount: "50", ledger_id: wallet })]);
    await expect(del(wallet, await nameOf(wallet))).rejects.toThrow(/Delete them in Expenses/);
    await rpc(db, OWNER, "public.delete_expense($1)", [e.id]);
    await del(wallet, await nameOf(wallet));
    expect(await one("select id from public.expenses where id = $1", [e.id])).toBeUndefined();
  });

  it("refuses while an advance, a client payment or a split depends on it", async () => {
    const c = await client("Adv");
    const wallet = await ledger({ wallet_kind: "bank" });
    await rpc(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, amount: "10", given_date: "2026-10-01", ledger_id: wallet })]);
    await expect(del(wallet, await nameOf(wallet))).rejects.toThrow(/Advances/);
    const w2 = await ledger({ wallet_kind: "bank" });
    await rpc(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, direction: "received", amount: "5", txn_date: "2026-10-02", ledger_id: w2 })]);
    await expect(del(w2, await nameOf(w2))).rejects.toThrow(/client payment/);
    const w3 = await ledger({ wallet_kind: "bank" });
    await rpc(db, OWNER, "public.create_split_expense($1::jsonb)", [j({ workspace_id: ws, title: "D", expense_date: "2026-10-04", category_id: category, amount: "90", your_share: "30", ledger_id: w3, people: [{ contractor_id: c, amount: "60" }] })]);
    await expect(del(w3, await nameOf(w3))).rejects.toThrow(/split|Expenses/);
  });

  it("refuses while client-ledger entries name it as their wallet", async () => {
    const wallet = await ledger({ wallet_kind: "bank" });
    const party = await ledger({ contractor_id: await client("Payer") });
    await post({ ledger_id: party, wallet_ledger_id: wallet });
    await expect(del(wallet, await nameOf(wallet))).rejects.toThrow(/went through this wallet/);
  });

  it("refuses while an issued invoice is posted to it, but a cancelled one is just unlinked", async () => {
    const c = await client("Inv");
    const party = await ledger({ contractor_id: c });
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Del Co", state_code: "27" })]);
    const id = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j({ workspace_id: ws, invoice_type: "service", invoice_date: "2026-10-05", contractor_id: c, ledger_id: party, client_name: "Inv", items: [{ name: "Work", quantity: "1", rate: "100" }] })]);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, "d".repeat(43), null]);
    await expect(del(party, await nameOf(party))).rejects.toThrow(/Cancel it first/);
    await rpc(db, OWNER, "public.cancel_invoice($1, $2)", [id, "Wrong"]);
    await del(party, await nameOf(party));
    const inv = await one<{ ledger_id: string | null; status: string }>("select ledger_id, status from public.invoices where id = $1", [id]);
    expect(inv).toEqual({ ledger_id: null, status: "cancelled" });
  });

  it("deletes a client's direct account, and a new one is made when needed", async () => {
    const c = await client("Direct");
    const r = await rpc<{ ledger_id: string }>(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, direction: "paid", amount: "20", txn_date: "2026-10-02" })]);
    await del(r.ledger_id, await nameOf(r.ledger_id));
    const again = await rpc<{ ledger_id: string }>(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, direction: "paid", amount: "20", txn_date: "2026-10-02" })]);
    expect(again.ledger_id).not.toBe(r.ledger_id);
  });
});
