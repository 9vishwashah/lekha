import { beforeAll, describe, expect, it } from "vitest";
import { createDb, as, rpc, type Db } from "./harness";
import { computeTax } from "@/lib/domain/tax";
import { toDecimal, toPaise } from "@/lib/domain/money";

const A = "user_alice";
const B = "user_bob";
const C = "user_contractor";
const STRANGER = "user_stranger";
const tok = (seed: string) => (seed + "x".repeat(48)).slice(0, 48).replace(/[^A-Za-z0-9_-]/g, "a");

let db: Db;
let wsA: string;
let wsB: string;
let ledgerA: string;
let ledgerA2: string;
let taxLedger: string;
let ledgerB: string;
let contractorA: string;

const j = (v: unknown) => JSON.stringify(v);

async function expectError(promise: Promise<unknown>, pattern: RegExp) {
  await expect(promise).rejects.toThrow(pattern);
}

beforeAll(async () => {
  db = await createDb();
  wsA = await rpc<string>(db, A, "public.create_workspace($1, $2, $3)", ["Alice Builders", "Alice", "a@example.com"]);
  wsB = await rpc<string>(db, B, "public.create_workspace($1, $2, $3)", ["Bob Traders", "Bob", "b@example.com"]);
  contractorA = await as(db, A, async (q) =>
    (await q<{ id: string }>(
      `insert into public.contractors (workspace_id, name, gstin, pan, created_by) values ($1, 'Ramesh Saini', '27AAPFU0939F1ZV', 'AAPFU0939F', $2) returning id`,
      [wsA, A],
    ))[0].id,
  );
  ledgerA = await rpc<string>(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Ramesh site", ledger_type: "basic", contractor_id: contractorA, opening_balance: "1000" })]);
  ledgerA2 = await rpc<string>(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Private ledger", ledger_type: "basic" })]);
  taxLedger = await rpc<string>(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Rishabh Sales", ledger_type: "taxation", perspective: "party" })]);
  ledgerB = await rpc<string>(db, B, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsB, name: "Bob ledger", ledger_type: "basic" })]);
  await rpc(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-01", direction: "in", amount: "5000", description: "Cash received" })]);
  await rpc(db, B, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerB, txn_date: "2026-04-01", direction: "out", amount: "99", description: "Bob secret" })]);
});

describe("tenant isolation", () => {
  it("lets a user read only their own workspace", async () => {
    const rows = await as(db, A, (q) => q<{ id: string }>("select id from public.workspaces"));
    expect(rows.map((r) => r.id)).toEqual([wsA]);
  });

  it("hides another tenant's ledgers and transactions even when queried by id", async () => {
    const ledgers = await as(db, A, (q) => q("select id from public.ledgers where id = $1", [ledgerB]));
    const txns = await as(db, A, (q) => q("select id from public.transactions where ledger_id = $1", [ledgerB]));
    expect(ledgers).toEqual([]);
    expect(txns).toEqual([]);
  });

  it("refuses writes into another tenant's ledger", async () => {
    await expectError(
      rpc(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerB, txn_date: "2026-04-02", direction: "in", amount: "1" })]),
      /permission/,
    );
  });

  it("ignores a forged workspace id in the payload", async () => {
    await expectError(
      rpc(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsB, name: "Injected", ledger_type: "basic" })]),
      /permission/,
    );
    await expectError(
      as(db, A, (q) => q(`insert into public.contractors (workspace_id, name, created_by) values ($1, 'x', $2)`, [wsB, A])),
      /row-level security/,
    );
  });

  it("blocks direct writes to financial tables", async () => {
    await expectError(
      as(db, A, (q) => q(`update public.transactions set amount = 1 where ledger_id = $1`, [ledgerA])),
      /permission denied/,
    );
    await expectError(as(db, A, (q) => q(`delete from public.audit_logs`)), /permission denied/);
  });

  it("does not expose GSTIN or PAN through table reads, only through the guarded function", async () => {
    await expectError(as(db, A, (q) => q("select gstin from public.contractors")), /permission denied/);
    const ids = await rpc<{ gstin: string }>(db, A, "public.contractor_tax_ids($1)", [contractorA]);
    expect(ids.gstin).toBe("27AAPFU0939F1ZV");
    expect(await rpc(db, B, "public.contractor_tax_ids($1)", [contractorA])).toBeNull();
  });

  it("gives anonymous visitors nothing", async () => {
    await expectError(as(db, null, (q) => q("select * from public.transactions")), /permission denied/);
  });
});

describe("transactions and tax", () => {
  it("computes tax in the database exactly like the app", async () => {
    const cases = [
      { taxable: "1000000", gst: "18", tds: "1", base: "taxable", type: "intra" },
      { taxable: "333.33", gst: "18", tds: "0.1", base: "taxable", type: "intra" },
      { taxable: "98765.43", gst: "12", tds: "2", base: "gross", type: "inter" },
      { taxable: "0.05", gst: "5", tds: "0", base: "taxable", type: "intra" },
    ];
    for (const c of cases) {
      const sql = await rpc<Record<string, string>>(db, null, "app.compute_tax($1, true, $2, $3, true, $4, $5)", [
        c.taxable, c.type, c.gst, c.tds, c.base,
      ]).catch(async () =>
        // anon cannot execute app functions; run as the table owner instead
        (await db.query<{ r: Record<string, string> }>("select app.compute_tax($1, true, $2, $3, true, $4, $5) as r", [c.taxable, c.type, c.gst, c.tds, c.base])).rows[0].r,
      );
      const ts = computeTax({
        taxable: toPaise(c.taxable),
        gstApplicable: true,
        gstType: c.type as "intra" | "inter",
        gstRate: c.gst,
        tdsApplicable: true,
        tdsRate: c.tds,
        tdsBase: c.base as "taxable" | "gross",
      });
      expect(toPaise(String(sql.gst_amount))).toBe(ts.gst);
      expect(toPaise(String(sql.cgst_amount))).toBe(ts.cgst);
      expect(toPaise(String(sql.tds_amount))).toBe(ts.tds);
      expect(toPaise(String(sql.net_amount))).toBe(ts.net);
    }
  });

  it("posts a bill with the computed net amount and frozen rates", async () => {
    const res = await rpc<{ id: string }>(db, A, "public.post_transaction($1::jsonb)", [
      j({
        ledger_id: taxLedger, txn_date: "2026-04-10", kind: "invoice", direction: "in", description: "Creative work",
        tax: { taxable_amount: "1000000", gst_applicable: true, gst_rate: "18", tds_applicable: true, tds_rate: "1", tds_base: "taxable", invoice_no: "RS/01" },
      }),
    ]);
    const [t] = await as(db, A, (q) => q<{ amount: string; is_cash: boolean }>("select amount, is_cash from public.transactions where id = $1", [res.id]));
    expect(t.amount).toBe("1170000.00");
    expect(t.is_cash).toBe(false);
    const [d] = await as(db, A, (q) => q<{ gst_amount: string; gst_rate: string }>("select gst_amount, gst_rate from public.transaction_tax_details where transaction_id = $1", [res.id]));
    expect(d).toMatchObject({ gst_amount: "180000.00", gst_rate: "18.000" });
    // Changing workspace defaults never rewrites the posted entry.
    await rpc(db, A, "public.update_workspace($1, $2::jsonb)", [wsA, j({ default_gst_rate: "12" })]);
    const [after] = await as(db, A, (q) => q<{ gst_rate: string }>("select gst_rate from public.transaction_tax_details where transaction_id = $1", [res.id]));
    expect(after.gst_rate).toBe("18.000");
  });

  it("rejects bad amounts and is idempotent on retries", async () => {
    await expectError(rpc(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-02", direction: "in", amount: "0" })]), /greater than zero/);
    await expectError(rpc(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-02", direction: "in", amount: "1.005" })]), /2 decimal/);
    await expectError(rpc(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-02", direction: "both", amount: "5" })]), /Money In or Money Out/);
    const payload = j({ ledger_id: ledgerA, txn_date: "2026-04-02", direction: "out", amount: "250", idempotency_key: "retry-key-0001" });
    const first = await rpc<{ id: string; duplicate: boolean }>(db, A, "public.post_transaction($1::jsonb)", [payload]);
    const second = await rpc<{ id: string; duplicate: boolean }>(db, A, "public.post_transaction($1::jsonb)", [payload]);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
  });

  it("assigns unique sequential voucher numbers", async () => {
    const rows = await as(db, A, (q) => q<{ seq: number; voucher_no: string }>("select seq, voucher_no from public.transactions where ledger_id = $1 order by seq", [ledgerA]));
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows[0].voucher_no).toBe("BL-0001");
  });

  it("voids and reverses with an audit trail", async () => {
    const { id } = await rpc<{ id: string }>(db, A, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-03", direction: "out", amount: "75" })]);
    await rpc(db, A, "public.amend_transaction($1, $2::jsonb)", [id, j({ amount: "80", description: "Fixed amount" })]);
    await rpc(db, A, "public.reverse_transaction($1, $2, $3)", [id, "Paid twice", "2026-04-04"]);
    await expectError(rpc(db, A, "public.reverse_transaction($1, $2, $3)", [id, "again", null]), /already reversed/);
    await expectError(rpc(db, A, "public.amend_transaction($1, $2::jsonb)", [id, j({ amount: "90" })]), /reversed/);
    const audit = await as(db, A, (q) => q<{ action: string; changes: Record<string, { from: unknown; to: unknown }> }>(
      "select action, changes from public.audit_logs where entity_type = 'transactions' and entity_id = $1 order by id", [id]));
    expect(audit[0].action).toBe("insert");
    expect(audit[1].changes.amount).toEqual({ from: 75, to: 80 });
  });

  it("records GST paid to Government without touching the party balance", async () => {
    const { id } = await rpc<{ id: string }>(db, A, "public.record_tax_settlement($1::jsonb)", [j({ ledger_id: taxLedger, txn_date: "2026-05-15", tax_type: "gst", amount: "180000", challan_no: "CH-1", period_month: "2026-04-01" })]);
    const [t] = await as(db, A, (q) => q<{ is_cash: boolean; affects_party: boolean }>("select is_cash, affects_party from public.transactions where id = $1", [id]));
    expect(t).toEqual({ is_cash: true, affects_party: false });
  });
});

describe("expenses and advances", () => {
  it("creates an expense and its single ledger entry atomically, and voids both", async () => {
    const [cat] = await as(db, A, (q) => q<{ id: string }>("select id from public.expense_categories where workspace_id = $1 and name = 'Materials'", [wsA]));
    const res = await rpc<{ id: string; transaction_id: string }>(db, A, "public.create_expense($1::jsonb)", [
      j({ workspace_id: wsA, category_id: cat.id, expense_date: "2026-04-05", title: "Cement", amount: "4200", ledger_id: ledgerA }),
    ]);
    const txns = await as(db, A, (q) => q("select id from public.transactions where id = $1 and kind = 'expense'", [res.transaction_id]));
    expect(txns).toHaveLength(1);
    await rpc(db, A, "public.update_expense($1, $2::jsonb)", [res.id, j({ amount: "4300" })]);
    const [linked] = await as(db, A, (q) => q<{ amount: string }>("select amount from public.transactions where id = $1", [res.transaction_id]));
    expect(linked.amount).toBe("4300.00");
    await rpc(db, A, "public.void_expense($1, $2)", [res.id, "Returned"]);
    const [voided] = await as(db, A, (q) => q<{ status: string }>("select status from public.transactions where id = $1", [res.transaction_id]));
    expect(voided.status).toBe("void");
  });

  it("rolls back the ledger entry when the expense itself fails", async () => {
    const before = await as(db, A, (q) => q<{ n: number }>("select count(*)::int as n from public.transactions where ledger_id = $1", [ledgerA]));
    await expectError(
      rpc(db, A, "public.create_expense($1::jsonb)", [
        j({ workspace_id: wsA, category_id: "00000000-0000-0000-0000-000000000000", expense_date: "2026-04-05", title: "Bad", amount: "10", ledger_id: ledgerA }),
      ]),
      /foreign key/,
    );
    const after = await as(db, A, (q) => q<{ n: number }>("select count(*)::int as n from public.transactions where ledger_id = $1", [ledgerA]));
    expect(after[0].n).toBe(before[0].n);
  });

  it("allows partial recovery and adjustment but never more than outstanding", async () => {
    const adv = await rpc<{ id: string }>(db, A, "public.create_advance($1::jsonb)", [
      j({ workspace_id: wsA, contractor_id: contractorA, given_date: "2026-04-01", amount: "50000", ledger_id: ledgerA, expected_recovery_date: "2026-04-30" }),
    ]);
    await rpc(db, A, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "recovery", amount: "20000", alloc_date: "2026-04-10", idempotency_key: "recover-0001" })]);
    // Retried submission does not double count.
    await rpc(db, A, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "recovery", amount: "20000", alloc_date: "2026-04-10", idempotency_key: "recover-0001" })]);
    await rpc(db, A, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "adjustment", amount: "25000", alloc_date: "2026-04-12", bill_reference: "Bill 7" })]);
    await expectError(
      rpc(db, A, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "recovery", amount: "5000.01", alloc_date: "2026-04-13" })]),
      /more than the outstanding/,
    );
    const [o] = await db.query<{ o: string }>("select app.advance_outstanding($1) as o", [adv.id]).then((r) => r.rows);
    expect(o.o).toBe("5000.00");
    const cash = await as(db, A, (q) => q<{ kind: string; direction: string }>(
      "select kind, direction from public.transactions where kind in ('advance_given','advance_recovery') and ledger_id = $1 and status = 'posted' order by seq", [ledgerA]));
    // Only the cash recovery hits the ledger; the bill adjustment does not pretend to be a receipt.
    expect(cash).toEqual([{ kind: "advance_given", direction: "out" }, { kind: "advance_recovery", direction: "in" }]);
  });
});

describe("share links", () => {
  const token = tok("shareTokenAlpha");

  it("serves only the permitted fields of one ledger to anonymous visitors", async () => {
    await rpc(db, A, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledgerA, token, "cipher", j({ show_reference: false })]);
    const data = await rpc<{ ledger: { name: string; contractor_name: string }; transactions: Record<string, unknown>[] }>(db, null, "public.get_shared_ledger($1)", [token]);
    expect(data.ledger.name).toBe("Ramesh site");
    expect(data.ledger.contractor_name).toBe("Ramesh Saini");
    const json = JSON.stringify(data);
    expect(json).not.toContain(ledgerA);
    expect(json).not.toContain(wsA);
    expect(json).not.toContain("notes");
    expect(json).not.toContain("Bob secret");
    expect(data.transactions.every((t) => !("reference_no" in t) && !("id" in t))).toBe(true);
  });

  it("cannot be used to write, and stops working when revoked or rotated", async () => {
    await expectError(
      as(db, null, (q) => q("select public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-02", direction: "in", amount: "1" })])),
      /permission denied/,
    );
    const rotated = tok("shareTokenBravo");
    await rpc(db, A, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledgerA, rotated, "cipher2", "{}"]);
    expect(await rpc(db, null, "public.get_shared_ledger($1)", [token])).toBeNull();
    const [link] = await as(db, A, (q) => q<{ id: string }>("select id from public.share_links where ledger_id = $1 and revoked_at is null", [ledgerA]));
    await rpc(db, A, "public.revoke_share_link($1)", [link.id]);
    expect(await rpc(db, null, "public.get_shared_ledger($1)", [rotated])).toBeNull();
  });

  it("rejects expired links and malformed tokens", async () => {
    const t = tok("shareTokenCharlie");
    await rpc(db, A, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledgerA2, t, "c", j({ expires_at: "2020-01-01T00:00:00Z" })]);
    expect(await rpc(db, null, "public.get_shared_ledger($1)", [t])).toBeNull();
    expect(await rpc(db, null, "public.get_shared_ledger($1)", ["' or 1=1 --"])).toBeNull();
  });

  it("never lets a non-member create a link for someone else's ledger", async () => {
    await expectError(rpc(db, B, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledgerA, tok("evilToken"), "c", "{}"]), /permission/);
  });
});

describe("collaborators", () => {
  const invite = tok("inviteTokenDelta");

  it("requires a signed-in account to accept, and grants only the invited ledger", async () => {
    await rpc(db, A, "public.create_invitation($1, $2::jsonb)", [invite, j({ scope: "ledger", ledger_id: ledgerA, can_create: true, can_edit_own: true })]);
    await expectError(as(db, null, (q) => q("select public.accept_invitation($1, 'C', null)", [invite])), /permission denied/);
    await rpc(db, C, "public.accept_invitation($1, $2, $3)", [invite, "Ramesh", null]);
    await expectError(rpc(db, STRANGER, "public.accept_invitation($1, $2, $3)", [invite, "x", null]), /no longer valid/);

    const visible = await as(db, C, (q) => q<{ id: string }>("select id from public.ledgers"));
    expect(visible.map((r) => r.id)).toEqual([ledgerA]);
    expect(await as(db, C, (q) => q("select id from public.workspaces"))).toEqual([]);
    expect(await as(db, C, (q) => q("select id from public.expenses"))).toEqual([]);
    expect(await as(db, C, (q) => q("select transaction_id from public.transaction_tax_details"))).toEqual([]);
  });

  it("lets a collaborator add and edit only their own entries in that ledger", async () => {
    const mine = await rpc<{ id: string }>(db, C, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-08", direction: "out", amount: "300", description: "By Ramesh" })]);
    await rpc(db, C, "public.amend_transaction($1, $2::jsonb)", [mine.id, j({ amount: "320" })]);
    const [ownerEntry] = await as(db, A, (q) => q<{ id: string }>("select id from public.transactions where ledger_id = $1 and created_by = $2 and kind = 'regular' limit 1", [ledgerA, A]));
    await expectError(rpc(db, C, "public.amend_transaction($1, $2::jsonb)", [ownerEntry.id, j({ amount: "1" })]), /permission/);
    await expectError(rpc(db, C, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA2, txn_date: "2026-04-08", direction: "out", amount: "1" })]), /permission/);
    await expectError(rpc(db, C, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledgerA, tok("collabShare"), "c", "{}"]), /permission/);
    const [audit] = await as(db, A, (q) => q<{ actor_role: string; actor_user_id: string }>(
      "select actor_role, actor_user_id from public.audit_logs where entity_id = $1 and action = 'insert'", [mine.id]));
    expect(audit).toEqual({ actor_role: "collaborator", actor_user_id: C });
  });

  it("cannot void workspace-owned entries such as advances even with edit-any permission", async () => {
    const [row] = await as(db, C, (q) => q<{ id: string }>("select id from public.ledger_collaborators where user_id = $1", [C]));
    await rpc(db, A, "public.update_collaborator($1, $2::jsonb)", [row.id, j({ can_edit_all: true })]);
    const [adv] = await as(db, A, (q) => q<{ id: string }>("select id from public.transactions where ledger_id = $1 and kind = 'advance_given' limit 1", [ledgerA]));
    await expectError(rpc(db, C, "public.void_transaction($1, $2)", [adv.id, "nope"]), /permission/);
    await rpc(db, A, "public.update_collaborator($1, $2::jsonb)", [row.id, j({ can_edit_all: false })]);
  });

  it("cannot change their own permissions, and loses access when revoked", async () => {
    const [row] = await as(db, C, (q) => q<{ id: string }>("select id from public.ledger_collaborators where user_id = $1", [C]));
    await expectError(rpc(db, C, "public.update_collaborator($1, $2::jsonb)", [row.id, j({ can_edit_all: true })]), /permission/);
    await rpc(db, A, "public.revoke_collaborator($1)", [row.id]);
    expect(await as(db, C, (q) => q("select id from public.ledgers"))).toEqual([]);
    await expectError(rpc(db, C, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledgerA, txn_date: "2026-04-09", direction: "out", amount: "1" })]), /permission/);
  });
});

describe("personal shared ledgers", () => {
  let ledger: string;
  let vishwa: string;
  let suraj: string;
  const SURAJ = "user_suraj";

  beforeAll(async () => {
    const surajClient = await as(db, A, async (q) =>
      (await q<{ id: string }>(
        `insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Suraj', 'personal', $2) returning id`,
        [wsA, A],
      ))[0].id,
    );
    // A free-text name is no longer accepted: people in shared accounts must be clients.
    await expectError(
      rpc(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Names only", ledger_type: "personal", participants: ["Suraj"] })]),
      /at least one other person/,
    );
    // Another tenant's client can't be pulled into this workspace's account.
    const bobsClient = await as(db, B, async (q) =>
      (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, created_by) values ($1, 'Bob client', $2) returning id`, [wsB, B]))[0].id,
    );
    await expectError(
      rpc(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Other tenant", ledger_type: "personal", participant_client_ids: [bobsClient] })]),
      /client accounts/,
    );
    ledger = await rpc<string>(db, A, "public.create_ledger($1::jsonb)", [j({ workspace_id: wsA, name: "Vishwa × Suraj", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [surajClient] })]);
    const people = await as(db, A, (q) => q<{ id: string; display_name: string }>("select id, display_name from public.ledger_participants where ledger_id = $1 order by position", [ledger]));
    [vishwa, suraj] = people.map((p) => p.id);
    const invite = tok("personalInvite");
    await rpc(db, A, "public.create_invitation($1, $2::jsonb)", [invite, j({ scope: "ledger", ledger_id: ledger, participant_id: suraj, can_create: true, can_edit_own: true })]);
    await rpc(db, SURAJ, "public.accept_invitation($1, $2, $3)", [invite, "Suraj", null]);
  });

  it("stores one canonical expense whose shares must reconcile", async () => {
    await expectError(
      rpc(db, A, "public.create_shared_expense($1::jsonb)", [
        j({ ledger_id: ledger, txn_date: "2026-10-01", description: "Dinner", total_amount: "100", split_method: "exact",
            payers: [{ participant_id: vishwa, amount: "100" }], shares: [{ participant_id: vishwa, amount: "50" }, { participant_id: suraj, amount: "49" }] }),
      ]),
      /must add up/,
    );
    await rpc(db, A, "public.create_shared_expense($1::jsonb)", [
      j({ ledger_id: ledger, txn_date: "2026-10-01", description: "Dinner", total_amount: "1000", split_method: "exact",
          payers: [{ participant_id: vishwa, amount: "1000" }], shares: [{ participant_id: vishwa, amount: "400" }, { participant_id: suraj, amount: "600" }] }),
    ]);
    const net = async (id: string) => (await db.query<{ n: string }>("select app.participant_net($1) as n", [id])).rows[0].n;
    expect(await net(suraj)).toBe("-600.00");
    expect(await net(vishwa)).toBe("600.00");
    // Suraj sees the very same record from his own account.
    const seen = await as(db, SURAJ, (q) => q("select id from public.shared_expenses where ledger_id = $1", [ledger]));
    expect(seen).toHaveLength(1);
  });

  it("applies partial and full repayment and blocks overpayment", async () => {
    await rpc(db, SURAJ, "public.record_settlement($1::jsonb)", [j({ ledger_id: ledger, from_participant_id: suraj, to_participant_id: vishwa, amount: "200", txn_date: "2026-10-02" })]);
    await expectError(
      rpc(db, SURAJ, "public.record_settlement($1::jsonb)", [j({ ledger_id: ledger, from_participant_id: suraj, to_participant_id: vishwa, amount: "400.01", txn_date: "2026-10-03" })]),
      /more than the outstanding/,
    );
    await rpc(db, SURAJ, "public.record_settlement($1::jsonb)", [j({ ledger_id: ledger, from_participant_id: suraj, to_participant_id: vishwa, amount: "400", txn_date: "2026-10-03" })]);
    const nets = await db.query<{ n: string }>("select app.participant_net(id) as n from public.ledger_participants where ledger_id = $1", [ledger]);
    expect(nets.rows.map((r) => r.n)).toEqual(["0.00", "0.00"]);
    await expectError(
      rpc(db, SURAJ, "public.record_settlement($1::jsonb)", [j({ ledger_id: ledger, from_participant_id: suraj, to_participant_id: vishwa, amount: "1", txn_date: "2026-10-04" })]),
      /Nothing is outstanding/,
    );
  });

  it("links the joined person to their client record and keeps names in step", async () => {
    const [p] = await as(db, A, (q) => q<{ contractor_id: string }>("select contractor_id from public.ledger_participants where id = $1", [suraj]));
    const [c] = await as(db, A, (q) => q<{ linked_user_id: string; kind: string }>("select linked_user_id, kind from public.contractors where id = $1", [p.contractor_id]));
    expect(c).toEqual({ linked_user_id: SURAJ, kind: "personal" });
    await as(db, A, (q) => q("update public.contractors set name = 'Suraj Mehta' where id = $1", [p.contractor_id]));
    const [renamed] = await as(db, SURAJ, (q) => q<{ display_name: string }>("select display_name from public.ledger_participants where id = $1", [suraj]));
    expect(renamed.display_name).toBe("Suraj Mehta");
  });

  it("keeps the participant away from the owner's other ledgers", async () => {
    const visible = await as(db, SURAJ, (q) => q<{ id: string }>("select id from public.ledgers"));
    expect(visible.map((v) => v.id)).toEqual([ledger]);
  });

  it("serialises concurrent repayments so they cannot together overpay", async () => {
    await rpc(db, A, "public.create_shared_expense($1::jsonb)", [
      j({ ledger_id: ledger, txn_date: "2026-10-05", description: "Cab", total_amount: "100", split_method: "equal",
          payers: [{ participant_id: vishwa, amount: "100" }], shares: [{ participant_id: vishwa, amount: "50" }, { participant_id: suraj, amount: "50" }] }),
    ]);
    const attempt = () => rpc(db, SURAJ, "public.record_settlement($1::jsonb)", [j({ ledger_id: ledger, from_participant_id: suraj, to_participant_id: vishwa, amount: "50", txn_date: "2026-10-06" })]);
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("import", () => {
  it("imports a batch atomically and refuses the same sheet twice", async () => {
    const payload = {
      ledger_id: ledgerA2, file_name: "ramesh.xlsx", file_hash: "a".repeat(64), sheet_name: "Sheet1",
      rows: [
        { row: 2, txn_date: "2026-04-01", direction: "in", amount: "1000", description: "Opening cash" },
        { row: 3, txn_date: "2026-04-02", direction: "out", amount: "250", description: "Labour" },
      ],
    };
    const res = await rpc<{ imported: number }>(db, A, "public.import_transactions($1::jsonb)", [j(payload)]);
    expect(res.imported).toBe(2);
    await expectError(rpc(db, A, "public.import_transactions($1::jsonb)", [j(payload)]), /already been imported/);
    const bad = { ...payload, file_hash: "b".repeat(64), rows: [...payload.rows, { row: 4, txn_date: "not-a-date", direction: "in", amount: "1" }] };
    await expectError(rpc(db, A, "public.import_transactions($1::jsonb)", [j(bad)]), /Date is not valid/);
    const [count] = await as(db, A, (q) => q<{ n: number }>("select count(*)::int as n from public.transactions where ledger_id = $1", [ledgerA2]));
    expect(count.n).toBe(2);
    expect(toDecimal(toPaise("1000") - toPaise("250"))).toBe("750.00");
  });
});
