import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_notify_owner";
const TEAM = "user_notify_team";
const FRIEND = "user_notify_friend";
const j = (v: unknown) => JSON.stringify(v);
let db: Db;
let ws: string;
let ledger: string;

type N = { kind: string; actor_name: string | null; subject: string | null; amount: string | null; direction: string | null; href: string | null; read_at: string | null };
const mine = (who: string) => as(db, who, (q) => q<N>("select kind, actor_name, subject, amount, direction, href, read_at from public.notifications order by id"));
const clear = () => db.query("delete from public.notifications");

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Notify", "Vishwa", null]);
  await rpc(db, OWNER, "public.save_my_profile($1, $2)", ["Vishwa Shah", null]);
  await rpc(db, TEAM, "public.save_my_profile($1, $2)", ["Teammate", null]);
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1, $2, 'member', 'Teammate')`, [ws, TEAM]);
  ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Site cash", ledger_type: "basic", opening_balance: "0" })]);
});

describe("notifications", () => {
  it("someone else's money in / out reaches everyone on the ledger, never the person who added it", async () => {
    await clear();
    await rpc(db, TEAM, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledger, txn_date: "2026-11-01", kind: "regular", status: "posted", direction: "in", amount: "5000", description: "Advance from client" })]);
    expect(await mine(OWNER)).toEqual([expect.objectContaining({ kind: "entry", actor_name: "Teammate", subject: "Site cash", direction: "in", href: `/ledgers/${ledger}` })]);
    expect(Number((await mine(OWNER))[0].amount)).toBe(5000);
    expect(await mine(TEAM)).toEqual([]);
  });

  it("drafts are not news", async () => {
    await clear();
    await rpc(db, TEAM, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledger, txn_date: "2026-11-01", kind: "regular", status: "draft", direction: "out", amount: "10" })]);
    expect(await mine(OWNER)).toEqual([]);
  });

  it("an expense and a payment added by a friend in their account reach you", async () => {
    await clear();
    const friendWs = await rpc<string>(db, FRIEND, "public.create_workspace($1, $2, $3)", ["Friend", "Dhiraj", null]);
    await rpc(db, FRIEND, "public.save_my_profile($1, $2)", ["Dhiraj Saini", null]);
    await rpc(db, OWNER, "public.set_my_username($1)", ["vishwa"]);
    const me = (await as(db, FRIEND, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Vishwa', 'personal', $2) returning id`, [friendWs, FRIEND])))[0].id;
    await rpc(db, FRIEND, "public.link_client_by_username($1, $2)", [me, "vishwa"]);
    const acct = await rpc<string>(db, FRIEND, "public.create_ledger($1::jsonb)", [j({ workspace_id: friendWs, name: "Trip", ledger_type: "personal", owner_name: "Dhiraj", participant_client_ids: [me] })]);
    const ps = await as(db, FRIEND, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [acct]));
    await rpc(db, FRIEND, "public.create_shared_expense($1::jsonb)", [j({ ledger_id: acct, txn_date: "2026-11-02", description: "Dinner", total_amount: "1200", split_method: "exact", payers: [{ participant_id: ps[0].id, amount: "1200" }], shares: [{ participant_id: ps[1].id, amount: "600" }, { participant_id: ps[0].id, amount: "600" }] })]);
    await rpc(db, FRIEND, "public.record_settlement($1::jsonb)", [j({ ledger_id: acct, from_participant_id: ps[1].id, to_participant_id: ps[0].id, amount: "600", txn_date: "2026-11-03" })]);
    const got = await mine(OWNER);
    expect(got.map((n) => n.kind)).toEqual(["expense", "payment"]);
    expect(got[0]).toMatchObject({ actor_name: "Dhiraj Saini", subject: "Trip" });
  });

  it("a confirmed statement and a client opening an invoice notify the workspace", async () => {
    await clear();
    const token = "z".repeat(48);
    await rpc(db, OWNER, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledger, token, "c", "{}"]);
    const v = await rpc<{ ledger: { last_activity_at: string } }>(db, null, "public.get_shared_ledger($1)", [token]);
    await rpc(db, null, "public.acknowledge_shared_ledger($1, $2::timestamptz, $3)", [token, v.ledger.last_activity_at, "Ramesh"]);
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Notify Co", state_code: "27" })]);
    const inv = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j({ workspace_id: ws, invoice_type: "service", invoice_date: "2026-11-01", client_name: "Regal", items: [{ name: "Work", quantity: "1", rate: "100" }] })]);
    const itoken = "q".repeat(43);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [inv, itoken, null]);
    await rpc(db, null, "public.note_invoice_view($1)", [itoken]);
    await rpc(db, null, "public.note_invoice_view($1)", [itoken]); // second view: no new alert
    const kinds = (await mine(OWNER)).map((n) => n.kind);
    expect(kinds).toEqual(["confirmed", "invoice_viewed"]);
    expect((await mine(TEAM)).map((n) => n.kind)).toEqual(["confirmed", "invoice_viewed"]);
  });

  it("tells you when someone with your client's number joins Lekha", async () => {
    await clear();
    const card = (await as(db, OWNER, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, phone, kind, created_by) values ($1, 'Anil', '9811122233', 'personal', $2) returning id`, [ws, OWNER])))[0].id;
    await rpc(db, "user_notify_anil", "public.save_my_profile($1, $2)", ["Anil Kumar", "+919811122233"]);
    await rpc(db, "user_notify_anil", "public.set_my_username($1)", ["anilk"]);
    expect(await mine(OWNER)).toEqual([expect.objectContaining({ kind: "joined", actor_name: "Anil Kumar", subject: "Anil", href: `/contractors/${card}` })]);
  });

  it("reminders are made once for an overdue invoice", async () => {
    await clear();
    const inv = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j({ workspace_id: ws, invoice_type: "service", invoice_date: "2026-01-01", due_date: "2026-01-10", client_name: "Late Co", items: [{ name: "Work", quantity: "1", rate: "900" }] })]);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [inv, "r".repeat(43), null]);
    await rpc(db, OWNER, "public.refresh_my_reminders()");
    await rpc(db, OWNER, "public.refresh_my_reminders()");
    const overdue = (await mine(OWNER)).filter((n) => n.kind === "invoice_overdue");
    expect(overdue).toHaveLength(1);
    expect(Number(overdue[0].amount)).toBe(900);
  });

  it("only you can read and clear your notifications", async () => {
    expect((await mine(OWNER)).length).toBeGreaterThan(0);
    expect(await mine(FRIEND)).toEqual([]);
    await expect(as(db, OWNER, (q) => q("update public.notifications set read_at = now()"))).rejects.toThrow();
    await rpc(db, OWNER, "public.mark_notifications_read($1::bigint[])", [null]);
    expect((await mine(OWNER)).every((n) => n.read_at !== null)).toBe(true);
  });
});
