import { describe, expect, it, vi } from "vitest";
import { as, createDb, rpc } from "./harness";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, updateTag: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {} }));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn(), currentUser: vi.fn() }));
vi.mock("@/lib/server/context", () => ({ requireUser: async () => "user_me", getWorkspace: async () => ({}) }));
// Server actions talk to this in-process database as the signed-in user.
const live: { db?: Awaited<ReturnType<typeof createDb>> } = {};
vi.mock("@/lib/supabase/server", () => ({
  userDb: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const sql = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ")})`;
      try {
        return { data: await rpc(live.db!, ME, sql, keys.map((k) => (typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]))), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: "P0001" } };
      }
    },
  }),
  anonDb: () => ({}),
}));

const ME = "user_me";
const j = (v: unknown) => JSON.stringify(v);
const { saveSharedExpense } = await import("@/app/(app)/actions/records");
const { amendEntry, postEntry } = await import("@/app/(app)/actions/ledgers");

async function setup() {
  const db = await createDb();
  live.db = db;
  const ws = await rpc<string>(db, ME, "public.create_workspace($1, $2, $3)", ["Home", "Vishwa", null]);
  const client = await as(db, ME, async (q) =>
    (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Suraj', 'personal', $2) returning id`, [ws, ME]))[0].id,
  );
  const ledger = await rpc<string>(db, ME, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Trip", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [client] })]);
  const people = await as(db, ME, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [ledger]));
  return { db, ledger, people };
}

describe("corrections", () => {
  it.each(["equal", "exact", "percent", "shares"] as const)("corrects a shared expense split by %s through the app action", async (method) => {
    const { db, ledger, people } = await setup();
    const inputs = { equal: [undefined, undefined], exact: ["150", "250"], percent: ["40", "60"], shares: ["1", "3"] }[method];
    const first = await saveSharedExpense(null, {
      ledger_id: ledger, txn_date: "2026-10-20", description: "Dinner", total_amount: "400", split_method: method, category: "", payment_mode: "",
      payers: [{ participant_id: people[0].id, amount: "400" }], shares: people.map((p, i) => ({ participant_id: p.id, input: inputs[i] })), idempotency_key: "key-12345678",
    });
    expect(first).toMatchObject({ ok: true });
    const [saved] = await as(db, ME, (q) => q<{ id: string }>("select id from public.shared_expenses where ledger_id = $1", [ledger]));
    // What the correction form sends back: the stored inputs, with a new total.
    const stored = await as(db, ME, (q) => q<{ share_amount: string; share_input: string | null }>("select share_amount, share_input::text from public.shared_expense_shares where shared_expense_id = $1 order by share_amount", [saved.id]));
    const res = await saveSharedExpense(saved.id, {
      ledger_id: ledger, txn_date: "2026-10-20", description: "Dinner (fixed)", total_amount: method === "exact" ? "400.00" : "500", split_method: method, category: "", payment_mode: "",
      payers: [{ participant_id: people[0].id, amount: method === "exact" ? "400.00" : "500.00" }],
      shares: people.map((p, i) => ({ participant_id: p.id, input: method === "equal" ? undefined : method === "exact" ? stored[i].share_amount : (stored[i].share_input ?? "") })),
    });
    expect(res, JSON.stringify({ res, stored })).toMatchObject({ ok: true, message: "Expense corrected" });
    const rows = await as(db, ME, (q) => q<{ description: string; status: string }>("select description, status from public.shared_expenses where ledger_id = $1 order by created_at", [ledger]));
    expect(rows).toEqual([{ description: "Dinner", status: "void" }, { description: "Dinner (fixed)", status: "posted" }]);
  });

  it("saves an edited ledger entry, including fields that were emptied", async () => {
    const db = await createDb();
    live.db = db;
    const ws = await rpc<string>(db, ME, "public.create_workspace($1, $2, $3)", ["Shop", "Vishwa", null]);
    const ledger = await rpc<string>(db, ME, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Cash", ledger_type: "basic" })]);
    const posted = await postEntry({ ledger_id: ledger, kind: "regular", direction: "out", amount: "1500", txn_date: "2026-10-01", description: "Cement", counterparty: "Ramesh", notes: "20 bags", idempotency_key: "key-abcdefgh" });
    expect(posted).toMatchObject({ ok: true });
    const [t] = await as(db, ME, (q) => q<{ id: string }>("select id from public.transactions where ledger_id = $1", [ledger]));
    const res = await amendEntry(t.id, ledger, { direction: "out", amount: "1750.00", txn_date: "2026-10-02", description: "Cement (25 bags)", counterparty: "", notes: "", payment_mode: "" });
    expect(res).toMatchObject({ ok: true });
    const [after] = await as(db, ME, (q) => q<Record<string, string | null>>("select amount, txn_date::text, description, counterparty, notes from public.transactions where id = $1", [t.id]));
    expect(after).toEqual({ amount: "1750.00", txn_date: "2026-10-02", description: "Cement (25 bags)", counterparty: null, notes: null });
  });
});
